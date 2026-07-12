'use strict';
/**
 * middleware/notFoundHandler.js
 *
 * Mounted after all routes and static file handlers. Requests for
 * /public/* and /uploads/* fall through untouched (express.static already
 * handles their own 404s with the right content-type); everything else
 * unmatched gets one consistent JSON 404 instead of Express's default
 * HTML error page.
 */
const logger = require('../utils/logger').child({ module: 'notFoundHandler' });

const PASSTHROUGH_PREFIXES = ['/api', '/public', '/uploads'];

const notFoundHandler = (req, res, next) => {
  if (PASSTHROUGH_PREFIXES.some((prefix) => req.url.startsWith(prefix))) return next();

  logger.warn('404 — unmatched route', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
  });
  res.status(404).json({ error: 'Not found. This is an API server.' });
};

module.exports = notFoundHandler;
