'use strict';
/**
 * services/msGraphService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralised Microsoft Graph API service.
 *
 * CHANGES FROM ORIGINAL:
 *   - Added `uploadSingleFileBuffer()` — accepts a Buffer directly (for multer
 *     memoryStorage) instead of base64. Used by the new upload middleware.
 *   - `buildOrderFolderHierarchy`: root folder is no longer hardcoded as 'Orders'.
 *     It now reads orderData.folderRoot → env ONEDRIVE_ORDER_ROOT → 'website/orders'.
 *     Old path: root/Orders/{client}/{FY}/{contact}/{ref}
 *     New path: root/website/orders/{client}/{FY}/{contact}/{ref}
 *   - All other existing exports unchanged.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const axios  = require('axios');
const logger = require('../utils/logger').child({ module: 'msGraphService' });

// ── Token cache ───────────────────────────────────────────────────────────────
let _cachedToken    = null;
let _tokenExpiresAt = 0;
const TOKEN_BUFFER  = 5 * 60 * 1000;

const getAccessToken = async () => {
  if (_cachedToken && Date.now() < _tokenExpiresAt - TOKEN_BUFFER) {
    return _cachedToken;
  }
  const { MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET } = process.env;
  if (!MICROSOFT_TENANT_ID || !MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET) {
    throw new Error('Microsoft Graph credentials missing in .env');
  }
  const params = new URLSearchParams({
    client_id:     MICROSOFT_CLIENT_ID,
    scope:         'https://graph.microsoft.com/.default',
    client_secret: MICROSOFT_CLIENT_SECRET,
    grant_type:    'client_credentials',
  });
  const res = await axios.post(
    `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );
  _cachedToken    = res.data.access_token;
  _tokenExpiresAt = Date.now() + res.data.expires_in * 1000;
  return _cachedToken;
};

const authHeaders = async () => ({ Authorization: `Bearer ${await getAccessToken()}` });

// ── Helpers ───────────────────────────────────────────────────────────────────
const driveBase = () => {
  const uid = process.env.MICROSOFT_USER_ID;
  if (!uid) throw new Error('MICROSOFT_USER_ID missing from .env');
  return `https://graph.microsoft.com/v1.0/users/${uid}/drive`;
};

const sh = (n) => String(n).slice(-2).padStart(2, '0');

/** Current financial year in short format: "24-25" */
const getFinancialYear = () => {
  const d = new Date(), y = d.getFullYear();
  return d.getMonth() < 3 ? `${sh(y - 1)}-${sh(y)}` : `${sh(y)}-${sh(y + 1)}`;
};

// ── OneDrive ──────────────────────────────────────────────────────────────────

/**
 * Get or create a folder by name under parentId.
 * Handles 409 race conditions gracefully.
 */
const getOrCreateFolder = async (parentId, folderName) => {
  const h = await authHeaders();
  const enc = folderName.replace(/'/g, "''");
  try {
    const r = await axios.get(
      `${driveBase()}/items/${parentId}/children?$filter=name eq '${enc}'`,
      { headers: h }
    );
    if (r.data.value.length > 0) return r.data.value[0].id;
  } catch { /* fall through */ }

  try {
    const r = await axios.post(
      `${driveBase()}/items/${parentId}/children`,
      { name: folderName, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
      { headers: h }
    );
    return r.data.id;
  } catch (err) {
    if (err.response?.status === 409) {
      const r = await axios.get(
        `${driveBase()}/items/${parentId}/children?$filter=name eq '${enc}'`,
        { headers: h }
      );
      return r.data.value[0]?.id;
    }
    throw err;
  }
};

/**
 * Build the Orders folder hierarchy and return { folderId, folderUrl }.
 *
 * Path (new):  root/website/orders/{client}/{FY}/{contact}/{refNumber}
 * Path (old):  root/Orders/{client}/{FY}/{contact}/{refNumber}
 *
 * The root is controlled by orderData.folderRoot (passed from orderInquiryRoute
 * via ONEDRIVE_ORDER_ROOT env var).  Defaults to 'website/orders' so this
 * function is correct with no caller changes if the env var is set.
 * Fallback chain: orderData.folderRoot → env ONEDRIVE_ORDER_ROOT → 'website/orders'
 *
 * folderRoot can be a slash-separated string ('website/orders') — each segment
 * becomes its own folder level, created with getOrCreateFolder.
 */
const buildOrderFolderHierarchy = async (orderData) => {
  const h = await authHeaders();
  const clientFolder  = (orderData.clientName    || 'Unknown Client').trim();
  const fyFolder      = getFinancialYear();
  const contactFolder = (orderData.orderPlacedBy || 'General').trim();
  const refFolder     = (orderData.refNumber     || 'No-Ref').replace(/\//g, '-').trim();

  // Resolve root: caller > env > hard default
  const rootPath = (
    orderData.folderRoot ||
    process.env.ONEDRIVE_ORDER_ROOT ||
    'website/orders'
  ).replace(/^\/|\/$/g, '');  // strip any leading/trailing slashes

  // Walk down from 'root', creating each segment of the root path first,
  // then the per-order segments beneath it.
  let parentId = 'root';
  for (const segment of rootPath.split('/')) {
    parentId = await getOrCreateFolder(parentId, segment);
  }
  parentId = await getOrCreateFolder(parentId, clientFolder);
  parentId = await getOrCreateFolder(parentId, fyFolder);
  parentId = await getOrCreateFolder(parentId, contactFolder);

  const r = await axios.post(
    `${driveBase()}/items/${parentId}/children`,
    { name: refFolder, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' },
    { headers: h }
  );
  return { folderId: r.data.id, folderUrl: r.data.webUrl };
};

/**
 * Upload an array of files to a OneDrive folder.
 * Each file: { name, base64, type }
 * (Existing — unchanged, used by orderInquiry routes)
 */
const uploadFiles = async (folderId, files) => {
  if (!files?.length) return;
  const h = await authHeaders();
  for (const f of files) {
    const raw = f.base64 || f.data;
    if (!raw) continue;
    const pure = raw.includes(',') ? raw.split(',')[1] : raw;
    await axios.put(
      `${driveBase()}/items/${folderId}:/${f.name}:/content`,
      Buffer.from(pure, 'base64'),
      { headers: { ...h, 'Content-Type': f.type || 'application/octet-stream' } }
    );
  }
};

/** List children of a folder */
const listFolderContents = async (folderId) => {
  const r = await axios.get(`${driveBase()}/items/${folderId}/children`, { headers: await authHeaders() });
  return r.data.value;
};

/** Delete a single OneDrive item by ID */
const deleteFile = async (itemId) => {
  await axios.delete(`${driveBase()}/items/${itemId}`, { headers: await authHeaders() });
};

/**
 * Delete a folder by path segments.
 * e.g. ['Orders', 'Acme Corp', '24-25', 'Ravi', 'INQ-24-25-001']
 */
const deleteFolderByPath = async (segments) => {
  const p = segments.map(encodeURIComponent).join('/');
  try {
    await axios.delete(`${driveBase()}/root:/${p}`, { headers: await authHeaders() });
  } catch (err) {
    if (err.response?.status !== 404) throw err;
    logger.warn('OneDrive folder not found — skipping deletion', { path: segments.join('/') });
  }
};

/** Rename a OneDrive item. Returns new webUrl or null. */
const renameItem = async (itemId, newName) => {
  const r = await axios.patch(
    `${driveBase()}/items/${itemId}`,
    { name: newName },
    { headers: { ...await authHeaders(), 'Content-Type': 'application/json' } }
  );
  return r.data?.webUrl || null;
};

/** Resolve a sharing URL to a drive item ID */
const getFolderIdFromUrl = async (url) => {
  if (!url) return null;
  try {
    const b64 = Buffer.from(url).toString('base64');
    const tok = 'u!' + b64.replace(/=/g, '').replace(/\//g, '_').replace(/\+/g, '-');
    const r   = await axios.get(
      `https://graph.microsoft.com/v1.0/shares/${tok}/driveItem`,
      { headers: await authHeaders() }
    );
    return r.data.id;
  } catch (err) {
    logger.error('getFolderIdFromUrl failed', { url, error: err.response?.data?.message || err.message });
    return null;
  }
};

/**
 * Upload a single file (base64) to OneDrive — EXISTING, unchanged.
 * Used by invoice, PI attachment, and payment screenshot uploads.
 *
 * @param {string[]} folderPath - e.g. ['Invoices', '25-26', 'May']
 * @param {string}   filename
 * @param {string}   base64     raw base64 or data URI
 * @param {string}   mimeType
 * @returns {Promise<{ fileId, webUrl }>}
 */
const uploadSingleFile = async (folderPath, filename, base64, mimeType) => {
  const h = await authHeaders();
  let parentId = 'root';
  for (const segment of folderPath) {
    parentId = await getOrCreateFolder(parentId, segment);
  }
  const pure = base64.includes(',') ? base64.split(',')[1] : base64;
  const r = await axios.put(
    `${driveBase()}/items/${parentId}:/${filename}:/content`,
    Buffer.from(pure, 'base64'),
    { headers: { ...h, 'Content-Type': mimeType || 'application/octet-stream' } }
  );
  return { fileId: r.data.id, webUrl: r.data.webUrl };
};

/**
 * NEW — Upload a Buffer directly to OneDrive.
 * Used by the upload middleware for multer memoryStorage files.
 * Replaces the base64 conversion step — cleaner and faster.
 *
 * @param {string[]} folderPath  e.g. ['Invoices', '25-26', 'May']
 * @param {string}   filename    e.g. 'uuid.pdf'
 * @param {Buffer}   buffer      file buffer from req.file.buffer
 * @param {string}   mimeType    e.g. 'application/pdf'
 * @returns {Promise<{ fileId: string, webUrl: string }>}
 */
const uploadSingleFileBuffer = async (folderPath, filename, buffer, mimeType) => {
  const h = await authHeaders();
  let parentId = 'root';
  for (const segment of folderPath) {
    parentId = await getOrCreateFolder(parentId, segment);
  }
  const r = await axios.put(
    `${driveBase()}/items/${parentId}:/${filename}:/content`,
    buffer,
    { headers: { ...h, 'Content-Type': mimeType || 'application/octet-stream' } }
  );
  logger.debug('OneDrive buffer upload complete', { path: folderPath.join('/'), filename });
  return { fileId: r.data.id, webUrl: r.data.webUrl };
};

// ── Outlook ───────────────────────────────────────────────────────────────────

/**
 * Scan all org mailboxes for attachments (images/PDFs) since sinceISO.
 */
const scanMailboxesForAttachments = async (sinceISO) => {
  const h       = await authHeaders();
  const GRAPH   = 'https://graph.microsoft.com/v1.0';
  const results = [];

  const users = (await axios.get(`${GRAPH}/users?$select=id,userPrincipalName`, { headers: h })).data.value;

  for (const user of users) {
    try {
      const msgs = (await axios.get(
        `${GRAPH}/users/${user.id}/messages?$filter=hasAttachments eq true and receivedDateTime ge ${sinceISO}&$select=id,subject,from`,
        { headers: h }
      )).data.value;

      for (const msg of msgs) {
        const atts = (await axios.get(
          `${GRAPH}/users/${user.id}/messages/${msg.id}/attachments`,
          { headers: h }
        )).data.value;

        for (const att of atts) {
          if (att.contentType?.startsWith('image/') || att.contentType === 'application/pdf') {
            results.push({
              contentBytes: att.contentBytes,
              contentType:  att.contentType,
              subject:      msg.subject,
              fromEmail:    msg.from?.emailAddress?.address,
              userEmail:    user.userPrincipalName,
            });
          }
        }
      }
    } catch {
      // No mailbox or no permission — skip silently
    }
  }
  return results;
};

/** Get the month name from a date */
const getMonthName = (date) =>
  new Date(date).toLocaleString('default', { month: 'long' });

module.exports = {
  getAccessToken,
  getOrCreateFolder,
  buildOrderFolderHierarchy,
  uploadFiles,
  uploadSingleFile,
  uploadSingleFileBuffer,          // NEW
  listFolderContents,
  deleteFile,
  deleteFolderByPath,
  renameItem,
  getFolderIdFromUrl,
  scanMailboxesForAttachments,
  getFinancialYear,
  getMonthName,
};