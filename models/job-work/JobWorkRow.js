'use strict';
/**
 * models/JobWorkRow.js
 *
 * One row = one unit of job work submitted by a "jobWork" vendor.
 * Lifecycle: ongoing -> completed (admin approves) -> archive (2 months after
 * completedAt, moved automatically by services/jobWorkLifecycleService.js)
 * -> deleted (1 year after archivedAt, same service).
 *
 * A row can only be edited/deleted by its owning vendor while status is
 * 'ongoing' — enforced in routes/jobWorkVendorRoutes.js, not here.
 *
 * totalAmount is always computed server-side (quantity * pricePerUnit *
 * (1 + gstRate/100)) — never trust a client-supplied total.
 */
const mongoose = require('mongoose');

const jobWorkImageSchema = new mongoose.Schema({
  filename:      { type: String, required: true },
  url:           { type: String, required: true },   // OneDrive webUrl
  oneDriveItemId:{ type: String, default: '' },
  mimeType:      { type: String, default: 'application/octet-stream' },
  size:          { type: Number, default: 0 },
  uploadedAt:    { type: Date, default: Date.now },
}, { _id: true });

const jobWorkCommentSchema = new mongoose.Schema({
  text:   { type: String, required: true },
  byUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  byName: { type: String, default: '' },
  at:     { type: Date, default: Date.now },
}, { _id: false });

const jobWorkRowSchema = new mongoose.Schema({
  vendor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },

  // Human-readable serial, e.g. "JW/25-26/0001" — generated server-side via
  // utils/jobWorkSerial.js, also used as the OneDrive folder name suffix.
  serialId: { type: String, required: true, unique: true },

  description: { type: String, required: true, trim: true },
  quantity:    { type: Number, required: true, min: 0 },
  pricePerUnit:{ type: Number, required: true, min: 0 },
  gstRate:     { type: Number, default: 18 },
  totalAmount: { type: Number, required: true, min: 0 }, // server-computed

  images: { type: [jobWorkImageSchema], default: [] },

  status: {
    type: String,
    enum: ['ongoing', 'completed', 'archive'],
    default: 'ongoing',
    index: true,
  },

  // Latest admin comment shown to the vendor (row stays 'ongoing' when set).
  adminComment: { type: String, default: '' },
  commentHistory: { type: [jobWorkCommentSchema], default: [] },

  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  approvedAt: { type: Date, default: null },

  // Drives the automatic ongoing/completed -> archive -> delete lifecycle.
  completedAt: { type: Date, default: null },
  archivedAt:  { type: Date, default: null },

  // OneDrive folder for this row's images — stored so deletes/uploads never
  // need to re-walk the folder path (same pattern as models/Vendor.js).
  oneDriveFolderId:   { type: String, default: '' },
  oneDriveFolderPath: { type: [String], default: [] },
}, { timestamps: true });

jobWorkRowSchema.index({ vendor: 1, status: 1 });
jobWorkRowSchema.index({ status: 1, completedAt: 1 });
jobWorkRowSchema.index({ status: 1, archivedAt: 1 });
jobWorkRowSchema.index({ description: 'text' });

module.exports = mongoose.model('JobWorkRow', jobWorkRowSchema);
