'use strict';
/**
 * middleware/idempotency.js
 *
 * Honours the `Idempotency-Key` request header on mutating /api/v2 routes.
 *
 *   first request            → runs normally, response is stored
 *   same key, same body      → stored response is replayed (header Idempotent-Replayed: true)
 *   same key, still running  → 409 IDEMPOTENCY_IN_PROGRESS (client should poll/retry later)
 *   same key, different body → 422 IDEMPOTENCY_KEY_REUSED
 *
 * Keys are scoped per user, so two people can never collide. The header is
 * optional — requests without it behave exactly as before. Mount AFTER any
 * body parser (multer included) so the fingerprint covers the real payload.
 *
 * Only 2xx responses are stored; a 4xx/5xx releases the key so a corrected
 * or retried request can go through.
 */
const crypto = require('crypto');
const IdempotencyRecord = require('../models/IdempotencyRecord');
const AppError = require('../lib/errors/AppError');
const logger = require('../utils/logger').child({ module: 'idempotency' });

const TTL_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

const fingerprint = (req) => {
  const files = [];
  if (req.file) files.push([req.file.fieldname, req.file.originalname, req.file.size]);
  const many = Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat();
  for (const f of many) files.push([f.fieldname, f.originalname, f.size]);
  const body = Buffer.isBuffer(req.body) ? `buffer:${req.body.length}` : req.body;
  return crypto.createHash('sha256')
    .update(JSON.stringify({ m: req.method, p: req.baseUrl + req.path, body, files }))
    .digest('hex');
};

const idempotency = () => async (req, res, next) => {
  const key = req.get('Idempotency-Key');
  if (!key) return next();
  if (!KEY_PATTERN.test(key)) return next(AppError.badRequest('Invalid Idempotency-Key header.'));

  const userId = String(req.user?.id || req.ip);
  const requestHash = fingerprint(req);

  let record;
  try {
    record = await IdempotencyRecord.create({
      key, userId, method: req.method, path: req.baseUrl + req.path, requestHash,
      expiresAt: new Date(Date.now() + TTL_MS),
    });
  } catch (err) {
    if (err.code !== 11000) return next(err);
    const existing = await IdempotencyRecord.findOne({ userId, key }).lean();
    if (!existing) return next(AppError.conflict('Please retry the request.'));
    if (existing.requestHash !== requestHash) {
      return next(new AppError('This Idempotency-Key was already used for a different request.', 422, { errorCode: 'IDEMPOTENCY_KEY_REUSED' }));
    }
    if (existing.state === 'in_progress') {
      res.setHeader('Retry-After', '2');
      return next(new AppError('The original request is still being processed.', 409, { errorCode: 'IDEMPOTENCY_IN_PROGRESS' }));
    }
    logger.info('Replaying idempotent response', { key, userId, path: existing.path });
    res.setHeader('Idempotent-Replayed', 'true');
    return res.status(existing.responseStatus).json(existing.responseBody);
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const status = res.statusCode;
    if (status >= 200 && status < 300) {
      IdempotencyRecord.updateOne(
        { _id: record._id },
        { $set: { state: 'completed', responseStatus: status, responseBody: body } }
      ).catch((e) => logger.warn('Failed to store idempotent response', { key, error: e.message }));
    } else {
      IdempotencyRecord.deleteOne({ _id: record._id }).catch(() => {});
    }
    return originalJson(body);
  };
  // If the connection dies before any response, release the key.
  res.once('close', () => {
    if (!res.headersSent) IdempotencyRecord.deleteOne({ _id: record._id, state: 'in_progress' }).catch(() => {});
  });
  next();
};

module.exports = idempotency;
