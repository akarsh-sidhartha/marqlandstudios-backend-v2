'use strict';
/**
 * lib/http/apiResponse.js
 *
 * The one response envelope every /api/v2 endpoint returns:
 *
 *   { success: true,  data: <payload>, error: null,                        meta: { requestId, ... } }
 *   { success: false, data: null,      error: { code, message, details },  meta: { requestId } }
 *
 * Controllers call ok()/created()/accepted() instead of res.json() so the
 * shape can never drift between endpoints. Errors never go through here —
 * they are thrown as AppError and shaped by middleware/errorHandler.js,
 * which uses buildError() below for v2 requests.
 */
const HTTP = require('./httpStatus');

const baseMeta = (req, meta) => ({ requestId: req.requestId, ...(meta || {}) });

const send = (res, status, data, meta) =>
  res.status(status).json({ success: true, data, error: null, meta: baseMeta(res.req, meta) });

const ok = (res, data, meta) => send(res, HTTP.OK, data, meta);
const created = (res, data, meta) => send(res, HTTP.CREATED, data, meta);

/**
 * 202 Accepted for work handed to the background queue. `job` is a Job
 * document (or its toClient() shape); the client polls statusUrl until the
 * job reaches a final state.
 */
const accepted = (res, job, extra = {}) => {
  const view = typeof job.toClient === 'function' ? job.toClient() : job;
  const statusUrl = `/api/v2/jobs/${view.id}`;
  res.setHeader('Location', statusUrl);
  return send(res, HTTP.ACCEPTED, { ...extra, job: view, jobId: view.id, statusUrl });
};

const buildError = (req, { code, message, details }) => ({
  success: false,
  data: null,
  error: { code: code || 'INTERNAL_ERROR', message, details: details || undefined },
  meta: baseMeta(req),
});

/** Parses ?page=&limit= with sane bounds and returns { page, limit, skip }. */
const paging = (query, { defaultLimit = 24, maxLimit = 100 } = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
};

const pageMeta = ({ page, limit }, total) => ({
  page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), hasMore: page * limit < total,
});

module.exports = { ok, created, accepted, buildError, paging, pageMeta };
