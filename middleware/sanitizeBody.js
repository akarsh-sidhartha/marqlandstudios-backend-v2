'use strict';
/**
 * middleware/sanitizeBody.js
 *
 * Replacement for `express-mongo-sanitize`, which crashes on this stack:
 *   TypeError: Cannot set property query of #<IncomingMessage> which has only a getter
 * That happens because express-mongo-sanitize tries to reassign req.query
 * (and req.params) in place, but modern Express/Node expose req.query as a
 * getter-only accessor with no setter — so ANY request throws, not just ones
 * with a real payload.
 *
 * This does the one part of that library's job that's actually needed here:
 * recursively strip any object key starting with `$` or containing a `.`
 * from req.body (the only one of the three that's a plain, safely-
 * reassignable object in every version of Express). That's the NoSQL
 * injection vector that matters — an attacker sending
 * { "email": { "$gt": "" } } as a query operator instead of a string.
 * req.query/req.params are left untouched; they're already validated
 * per-route (see utils/inputValidation.js) and, for this app, never get
 * passed directly into a Mongoose filter as a whole object.
 */
const sanitizeValue = (value) => {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value && typeof value === 'object' && !(value instanceof Date) && !(value.buffer)) {
    const clean = {};
    for (const [key, val] of Object.entries(value)) {
      if (key.startsWith('$') || key.includes('.')) continue; // drop the key entirely
      clean[key] = sanitizeValue(val);
    }
    return clean;
  }
  return value;
};

const sanitizeBody = (req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }
  next();
};

module.exports = sanitizeBody;