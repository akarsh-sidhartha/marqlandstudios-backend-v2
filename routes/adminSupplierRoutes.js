'use strict';
/**
 * routes/adminSupplierRoutes.js
 * Mounted at /api/admin/supplier-products — protected globally by
 * routeGuard(['admin']) via authMiddleware.js ROUTE_PERMISSIONS.
 */
const express = require('express');
const router = express.Router();

const SupplierProduct = require('../models/SupplierProduct');
const Product = require('../models/Product');
const logger = require('../utils/logger').child({ module: 'adminSupplierRoutes' });
const revisions = require('../services/catalog/supplierRevisionService');   // NEW — edits to live products
const { videoStreamFor } = require('../services/catalog/productService');
const { videoView } = require('../services/media/productMediaService');
const { requestTimeout } = require('../middleware/requestTimeout');

// Video summary for the review screen (never exposes OneDrive ids).
const reviewVideo = (fields, videoUpload) => videoView({ ...fields, videoUpload });

// ─── GET /api/admin/supplier-products/pending ─────────────────────────────────
// CHANGED — the queue now holds two kinds of item:
//   kind: 'new'    — a first-time submission (status 'pending')
//   kind: 'update' — a partner's change to a product that is already live
//                    (revisionStatus 'pending'). `live` carries the version
//                    currently published and `proposed` the partner's change,
//                    so the reviewer can compare them side by side.
// Both carry a `video` summary (link / uploaded file / still processing).
router.get('/pending', async (req, res) => {
  try {
    const rows = await SupplierProduct.find({ $or: [{ status: 'pending' }, { revisionStatus: 'pending' }] })
      .populate('supplier', 'name email supplierCompanyName')
      .sort({ updatedAt: 1 })
      .lean();

    const liveIds = rows.filter(r => r.revisionStatus === 'pending' && r.convertedProductId).map(r => r.convertedProductId);
    const lives = liveIds.length ? await Product.find({ _id: { $in: liveIds } }).lean() : [];
    const liveById = new Map(lives.map(p => [String(p._id), p]));

    const items = rows.map(r => {
      if (r.status === 'pending') {
        return { ...r, kind: 'new', video: reviewVideo(r, r.videoUpload) };
      }
      const live = liveById.get(String(r.convertedProductId));
      const rev = r.pendingRevision || {};
      return {
        ...r,
        kind: 'update',
        // Top-level fields show the proposed version (list thumbnails/names).
        ...revisions.CONTENT_FIELDS.reduce((acc, k) => ({ ...acc, [k]: rev[k] }), {}),
        sellingPrice: rev.sellingPrice,
        video: reviewVideo(rev, r.videoUpload),
        proposed: { ...rev, video: reviewVideo(rev, r.videoUpload) },
        live: live ? {
          _id: live._id, brand: live.brand, name: live.name, description: live.description,
          imageUrl: live.imageUrl, additionalImages: live.additionalImages,
          purchasePrice: live.purchasePrice, markupPercent: live.markupPercent, sellingPrice: live.sellingPrice,
          category: live.category, subCategory: live.subCategory,
          video: reviewVideo(live),
        } : null,
      };
    });
    res.json(items);
  } catch (err) {
    logger.error('Failed to fetch pending supplier products', { error: err.message });
    res.status(500).json({ message: err.message });
  }
});

/**
 * NEW — GET /api/admin/supplier-products/:id/video-stream?version=live|proposed
 * Playable URL for the partner's video on the review screen. 'proposed'
 * (default) is the submission / pending change; 'live' is what's published.
 */
router.get('/:id/video-stream', requestTimeout(10_000), async (req, res) => {
  try {
    const row = await SupplierProduct.findById(req.params.id).lean();
    if (!row) return res.status(404).json({ message: 'Submission not found.' });
    let fields = row;
    if (req.query.version === 'live' && row.convertedProductId) {
      fields = await Product.findById(row.convertedProductId).lean() || {};
    } else if (row.revisionStatus === 'pending' && row.pendingRevision) {
      fields = row.pendingRevision;
    }
    const stream = await videoStreamFor({ ...fields, _id: undefined });
    res.set('Cache-Control', 'private, no-store');
    res.json(stream);
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.statusCode === 404 ? 'This product has no video.' : 'Video temporarily unavailable.' });
  }
});

/**
 * NEW — PUT /api/admin/supplier-products/:id/approve-changes
 * Body (optional): { purchasePrice, markupPercent } — defaults to the
 * partner's proposed price and the product's current markup.
 * Publishes the partner's change to the live product.
 */
router.put('/:id/approve-changes', async (req, res) => {
  try {
    const product = await revisions.approveRevision(req.params.id, req.body || {}, req.user);
    res.json({ message: 'Changes approved and published.', product });
  } catch (err) {
    if (!err.statusCode) logger.error('Approve changes failed', { error: err.message, id: req.params.id });
    res.status(err.statusCode || 500).json({ message: err.message });
  }
});

/**
 * NEW — PUT /api/admin/supplier-products/:id/reject-changes   Body: { reason }
 * The live product stays as it is; the partner sees the reason and can resubmit.
 */
router.put('/:id/reject-changes', async (req, res) => {
  try {
    await revisions.rejectRevision(req.params.id, req.body?.reason, req.user);
    res.json({ message: 'Changes rejected. The partner can update and resubmit them.' });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message });
  }
});

// ─── GET /api/admin/supplier-products/:id ─────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const row = await SupplierProduct.findById(req.params.id)
      .populate('supplier', 'name email supplierCompanyName')
      .lean();
    if (!row) return res.status(404).json({ message: 'Submission not found.' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PUT /api/admin/supplier-products/:id/approve
 * Body: { category, subCategory, purchasePrice, sellingPrice, markupPercent }
 *
 * Converts the staging row into a real Product. The staging row is KEPT
 * (not deleted) — its status flips to 'approved' and it's linked to the new
 * Product via convertedProductId. This is what lets productRoutes.js's
 * DELETE /:id cascade a deletion reason back to the supplier later; the row
 * simply no longer shows as "pending" in either the admin queue or, since
 * SupplierPortal.js already filters its own display, as an active item to
 * resubmit.
 */
router.put('/:id/approve', async (req, res) => {
  try {
    const { category, subCategory, purchasePrice, sellingPrice, markupPercent } = req.body;
    if (!category)
      return res.status(400).json({ message: 'Category is required to approve a product.' });
    if (purchasePrice === undefined || purchasePrice === null || purchasePrice === '')
      return res.status(400).json({ message: 'Purchase price is required to approve a product.' });
    if (sellingPrice === undefined || sellingPrice === null || sellingPrice === '')
      return res.status(400).json({ message: 'Selling price is required to approve a product.' });

    const row = await SupplierProduct.findById(req.params.id);
    if (!row) return res.status(404).json({ message: 'Submission not found.' });
    if (row.status === 'approved')
      return res.status(400).json({ message: 'This submission has already been approved.' });

    const product = new Product({
      brand: row.brand,
      category,
      subCategory: subCategory || '',
      name: row.name,
      description: row.description,
      purchasePrice: Number(purchasePrice),
      sellingPrice: Number(sellingPrice),
      markupPercent: markupPercent !== undefined ? Number(markupPercent) : 10,
      imageUrl: row.imageUrl,
      imageKey: row.imageKey,
      additionalImages: row.additionalImages,
      additionalImageKeys: row.additionalImageKeys,
      // Carry the partner's video over whichever way it was supplied — a
      // link, or a file already uploaded to OneDrive. (Previously only
      // videoUrl was copied, so uploaded videos were lost on approval.)
      videoSource: row.videoSource || (row.videoUrl ? 'link' : (row.videoOneDriveItemId || row.videoOneDrivePath ? 'upload' : '')),
      videoUrl: row.videoUrl,
      videoOneDriveItemId: row.videoOneDriveItemId || '',
      videoOneDrivePath: row.videoOneDrivePath || '',
      videoFileName: row.videoFileName || '',
      // Lets the partner keep editing this product after approval.
      supplier: row.supplier,
    });
    await product.save();

    logger.info('Supplier product approved and published', {
      supplierProductId: row._id, newProductId: product._id, approvedBy: req.user.id,
    });

    // CHANGED — no longer deletes the row. It stays visible to the supplier
    // (SupplierPortal.js shows it with an "Approved" badge) and is linked to
    // the live Product so a later deletion can be cascaded back with a reason.
    row.status = 'approved';
    row.reviewedBy = req.user.id;
    row.reviewedAt = new Date();
    row.category = category;
    row.subCategory = subCategory || '';
    row.convertedProductId = product._id;
    await row.save();

    res.json({ message: 'Product approved and published.', product });
  } catch (err) {
    logger.error('Approve failed', { error: err.message, id: req.params.id });
    res.status(500).json({ message: err.message });
  }
});

/**
 * PUT /api/admin/supplier-products/:id/reject
 * Body: { reason }
 * Row stays in the collection with status 'rejected' + reason, visible back
 * to the supplier in their Review tab so they can correct and resubmit.
 */
router.put('/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || !reason.trim())
      return res.status(400).json({ message: 'A rejection reason is required.' });

    const row = await SupplierProduct.findByIdAndUpdate(
      req.params.id,
      { status: 'rejected', rejectionReason: reason.trim(), reviewedBy: req.user.id, reviewedAt: new Date() },
      { new: true }
    );
    if (!row) return res.status(404).json({ message: 'Submission not found.' });

    logger.info('Supplier product rejected', { supplierProductId: row._id, rejectedBy: req.user.id });
    res.json({ message: 'Product rejected. Supplier will be able to review and resubmit.', product: row });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;