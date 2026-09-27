'use strict';
/**
 * controllers/v2/jobController.js — background task status for the front ends.
 *
 *   GET  /api/v2/jobs/:id            one job (poll until isFinal)
 *   GET  /api/v2/jobs?ids=a,b,c      several at once (the task tray polls with one request)
 *   GET  /api/v2/jobs?resourceKind=product&resourceId=…&active=true
 *   POST /api/v2/jobs/:id/retry      re-queue a failed job
 *   POST /api/v2/jobs/:id/cancel     cancel a job that hasn't started
 *
 * Users only ever see their own jobs; admins can see all.
 */
const Job = require('../../models/Job');
const AppError = require('../../lib/errors/AppError');
const jobQueue = require('../../lib/jobs/jobQueue');
const { ok } = require('../../lib/http/apiResponse');

const scope = (user) => (user.role === 'admin' ? {} : { 'owner.userId': String(user.id) });

// Partners only ever see neutral wording — internal errors can name storage
// providers or infrastructure. Errors raised deliberately for the user are kept.
const USER_FACING_CODES = new Set(['UPLOAD_FILE_MISSING', 'TARGET_DELETED']);
const view = (job, user) => {
  const out = job.toClient();
  if (user.role === 'supplier' && out.error && !USER_FACING_CODES.has(out.error.code)) {
    out.error = { ...out.error, message: out.status === 'failed'
      ? 'The video could not be processed. Please try again.'
      : 'Having trouble processing the video — retrying automatically.' };
  }
  if (user.role === 'supplier' && out.result) out.result = { fileName: out.result.fileName, pendingApproval: out.result.pendingApproval };
  return out;
};

const findVisible = async (id, user) => {
  const job = await Job.findOne({ _id: id, ...scope(user) });
  if (!job) throw AppError.notFound('Task not found.');
  return job;
};

const getOne = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  ok(res, view(await findVisible(req.params.id, req.user), req.user));
};

const list = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const filter = { ...scope(req.user) };
  if (req.query.ids) {
    const ids = req.query.ids.split(',').filter((id) => /^[0-9a-fA-F]{24}$/.test(id)).slice(0, 50);
    filter._id = { $in: ids };
  }
  if (req.query.resourceKind && req.query.resourceId) {
    filter['resource.kind'] = req.query.resourceKind;
    filter['resource.id'] = req.query.resourceId;
  }
  if (req.query.active === 'true') filter.status = { $in: ['queued', 'running'] };
  if (!req.query.ids && !req.query.resourceId && req.query.active !== 'true') {
    throw AppError.badRequest('Pass ids, a resource, or active=true.');
  }
  const jobs = await Job.find(filter).sort({ createdAt: -1 }).limit(50);
  ok(res, jobs.map((j) => view(j, req.user)));
};

const retry = async (req, res) => {
  const job = await findVisible(req.params.id, req.user);
  if (job.status !== 'failed') throw AppError.conflict('Only failed tasks can be retried.');
  const retried = await jobQueue.retryJob(job._id);
  if (!retried) throw AppError.conflict('This task changed state — refresh and try again.');
  ok(res, view(retried, req.user));
};

const cancel = async (req, res) => {
  const job = await findVisible(req.params.id, req.user);
  const cancelled = await jobQueue.cancelJob(job._id);
  if (!cancelled) throw AppError.conflict('Only tasks that have not started can be cancelled.');
  ok(res, view(cancelled, req.user));
};

module.exports = { getOne, list, retry, cancel };
