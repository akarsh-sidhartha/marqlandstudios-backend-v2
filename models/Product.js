const mongoose = require('mongoose');

// Background OneDrive upload of a new video file. The product keeps
// playing its current video until the job finishes and swaps it in.
const videoUploadSchema = new mongoose.Schema({
  status: { type: String, enum: ['idle', 'processing', 'failed'], default: 'idle' },
  jobId: { type: String, default: '' },
  fileName: { type: String, default: '' },
  error: { type: String, default: '' },
  updatedAt: { type: Date, default: null },
}, { _id: false });

const productSchema = new mongoose.Schema({
  brand: { type: String, required: true },
  category: { type: String, required: true },
  subCategory: { type: String, required: false },
  name: { type: String, required: true },
  description: String,
  purchasePrice: { type: Number, required: true },
  markupPercent: { type: Number, default: 10 },
  imageUrl: String,
  sellingPrice: { type: Number, required: true }, // while partner uploads the product.
  // Additional product angles / lifestyle shots sourced from reverse image search
  // or manually uploaded. Stored as local /uploads/... paths (downloaded + saved).
  additionalImages: {
    type: [String],
    default: [],
  },
  imageKey: { type: String, default: '' },   // R2 key: "website/internalApp/products/uuid.webp"
  additionalImageKeys: { type: [String], default: [] }, // R2 keys for gallery images

  // ── Product video ─────────────────────────────────────────────────────────
  // videoSource decides which of the fields below is the live video:
  //   'link'   → videoUrl (YouTube / YouTube Shorts / brand video URL)
  //   'upload' → a file on OneDrive (videoOneDriveItemId). Played through a
  //              short-lived URL from GET /api/v2/products/:id/video-stream
  //              (admin) or /api/portal/public/:slug/products/:id/video-stream
  //              (client portal) — never stored, because it expires.
  //   ''       → legacy rows: treated as 'link' when videoUrl is set.
  videoSource: { type: String, enum: ['', 'link', 'upload'], default: '' },
  videoUrl: {
    type: String,
    default: '',
  },
  videoOneDriveItemId: { type: String, default: '' },
  videoOneDrivePath: { type: String, default: '' },
  videoFileName: { type: String, default: '' },
  videoUpload: { type: videoUploadSchema, default: () => ({}) },

  // Set when the product came from a Partner submission — lets the
  // partner keep editing it after approval (see routes/v2/supplierProductRoutes.js).
  supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  lastEditedBy: {
    userId: { type: String, default: '' },
    role: { type: String, default: '' },
    at: { type: Date, default: null },
  },
}, { timestamps: true });

// Category-first browsing (GET /api/v2/products?category=…) and the
// category summary aggregation both lean on these.
productSchema.index({ category: 1, updatedAt: -1 });
productSchema.index({ category: 1, subCategory: 1 });
productSchema.index({ brand: 1 });
productSchema.index({ updatedAt: -1 });

module.exports = mongoose.model('Product', productSchema);
