console.log('product model: top of file');
const mongoose = require('mongoose');
console.log('product model: mongoose OK');

const productSchema = new mongoose.Schema({
  brand: { type: String, required: true },
  category: { type: String, required: true },
  subCategory: { type: String, required: false },
  name: { type: String, required: true },
  description: String,
  purchasePrice: { type: Number, required: true },
  markupPercent: { type: Number, default: 10 },
  imageUrl: String,
  // Additional product angles / lifestyle shots sourced from reverse image search
  // or manually uploaded. Stored as local /uploads/... paths (downloaded + saved).
  additionalImages: {
    type: [String],
    default: [],
  },
  imageKey: { type: String, default: '' },   // R2 key: "website/internalApp/products/uuid.webp"
  additionalImageKeys: { type: [String], default: [] }, // R2 keys for gallery images
  // ── NEW: Product video ────────────────────────────────────────────────────
  // YouTube URL, brand video URL, or any embeddable link.
  // Shown as an embedded player in the client portal view.
  videoUrl: {
    type: String,
    default: '',
  },
}, { timestamps: true });

module.exports = mongoose.model('Product', productSchema);