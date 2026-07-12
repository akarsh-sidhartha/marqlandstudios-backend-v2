'use strict';
/**
 * middleware/asyncHandler.js
 *
 * Wraps an async route/controller function so a rejected promise (a
 * thrown error inside an `await`) is forwarded to next(err) instead of
 * crashing the process or hanging the request. Eliminates the
 * try { ... } catch (err) { res.status(...).json(...) } block that would
 * otherwise be copy-pasted into every controller — see
 * middleware/errorHandler.js for where the forwarded error ends up.
 *
 * Usage: router.post('/', asyncHandler(controller.create));
 */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
