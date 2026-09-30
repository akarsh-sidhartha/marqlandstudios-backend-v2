const mongoose = require('mongoose');
const { ORDER_STATUSES, ORDER_TYPES, PROCUREMENT_STATUS_VALUES, FILE_CATEGORIES } = require('../lib/orders/orderConstants');

// One file in the order's OneDrive folder. `itemId` is the Graph drive-item id
// (the stable handle for streaming/deleting); `category` groups the file in
// the UI — screenshots and the quote are ordinary files in the same folder.
const attachmentSchema = new mongoose.Schema({
  itemId:       { type: String },
  name:         { type: String },
  type:         { type: String },
  size:         { type: Number },
  lastModified: { type: Number },
  webUrl:       { type: String },
  downloadUrl:  { type: String },
  isOneDrive:   { type: Boolean, default: false },
  category:     { type: String, enum: FILE_CATEGORIES, default: 'attachment' },
  uploadedBy:   { type: String },
  uploadedAt:   { type: Date },
}, { _id: false });

// ── Procurement line items ─────────────────────────────────────────────────
// One row per product to source — seeded from the uploaded quote's item
// table (source: 'quote') or added by hand. statusHistory is the audit trail
// for book-keeping: who moved the item to which stage, and when.
const statusChangeSchema = new mongoose.Schema({
  status: { type: String, enum: PROCUREMENT_STATUS_VALUES, required: true },
  by:     { type: String },
  at:     { type: Date, default: Date.now },
}, { _id: false });

// A vendor picked for an item. The name is copied in so the row still reads
// correctly if the vendor is later renamed or deleted.
const vendorRefSchema = new mongoose.Schema({
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
  name:     { type: String, trim: true },
}, { _id: false });

const procurementItemSchema = new mongoose.Schema({
  lineNo:        { type: Number },
  name:          { type: String, required: true, trim: true, maxlength: 300 },
  details:       { type: String, trim: true, maxlength: 1000, default: '' },
  hsn:           { type: String, trim: true, maxlength: 12 },
  quantity:      { type: Number, min: 0, default: 1 },
  unit:          { type: String, trim: true, maxlength: 20 },
  rate:          { type: Number, min: 0 },
  amount:        { type: Number, min: 0 },
  status:        { type: String, enum: PROCUREMENT_STATUS_VALUES, default: PROCUREMENT_STATUS_VALUES[0] },
  notes:         { type: String, trim: true, maxlength: 2000, default: '' },
  productSupplier: { type: vendorRefSchema, default: null },   // who supplies the product
  brandingPartner: { type: vendorRefSchema, default: null },   // who brands it
  source:        { type: String, enum: ['quote', 'manual'], default: 'manual' },
  statusHistory: { type: [statusChangeSchema], default: [] },
}, { timestamps: true });

// Header fields read off the uploaded quote document.
const quoteDocumentSchema = new mongoose.Schema({
  fileItemId: { type: String },
  fileName:   { type: String },
  quoteDate:  { type: String },
  subject:    { type: String },
  subTotal:   { type: Number },
  total:      { type: Number },
  parsedAt:   { type: Date },
}, { _id: false });

// ── Timeline events ────────────────────────────────────────────────────────
// One entry per staff-posted update. 'status' mirrors the order lifecycle
// statuses plus a generic 'update' for anything that isn't a stage change.
// emailSent/emailError record whether the client notification succeeded,
// so the UI can surface delivery failures without a separate log lookup.
const timelineEventSchema = new mongoose.Schema({
  status:     { type: String, enum: ['inquiry', 'ongoing', 'completed', 'update'], default: 'update' },
  message:    { type: String, required: true },
  postedBy:   { type: String },
  emailSent:  { type: Boolean, default: false },
  emailError: { type: String },
  createdAt:  { type: Date, default: Date.now },
});

// ── Email thread anchor ───────────────────────────────────────────────────
// Set once, when the initial portal email is sent (see /api/portal/send-email).
// Every subsequent timeline-update email reads this to build its
// In-Reply-To / References headers, then appends its own new Message-ID
// to `references` so the next update can chain off of it.
const emailThreadSchema = new mongoose.Schema({
  subject:    { type: String },   // exact subject of the ORIGINAL email — never changes
  messageId:  { type: String },   // Message-ID of the original email
  references: [{ type: String }], // full chain of Message-IDs sent so far, oldest → newest
}, { _id: false });

const orderInquirySchema = new mongoose.Schema({
  title:             { type: String },
  clientName:        { type: String, required: true },
  orderPlacedBy:     { type: String, required: true },
  description:       { type: String },
  refNumber:         { type: String, unique: true, sparse: true }, // permanent INQ identifier — set once at creation, never overwritten
  quoteNumber:       { type: String },                             // ← NEW: set when Start Project assigns a quote (e.g. QT-26-27/0095)
  invoiceNumber:     { type: String },                             // set when the order is marked completed (e.g. INV-26-27/0094)
  status:            { type: String, enum: ORDER_STATUSES, default: 'inquiry' },
  orderType:         { type: String, enum: ORDER_TYPES, default: 'product' },
  attachments:       [attachmentSchema],
  oneDriveFolderUrl: { type: String },
  oneDriveFolderId:  { type: String },                             // cached Graph item id — saves a /shares lookup per file call
  procurementItems:  { type: [procurementItemSchema], default: [] },
  quoteDocument:     quoteDocumentSchema,
  createdBy:         { type: String },
  completedAt:       { type: Date },
  timeline:          [timelineEventSchema], // ← NEW: staff-posted updates shown to the client
  emailThread:       emailThreadSchema,     // ← NEW: anchors threaded reply emails
}, {
  timestamps: true,
});

// Index on updatedAt for efficient sorting — required for Atlas M0 memory limits
orderInquirySchema.index({ updatedAt: -1 });
orderInquirySchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.model('OrderInquiry', orderInquirySchema);