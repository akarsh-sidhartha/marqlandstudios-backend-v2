'use strict';
/**
 * controllers/v2/uploadController.js — resumable chunked uploads.
 *
 *   POST   /api/v2/uploads                  start   → 201 { uploadId, chunkSize, receivedBytes }
 *   GET    /api/v2/uploads/:id              status  → how many bytes the server holds (resume point)
 *   PUT    /api/v2/uploads/:id/chunks?offset=N   raw bytes → 200 { receivedBytes }
 *   POST   /api/v2/uploads/:id/complete     → 202 { jobId, statusUrl }  (OneDrive upload runs in background)
 *   DELETE /api/v2/uploads/:id              cancel
 */
const Job = require('../../models/Job');
const sessions = require('../../services/media/uploadSessionService');
const { ok, created, accepted } = require('../../lib/http/apiResponse');

const start = async (req, res) => created(res, (await sessions.create(req.user, req.body)).toClient());

const status = async (req, res) => ok(res, (await sessions.findOwned(req.params.id, req.user)).toClient());

const chunk = async (req, res) => {
  const session = await sessions.writeChunk(req.user, req.params.id, req.query.offset, req.body);
  ok(res, { uploadId: String(session._id), receivedBytes: session.receivedBytes, totalBytes: session.totalBytes });
};

const complete = async (req, res) => {
  const { session, job, jobId } = await sessions.complete(req.user, req.params.id, {
    idempotencyKey: req.get('Idempotency-Key') || undefined,
  });
  if (job) return accepted(res, job, { upload: session.toClient() });
  // Replayed /complete — the job already exists.
  const existing = await Job.findById(jobId);
  return accepted(res, existing || { id: jobId, status: 'queued' }, { upload: session.toClient() });
};

const abort = async (req, res) => ok(res, (await sessions.abort(req.user, req.params.id)).toClient());

module.exports = { start, status, chunk, complete, abort };
