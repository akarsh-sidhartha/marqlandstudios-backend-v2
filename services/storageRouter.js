'use strict';
/**
 * services/storageRouter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Routes each uploaded file to the correct storage backend.
 * Called by middleware/upload.js after multer captures the buffer.
 *
 * Decision table
 * ──────────────
 * mimetype           req flag          → destination
 * ─────────────────────────────────────────────────────
 * application/pdf    any               → OneDrive /Invoices/{FY}/{Month}/
 * image/*            req.isInvoice     → OneDrive /Invoices/{FY}/{Month}/
 * image/*            (default)         → Cloudflare R2
 * video/*            any               → OneDrive /uploads/videos/
 * anything else      any               → OneDrive /uploads/files/
 *
 * Set req.isInvoice = true before upload middleware on invoice routes.
 * Set req.r2Folder  = 'products'|'vendors'|'portal'|'publicApp'|'store'
 *   for explicit R2 subfolder (auto-detected from URL otherwise).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const path  = require('path');
const { v4: uuidv4 } = require('uuid');
const { uploadFile: uploadToR2, deleteFromR2 } = require('./r2Service');
const { uploadSingleFileBuffer, getFinancialYear, getMonthName } = require('./msGraphService');
const logger = require('../utils/logger').child({ module: 'storageRouter' });

/**
 * @typedef {Object} StorageResult
 * @property {'r2'|'onedrive'} storage  Which backend was used
 * @property {string} url               Public URL to store in MongoDB
 * @property {string} key               Storage key / path (for deletion)
 * @property {string} [webUrl]          OneDrive web URL (onedrive only)
 */

/**
 * Route a single multer memoryStorage file to R2 or OneDrive.
 *
 * @param {Express.Multer.File}       file
 * @param {import('express').Request} req
 * @returns {Promise<StorageResult>}
 */
const routeFile = async (file, req) => {
  const mime       = file.mimetype.toLowerCase();
  const isImage    = mime.startsWith('image/');
  const isPdf      = mime === 'application/pdf';
  const isVideo    = mime.startsWith('video/');
  const isInvoice  = !!req.isInvoice;

  // ── PDF → always OneDrive Invoices ─────────────────────────────────────────
  if (isPdf || (isImage && isInvoice)) {
    const fy       = getFinancialYear();                           // e.g. "25-26"
    const month    = getMonthName(new Date());                     // e.g. "May"
    const ext      = path.extname(file.originalname).toLowerCase() || (isPdf ? '.pdf' : '.jpg');
    const filename = `${uuidv4()}${ext}`;
    const folderPath = ['Invoices', fy, month];

    const result = await uploadSingleFileBuffer(folderPath, filename, file.buffer, file.mimetype);
    logger.info('File → OneDrive/Invoices', { filename, fy, month });
    return {
      storage: 'onedrive',
      url:     result.webUrl,
      key:     `Invoices/${fy}/${month}/${filename}`,  // readable path for logs
      webUrl:  result.webUrl,
    };
  }

  // ── Regular image → R2 ─────────────────────────────────────────────────────
  if (isImage) {
    const result = await uploadToR2(file, req);
    logger.info('File → R2', { key: result.key });
    return { storage: 'r2', url: result.url, key: result.key };
  }

  // ── Video → OneDrive /uploads/videos/ ──────────────────────────────────────
  if (isVideo) {
    const ext      = path.extname(file.originalname).toLowerCase() || '.mp4';
    const filename = `${uuidv4()}${ext}`;
    const result   = await uploadSingleFileBuffer(['uploads', 'videos'], filename, file.buffer, file.mimetype);
    logger.info('File → OneDrive/uploads/videos', { filename });
    return {
      storage: 'onedrive',
      url:     result.webUrl,
      key:     `uploads/videos/${filename}`,
      webUrl:  result.webUrl,
    };
  }

  // ── Everything else (doc, xls, zip…) → OneDrive /uploads/files/ ────────────
  const ext      = path.extname(file.originalname).toLowerCase() || '.bin';
  const filename = `${uuidv4()}${ext}`;
  const result   = await uploadSingleFileBuffer(['uploads', 'files'], filename, file.buffer, file.mimetype);
  logger.info('File → OneDrive/uploads/files', { filename, mimetype: mime });
  return {
    storage: 'onedrive',
    url:     result.webUrl,
    key:     `uploads/files/${filename}`,
    webUrl:  result.webUrl,
  };
};

/**
 * Route multiple files in parallel.
 * @param {Express.Multer.File[]}     files
 * @param {import('express').Request} req
 * @returns {Promise<StorageResult[]>}
 */
const routeFiles = async (files, req) =>
  Promise.all(files.map(f => routeFile(f, req)));

module.exports = { routeFile, routeFiles, deleteFromR2 };