'use strict';
/**
 * services/media/oneDriveMediaService.js
 *
 * OneDrive operations for product videos. Only ever called from background
 * jobs (never inside an HTTP request), so it is free to take minutes.
 *
 *   uploadLargeFile()  Graph upload session, 10 MiB chunks, each chunk
 *                      retried with exponential backoff. If a chunk still
 *                      fails, the session is cancelled and the error bubbles
 *                      up so the job queue retries the whole upload later.
 *   getStreamUrl()     short-lived pre-authenticated download URL a <video>
 *                      tag can play directly (cached ~45 min; Graph issues
 *                      them for ~1 hour).
 *   deleteItem()       idempotent delete (404 is treated as success).
 *
 * Folder layout (utils/oneDrivePaths.js picks the root per NODE_ENV):
 *   development/products/{Product folder}/video.mp4
 *   website/products/{Product folder}/video.mp4
 */
const fs = require('fs');
const axios = require('axios');
const { getAccessToken, getOrCreateFolder, driveBase } = require('../msGraphService');
const { withRetry } = require('../../lib/resilience/retry');
const { odvPath } = require('../../utils/oneDrivePaths');
const logger = require('../../utils/logger').child({ module: 'oneDriveMediaService' });

// Graph requires chunk sizes that are multiples of 320 KiB; 10 MiB = 32 × 320 KiB.
const CHUNK_SIZE = 10 * 1024 * 1024;
const GRAPH_TIMEOUT_MS = 30_000;
const CHUNK_TIMEOUT_MS = 120_000;
const STREAM_URL_TTL_MS = 45 * 60 * 1000;

const authHeaders = async () => ({ Authorization: `Bearer ${await getAccessToken()}` });

/** Safe OneDrive folder/file name: letters, numbers, space, dash, underscore, dot, brackets. */
const safeName = (value, fallback) => {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9 ._()-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return cleaned || fallback;
};

/**
 * Folder for a catalogue product's media. The short id suffix keeps two
 * products with the same name from sharing (and overwriting) a folder.
 */
const productFolderSegments = (product) => {
  const base = safeName([product.brand, product.name].filter(Boolean).join(' '), 'product');
  return odvPath('products', `${base} (${String(product._id).slice(-6)})`);
};

/** Partner-uploaded videos keep the existing supplier-folder convention. */
const supplierFolderSegments = (supplierName, productName) =>
  odvPath('supplier folder', safeName(supplierName, 'unknown-supplier'), safeName(productName, 'untitled-product'));

const ensureFolder = async (segments) => {
  let parentId = 'root';
  for (const segment of segments) {
    // eslint-disable-next-line no-await-in-loop
    parentId = await withRetry(() => getOrCreateFolder(parentId, segment), { label: 'onedrive.folder', retries: 4 });
  }
  return parentId;
};

const createUploadSession = async (folderId, fileName) => {
  const res = await withRetry(async () => axios.post(
    `${driveBase()}/items/${folderId}:/${encodeURIComponent(fileName)}:/createUploadSession`,
    { item: { '@microsoft.graph.conflictBehavior': 'rename' } },
    { headers: { ...(await authHeaders()), 'Content-Type': 'application/json' }, timeout: GRAPH_TIMEOUT_MS }
  ), { label: 'onedrive.createUploadSession' });
  return res.data.uploadUrl;
};

const readChunk = async (fd, offset, length) => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await fd.read(buffer, 0, length, offset);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
};

/**
 * Upload a local file to OneDrive in 10 MiB chunks through one upload session.
 * @returns {Promise<{ itemId, webUrl, name, size, path }>}
 */
const uploadLargeFile = async ({ folderSegments, fileName, filePath, mimeType, onProgress, signal }) => {
  const { size } = await fs.promises.stat(filePath);
  if (!size) throw new Error('Uploaded file is empty.');

  const folderId = await ensureFolder(folderSegments);
  const uploadUrl = await createUploadSession(folderId, fileName);
  const fd = await fs.promises.open(filePath, 'r');
  let offset = 0;
  let item = null;

  try {
    while (offset < size) {
      if (signal?.aborted) throw new Error('Upload aborted — worker shutting down.');
      const length = Math.min(CHUNK_SIZE, size - offset);
      const chunk = await readChunk(fd, offset, length);
      const start = offset;

      // The upload URL is pre-authenticated — Graph rejects an Authorization header on it.
      // eslint-disable-next-line no-await-in-loop
      const res = await withRetry(() => axios.put(uploadUrl, chunk, {
        headers: {
          'Content-Length': chunk.length,
          'Content-Range': `bytes ${start}-${start + chunk.length - 1}/${size}`,
          'Content-Type': mimeType || 'application/octet-stream',
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: CHUNK_TIMEOUT_MS,
        signal,
      }), { label: 'onedrive.chunk', retries: 5 });

      if (res.status === 200 || res.status === 201) {
        item = res.data;
        offset = size;
      } else {
        const ranges = res.data?.nextExpectedRanges;
        offset = ranges?.length ? Number(ranges[0].split('-')[0]) : start + chunk.length;
      }
      onProgress?.(Math.min(size, offset), size);
    }
  } catch (err) {
    // Best effort: cancel the session so OneDrive doesn't keep a partial file.
    axios.delete(uploadUrl, { timeout: 10_000 }).catch(() => {});
    throw err;
  } finally {
    await fd.close();
  }

  if (!item) throw new Error('OneDrive did not confirm the upload.');
  const path = `${folderSegments.join('/')}/${item.name}`;
  logger.info('Large file uploaded to OneDrive', { path, itemId: item.id, size });
  return { itemId: item.id, webUrl: item.webUrl, name: item.name, size: item.size || size, path };
};

// ── Streaming ────────────────────────────────────────────────────────────────
const streamUrlCache = new Map(); // itemId -> { url, expiresAt }

const getStreamUrl = async (itemId) => {
  const cached = streamUrlCache.get(itemId);
  if (cached && cached.expiresAt > Date.now()) {
    return { url: cached.url, expiresInSeconds: Math.round((cached.expiresAt - Date.now()) / 1000) };
  }
  const { data } = await withRetry(async () => axios.get(
    `${driveBase()}/items/${itemId}?select=id,name,file,@microsoft.graph.downloadUrl`,
    { headers: await authHeaders(), timeout: 8_000 }
  ), { label: 'onedrive.downloadUrl', retries: 2, maxMs: 2_000 });

  const url = data['@microsoft.graph.downloadUrl'];
  if (!url) throw new Error('OneDrive returned no download URL.');
  streamUrlCache.set(itemId, { url, expiresAt: Date.now() + STREAM_URL_TTL_MS });
  if (streamUrlCache.size > 500) streamUrlCache.delete(streamUrlCache.keys().next().value);
  return { url, expiresInSeconds: STREAM_URL_TTL_MS / 1000, mimeType: data.file?.mimeType || 'video/mp4' };
};

/**
 * Resolve a legacy OneDrive path (e.g. SupplierProduct.videoOneDrivePath,
 * saved before item ids were stored) to an item id.
 */
const itemIdForPath = async (path) => {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const { data } = await withRetry(async () => axios.get(
    `${driveBase()}/root:/${encoded}?select=id`,
    { headers: await authHeaders(), timeout: 8_000 }
  ), { label: 'onedrive.resolvePath', retries: 2, maxMs: 2_000 });
  return data.id;
};

const deleteItem = async (itemId) => {
  if (!itemId) return;
  streamUrlCache.delete(itemId);
  try {
    await withRetry(async () => axios.delete(`${driveBase()}/items/${itemId}`, {
      headers: await authHeaders(), timeout: GRAPH_TIMEOUT_MS,
    }), { label: 'onedrive.delete' });
  } catch (err) {
    if (err.response?.status === 404) return;
    throw err;
  }
};

module.exports = {
  uploadLargeFile, getStreamUrl, itemIdForPath, deleteItem,
  productFolderSegments, supplierFolderSegments, safeName, CHUNK_SIZE,
};
