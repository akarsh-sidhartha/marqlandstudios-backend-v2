'use strict';
/**
 * routes/jobWorkVendorRoutes.js
 * Mounted at /api/job-work — protected globally by routeGuard(['jobWork'])
 * via authMiddleware.js ROUTE_PERMISSIONS['/job-work'] (see JOB_WORK_WIRING.md).
 *
 * Every route here scopes queries to req.user.id so a job-work vendor can
 * only ever see/edit their own rows — same pattern as routes/supplierRoutes.js.
 *
 * Edit/delete are only allowed while a row is still 'ongoing' (locked once
 * an admin approves it into 'completed').
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');

const JobWorkRow = require('../../models/job-work/JobWorkRow');
const { generateJobWorkSerialId } = require('../../utils/jobWorkSerial');
const { uploadJobWorkImages, deleteJobWorkFolder } = require('../../services/job-work/jobWorkOneDriveService');
const { isValidMessage } = require('../../utils/inputValidation');
const { createRateLimiter } = require('../../middleware/security/rateLimiter');
const logger = require('../../utils/logger').child({ module: 'jobWorkVendorRoutes' });

const GST_RATE = 18;
const MAX_IMAGES = 12;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB/image
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Server-side allowlist — the real security boundary. Never trust a
// client-declared mimetype/extension alone; multer's fileFilter still runs
// before the buffer ever touches disk/memory long-term or OneDrive.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_MIMES.has(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, or WEBP images are allowed.'));
    }
    cb(null, true);
  },
}).array('images', MAX_IMAGES);

// Tighter bucket for mutating job-work endpoints (create/edit/delete),
// mirroring config/security.js's `write` bucket shape without touching that
// shared file.
const jobWorkWriteLimiter = createRateLimiter({ capacity: 30, refillPerSec: 0.5 });

const computeTotal = (quantity, pricePerUnit) =>
  Math.round(quantity * pricePerUnit * (1 + GST_RATE / 100) * 100) / 100;

// NEW — security hardening: whitelist-based field validation, same rationale
// as supplierRoutes.js's validateProductFields (reject outright, don't
// silently strip, so no script/HTML/NoSQL-operator syntax ever reaches Mongo).
function validateRowFields({ description, quantity, pricePerUnit }) {
  if (!isValidMessage(description) || !description || !String(description).trim())
    return 'Description is required and can only contain letters, numbers, spaces, and line breaks.';
  const qty = Number(quantity);
  const price = Number(pricePerUnit);
  if (!Number.isFinite(qty) || qty <= 0) return 'Quantity must be a positive number.';
  if (!Number.isFinite(price) || price <= 0) return 'Price per unit must be a positive number.';
  return null;
}

const buildDateFilter = (from, to) => {
  const filter = {};
  if (from) filter.$gte = new Date(from);
  if (to) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    filter.$lte = end;
  }
  return Object.keys(filter).length ? filter : null;
};

// ─── GET /api/job-work/rows ───────────────────────────────────────────────────
// Query: tab=ongoing|completed|archive, search=, from=, to= (createdAt range)
router.get('/rows', async (req, res) => {
  try {
    const { tab, search, from, to } = req.query;
    const filter = { vendor: req.user.id };
    if (tab && ['ongoing', 'completed', 'archive'].includes(tab)) filter.status = tab;
    if (search && String(search).trim()) {
      filter.$or = [
        { description: { $regex: String(search).trim().slice(0, 200), $options: 'i' } },
        { serialId: { $regex: String(search).trim().slice(0, 200), $options: 'i' } },
      ];
    }
    const dateFilter = buildDateFilter(from, to);
    if (dateFilter) filter.createdAt = dateFilter;

    const rows = await JobWorkRow.find(filter).sort({ createdAt: -1 }).lean();
    res.json(rows);
  } catch (err) {
    logger.error('Failed to list job work rows', { error: err.message, vendorId: req.user.id });
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/job-work/rows/:id ───────────────────────────────────────────────
router.get('/rows/:id', async (req, res) => {
  try {
    const row = await JobWorkRow.findOne({ _id: req.params.id, vendor: req.user.id }).lean();
    if (!row) return res.status(404).json({ message: 'Row not found.' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/job-work/media/:rowId/:imageId — authenticated OneDrive proxy ──
/**
 * Streams a job-work image from OneDrive through the backend, exactly
 * mirroring routes/vendorRoutes.js's GET /media/:vendorId/:mediaId and
 * routes/orderInquiryRoute.js's GET /proxy-attachment. A raw OneDrive
 * webUrl opens the online viewer page, not an image byte stream, so it
 * can never be used directly as an <img src> — this proxy is required.
 *
 * Public route (see authMiddleware.js ROUTE_PERMISSIONS['/job-work/media'])
 * since <img>/<video> tags can't attach an Authorization header — same
 * security model as the two sibling proxies this mirrors: unguessable
 * Mongo ObjectIds in the path are the only gate, not a JWT.
 *
 * ?download=1 adds Content-Disposition: attachment instead of inline.
 */
router.get('/media/:rowId/:imageId', async (req, res) => {
  try {
    const row = await JobWorkRow.findById(req.params.rowId).lean();
    if (!row) return res.status(404).json({ message: 'Row not found.' });

    const image = (row.images || []).find(img => img._id.toString() === req.params.imageId);
    if (!image) return res.status(404).json({ message: 'Image not found.' });

    const itemId = image.oneDriveItemId;
    if (!itemId) return res.status(404).json({ message: 'No OneDrive item ID stored for this image.' });

    const { getAccessToken } = require('../../services/msGraphService');
    const MICROSOFT_USER_ID = process.env.MICROSOFT_USER_ID;
    const token = await getAccessToken();

    const metaRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${MICROSOFT_USER_ID}/drive/items/${itemId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!metaRes.ok) {
      const err = await metaRes.text();
      logger.error('Job work media proxy — Graph metadata failed', { itemId, status: metaRes.status, err });
      return res.status(metaRes.status).json({ message: 'Could not resolve file from OneDrive.' });
    }
    const meta = await metaRes.json();
    const downloadUrl = meta['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) return res.status(502).json({ message: 'OneDrive did not return a download URL.' });

    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok) return res.status(fileRes.status).json({ message: 'Failed to stream file from OneDrive.' });

    const ct = fileRes.headers.get('content-type') || image.mimeType || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    if (fileRes.headers.get('content-length')) res.setHeader('Content-Length', fileRes.headers.get('content-length'));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${encodeURIComponent(image.filename)}"`);

    const { Readable } = require('stream');
    Readable.fromWeb(fileRes.body).pipe(res);
  } catch (err) {
    logger.error('Job work media proxy failed', { error: err.message, ...req.params });
    res.status(500).json({ message: 'Media proxy error.', error: err.message });
  }
});

// ─── POST /api/job-work/rows ──────────────────────────────────────────────────
// multipart/form-data: description, quantity, pricePerUnit, images[] (0..12)
router.post('/rows', jobWorkWriteLimiter,
  (req, res, next) => upload(req, res, (err) => {
    if (err) return res.status(400).json({ message: `Upload failed: ${err.message}` });
    next();
  }),
  async (req, res) => {
    try {
      const { description, quantity, pricePerUnit } = req.body;
      const fieldError = validateRowFields({ description, quantity, pricePerUnit });
      if (fieldError) return res.status(400).json({ message: fieldError });

      const qty = Number(quantity);
      const price = Number(pricePerUnit);
      const totalAmount = computeTotal(qty, price);
      const serialId = await generateJobWorkSerialId();

      const { folderId, folderPath, images } = await uploadJobWorkImages(serialId, req.files || []);

      const row = new JobWorkRow({
        vendor: req.user.id,
        serialId,
        description: String(description).trim(),
        quantity: qty,
        pricePerUnit: price,
        gstRate: GST_RATE,
        totalAmount,
        images,
        oneDriveFolderId: folderId,
        oneDriveFolderPath: folderPath,
        status: 'ongoing',
      });
      await row.save();

      logger.info('Job work row created', { rowId: row._id, serialId, vendorId: req.user.id });
      res.status(201).json({ message: 'Job work submitted.', row });
    } catch (err) {
      logger.error('Failed to create job work row', { error: err.message, vendorId: req.user.id });
      res.status(500).json({ message: 'Failed to submit job work.', error: err.message });
    }
  }
);

// ─── PUT /api/job-work/rows/:id ───────────────────────────────────────────────
// Only while status === 'ongoing'. New images are appended (existing images kept).
router.put('/rows/:id', jobWorkWriteLimiter,
  (req, res, next) => upload(req, res, (err) => {
    if (err) return res.status(400).json({ message: `Upload failed: ${err.message}` });
    next();
  }),
  async (req, res) => {
    try {
      const row = await JobWorkRow.findOne({ _id: req.params.id, vendor: req.user.id });
      if (!row) return res.status(404).json({ message: 'Row not found.' });
      if (row.status !== 'ongoing')
        return res.status(400).json({ message: 'Only rows in Ongoing can be edited.' });

      const nextDescription = req.body.description !== undefined ? req.body.description : row.description;
      const nextQuantity = req.body.quantity !== undefined ? req.body.quantity : row.quantity;
      const nextPrice = req.body.pricePerUnit !== undefined ? req.body.pricePerUnit : row.pricePerUnit;
      const fieldError = validateRowFields({ description: nextDescription, quantity: nextQuantity, pricePerUnit: nextPrice });
      if (fieldError) return res.status(400).json({ message: fieldError });

      const qty = Number(nextQuantity);
      const price = Number(nextPrice);

      if (req.files?.length) {
        const { images } = await uploadJobWorkImages(row.serialId, req.files, row.oneDriveFolderId);
        row.images.push(...images);
      }

      row.description = String(nextDescription).trim();
      row.quantity = qty;
      row.pricePerUnit = price;
      row.totalAmount = computeTotal(qty, price);
      await row.save();

      logger.info('Job work row updated', { rowId: row._id, vendorId: req.user.id });
      res.json({ message: 'Job work updated.', row });
    } catch (err) {
      logger.error('Failed to update job work row', { error: err.message, rowId: req.params.id });
      res.status(500).json({ message: err.message });
    }
  }
);

// ─── DELETE /api/job-work/rows/:id ────────────────────────────────────────────
router.delete('/rows/:id', jobWorkWriteLimiter, async (req, res) => {
  try {
    const row = await JobWorkRow.findOne({ _id: req.params.id, vendor: req.user.id });
    if (!row) return res.status(404).json({ message: 'Row not found.' });
    if (row.status !== 'ongoing')
      return res.status(400).json({ message: 'Only rows in Ongoing can be deleted.' });

    if (row.oneDriveFolderId) await deleteJobWorkFolder(row.oneDriveFolderId).catch(() => {});

    await row.deleteOne();
    logger.info('Job work row deleted', { rowId: row._id, vendorId: req.user.id });
    res.json({ message: 'Row deleted.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;