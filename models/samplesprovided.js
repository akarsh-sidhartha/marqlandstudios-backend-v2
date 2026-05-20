'use strict';
/**
 * backend/models/samplesprovided.js
 *
 * CHANGES FROM ORIGINAL:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. SampleItemSchema.image: String  (base64 stored in MongoDB)
 *    → imageUrl: { type: String, default: '' }   R2 https:// URL
 *      imageKey: { type: String, default: '' }   R2 key for deletion
 *    Legacy `image` field kept as { select: false } for backward compat — never returned.
 *
 * 2. dcAttachments[].data: String  (base64 stored in MongoDB)
 *    → url:     { type: String, default: '' }    R2/OneDrive https:// URL
 *      key:     { type: String, default: '' }    storage key for deletion
 *      storage: { type: String }                 'r2' | 'onedrive'
 *    Legacy `data` field kept as { select: false } for backward compat — never returned.
 *
 * MIGRATION: existing documents with base64 in `image` / `data` fields will
 * continue to load fine — those fields are just excluded from query results.
 * New documents will use imageUrl / url instead.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const mongoose = require('mongoose');

const SampleItemSchema = new mongoose.Schema({
  id:              String,
  name:            { type: String, required: true },
  qtySent:         { type: Number, default: 0 },
  qtyReturned:     { type: Number, default: 0 },
  qtyMissing:      { type: Number, default: 0 },
  writeOffRemarks: { type: String, default: '' },
  status:          { type: String, default: 'pending' },

  // ── Cloud image storage ──────────────────────────────────────────────────────
  // Image uploaded to R2: website/internalApp/portal/{uuid}.webp
  imageUrl: { type: String, default: '' },  // R2 https:// URL
  imageKey: { type: String, default: '' },  // R2 key for deletion

  // Legacy base64 (deprecated — select: false keeps it out of all queries)
  image: { type: String, select: false },
});

const dcAttachmentSchema = new mongoose.Schema({
  name: { type: String },
  type: { type: String },  // mimeType
  size: { type: String },

  // ── Cloud file storage ───────────────────────────────────────────────────────
  // Images → R2 /website/internalApp/portal/
  // PDFs/docs → OneDrive /website/uploads/files/
  url:     { type: String, default: '' },    // R2 or OneDrive https:// URL
  key:     { type: String, default: '' },    // storage key for deletion
  storage: { type: String, default: '' },    // 'r2' | 'onedrive'

  // Legacy base64 (deprecated — select: false keeps it out of all queries)
  data: { type: String, select: false },
}, { _id: false });

const ChallanSchema = new mongoose.Schema({
  challanNumber: { type: String, required: true, unique: true },
  clientName:    { type: String, required: true },
  orderedBy:     { type: String },
  description:   { type: String },
  date:          { type: Date, default: Date.now },
  samples:       [SampleItemSchema],
  dcAttachments: [dcAttachmentSchema],
  totalItems:    Number,
  status: {
    type:    String,
    enum:    ['open', 'settled', 'archived'],
    default: 'open',
  },
  settledAt: Date,
}, { timestamps: true });

module.exports = mongoose.model('Challan', ChallanSchema);