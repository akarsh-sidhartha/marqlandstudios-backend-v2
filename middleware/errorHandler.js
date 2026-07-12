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
 */
const logger = require('../utils/logger').child({ module: 'errorHandler' });
const AppError = require('../lib/errors/AppError');
const HTTP = require('../lib/http/httpStatus');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : (err.status || err.statusCode || HTTP.INTERNAL_SERVER_ERROR);
  const isOperational = isAppError && err.isOperational;

  const level = statusCode >= 500 ? 'error' : 'warn';
  logger[level]('Request error', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    statusCode,
    error: err.message,
    stack: err.stack,
    userId: req.user?.id,
  });

  const body = {
    error: isOperational || !IS_PRODUCTION ? err.message : 'Internal Server Error',
  };
  if (isAppError && err.errorCode) body.code = err.errorCode;
  if (isAppError && err.details) body.details = err.details;

  res.status(statusCode).json(body);
};

module.exports = errorHandler;
