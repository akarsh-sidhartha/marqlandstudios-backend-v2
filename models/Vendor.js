const mongoose = require('mongoose');

const vendorMediaSchema = new mongoose.Schema({
  name:       { type: String, required: true },   // original filename
  url:        { type: String, required: true },    // full https:// cloud URL
  key:        { type: String, default: '' },       // R2 key or OneDrive path — for deletion
  storage:    { type: String, enum: ['r2', 'onedrive', 'local'], default: 'local' },
  mimeType:   { type: String, default: 'application/octet-stream' },
  size:       { type: Number, default: 0 },
  label:      { type: String, default: '' },       // optional note e.g. "Product Catalogue 2024"
  uploadedAt: { type: Date, default: Date.now },
}, { _id: true });

const vendorSchema = new mongoose.Schema({
  companyName:      { type: String, required: true },
  state:            { type: String },
  city:             { type: String },
  suppliedProducts: { type: String },
  category:         { type: String },
  subCategory:      { type: String, default: '' },
  description:      String,
  gstNumber:        { type: String, default: '' },

  // ── Feature 1: Preferred Vendor flag ────────────────────────────────────────
  isPreferred:      { type: Boolean, default: false },

  // ── Feature 2: Vendor website for menu/service extraction ───────────────────
  websiteUrl:       { type: String, default: '' },

  contacts: [{
    name:  String,
    phone: String,
    email: String,
  }],

  // Images, PDFs, documents, video recordings about this vendor
  // ── Feature 3: All attachments are stored in OneDrive under the vendor's
  //    folder. The onedriveFolderId is persisted so we can always delete the
  //    whole folder when the vendor is deleted, without a path look-up.
  onedriveFolderId: { type: String, default: '' },   // OneDrive item ID of vendor folder
  onedriveFolderUrl:{ type: String, default: '' },   // browser webUrl of vendor folder
  media: [vendorMediaSchema],

}, { timestamps: true });

module.exports = mongoose.model('Vendor', vendorSchema);