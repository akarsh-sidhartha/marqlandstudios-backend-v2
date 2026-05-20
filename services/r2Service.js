'use strict';
/**
 * services/r2Service.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cloudflare R2 client (S3-compatible via @aws-sdk/client-s3).
 * Mirrors the style of msGraphService.js — singleton client, named exports.
 *
 * R2 bucket layout
 * ─────────────────
 * website/
 *   internalApp/
 *     products/    ← product images  (was public/uploads/internalApp/products/)
 *     vendors/     ← vendor media    (was public/uploads/internalApp/vendors/)
 *     portal/      ← portal images   (was public/uploads/internalApp/portal/)
 *   publicApp/     ← public site     (was public/uploads/publicApp/)
 *   store/         ← store images    (was public/uploads/store/)
 *
 * Required .env vars:
 *   R2_ACCOUNT_ID          Cloudflare account ID (right sidebar on dash.cloudflare.com)
 *   R2_ACCESS_KEY_ID       R2 API token → Access Key ID
 *   R2_SECRET_ACCESS_KEY   R2 API token → Secret Access Key
 *   R2_BUCKET_NAME         e.g. "marqlandstudios"
 *   R2_PUBLIC_URL          e.g. "https://pub-xxxx.r2.dev" (no trailing slash)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const sharp = require('sharp');
const logger = require('../utils/logger').child({ module: 'r2Service' });

// ── Client singleton ──────────────────────────────────────────────────────────
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET     = () => process.env.R2_BUCKET_NAME;
const PUBLIC_URL = () => (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

// ── Folder map (matches your existing public/uploads/ structure) ──────────────
const FOLDER_MAP = {
  products:  'website/internalApp/products',
  vendors:   'website/internalApp/vendors',
  portal:    'website/internalApp/portal',
  publicApp: 'website/publicApp',
  store:     'website/store',
};

/**
 * Resolve R2 folder from explicit hint or URL path.
 * @param {import('express').Request} req
 */
const resolveFolder = (req) => {
  if (req.r2Folder && FOLDER_MAP[req.r2Folder]) return FOLDER_MAP[req.r2Folder];
  const url = req.originalUrl?.toLowerCase() || '';
  if (url.includes('/products'))  return FOLDER_MAP.products;
  if (url.includes('/vendors'))   return FOLDER_MAP.vendors;
  if (url.includes('/portal'))    return FOLDER_MAP.portal;
  if (url.includes('/public-site') || url.includes('/publicapp')) return FOLDER_MAP.publicApp;
  if (url.includes('/store'))     return FOLDER_MAP.store;
  return 'website/misc';
};

// ── Core upload ───────────────────────────────────────────────────────────────

/**
 * Upload a buffer directly to R2.
 * Used internally and by processProductImage flow.
 *
 * @param {Buffer}  buffer
 * @param {string}  folder   e.g. "website/internalApp/products"
 * @param {string}  ext      e.g. ".webp"
 * @param {string}  mimeType e.g. "image/webp"
 * @param {string}  [customKey]  override the auto-generated uuid key
 * @returns {Promise<{ key: string, url: string }>}
 */
const uploadBuffer = async (buffer, folder, ext, mimeType, customKey) => {
  const key = customKey || `${folder}/${uuidv4()}${ext}`;
  await r2.send(new PutObjectCommand({
    Bucket:      BUCKET(),
    Key:         key,
    Body:        buffer,
    ContentType: mimeType,
  }));
  const url = `${PUBLIC_URL()}/${key}`;
  logger.debug('R2 upload complete', { key, size: buffer.length });
  return { key, url };
};

/**
 * Upload a multer memoryStorage file to R2.
 * Automatically converts images to WebP (via sharp) for consistent storage.
 *
 * @param {Express.Multer.File}         file   multer file (must have .buffer)
 * @param {import('express').Request}   req    used to resolve target folder
 * @param {object}  [opts]
 * @param {boolean} [opts.skipWebp=false]  set true for non-image files or when you need original format
 * @param {string}  [opts.customKey]       override generated key (used by AI proc replacement)
 * @returns {Promise<{ key: string, url: string }>}
 */
const uploadFile = async (file, req, opts = {}) => {
  const folder = resolveFolder(req);
  const isImage = file.mimetype.startsWith('image/');

  if (isImage && !opts.skipWebp) {
    // Convert to WebP — matches your existing sharp pipeline
    const webpBuf = await sharp(file.buffer)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 88 })
      .toBuffer();
    return uploadBuffer(webpBuf, folder, '.webp', 'image/webp', opts.customKey);
  }

  const ext = path.extname(file.originalname).toLowerCase() || '';
  return uploadBuffer(file.buffer, folder, ext, file.mimetype, opts.customKey);
};

/**
 * Delete a file from R2 by its key.
 * Non-fatal — logs warning on failure instead of throwing.
 *
 * @param {string} key  e.g. "website/internalApp/products/uuid.webp"
 */
const deleteFromR2 = async (key) => {
  if (!key) return;
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key }));
    logger.debug('R2 file deleted', { key });
  } catch (err) {
    logger.warn('R2 file delete failed (non-fatal)', { key, error: err.message });
  }
};

module.exports = { uploadFile, uploadBuffer, deleteFromR2, resolveFolder, FOLDER_MAP };