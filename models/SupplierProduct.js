/**
 * models/SupplierProduct.js
 *
 * Staging collection for products submitted by Suppliers via the Partner Portal.
 * Rows here are NEVER shown in the main product catalogue directly — an admin
 * must review + approve, at which point a real `Product` document is created
 * (see routes/adminSupplierRoutes.js → PUT /:id/approve) and this row is deleted.
 *
 * Lifecycle: pending -> approved (stays visible in supplier's list, status
 *                                  flips to 'approved'; a live Product is created
 *                                  and linked via convertedProductId)
 *                    -> rejected (stays visible to supplier w/ rejectionReason,
 *                                  supplier can edit + resubmit -> back to pending)
 *                    -> deleted  (an admin later removed the live Product from
 *                                  the catalogue — see productRoutes.js DELETE
 *                                  /:id — deletionReason is shown to the supplier)
 */
const mongoose = require('mongoose');

const supplierProductSchema = new mongoose.Schema({
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  brand: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, required: true },

  // Primary image — R2 key + public url (same pattern as Product.imageUrl/imageKey)
  imageUrl: { type: String, default: '' },
  imageKey: { type: String, default: '' },

  // Secondary angles / gallery
  additionalImages: { type: [String], default: [] },
  additionalImageKeys: { type: [String], default: [] },

  // Either a pasted URL (YouTube etc.) OR an uploaded file path on OneDrive.
  // Only one will typically be populated.
  videoUrl: { type: String, default: '' },
  videoOneDrivePath: { type: String, default: '' },

  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'deleted'],
    default: 'pending',
    index: true,
  },

  // Populated by admin when rejecting — shown back to the supplier so they
  // know what to fix before resubmitting.
  rejectionReason: { type: String, default: '' },

  // NEW — populated when an admin later deletes the live Product this row
  // was converted into. Shown to the supplier in "Review My Products" so
  // they understand why it disappeared from the catalogue.
  deletionReason: { type: String, default: '' },

  // Populated by admin at approval time; copied onto the resulting Product.
  category: { type: String, default: '' },
  subCategory: { type: String, default: '' },

  // NEW — the price the supplier suggests when submitting; admin can accept
  // or override this when approving (see adminSupplierRoutes.js /approve,
  // and PendingSupplierApprovals.js, which prefills from this value).
  sellingPrice: { type: Number, default: 0 },

  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },

  // Set when a row is approved and converted — kept briefly for audit/debug
  // before the row is removed; not relied upon since row is deleted on approve.
  convertedProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
}, { timestamps: true });

supplierProductSchema.index({ supplier: 1, status: 1 });

module.exports = mongoose.model('SupplierProduct', supplierProductSchema);