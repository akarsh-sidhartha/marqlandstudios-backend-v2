const mongoose = require('mongoose');

const vendorMediaSchema = new mongoose.Schema({
  name: { type: String, required: true },   // original filename
  url: { type: String, required: true },   // /uploads/vendors/...
  mimeType: { type: String, default: 'application/octet-stream' },
  size: { type: Number, default: 0 },
  label: { type: String, default: '' },      // optional note e.g. "Product Catalogue 2024"
  uploadedAt: { type: Date, default: Date.now },
}, { _id: true });

const vendorSchema = new mongoose.Schema({
  companyName: { type: String, required: true },
  state: { type: String },
  suppliedProducts: { type: String },
  category: { type: String },
  description: String,
  gstNumber: { type: String, default: "" },
  contacts: [{
    name: String,
    phone: String,
    email: String,
  }],
  key: { type: String, default: '' },    // R2 key or OneDrive path — for deletion
  storage: { type: String, enum: ['r2', 'onedrive', 'local'], default: 'local' },
  // Images, PDFs, documents, video recordings about this vendor
  media: [vendorMediaSchema],
}, { timestamps: true });

module.exports = mongoose.model('Vendor', vendorSchema);