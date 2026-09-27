'use strict';
/**
 * models/Job.js
 *
 * Durable background job record — the backing store for lib/jobs/jobQueue.js.
 * One document per unit of long-running work (OneDrive video upload, image
 * import, …). The API answers 202 with the job id straight away; the front
 * end polls GET /api/v2/jobs/:id until status is 'completed' or 'failed'.
 *
 * Lifecycle:
 *   queued ──claim──▶ running ──ok──▶ completed
 *      ▲                 │
 *      └──retry (backoff)┤
 *                        └──attempts exhausted / permanent error──▶ failed
 *   queued ──cancel──▶ cancelled
 *
 * Why MongoDB and not Redis/BullMQ: this API already depends on Atlas and
 * runs as a single instance, so a Mongo-backed queue adds durability,
 * retries and visibility with zero new infrastructure. The queue API
 * (enqueue / registerHandler) is deliberately BullMQ-shaped so it can be
 * swapped for a Redis-backed implementation later without touching callers.
 */
const mongoose = require('mongoose');

const FINAL_STATUSES = ['completed', 'failed', 'cancelled'];

const jobSchema = new mongoose.Schema({
  type: { type: String, required: true, index: true },
  status: {
    type: String,
    enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
    default: 'queued',
    index: true,
  },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  error: {
    message: { type: String, default: '' },
    code: { type: String, default: '' },
    retryable: { type: Boolean, default: false },
  },
  progress: {
    percent: { type: Number, default: 0 },
    stage: { type: String, default: 'queued' },
    message: { type: String, default: '' },
  },
  // Short human label shown in the front-end task tray.
  title: { type: String, default: '' },

  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  runAt: { type: Date, default: Date.now },

  // Lease — a worker owns a running job until lockedUntil; a crashed
  // worker's job is picked up again once the lease expires.
  lockedBy: { type: String, default: null },
  lockedUntil: { type: Date, default: null },

  // Jobs whose input lives on this server's local disk (a staged video
  // upload) can only be run by the instance that holds the file.
  pinnedHost: { type: String, default: null },

  owner: {
    userId: { type: String, default: null, index: true },
    role: { type: String, default: null },
  },
  // Front-end supplied Idempotency-Key — enqueueing twice with the same key
  // returns the existing job instead of doing the work again.
  idempotencyKey: { type: String, default: undefined },

  // What the job acts on — lets the UI show "video processing" on a product card.
  resource: {
    kind: { type: String, default: '' },
    id: { type: String, default: '' },
  },

  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  // Finished jobs are purged by the TTL index after a week.
  expiresAt: { type: Date, default: null },
}, { timestamps: true });

jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index({ status: 1, lockedUntil: 1 });
jobSchema.index({ 'resource.kind': 1, 'resource.id': 1, createdAt: -1 });
jobSchema.index({ 'owner.userId': 1, idempotencyKey: 1 }, {
  unique: true,
  partialFilterExpression: { idempotencyKey: { $type: 'string' } },
});
jobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

jobSchema.statics.FINAL_STATUSES = FINAL_STATUSES;

jobSchema.methods.toClient = function toClient() {
  return {
    id: String(this._id),
    type: this.type,
    title: this.title,
    status: this.status,
    isFinal: FINAL_STATUSES.includes(this.status),
    progress: this.progress,
    attempts: this.attempts,
    maxAttempts: this.maxAttempts,
    nextAttemptAt: this.status === 'queued' && this.attempts > 0 ? this.runAt : null,
    result: this.status === 'completed' ? this.result : null,
    error: this.status === 'failed' || this.attempts > 0 ? (this.error?.message ? this.error : null) : null,
    resource: this.resource,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
    finishedAt: this.finishedAt,
  };
};

module.exports = mongoose.model('Job', jobSchema);
