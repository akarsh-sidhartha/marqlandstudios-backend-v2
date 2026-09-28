'use strict';
/**
 * services/paymentTracker/fileStore.js
 *
 * The one place the Payment Tracker touches OneDrive: upload (with retry),
 * stream-back proxy, delete — plus filename/folder builders so every caller
 * names files the same way.
 *
 * Storage failures are "soft" by design: a record is still saved when
 * OneDrive is down, and the caller gets a warning to surface to the user
 * instead of losing the whole submission.
 */
const axios = require('axios');
const { uploadSingleFileBuffer, deleteFile, deleteFolderByPath, getAccessToken, driveBase } = require('../msGraphService');
const { withRetry } = require('../../lib/resilience/retry');
const { odvPath } = require('../../utils/oneDrivePaths');
const AppError = require('../../lib/errors/AppError');
const logger = require('../../utils/logger').child({ module: 'paymentTracker.fileStore' });

// ── Naming ────────────────────────────────────────────────────────────────────
const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };
const extFromMime = (mime) => EXT[mime] || 'bin';

/** Safe for a OneDrive path segment and a Content-Disposition header. */
const safeToken = (s, fallback = '') =>
  (String(s || '').replace(/[^a-z0-9_-]+/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60)) || fallback;

/** "PI/2025/001" → "PI-2025-001" (folder-safe but still recognisable). */
const safeFolder = (s, fallback = 'UNSPECIFIED') =>
  (String(s || '').replace(/\//g, '-').replace(/[\\:*?"<>|#%]/g, '_').trim().slice(0, 80)) || fallback;

const buildName = (parts, mime) => `${parts.map((p) => safeToken(p)).filter(Boolean).join('_') || 'FILE'}.${extFromMime(mime)}`;

const folders = {
  invoice: (fy, month) => odvPath('Invoices', fy, month),
  pi: (piNumber) => odvPath('PI-Attachments', safeFolder(piNumber)),
  payment: (fy, month) => odvPath('Invoices', fy, month, 'Payments'),
  legacyPaymentFolder: (paymentRef) => odvPath('Payments', paymentRef),
};

// ── Operations ────────────────────────────────────────────────────────────────
/**
 * Upload a buffer. Never throws for storage problems — returns
 * { fileId, webUrl, fileName, mime } on success or { warning } on failure.
 */
const save = async ({ folder, fileName, buffer, mime }) => {
  try {
    const { fileId, webUrl } = await withRetry(
      () => uploadSingleFileBuffer(folder, fileName, buffer, mime),
      { retries: 3, label: 'onedrive.paymentTracker.upload' },
    );
    logger.debug('File stored', { path: folder.join('/'), fileName });
    return { fileId, webUrl, fileName, mime };
  } catch (err) {
    logger.error('OneDrive upload failed — record will be saved without its file', { fileName, error: err.message });
    return { warning: 'The document could not be stored in OneDrive right now — the record was saved without it. Re-attach it later.' };
  }
};

const remove = async (fileId) => {
  if (!fileId) return;
  try { await deleteFile(fileId); }
  catch (err) { if (err.response?.status !== 404) logger.warn('OneDrive delete failed', { fileId, error: err.message }); }
};

const removeFolder = async (segments) => {
  try { await deleteFolderByPath(segments); }
  catch (err) { logger.warn('OneDrive folder delete failed', { path: segments.join('/'), error: err.message }); }
};

/**
 * Proxy a stored file to the browser without exposing OneDrive URLs or
 * credentials. Headers are fixed server-side values, never client input.
 */
const stream = async (res, { fileId, mime, fileName }) => {
  if (!fileId) throw AppError.notFound('No document is attached.');
  let meta;
  try {
    const token = await getAccessToken();
    meta = await withRetry(
      () => axios.get(`${driveBase()}/items/${encodeURIComponent(fileId)}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 }),
      { retries: 2, label: 'onedrive.paymentTracker.meta' },
    );
  } catch (err) {
    if (err.response?.status === 404) throw AppError.notFound('The document no longer exists in OneDrive.');
    throw AppError.upstream('OneDrive is temporarily unavailable. Please try again.');
  }
  const url = meta.data['@microsoft.graph.downloadUrl'];
  if (!url) throw AppError.upstream('OneDrive did not return a download link.');

  const file = await axios.get(url, { responseType: 'stream', timeout: 60_000 });
  const name = buildName([String(fileName || 'document').replace(/\.[a-z0-9]+$/i, '')], mime);
  res.setHeader('Content-Type', EXT[mime] ? mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  file.data.on('error', (err) => { logger.warn('File stream aborted', { error: err.message }); res.destroy(err); });
  file.data.pipe(res);
};

module.exports = { save, remove, removeFolder, stream, buildName, safeFolder, folders, extFromMime };
