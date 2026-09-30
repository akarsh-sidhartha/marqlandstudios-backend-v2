'use strict';
/**
 * services/orders/orderStorage.js
 *
 * Every OneDrive operation on an order's folder, in one place:
 *
 *   <root>/orders/<client>/<FY>/<contact>/<INQ-… | QT-… | INV-…>/
 *       ├─ requirement.xlsx            (category: attachment)
 *       ├─ Screenshot 2026-09-28 …png  (category: screenshot)
 *       └─ QT-26-27-000031.pdf         (category: quote)
 *
 * The folder is named after the order's CURRENT identifier and renamed as it
 * moves inquiry → ongoing → completed. Its Graph item id is cached on the
 * order (oneDriveFolderId), so a rename never loses it and file calls skip
 * the /shares URL lookup.
 *
 * Every Graph call goes through withRetry (transient 429/5xx/network only).
 * Files are addressed by item id and always checked to live in the order's
 * folder — an id from another order (or anywhere else in the drive) is
 * refused, so the streaming endpoint can't be used to read arbitrary files.
 */
const axios = require('axios');
const OrderInquiry = require('../../models/orderInquiry');
const AppError = require('../../lib/errors/AppError');
const { withRetry } = require('../../lib/resilience/retry');
const { odvSegments } = require('../../utils/oneDrivePaths');
const graph = require('../msGraphService');
const logger = require('../../utils/logger').child({ module: 'orderStorage' });

const GRAPH_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 90_000;

const headers = async (extra = {}) => ({ Authorization: `Bearer ${await graph.getAccessToken()}`, ...extra });
const call = (label, fn) => withRetry(fn, { label: `onedrive.${label}`, retries: 3 });

// Upstream failures become a 502 the client can retry; a 404 is "not found".
const upstream = (err, what) => {
  if (err instanceof AppError) return err;
  if (err?.response?.status === 404) return AppError.notFound(`${what} was not found in OneDrive.`);
  logger.error('OneDrive call failed', { what, status: err?.response?.status, error: err?.response?.data?.error?.message || err.message });
  return AppError.upstream('OneDrive is not responding right now. Please try again in a moment.');
};

// ── Naming ────────────────────────────────────────────────────────────────────
const FORBIDDEN = /[\\/:*?"<>|#%\u0000-\u001f]/g;

/** A OneDrive-safe file/folder name (Graph rejects these characters). */
const safeName = (name, fallback = 'file') => {
  const cleaned = String(name || '').replace(FORBIDDEN, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120);
  return cleaned || fallback;
};

/** The order's current identifier, used as its folder name. */
const folderNameFor = (order) =>
  safeName((order.invoiceNumber || order.quoteNumber || order.refNumber || String(order._id)).replace(/\//g, '-'), 'order');

const financialYear = (date) => {
  const d = new Date(date || Date.now());
  const y = d.getFullYear();
  const start = d.getMonth() >= 3 ? y : y - 1;
  return `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`;
};

const parentSegments = (order) => [
  ...odvSegments('orders'),
  safeName((order.clientName || 'Unknown Client').trim(), 'Unknown Client'),
  financialYear(order.createdAt),
  safeName((order.orderPlacedBy || 'General').trim(), 'General'),
];

// ── Folder ────────────────────────────────────────────────────────────────────
const getItem = async (itemId) => {
  const { data } = await call('getItem', async () => axios.get(`${graph.driveBase()}/items/${encodeURIComponent(itemId)}`, {
    headers: await headers(), timeout: GRAPH_TIMEOUT_MS,
  }));
  return data;
};

/**
 * The order's folder id — cached, resolved from the legacy share URL, or
 * created. Never replaces an existing folder (the old create path used
 * conflictBehavior 'replace', which would wipe a folder's files).
 */
const ensureFolder = async (order) => {
  if (order.oneDriveFolderId) return order.oneDriveFolderId;

  try {
    let folderId = order.oneDriveFolderUrl ? await graph.getFolderIdFromUrl(order.oneDriveFolderUrl) : null;
    let webUrl = order.oneDriveFolderUrl || null;

    if (!folderId) {
      let parentId = 'root';
      for (const segment of [...parentSegments(order), folderNameFor(order)]) {
        parentId = await call('ensureFolder', () => graph.getOrCreateFolder(parentId, segment));
      }
      folderId = parentId;
      webUrl = (await getItem(folderId)).webUrl || null;
      logger.info('Order folder created', { orderId: order._id, folderId });
    }

    await OrderInquiry.updateOne({ _id: order._id }, { $set: { oneDriveFolderId: folderId, ...(webUrl && { oneDriveFolderUrl: webUrl }) } });
    order.oneDriveFolderId = folderId;
    return folderId;
  } catch (err) {
    throw upstream(err, 'The order folder');
  }
};

/** Renames the folder to the order's current identifier (no-op when it already matches). */
const syncFolderName = async (order) => {
  const folderId = await ensureFolder(order);
  const target = folderNameFor(order);
  const current = await getItem(folderId);
  if (current.name === target) return { folderId, renamed: false };

  const { data } = await call('rename', async () => axios.patch(`${graph.driveBase()}/items/${folderId}`, {
    name: target, '@microsoft.graph.conflictBehavior': 'rename',
  }, { headers: await headers({ 'Content-Type': 'application/json' }), timeout: GRAPH_TIMEOUT_MS }));
  await OrderInquiry.updateOne({ _id: order._id }, { $set: { oneDriveFolderUrl: data.webUrl } });
  logger.info('Order folder renamed', { orderId: order._id, from: current.name, to: data.name });
  return { folderId, renamed: true };
};

const deleteFolder = async ({ folderId, legacySegments }) => {
  try {
    if (folderId) {
      await call('deleteFolder', async () => axios.delete(`${graph.driveBase()}/items/${folderId}`, { headers: await headers(), timeout: GRAPH_TIMEOUT_MS }));
    } else if (legacySegments?.length) {
      await graph.deleteFolderByPath(legacySegments);
    }
  } catch (err) {
    if (err?.response?.status === 404) return; // already gone
    throw err;
  }
};

// ── Files ─────────────────────────────────────────────────────────────────────
const toFile = (item, extra = {}) => ({
  itemId: item.id,
  name: item.name,
  size: item.size,
  type: item.file?.mimeType || '',
  webUrl: item.webUrl || null,
  lastModified: item.lastModifiedDateTime ? Date.parse(item.lastModifiedDateTime) : null,
  isOneDrive: true,
  ...extra,
});

/** Uploads one buffer into the folder; a name clash gets "name 1.ext" instead of overwriting. */
const uploadFile = async (folderId, { buffer, name, mimeType }) => {
  const url = `${graph.driveBase()}/items/${folderId}:/${encodeURIComponent(safeName(name))}:/content`;
  try {
    const { data } = await call('upload', async () => axios.put(url, buffer, {
      params: { '@microsoft.graph.conflictBehavior': 'rename' },
      headers: await headers({ 'Content-Type': mimeType || 'application/octet-stream' }),
      timeout: UPLOAD_TIMEOUT_MS,
      maxBodyLength: Infinity,
    }));
    return toFile(data);
  } catch (err) {
    throw upstream(err, `"${name}"`);
  }
};

/** Files (not sub-folders) currently in the order's folder. */
const listFiles = async (folderId) => {
  try {
    const { data } = await call('list', async () => axios.get(`${graph.driveBase()}/items/${folderId}/children`, {
      params: { $top: 200, $select: 'id,name,size,file,folder,webUrl,lastModifiedDateTime' },
      headers: await headers(), timeout: GRAPH_TIMEOUT_MS,
    }));
    return (data.value || []).filter((i) => i.file).map((i) => toFile(i));
  } catch (err) {
    throw upstream(err, 'The order folder');
  }
};

/** Metadata of a file, verified to be inside the given folder. */
const getOwnedFile = async (folderId, itemId) => {
  let item;
  try {
    item = await getItem(itemId);
  } catch (err) {
    throw upstream(err, 'The file');
  }
  if (item.parentReference?.id !== folderId || !item.file) throw AppError.notFound('File not found on this order.');
  return item;
};

const deleteFile = async (folderId, itemId) => {
  await getOwnedFile(folderId, itemId);
  try {
    await call('deleteFile', async () => axios.delete(`${graph.driveBase()}/items/${encodeURIComponent(itemId)}`, { headers: await headers(), timeout: GRAPH_TIMEOUT_MS }));
  } catch (err) {
    if (err?.response?.status !== 404) throw upstream(err, 'The file');
  }
};

/** A readable stream of the file's bytes plus the headers to send with it. */
const openFileStream = async (folderId, itemId) => {
  const item = await getOwnedFile(folderId, itemId);
  const downloadUrl = item['@microsoft.graph.downloadUrl'];
  if (!downloadUrl) throw AppError.upstream('OneDrive did not return a download link for this file.');
  try {
    const res = await call('download', () => axios.get(downloadUrl, { responseType: 'stream', timeout: UPLOAD_TIMEOUT_MS }));
    return {
      stream: res.data,
      name: item.name,
      mimeType: item.file?.mimeType || 'application/octet-stream',
      size: item.size,
    };
  } catch (err) {
    throw upstream(err, 'The file');
  }
};

module.exports = {
  ensureFolder,
  syncFolderName,
  deleteFolder,
  uploadFile,
  listFiles,
  deleteFile,
  openFileStream,
  folderNameFor,
  parentSegments,
  safeName,
  financialYear,
};
