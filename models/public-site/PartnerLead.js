/**
 * models/public-site/PartnerLead.js
 *
 * Captures the "Partner" tab registration form on www.marqlandstudios.com —
 * this is a lightweight interest form, NOT the actual Supplier account.
 * An admin reviews these under AdminView.js -> Partner tab, and if interested,
 * sends a normal employee-style invite (User.role = 'supplier' on approval)
 * to actually onboard them into the Supplier Portal.
 */
const mongoose = require('mongoose');

const partnerLeadSchema = new mongoose.Schema({
  companyName: { type: String, required: true, trim: true },
  contactName: { type: String, required: true, trim: true },
  email:       { type: String, required: true, trim: true, lowercase: true },
  phone:       { type: String, default: '' },
  website:     { type: String, default: '' },
  productCategories: { type: String, default: '' }, // free text — what they sell
  message:     { type: String, default: '' },
  // NEW — path of the uploaded Catalog/Portfolio file on OneDrive, if provided.
  // Same convention as supplier product videos: development/website -> supplier folder -> {companyName}
  attachmentOneDrivePath: { type: String, default: '' },
  attachmentWebUrl: { type: String, default: '' }, // browser-viewable OneDrive link, for AdminView.js
  status: {
    type: String,
    enum: ['new', 'contacted', 'invited', 'declined'],
    default: 'new',
  },
  read: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('PartnerLead', partnerLeadSchema);