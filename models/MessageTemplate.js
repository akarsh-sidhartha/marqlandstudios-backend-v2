const mongoose = require('mongoose');

/**
 * backend/models/MessageTemplate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reusable "canned statement" templates shown in the Timeline composer's
 * Quick Statement dropdown (see OrderTimeline.js). Staff manage these via
 * the Manage Statements modal (MessageTemplateManager.js).
 *
 * `status` mirrors the timeline event statuses so the composer can filter
 * templates down to the ones relevant to whatever status is selected.
 * `order` controls display order within a status group (lower = higher up);
 * ties break by createdAt.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const messageTemplateSchema = new mongoose.Schema({
  status: { type: String, enum: ['inquiry', 'ongoing', 'completed', 'update'], default: 'update' },
  text:   { type: String, required: true, trim: true },
  order:  { type: Number, default: 0 },
}, {
  timestamps: true,
});

messageTemplateSchema.index({ status: 1, order: 1 });

module.exports = mongoose.model('MessageTemplate', messageTemplateSchema);