'use strict';
/**
 * routes/supplierRoutes.js
 * Mounted at /api/suppliers — protected globally by routeGuard(['supplier'])
 * via authMiddleware.js ROUTE_PERMISSIONS['/suppliers'].
 *
 * Every route here scopes queries to req.user.id so a supplier can only ever
 * see/edit their own submissions.
 *
 * FILE UPLOAD ASSUMPTION:
 * Reuses the existing `middleware/upload` (same R2-backed multer wrapper used
 * in productRoutes.js). It's used here with .fields() to accept a primary
 * image, a gallery of additional images, and an optional video file, per row,
 * for up to MAX_ROWS rows in one multipart submission. Adjust field names to
 * match whatever the frontend's FormData actually sends — see notes inline.
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');

const SupplierProduct = require('../models/SupplierProduct');
const { uploadFile, deleteFromR2 } = require('../services/r2Service');
const { uploadSingleFileBuffer } = require('../services/msGraphService');
const { odvPath } = require('../utils/oneDrivePaths');
const logger = require('../utils/logger').child({ module: 'supplierRoutes' });
// NEW — security hardening: this route previously saved req.body fields
// straight to Mongo with no validation at all, unlike every other form in
// the app. Mirrors the same whitelist rules as src/utils/inputValidation.js
// on the front end — the server copy is the real boundary; the client copy
// is only a UX nicety and can always be bypassed with a direct API call.
const { isValidName, isValidMessage, isSafeUrl, normalizeUrl } = require('../utils/inputValidation');

const MAX_ROWS = 25; // sane ceiling for one batch submission

// middleware/upload.js only exposes single/array/fields/none — there's no
// `.any()` for dynamically-named fields. We pre-declare fixed field names
// for every possible row index instead (image_0..image_24, etc.), and use a
// bare multer instance (not the routeFile/routeFiles wrapper) so we can do
// custom routing here: images -> R2 'supplierSubmissions' folder, videos ->
// a *supplier-specific* OneDrive folder — not the generic uploads/videos
// folder that middleware/upload.js's storageRouter would send them to.
const bulkFields = [];
for (let i = 0; i < MAX_ROWS; i++) {
  bulkFields.push({ name: `image_${i}`, maxCount: 1 });
  bulkFields.push({ name: `gallery_${i}`, maxCount: 8 });
  bulkFields.push({ name: `video_${i}`, maxCount: 1 });
}
const rawMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
}).fields(bulkFields);

const rawSingleRowMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
}).fields([{ name: 'image', maxCount: 1 }, { name: 'gallery', maxCount: 8 }, { name: 'video', maxCount: 1 }]);

// Builds the OneDrive folder path for a supplier's product videos, matching
// the spec:
//   dev  -> development / supplier folder / {Supplier_Name} / {Product_Name}
//   prod -> website     / supplier folder / {Supplier_Name} / {Product_Name}
// odvPath() (utils/oneDrivePaths, already used by storageRouter.js) prepends
// the correct env root automatically.
const supplierVideoFolderPath = (req, productName) => {
  const folderName = (req.user.supplierCompanyName || req.user.name || 'unknown-supplier')
    .replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'unknown-supplier';
  const productFolderName = (productName || 'untitled-product')
    .replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'untitled-product';
  return odvPath('supplier folder', folderName, productFolderName);
};

// NEW — security hardening: shared field validation for both the bulk-create
// and edit/resubmit endpoints. Returns an error string, or null if the row
// is clean. Whitelist-based (matches the front-end mirror) rather than
// blacklisting tag names, since tag-name blacklists are trivially bypassed.
function validateProductFields({ brand, name, description, videoUrl }) {
  if (!isValidName(brand)) return 'Brand contains invalid characters.';
  if (!isValidName(name)) return 'Product name contains invalid characters.';
  if (!isValidMessage(description)) return 'Description contains invalid characters.';
  if (videoUrl && !isSafeUrl(videoUrl)) return 'Video URL must be a valid http(s) link.';
  return null;
}

// ─── GET /api/suppliers/products ──────────────────────────────────────────────
// Supplier's own submissions across all statuses (pending/approved/rejected).
// NOTE: per the spec, once a row is approved it is deleted from this
// collection (converted into a real Product), so "approved" rows will not
// actually show up here after approval — only pending + rejected persist.
router.get('/products', async (req, res) => {
  try {
    const rows = await SupplierProduct.find({ supplier: req.user.id }).sort({ updatedAt: -1 }).lean();
    res.json(rows);
  } catch (err) {
    logger.error('Failed to list supplier products', { error: err.message, supplierId: req.user.id });
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/suppliers/products/:id ──────────────────────────────────────────
router.get('/products/:id', async (req, res) => {
  try {
    const row = await SupplierProduct.findOne({ _id: req.params.id, supplier: req.user.id }).lean();
    if (!row) return res.status(404).json({ message: 'Submission not found.' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /api/suppliers/products/bulk
 * Batch create. Body is multipart/form-data.
 *
 * Expected shape from the frontend (adjust field naming to match your form
 * builder, this is the contract this handler expects):
 *   rows: JSON.stringify([
 *     { brand, name, description, videoUrl },
 *     ...
 *   ])
 *   image_0, image_1, ...        -> primary image file per row index
 *   gallery_0, gallery_1, ...    -> array of additional image files per row index
 *   video_0, video_1, ...        -> optional video file per row index (OneDrive path resolved server-side)
 *
 * Using indexed field names (image_0, image_1...) is the simplest way to
 * carry "which files belong to which row" through a single multipart
 * request without a heavier client-side multipart builder.
 */
router.post('/products/bulk',
  (req, res, next) => rawMulter(req, res, (err) => {
    if (err) return res.status(400).json({ message: `Upload failed: ${err.message}` });
    next();
  }),
  (req, _res, next) => { req.r2Folder = 'supplierSubmissions'; next(); },
  async (req, res) => {
    try {
      let rows;
      try {
        rows = JSON.parse(req.body.rows || '[]');
      } catch {
        return res.status(400).json({ message: 'rows must be a JSON array.' });
      }

      if (!Array.isArray(rows) || rows.length === 0)
        return res.status(400).json({ message: 'At least one product row is required.' });
      if (rows.length > MAX_ROWS)
        return res.status(400).json({ message: `Maximum ${MAX_ROWS} products per batch.` });

      const files = req.files || {}; // { fieldname: [multerFile,...] }
      const created = [];
      const errors = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          if (!row.brand || !row.name || !row.description) {
            errors.push({ row: i, message: 'Brand, product name, and description are required.' });
            continue;
          }
          // NEW — security hardening: reject before any upload/DB work happens.
          const fieldError = validateProductFields(row);
          if (fieldError) {
            errors.push({ row: i, message: fieldError });
            continue;
          }

          const primary = files[`image_${i}`]?.[0];
          if (!primary) {
            errors.push({ row: i, message: 'Primary image is required.' });
            continue;
          }

          // Primary image -> R2 (uploadFile handles the webp resize + resolveFolder via req.r2Folder)
          const primaryUpload = await uploadFile(primary, req);

          // Gallery images (optional) -> R2
          const galleryFiles = files[`gallery_${i}`] || [];
          const additionalImages = [];
          const additionalImageKeys = [];
          for (const g of galleryFiles) {
            const up = await uploadFile(g, req);
            additionalImages.push(up.url);
            additionalImageKeys.push(up.key);
          }

          // Video: either a pasted URL, or an uploaded file -> OneDrive
          // (development/website -> supplier folder -> {supplier name} -> {product name}).
          const videoFile = files[`video_${i}`]?.[0];
          let videoOneDrivePath = '';
          if (videoFile) {
            const videoFolderPath = supplierVideoFolderPath(req, row.name);
            const filenameExt = (videoFile.originalname.match(/\.[a-zA-Z0-9]+$/) || ['.mp4'])[0];
            const filename = `${row.name || 'video'}-${Date.now()}${filenameExt}`.replace(/\s+/g, '_');
            const result = await uploadSingleFileBuffer(videoFolderPath, filename, videoFile.buffer, videoFile.mimetype);
            videoOneDrivePath = `${videoFolderPath.join('/')}/${filename}`;
            logger.info('Supplier video uploaded to OneDrive', { row: i, path: videoOneDrivePath, webUrl: result.webUrl });
          }

          const supplierProduct = new SupplierProduct({
            supplier: req.user.id,
            brand: row.brand,
            name: row.name,
            description: row.description,
            imageUrl: primaryUpload.url,
            imageKey: primaryUpload.key,
            additionalImages,
            additionalImageKeys,
            videoUrl: row.videoUrl ? normalizeUrl(row.videoUrl) : '',
            videoOneDrivePath,
            sellingPrice: Number(row.sellingPrice) || 0, // NEW — supplier's suggested price
            status: 'pending',
          });

          await supplierProduct.save();
          created.push(supplierProduct);
        } catch (rowErr) {
          logger.error('Supplier bulk row failed', { row: i, error: rowErr.message });
          errors.push({ row: i, message: rowErr.message });
        }
      }

      logger.info('Supplier bulk submission processed', {
        supplierId: req.user.id, created: created.length, failed: errors.length,
      });

      res.status(errors.length ? 207 : 201).json({
        message: `${created.length} product(s) submitted for review.` + (errors.length ? ` ${errors.length} row(s) failed.` : ''),
        created,
        errors,
      });
    } catch (err) {
      logger.error('Supplier bulk upload failed', { error: err.message, supplierId: req.user.id });
      res.status(500).json({ message: 'Bulk upload failed.', error: err.message });
    }
  }
);

// ─── PUT /api/suppliers/products/:id ──────────────────────────────────────────
// Edit + resubmit — used for rejected rows (also allowed on pending rows so
// a supplier can fix a typo before admin gets to it).
router.put('/products/:id',
  (req, res, next) => rawSingleRowMulter(req, res, (err) => {
    if (err) return res.status(400).json({ message: `Upload failed: ${err.message}` });
    next();
  }),
  (req, _res, next) => { req.r2Folder = 'supplierSubmissions'; next(); },
  async (req, res) => {
    try {
      const row = await SupplierProduct.findOne({ _id: req.params.id, supplier: req.user.id });
      if (!row) return res.status(404).json({ message: 'Submission not found.' });
      if (row.status === 'approved')
        return res.status(400).json({ message: 'Approved products can no longer be edited here.' });

      // NEW — security hardening: validate incoming fields before touching
      // the document. Uses the values that WOULD be applied (falling back
      // to the existing row value), so a partial edit can't smuggle in an
      // unvalidated new field via an old-value fallback.
      const nextBrand = req.body.brand || row.brand;
      const nextName = req.body.name || row.name;
      const nextDescription = req.body.description || row.description;
      const nextVideoUrl = req.body.videoUrl !== undefined ? req.body.videoUrl : row.videoUrl;
      const fieldError = validateProductFields({
        brand: nextBrand, name: nextName, description: nextDescription, videoUrl: nextVideoUrl,
      });
      if (fieldError) return res.status(400).json({ message: fieldError });

      row.brand = nextBrand;
      row.name = nextName;
      row.description = nextDescription;
      row.videoUrl = nextVideoUrl ? normalizeUrl(nextVideoUrl) : '';
      row.sellingPrice = req.body.sellingPrice !== undefined ? Number(req.body.sellingPrice) : row.sellingPrice; // NEW

      const newPrimary = req.files?.image?.[0];
      if (newPrimary) {
        if (row.imageKey) await deleteFromR2(row.imageKey).catch(() => {});
        const up = await uploadFile(newPrimary, req);
        row.imageUrl = up.url;
        row.imageKey = up.key;
      }

      const newGallery = req.files?.gallery || [];
      if (newGallery.length) {
        for (const g of newGallery) {
          const up = await uploadFile(g, req);
          row.additionalImages.push(up.url);
          row.additionalImageKeys.push(up.key);
        }
      }

      // New video on resubmit -> supplier's OneDrive folder, same as bulk create.
      const newVideo = req.files?.video?.[0];
      if (newVideo) {
        const videoFolderPath = supplierVideoFolderPath(req, row.name);
        const filenameExt = (newVideo.originalname.match(/\.[a-zA-Z0-9]+$/) || ['.mp4'])[0];
        const filename = `${row.name || 'video'}-${Date.now()}${filenameExt}`.replace(/\s+/g, '_');
        await uploadSingleFileBuffer(videoFolderPath, filename, newVideo.buffer, newVideo.mimetype);
        row.videoOneDrivePath = `${videoFolderPath.join('/')}/${filename}`;
      }

      // Resubmitting always resets status back to pending for re-review.
      row.status = 'pending';
      row.rejectionReason = '';
      await row.save();

      logger.info('Supplier resubmitted product', { rowId: row._id, supplierId: req.user.id });
      res.json({ message: 'Product resubmitted for review.', product: row });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// ─── DELETE /api/suppliers/products/:id ───────────────────────────────────────
router.delete('/products/:id', async (req, res) => {
  try {
    const row = await SupplierProduct.findOne({ _id: req.params.id, supplier: req.user.id });
    if (!row) return res.status(404).json({ message: 'Submission not found.' });
    if (row.status === 'approved')
      return res.status(400).json({ message: 'Approved products cannot be deleted here.' });

    if (row.imageKey) await deleteFromR2(row.imageKey).catch(() => {});
    for (const key of row.additionalImageKeys || []) await deleteFromR2(key).catch(() => {});

    await row.deleteOne();
    res.json({ message: 'Submission deleted.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;