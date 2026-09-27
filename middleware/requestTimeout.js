'use strict';
/**
 * middleware/requestTimeout.js
 *
 * Guarantees a synchronous request never hangs: if the handler hasn't
 * answered within `ms`, the client gets a 504 REQUEST_TIMEOUT immediately
 * (anything the handler writes afterwards is dropped by errorHandler's
 * headersSent guard). Work that legitimately takes longer than a few
 * seconds does not belong in the request at all — it is queued as a
 * background job and answered with 202 (see lib/jobs/jobQueue.js).
 *
 * Calling it again later in the chain replaces the earlier timer, so a
 * router can set a strict default and a single route (e.g. a chunk upload)
 * can widen it:
 *
 *   router.use(requestTimeout(10_000));
 *   router.put('/:id/chunks', requestTimeout(60_000), ...);
 */
const AppError = require('../lib/errors/AppError');
const logger = require('../utils/logger').child({ module: 'requestTimeout' });

const DEFAULT_TIMEOUT_MS = 10_000;

const requestTimeout = (ms = DEFAULT_TIMEOUT_MS) => (req, res, next) => {
  if (req._timeoutTimer) clearTimeout(req._timeoutTimer);

  req._timeoutTimer = setTimeout(() => {
    if (res.headersSent) return;
    req.timedOut = true;
    logger.warn('Request timed out', { requestId: req.requestId, method: req.method, path: req.originalUrl, ms });
    next(AppError.timeout());
  }, ms);
  req._timeoutTimer.unref?.();

  const clear = () => clearTimeout(req._timeoutTimer);
  res.once('finish', clear);
  res.once('close', clear);
  next();
};

module.exports = { requestTimeout, DEFAULT_TIMEOUT_MS };
