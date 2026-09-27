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

  // Either a pasted URL (YouTube etc.) OR an uploaded file on OneDrive.
  // videoSource says which one is live ('' on legacy rows = infer from the
  // populated field). Uploaded files are sent to OneDrive by a background
  // job; videoUpload tracks that job so the portal can show its progress.
  videoSource: { type: String, enum: ['', 'link', 'upload'], default: '' },
  videoUrl: { type: String, default: '' },
  videoOneDrivePath: { type: String, default: '' },
  videoOneDriveItemId: { type: String, default: '' },
  videoFileName: { type: String, default: '' },
  videoUpload: {
    status: { type: String, enum: ['idle', 'processing', 'failed'], default: 'idle' },
    jobId: { type: String, default: '' },
    fileName: { type: String, default: '' },
    error: { type: String, default: '' },
    updatedAt: { type: Date, default: null },
  },

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

  // ── Edits to an APPROVED (live) product ─────────────────────────────────
  // A partner's change to a live product does not touch the catalogue
  // straight away. The proposed version is kept here and goes through the
  // same admin approval queue; the live Product (and every client portal
  // showing it) keeps the approved version until the change is approved.
  //   revisionStatus 'pending'  → waiting for admin review
  //                  'rejected' → admin rejected it (revisionRejectionReason)
  //                  'none'     → no outstanding change
  pendingRevision: {
    type: new mongoose.Schema({
      brand: { type: String, default: '' },
      name: { type: String, default: '' },
      description: { type: String, default: '' },
      sellingPrice: { type: Number, default: 0 },
      imageUrl: { type: String, default: '' },
      imageKey: { type: String, default: '' },
      additionalImages: { type: [String], default: [] },
      additionalImageKeys: { type: [String], default: [] },
      videoSource: { type: String, enum: ['', 'link', 'upload'], default: '' },
      videoUrl: { type: String, default: '' },
      videoOneDriveItemId: { type: String, default: '' },
      videoOneDrivePath: { type: String, default: '' },
      videoFileName: { type: String, default: '' },
    }, { _id: false }),
    default: null,
  },
  revisionStatus: { type: String, enum: ['none', 'pending', 'rejected'], default: 'none', index: true },
  revisionRejectionReason: { type: String, default: '' },
  revisionSubmittedAt: { type: Date, default: null },

  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },

  // Set when a row is approved and converted — kept briefly for audit/debug
  // before the row is removed; not relied upon since row is deleted on approve.
  convertedProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
}, { timestamps: true });

supplierProductSchema.index({ supplier: 1, status: 1 });
supplierProductSchema.index({ supplier: 1, updatedAt: -1 });
supplierProductSchema.index({ convertedProductId: 1 });

module.exports = mongoose.model('SupplierProduct', supplierProductSchema);