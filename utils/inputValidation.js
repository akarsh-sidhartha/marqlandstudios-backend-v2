'use strict';
/**
 * utils/inputValidation.js
 *
 * Central server-side input validation for public-facing text fields:
 * Partner registration, login, and the homepage "Get in Touch" form.
 * This is the layer that actually matters for security — the matching
 * front-end checks (src/utils/inputValidation.js in each client repo) are
 * for UX only and are never trusted on their own.
 *
 * Design rationale:
 *  - Name-like fields (company name, contact name, "how did you hear about
 *    us") -> alphanumeric + spaces ONLY. Anything else is rejected outright
 *    (not silently stripped), so no script tag, HTML, or SQL/NoSQL operator
 *    syntax can ever reach the database in these fields.
 *  - Email -> a standard email-format regex. It necessarily allows
 *    . _ % + - @ (a valid address can't exist without them), but the regex
 *    itself rejects <, >, quotes, backticks, semicolons, spaces, and any
 *    other character an XSS/injection payload would need.
 *  - Phone -> digits, spaces, +, -, ( ) only.
 *  - Website -> must parse as a well-formed http(s) URL; angle brackets/
 *    quotes and non-http(s) schemes (e.g. javascript:) are rejected outright.
 *  - Message/description textareas -> alphanumeric + spaces + line breaks
 *    only, same rationale as name fields, just longer.
 *  - Password -> deliberately NOT restricted to alphanumeric. Restricting a
 *    password's character set would reduce the space of possible passwords
 *    (weaker against brute-force) and passwords are hashed (bcrypt) and
 *    never rendered back as HTML or executed anywhere, so there is no XSS
 *    surface here. We only enforce a length bound, matching the existing
 *    User model's 8-character minimum.
 *
 * All rejections return a single generic message and a 400 — no regex,
 * field name detail, or stack trace is ever exposed to the client.
 */

const NAME_REGEX    = /^[a-zA-Z0-9 ]{1,120}$/;
const EMAIL_REGEX   = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const PHONE_REGEX   = /^[0-9+\-() ]{0,20}$/;
const MESSAGE_REGEX = /^[a-zA-Z0-9 \r\n]{0,2000}$/;

const isValidName    = (v) => typeof v === 'string' && NAME_REGEX.test(v.trim());
const isValidEmail   = (v) => typeof v === 'string' && v.length <= 254 && EMAIL_REGEX.test(v.trim());
const isValidPhone   = (v) => v === undefined || v === '' || (typeof v === 'string' && PHONE_REGEX.test(v.trim()));
const isValidMessage = (v) => v === undefined || v === '' || (typeof v === 'string' && MESSAGE_REGEX.test(v));
const isValidPassword = (v) => typeof v === 'string' && v.length >= 8 && v.length <= 200;

const isSafeUrl = (v) => {
  if (v === undefined || v === '') return true; // optional field
  if (typeof v !== 'string' || v.length > 500) return false;
  if (/[<>"'`]/.test(v)) return false;
  // Protocol is optional — "www.example.com" or "example.com" are both
  // accepted, same as "https://example.com". Only javascript:/data:/etc.
  // pseudo-schemes are rejected, via the explicit http(s) check below.
  const candidate = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(candidate);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

// Normalizes a website value for storage — prepends https:// if the person
// left the protocol off, so the saved link is always clickable as-is.
const normalizeUrl = (v) => {
  if (!v) return '';
  const trimmed = v.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const VALIDATORS = {
  name:     isValidName,
  email:    isValidEmail,
  phone:    isValidPhone,
  url:      isSafeUrl,
  message:  isValidMessage,
  password: isValidPassword,
};

/**
 * Express middleware factory.
 *   schema:   { fieldName: 'name' | 'email' | 'phone' | 'url' | 'message' | 'password' }
 *   required: [fieldName, ...] — fields that must be present and non-empty
 *
 * Optional fields (not in `required`) are only validated if present/non-empty.
 * Usage:
 *   router.post('/partner-leads', validateBody(
 *     { companyName: 'name', contactName: 'name', email: 'email', phone: 'phone', website: 'url', message: 'message' },
 *     ['companyName', 'contactName', 'email']
 *   ), async (req, res) => { ... });
 */
const validateBody = (schema, required = []) => (req, res, next) => {
  for (const field of required) {
    const value = req.body[field];
    if (value === undefined || value === null || String(value).trim() === '') {
      return res.status(400).json({ message: `${field} is required.` });
    }
  }
  for (const [field, type] of Object.entries(schema)) {
    const value = req.body[field];
    if (value === undefined || value === '') continue; // optional & absent
    const validator = VALIDATORS[type];
    if (!validator || !validator(value)) {
      return res.status(400).json({ message: 'Invalid input. Please use only letters, numbers, and spaces, and try again.' });
    }
  }
  next();
};

module.exports = {
  isValidName, isValidEmail, isValidPhone, isSafeUrl, isValidMessage, isValidPassword, normalizeUrl,
  validateBody,
};