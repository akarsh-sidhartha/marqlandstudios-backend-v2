'use strict';
/**
 * middleware/security/sanitizeRequest.js
 *
 * Recursively strips HTML/script content from every string in
 * req.body, req.query, and req.params — defense against stored/reflected
 * XSS from any field that later gets rendered by the admin or client
 * front-ends. Complements middleware/sanitizeBody.js (which strips
 * NoSQL-operator keys like `$gt`) rather than replacing it; that one is
 * about query-shape injection, this one is about markup injection.
 *
 * IMPORTANT — this mutates objects IN PLACE (obj[key] = ...) rather than
 * reassigning req.query/req.params/req.body. Express 5 exposes req.query
 * as a getter-only accessor (reassigning it throws), so every field must
 * be sanitized by walking into the existing object, never by replacing
 * the object itself. See middleware/sanitizeBody.js for the same
 * constraint documented in more detail.
 */
const xss = require('xss');

const XSS_OPTIONS = {
  whiteList: {}, // no tags allowed through at all — this is a JSON API, not a rich-text renderer
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style'],
};

const sanitizeString = (value) => xss(value, XSS_OPTIONS).trim();

const sanitizeInPlace = (obj) => {
  if (!obj || typeof obj !== 'object') return;

  for (const key of Object.keys(obj)) {
    const value = obj[key];

    if (typeof value === 'string') {
      obj[key] = sanitizeString(value);
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'string') value[i] = sanitizeString(item);
        else if (item && typeof item === 'object') sanitizeInPlace(item);
      });
    } else if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
      sanitizeInPlace(value);
    }
  }
};

const sanitizeRequest = (req, res, next) => {
  sanitizeInPlace(req.body);
  sanitizeInPlace(req.query);
  sanitizeInPlace(req.params);
  next();
};

module.exports = sanitizeRequest;
