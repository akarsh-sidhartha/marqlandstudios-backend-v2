'use strict';
/**
 * models/IdempotencyRecord.js
 *
 * Remembers the response to a mutating /api/v2 request sent with an
 * Idempotency-Key header, so a retried request (network drop, double
 * click, automatic client retry) replays the original response instead of
 * creating a second product / second upload. Records expire after 24h.
 * See middleware/idempotency.js.
 */
const mongoose = require('mongoose');

const idempotencyRecordSchema = new mongoose.Schema({
  key: { type: String, required: true },
  userId: { type: String, required: true },
  method: { type: String, required: true },
  path: { type: String, required: true },
  requestHash: { type: String, required: true },
  state: { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
  responseStatus: { type: Number, default: null },
  responseBody: { type: mongoose.Schema.Types.Mixed, default: null },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

idempotencyRecordSchema.index({ userId: 1, key: 1 }, { unique: true });
idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('IdempotencyRecord', idempotencyRecordSchema);
