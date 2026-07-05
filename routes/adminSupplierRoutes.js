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

// ─── GET /api/admin/supplier-products/pending ─────────────────────────────────
router.get('/pending', async (req, res) => {
  try {
    const rows = await SupplierProduct.find({ status: 'pending' })
      .populate('supplier', 'name email supplierCompanyName')
      .sort({ createdAt: 1 })
      .lean();
    res.json(rows);
  } catch (err) {
    logger.error('Failed to fetch pending supplier products', { error: err.message });
    res.status(500).json({ message: err.message });
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
      videoUrl: row.videoUrl,
    });
    await product.save();

    logger.info('Supplier product approved and published', {
      supplierProductId: row._id, newProductId: product._id, approvedBy: req.user.id,
    });

    // CHANGED — no longer deletes the row. It stays visible to the supplier
    // (SupplierPortal.js shows it with an "Approved" badge) and is linked to
    // the live Product so a later deletion can be cascaded back with a reason.
    row.status = 'approved';
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