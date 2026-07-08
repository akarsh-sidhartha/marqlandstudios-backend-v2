const mongoose = require('mongoose');

const attachmentSchema = new mongoose.Schema({
  name:         { type: String },
  type:         { type: String },
  size:         { type: Number },
  lastModified: { type: Number },
  webUrl:       { type: String },
  downloadUrl:  { type: String },
  isOneDrive:   { type: Boolean, default: false },
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
  status:            { type: String, enum: ['inquiry', 'ongoing', 'completed'], default: 'inquiry' },
  orderType:         { type: String, enum: ['product', 'offsite'], default: 'product' }, // ← NEW
  attachments:       [attachmentSchema],
  oneDriveFolderUrl: { type: String },
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