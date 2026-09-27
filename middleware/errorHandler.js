'use strict';
/**
 * middleware/errorHandler.js
 *
 * Single centralized error-handling middleware — the only place in the
 * app that writes an error response. Controllers/services throw AppError
 * (or let unexpected errors bubble up via asyncHandler) instead of
 * formatting their own res.status().json(); this is what makes that safe.
 *
 * AppError instances (isOperational: true) are "expected" errors — their
 * message is safe to show the client (e.g. "Task not found."). Anything
 * else is an unhandled bug: it's logged with full detail but the client
 * only ever sees a generic message in production, so internals never leak.
 *
 * /api/v2/* requests get the standard envelope from lib/http/apiResponse.js
 * ({ success:false, data:null, error:{ code, message, details }, meta }).
 * Legacy routes keep their original { error, code, details } body so the
 * existing front-end screens that read it are unaffected.
 */
const logger = require('../utils/logger').child({ module: 'errorHandler' });
const AppError = require('../lib/errors/AppError');
const HTTP = require('../lib/http/httpStatus');
const { buildError } = require('../lib/http/apiResponse');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Multer and body-parser raise their own error types — map them to proper
// 4xx codes instead of letting them surface as a 500.
const normalise = (err) => {
  if (err instanceof AppError) return err;
  if (err?.name === 'MulterError') {
    return err.code === 'LIMIT_FILE_SIZE'
      ? AppError.payloadTooLarge('File is larger than the allowed limit.')
      : AppError.badRequest(`Upload failed: ${err.message}`);
  }
  if (err?.type === 'entity.too.large') return AppError.payloadTooLarge();
  if (err?.name === 'CastError') return AppError.badRequest('Invalid id.');
  if (err?.name === 'ValidationError') {
    return AppError.badRequest('Invalid data.', Object.values(err.errors || {}).map((e) => ({ field: e.path, message: e.message })));
  }
  return err;
};

// eslint-disable-next-line no-unused-vars
const errorHandler = (rawErr, req, res, next) => {
  const err = normalise(rawErr);
  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : (err.status || err.statusCode || HTTP.INTERNAL_SERVER_ERROR);
  const isOperational = isAppError && err.isOperational;

  const level = statusCode >= 500 ? 'error' : 'warn';
  logger[level]('Request error', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    statusCode,
    code: err.errorCode,
    error: err.message,
    stack: statusCode >= 500 ? err.stack : undefined,
    userId: req.user?.id,
  });

  // A timeout (or a client disconnect) may already have answered.
  if (res.headersSent) return;

  const message = isOperational || !IS_PRODUCTION ? err.message : 'Internal Server Error';

  if ((req.originalUrl || '').startsWith('/api/v2')) {
    return res.status(statusCode).json(buildError(req, {
      code: isAppError ? err.errorCode : 'INTERNAL_ERROR',
      message,
      details: isAppError ? err.details : undefined,
    }));
  }

  const body = { error: message, message };
  if (isAppError && err.errorCode) body.code = err.errorCode;
  if (isAppError && err.details) body.details = err.details;

  res.status(statusCode).json(body);
};

module.exports = errorHandler;
