'use strict';
/**
 * middleware/documentUpload.js
 *
 * Multipart intake for business documents (invoices, PIs, payment proofs):
 * in-memory only (files go straight to OneDrive, never to local disk), one
 * file, size-capped, and — after multer — the declared type is checked
 * against the file's actual bytes. A renamed .exe or an HTML file claiming
 * to be image/png is rejected before any service sees it.
 *
 *   router.post('/x', documentUpload('file'), handler)
 *   router.post('/y', documentUpload('screenshot', { required: true }), handler)
 *   router.post('/z', documentUpload.many('files', { maxFiles: 10, accept: 'attachment' }), handler)
 */
const multer = require('multer');
const AppError = require('../lib/errors/AppError');
const { detectMime, detectAttachmentMime, DOCUMENT_MIMES, IMAGE_MIMES } = require('../utils/fileType');

const MAX_BYTES = (Number(process.env.DOCUMENT_UPLOAD_MAX_MB) || 20) * 1024 * 1024;

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 40, fieldSize: 64 * 1024 },
  fileFilter: (req, file, cb) => {
    if (DOCUMENT_MIMES.has(file.mimetype)) return cb(null, true);
    cb(AppError.unprocessable(`Unsupported file type "${file.mimetype}". Upload a PDF, JPG, PNG or WEBP.`));
  },
});

const documentUpload = (field, { required = false } = {}) => [
  parser.single(field),
  (req, res, next) => {
    if (!req.file) return required ? next(AppError.badRequest('Please attach a document.')) : next();
    const actual = detectMime(req.file.buffer);
    if (!actual) return next(AppError.unprocessable('The file content is not a valid PDF or image.'));
    req.file.mimetype = actual; // trust the bytes, not the client's label
    next();
  },
];

// What each multi-file intake accepts, checked against the sniffed bytes.
const ACCEPT = {
  image:      { detect: (f) => detectMime(f.buffer), allowed: (m) => IMAGE_MIMES.has(m), label: 'an image (JPG, PNG, WEBP or HEIC)' },
  document:   { detect: (f) => detectMime(f.buffer), allowed: (m) => DOCUMENT_MIMES.has(m), label: 'a PDF or image' },
  attachment: { detect: (f) => detectAttachmentMime(f.buffer, f.originalname), allowed: Boolean, label: 'a PDF, image, Office document or CSV' },
};

const manyParser = (field, maxFiles) => multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: maxFiles, fields: 20, fieldSize: 256 * 1024 },
}).array(field, maxFiles);

/**
 * Several files under one field. Each file's real type is sniffed and
 * checked against `accept` ('image' | 'document' | 'attachment', or a
 * function (req) => one of those, e.g. picked from a query param).
 */
documentUpload.many = (field, { maxFiles = 10, required = true, accept = 'document' } = {}) => {
  const parse = manyParser(field, maxFiles);
  return [
    (req, res, next) => parse(req, res, (err) => {
      if (err?.code === 'LIMIT_FILE_COUNT' || err?.code === 'LIMIT_UNEXPECTED_FILE') {
        return next(AppError.badRequest(`Upload at most ${maxFiles} files at a time.`));
      }
      next(err);
    }),
    (req, res, next) => {
      const files = req.files || [];
      if (!files.length) return required ? next(AppError.badRequest('Please attach at least one file.')) : next();
      const rule = ACCEPT[typeof accept === 'function' ? accept(req) : accept] || ACCEPT.document;
      for (const file of files) {
        const actual = rule.detect(file);
        if (!actual || !rule.allowed(actual)) {
          return next(AppError.unprocessable(`"${file.originalname}" is not ${rule.label}.`));
        }
        file.mimetype = actual;
      }
      next();
    },
  ];
};

module.exports = documentUpload;
