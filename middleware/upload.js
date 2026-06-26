'use strict';
/**
 * middleware/upload.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop-in replacement for the inline multer configs in each route file.
 * Uses memoryStorage (no disk writes) + routes each file to R2 or OneDrive.
 *
 * USAGE IN ROUTE FILES — identical call signature to multer:
 *
 *   const upload = require('../middleware/upload');
 *
 *   upload.single('image')           // was: multer({storage}).single('image')
 *   upload.array('mediaFiles', 20)   // was: multer({storage}).array('mediaFiles', 20)
 *   upload.fields([...])
 *
 * READING RESULTS IN HANDLERS:
 *
 *   // Single file
 *   req.uploadedFile          → { storage, url, key }
 *
 *   // Multiple files (array)
 *   req.uploadedFiles         → [{ storage, url, key }, ...]
 *
 *   // Multiple fields
 *   req.uploadedFiles         → { fieldname: [{ storage, url, key }], ... }
 *
 * OPTIONAL FLAGS (set before this middleware):
 *   req.isInvoice = true      → images go to OneDrive/Invoices instead of R2
 *   req.r2Folder  = 'products'|'vendors'|'portal'|'publicApp'|'store'
 *                             → explicit R2 subfolder (auto-detected from URL otherwise)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const multer = require('multer');
const { routeFile, routeFiles } = require('../services/storageRouter');
const logger = require('../utils/logger').child({ module: 'uploadMiddleware' });

// ── Allowed mime types — same set as your vendorRoutes (used as default) ──────
const DEFAULT_ALLOWED = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/mpeg', 'video/3gpp',
]);

/**
 * Build a multer instance with optional per-route mime filter and size limit.
 * @param {object}       [opts]
 * @param {Set<string>}  [opts.allowedTypes]  override DEFAULT_ALLOWED
 * @param {number}       [opts.maxSize]       bytes, default 500 MB
 */
const buildMulter = (opts = {}) => multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: opts.maxSize || 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = opts.allowedTypes || DEFAULT_ALLOWED;
    if (allowed.has(file.mimetype)) cb(null, true);
    else cb(new Error(`File type not supported: ${file.mimetype}`));
  },
});

// ── Wrap multer: after buffer captured, route to cloud ─────────────────────────
const wrap = (multerMiddleware, mode) => (req, res, next) => {
  multerMiddleware(req, res, async (err) => {
    if (err) return next(err);

    // ── Vendor routes (and any future route) set req.skipStorageRouter = true
    // to handle their own uploads. Multer has already captured the buffers into
    // req.file / req.files — we just skip the storageRouter dispatch entirely.
    if (req.skipStorageRouter) {
      req.uploadedFiles = [];
      req.uploadedFile  = null;
      return next();
    }

    try {
      if (mode === 'single') {
        if (!req.file) return next();
        req.uploadedFile = await routeFile(req.file, req);
        logger.debug('Single file routed', { storage: req.uploadedFile.storage, key: req.uploadedFile.key });

      } else if (mode === 'array') {
        if (!req.files?.length) return next();
        req.uploadedFiles = await routeFiles(req.files, req);
        logger.debug('Array files routed', { count: req.uploadedFiles.length });

      } else if (mode === 'fields') {
        // req.files is { fieldname: [multerFile, ...], ... }
        if (!req.files || !Object.keys(req.files).length) return next();
        req.uploadedFiles = {};
        for (const [field, fieldFiles] of Object.entries(req.files)) {
          req.uploadedFiles[field] = await routeFiles(fieldFiles, req);
        }
        logger.debug('Fields files routed', { fields: Object.keys(req.uploadedFiles) });
      }

      next();
    } catch (uploadErr) {
      logger.error('Cloud upload failed', { error: uploadErr.message, stack: uploadErr.stack });
      next(uploadErr);
    }
  });
};

// ── Public API ─────────────────────────────────────────────────────────────────
const upload = {
  /**
   * upload.single('fieldName')
   * → req.uploadedFile: { storage, url, key }
   */
  single(fieldname, opts) {
    return wrap(buildMulter(opts).single(fieldname), 'single');
  },

  /**
   * upload.array('fieldName', maxCount?)
   * → req.uploadedFiles: [{ storage, url, key }, ...]
   */
  array(fieldname, maxCount, opts) {
    return wrap(buildMulter(opts).array(fieldname, maxCount), 'array');
  },

  /**
   * upload.fields([{ name: 'image' }, { name: 'mediaFiles', maxCount: 20 }])
   * → req.uploadedFiles: { image: [...], mediaFiles: [...] }
   */
  fields(fields, opts) {
    return wrap(buildMulter(opts).fields(fields), 'fields');
  },

  /**
   * upload.none() — form fields only, no files
   */
  none() {
    return multer({ storage: multer.memoryStorage() }).none();
  },

  /**
   * upload.imageOnly.single / .array
   * Stricter variant for product/public routes — images only, 5 MB cap.
   * Matches your original productRoutes limit: { fileSize: 5 * 1024 * 1024 }
   */
  imageOnly: {
    single(fieldname) {
      return wrap(buildMulter({
        allowedTypes: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic']),
        maxSize: 5 * 1024 * 1024,
      }).single(fieldname), 'single');
    },
    array(fieldname, maxCount) {
      return wrap(buildMulter({
        allowedTypes: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic']),
        maxSize: 5 * 1024 * 1024,
      }).array(fieldname, maxCount), 'array');
    },
  },
};

module.exports = upload;