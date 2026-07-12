'use strict';
/**
 * lib/errors/AppError.js
 *
 * Base class for all expected/handled errors. `isOperational: true` marks
 * an error as safe to expose its message to the client (as opposed to an
 * unexpected bug, whose message gets swallowed behind "Internal Server
 * Error" in production — see middleware/errorHandler.js). Throw these
 * from services/controllers instead of calling res.status().json()
 * directly, so every error path funnels through the one centralized
 * handler.
 */
const HTTP = require('../http/httpStatus');

class AppError extends Error {
  constructor(message, statusCode = HTTP.INTERNAL_SERVER_ERROR, { errorCode, details } = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, details) {
    return new AppError(message, HTTP.BAD_REQUEST, { errorCode: 'BAD_REQUEST', details });
  }

  static unauthorized(message = 'Access denied.') {
    return new AppError(message, HTTP.UNAUTHORIZED, { errorCode: 'UNAUTHORIZED' });
  }

  static forbidden(message = 'Forbidden.') {
    return new AppError(message, HTTP.FORBIDDEN, { errorCode: 'FORBIDDEN' });
  }

  static notFound(message = 'Resource not found.') {
    return new AppError(message, HTTP.NOT_FOUND, { errorCode: 'NOT_FOUND' });
  }

  static conflict(message, details) {
    return new AppError(message, HTTP.CONFLICT, { errorCode: 'CONFLICT', details });
  }

  static tooManyRequests(message = 'Too many requests. Please slow down and try again shortly.', details) {
    return new AppError(message, HTTP.TOO_MANY_REQUESTS, { errorCode: 'RATE_LIMITED', details });
  }
}

module.exports = AppError;
