'use strict';
/**
 * models/paymentTrackerModel.js
 * ─────────────────────────────────────────────────────────────────────────────
 * MERGED: absorbs models/Invoice.js (the old invoice vault model).
 *
 * CHANGES FROM ORIGINAL:
 * 1. InvoiceSchema moved here from models/Invoice.js — identical fields,
 *    adds `downloadUrl` field alongside existing `oneDriveUrl` (webUrl).
 *    downloadUrl is used for inline display; oneDriveUrl for opening OneDrive.
 *
 * 2. ProformaInvoice: `attachment` fields upgraded —
 *      attachmentUrl   now stores webUrl (OneDrive viewer)    [was already there]
 *      attachmentDownloadUrl  NEW — proxied download URL for inline display
 *    Legacy base64 `attachment` field kept for backward compat (select: false).
 *
 * 3. Payment: `screenshot` fields upgraded —
 *      screenshotUrl   now stores webUrl                      [was already there]
 *      screenshotDownloadUrl  NEW — proxied download URL for inline display
 *    Legacy base64 `screenshot` field kept for backward compat (select: false).
 *
 * MIGRATION: models/Invoice.js can be deleted once all imports are updated.
 * In the meantime, Invoice.js can safely re-export from here:
 *   module.exports = require('./paymentTrackerModel').Invoice;
 * ─────────────────────────────────────────────────────────────────────────────
 */

const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────────────
// INVOICE VAULT SCHEMA (merged from models/Invoice.js)
// ─────────────────────────────────────────────────────────────────────────────

const InvoiceSchema = new mongoose.Schema({
  // Vendor Identity
  vendor_name: { type: String, default: 'Unknown Vendor' },
  vendor_gst:  { type: String, default: '' },

  // Invoice Specifics
  invoice_number: { type: String, default: '---' },
  date:           { type: String },
  currency:       { type: String, default: 'INR' },

  // Financial Breakdown
  total_amount: { type: Number, default: 0 },
  cgst:         { type: Number, default: 0 },
  sgst:         { type: Number, default: 0 },
  igst:         { type: Number, default: 0 },
  tax_amount:   { type: Number, default: 0 },

  // Organisation/Filing
  financialYear: { type: String },   // e.g. "2025-26"
  month:         { type: String },   // e.g. "August"

  // ── OneDrive storage ────────────────────────────────────────────────────────
  // Stored at: OneDrive/website/Invoices/{FY}/{Month}/{filename}
  oneDriveFileId:      { type: String, default: '' },
  oneDriveUrl:         { type: String, default: '' },  // webUrl  — opens OneDrive viewer
  oneDriveDownloadUrl: { type: String, default: '' },  // NEW: proxied via /invoices/:id/file
  fileName:            { type: String, default: '' },

  // Source
  receivedVia: { type: String, default: 'manual' }, // 'whatsapp' | 'outlook' | 'manual'
  notes:       { type: String, default: '' },

  // Optional line items
  items: [{
    description: String,
    quantity:    Number,
    total:       Number,
  }],

  // ── Legacy base64 (deprecated — backward compat only, never returned) ───────
  image:    { type: String, select: false },
  mimeType: { type: String, default: 'image/jpeg' },

  createdAt: { type: Date, default: Date.now },
});

InvoiceSchema.index({ createdAt: -1 });
InvoiceSchema.index({ financialYear: 1, month: 1, createdAt: -1 });
InvoiceSchema.index({ vendor_gst: 1, invoice_number: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// PROFORMA INVOICE SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

const proformaInvoiceSchema = new mongoose.Schema(
  {
    piNumber:   { type: String, required: true, unique: true, trim: true },
    vendor:     { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    piDate:     { type: Date, required: true },
    dueDate:    { type: Date },
    items: [
      {
        description: { type: String, trim: true },
        quantity:    { type: Number, default: 1 },
        unitPrice:   { type: Number, default: 0 },
        amount:      { type: Number, default: 0 },
      },
    ],
    totalAmount: { type: Number, required: true, min: 0 },
    currency:    { type: String, default: 'INR' },
    bankDetails: { type: String, trim: true },
    notes:       { type: String, trim: true },
    amountPaid:  { type: Number, default: 0 },
    amountDue:   { type: Number, default: 0 },
    status: {
      type:    String,
      enum:    ['pending', 'partial', 'fully_paid', 'invoiced', 'cancelled'],
      default: 'pending',
    },
    finalInvoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },

    // ── OneDrive PI attachment ─────────────────────────────────────────────────
    // Stored at: OneDrive/website/PI-Attachments/{piNumber}/{filename}
    attachmentFileId:      { type: String, default: '' },
    attachmentUrl:         { type: String, default: '' },  // webUrl — OneDrive viewer
    attachmentDownloadUrl: { type: String, default: '' },  // NEW: proxied via /pi/:id/attachment
    attachmentName:        { type: String, default: '' },
    attachmentMime:        { type: String, default: '' },  // NEW: needed for inline rendering

    // Legacy base64 (deprecated — select: false keeps it out of all queries)
    attachment: { type: String, select: false },
  },
  { timestamps: true }
);

proformaInvoiceSchema.pre('save', function () {
  this.amountDue = Math.max(0, this.totalAmount - this.amountPaid);
  // Only auto-set payment-driven states; preserve 'invoiced' and 'cancelled'
  if (this.status === 'invoiced' || this.status === 'cancelled') return;
  if (this.amountPaid <= 0)    this.status = 'pending';
  else if (this.amountDue > 0) this.status = 'partial';
  else                          this.status = 'fully_paid';
});

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

const paymentSchema = new mongoose.Schema(
  {
    paymentRef:  { type: String, required: true, unique: true, trim: true },
    vendor:      { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
    paymentDate: { type: Date, required: true },
    amount:      { type: Number, required: true, min: 0.01 },
    currency:    { type: String, default: 'INR' },
    paymentMode: {
      type:    String,
      enum:    ['neft', 'rtgs', 'imps', 'upi', 'cheque', 'cash', 'other'],
      default: 'other',
    },
    bankRef:  { type: String, trim: true },
    remarks:  { type: String, trim: true },
    mappedTo: {
      type:    String,
      enum:    ['proforma_invoice', 'vendor_invoice', 'advance'],
      default: 'advance',
    },
    proformaInvoice: { type: mongoose.Schema.Types.ObjectId, ref: 'ProformaInvoice', default: null },
    vendorInvoice:   { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice',         default: null },
    status: {
      type:    String,
      enum:    ['recorded', 'verified', 'reconciled'],
      default: 'recorded',
    },

    // ── OneDrive payment screenshot ────────────────────────────────────────────
    // Stored at: OneDrive/website/Payments/{paymentRef}/{filename}
    screenshotFileId:      { type: String, default: '' },
    screenshotUrl:         { type: String, default: '' },  // webUrl — OneDrive viewer
    screenshotDownloadUrl: { type: String, default: '' },  // NEW: proxied via /payments/:id/screenshot
    screenshotName:        { type: String, default: '' },
    screenshotMime:        { type: String, default: '' },  // NEW: needed for inline rendering

    // Legacy base64 (deprecated — select: false keeps it out of all queries)
    screenshot:     { type: String, select: false },
    screenshotMime_legacy: { type: String, select: false }, // avoid field name collision
  },
  { timestamps: true }
);

// ─────────────────────────────────────────────────────────────────────────────
// VENDOR INVOICE SCHEMA (internal)
// ─────────────────────────────────────────────────────────────────────────────

const vendorInvoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, trim: true },
    vendor:        { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    invoiceDate:   { type: Date, required: true },
    receivedDate:  { type: Date, default: Date.now },
    items: [
      {
        description: { type: String, trim: true },
        quantity:    { type: Number, default: 1 },
        unitPrice:   { type: Number, default: 0 },
        amount:      { type: Number, default: 0 },
      },
    ],
    totalAmount: { type: Number, required: true, min: 0 },
    currency:    { type: String, default: 'INR' },
    payments:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'Payment' }],
    proformaInvoice: { type: mongoose.Schema.Types.ObjectId, ref: 'ProformaInvoice', default: null },
    amountPaid:  { type: Number, default: 0 },
    amountDue:   { type: Number, default: 0 },
    status: {
      type:    String,
      enum:    ['pending', 'partial', 'paid', 'overdue'],
      default: 'pending',
    },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

vendorInvoiceSchema.pre('save', function () {
  this.amountDue = Math.max(0, this.totalAmount - this.amountPaid);
  if (this.amountPaid <= 0)    this.status = 'pending';
  else if (this.amountDue > 0) this.status = 'partial';
  else                          this.status = 'paid';
});

// ── Indexes ───────────────────────────────────────────────────────────────────
proformaInvoiceSchema.index({ createdAt: -1 });
proformaInvoiceSchema.index({ vendor: 1, status: 1 });
paymentSchema.index({ paymentDate: -1 });
paymentSchema.index({ vendor: 1, paymentDate: -1 });

// ── Exports ───────────────────────────────────────────────────────────────────
const Invoice        = mongoose.model('Invoice',        InvoiceSchema);
const ProformaInvoice = mongoose.model('ProformaInvoice', proformaInvoiceSchema);
const Payment        = mongoose.model('Payment',        paymentSchema);
const VendorInvoice  = mongoose.model('VendorInvoice',  vendorInvoiceSchema);

module.exports = { Invoice, ProformaInvoice, Payment, VendorInvoice };