'use strict';
/**
 * backend/middleware/legacyPortalRedirect.js
 *
 * Redirects requests arriving on the old internal server domain
 * (internalportal.marqland.com) to the new public domain
 * (marqlandstudios.com), preserving the full path + query string.
 *
 * Mount this as the VERY FIRST middleware in your Express app (before
 * all routes), so it runs on every request before any other logic:
 *
 *   // In app.js / server.js:
 *   const legacyPortalRedirect = require('./middleware/legacyPortalRedirect');
 *   app.use(legacyPortalRedirect);
 *
 * The redirect is permanent (301) so browsers and search engines update
 * their bookmarks/indexes automatically.
 */

const LEGACY_HOST   = 'internalportal.marqland.com';
const NEW_BASE_URL  = (process.env.CLIENT_URL || 'https://www.marqlandstudios.com').replace(/\/$/, '');

module.exports = function legacyPortalRedirect(req, res, next) {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();

  if (host === LEGACY_HOST) {
    // Preserve path + query string, e.g.
    //   internalportal.marqland.com/p/ra0p0-inq-26-27-043
    //   → marqlandstudios.com/p/ra0p0-inq-26-27-043
    const destination = `${NEW_BASE_URL}${req.originalUrl}`;
    return res.redirect(301, destination);
  }

  next();
};