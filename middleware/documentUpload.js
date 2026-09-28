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
 */
const multer = require('multer');
const AppError = require('../lib/errors/AppError');
const { detectMime, DOCUMENT_MIMES } = require('../utils/fileType');

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

module.exports = documentUpload;
