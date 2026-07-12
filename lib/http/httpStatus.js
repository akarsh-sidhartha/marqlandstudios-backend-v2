'use strict';
/**
 * lib/http/httpStatus.js
 *
 * Named HTTP status constants. Import this instead of hardcoding magic
 * numbers (res.status(400)) so every layer (controllers, services, error
 * classes) agrees on one vocabulary.
 */
module.exports = Object.freeze({
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
});
