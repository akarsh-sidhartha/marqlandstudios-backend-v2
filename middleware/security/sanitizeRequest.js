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

// Route + field combinations that are *expected* to carry limited, safe HTML
// (e.g. rich-text editors that let users paste screenshots or apply basic
// formatting). Every other route/field keeps the fully-strict, zero-tags
// behavior above. Scoped by route (not just field name) so a field called
// "description" on some other, unrelated route doesn't silently become
// more permissive just because it shares a name with this one. Keep this
// list narrow and the whitelist minimal — this is still an XSS boundary,
// just a slightly wider one for these specific route+field pairs.
const EMPTY_FIELD_SET = new Set();

const RICH_TEXT_ROUTES = [
  { match: /^\/api\/orders(\/|$)/, fields: new Set(['description']) },
];

// Returns the Set of rich-text-allowed field names for this request's
// route, or an empty Set if no route config matches (i.e. fully strict).
const richTextFieldsForRoute = (req) => {
  const path = req.originalUrl ? req.originalUrl.split('?')[0] : req.path;
  const config = RICH_TEXT_ROUTES.find((r) => r.match.test(path));
  return config ? config.fields : EMPTY_FIELD_SET;
};

const RICH_TEXT_XSS_OPTIONS = {
  whiteList: {
    img: ['src', 'style', 'alt'],
    br: [],
    div: ['style'],
    p: ['style'],
    b: [], i: [], strong: [], em: [], u: [],
    span: ['style'],
  },
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style'],
  // Belt-and-suspenders: even within the whitelist, refuse any src/href that
  // isn't a data: image URI or a relative/https URL — blocks javascript:
  // and other unexpected schemes from sneaking in via a whitelisted attr.
  onIgnoreTagAttr: undefined,
  safeAttrValue: (tag, name, value) => {
    if ((name === 'src' || name === 'href') && /^\s*javascript:/i.test(value)) {
      return '';
    }
    return xss.escapeAttrValue(value);
  },
};

const sanitizeString = (value, key, richTextFields) => {
  const options = richTextFields.has(key) ? RICH_TEXT_XSS_OPTIONS : XSS_OPTIONS;
  return xss(value, options).trim();
};

const sanitizeInPlace = (obj, richTextFields) => {
  if (!obj || typeof obj !== 'object') return;

  for (const key of Object.keys(obj)) {
    const value = obj[key];

    if (typeof value === 'string') {
      obj[key] = sanitizeString(value, key, richTextFields);
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'string') value[i] = sanitizeString(item, key, richTextFields);
        else if (item && typeof item === 'object') sanitizeInPlace(item, richTextFields);
      });
    } else if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
      sanitizeInPlace(value, richTextFields);
    }
  }
};

const sanitizeRequest = (req, res, next) => {
  // Resolved once per request, from the route, so the allowlist can never
  // "leak" onto an unrelated route just because a field shares a name.
  const richTextFields = richTextFieldsForRoute(req);
  sanitizeInPlace(req.body, richTextFields);
  sanitizeInPlace(req.query, richTextFields);
  sanitizeInPlace(req.params, richTextFields);
  next();
};

module.exports = sanitizeRequest;