/**
 * lib/storage/onedriveUploader.js
 *
 * Unified OneDrive uploader.
 * Replaces / wraps whatever OneDrive code you already have for invoices.
 *
 * OneDrive folder layout
 * ──────────────────────
 * website/
 *   Invoices/
 *     {FY}/          e.g. "FY2025-26"
 *       {Month}/     e.g. "May"
 *   uploads/
 *     videos/
 *     files/         ← catch-all for non-invoice, non-video attachments
 *
 * Required .env vars (same as your existing invoice integration):
 *   ONEDRIVE_CLIENT_ID
 *   ONEDRIVE_CLIENT_SECRET
 *   ONEDRIVE_TENANT_ID
 *   ONEDRIVE_DRIVE_ID         (Graph API driveId, or "me" for personal)
 *   ONEDRIVE_ROOT_FOLDER      e.g. "website"  — the top-level folder in OneDrive
 *
 * How to get ONEDRIVE_DRIVE_ID:
 *   GET https://graph.microsoft.com/v1.0/me/drives  → use id of the drive you want.
 *   For SharePoint/org use: GET /sites/{siteId}/drives
 */

const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

// ─── Auth token cache ─────────────────────────────────────────────────────────

let _tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }

  const url = `https://login.microsoftonline.com/${process.env.ONEDRIVE_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.ONEDRIVE_CLIENT_ID,
    client_secret: process.env.ONEDRIVE_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
  });

  const { data } = await axios.post(url, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  _tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return _tokenCache.token;
}

// ─── Graph API helpers ────────────────────────────────────────────────────────

function driveBase() {
  const driveId = process.env.ONEDRIVE_DRIVE_ID;
  // "me" → personal account,  otherwise → shared/org drive
  return driveId === "me"
    ? "https://graph.microsoft.com/v1.0/me/drive"
    : `https://graph.microsoft.com/v1.0/drives/${driveId}`;
}

/**
 * Upload a file to OneDrive using the simple PUT upload session.
 * For files > 4 MB you should use the resumable upload session API.
 * This implementation uses the resumable session for ALL files so it's safe.
 *
 * @param {Buffer} buffer
 * @param {string} remotePath   e.g. "website/Invoices/FY2025-26/May/invoice.pdf"
 * @param {string} mimeType
 * @returns {Promise<{ id: string, webUrl: string, downloadUrl: string }>}
 */
async function uploadBufferToOneDrive(buffer, remotePath, mimeType) {
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };
  const base = driveBase();

  // 1. Create upload session
  const sessionRes = await axios.post(
    `${base}/root:/${remotePath}:/createUploadSession`,
    { item: { "@microsoft.graph.conflictBehavior": "rename" } },
    { headers: { ...headers, "Content-Type": "application/json" } }
  );
  const uploadUrl = sessionRes.data.uploadUrl;

  // 2. Upload buffer in one shot (works up to ~250 MB in practice)
  const size = buffer.length;
  const { data } = await axios.put(uploadUrl, buffer, {
    headers: {
      "Content-Type": mimeType,
      "Content-Length": size,
      "Content-Range": `bytes 0-${size - 1}/${size}`,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  return {
    id: data.id,
    webUrl: data.webUrl,
    downloadUrl: data["@microsoft.graph.downloadUrl"] || data.webUrl,
  };
}

// ─── Folder path helpers ──────────────────────────────────────────────────────

/**
 * Returns the Indian financial year string for a given date.
 * Apr–Mar cycle, e.g. date in May 2025 → "FY2025-26"
 */
function getFY(date = new Date()) {
  const month = date.getMonth(); // 0 = Jan
  const year = date.getFullYear();
  if (month >= 3) {
    // April (3) or later → current FY
    return `FY${year}-${String(year + 1).slice(-2)}`;
  }
  return `FY${year - 1}-${String(year).slice(-2)}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function getMonthName(date = new Date()) {
  return MONTHS[date.getMonth()];
}

const ROOT = () => process.env.ONEDRIVE_ROOT_FOLDER || "website";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Upload an invoice (PDF or image) to OneDrive.
 * Path: website/Invoices/{FY}/{Month}/{uuid}{ext}
 */
async function uploadInvoice(file) {
  const now = new Date();
  const ext = path.extname(file.originalname).toLowerCase();
  const filename = `${uuidv4()}${ext}`;
  const remotePath = `${ROOT()}/Invoices/${getFY(now)}/${getMonthName(now)}/${filename}`;

  const result = await uploadBufferToOneDrive(file.buffer, remotePath, file.mimetype);
  return { ...result, remotePath };
}

/**
 * Upload a video to OneDrive.
 * Path: website/uploads/videos/{uuid}{ext}
 */
async function uploadVideo(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const filename = `${uuidv4()}${ext}`;
  const remotePath = `${ROOT()}/uploads/videos/${filename}`;

  const result = await uploadBufferToOneDrive(file.buffer, remotePath, file.mimetype);
  return { ...result, remotePath };
}

/**
 * Upload any other file (doc, xls, zip…) to OneDrive.
 * Path: website/uploads/files/{uuid}{ext}
 */
async function uploadFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const filename = `${uuidv4()}${ext}`;
  const remotePath = `${ROOT()}/uploads/files/${filename}`;

  const result = await uploadBufferToOneDrive(file.buffer, remotePath, file.mimetype);
  return { ...result, remotePath };
}

module.exports = { uploadInvoice, uploadVideo, uploadFile, getFY, getMonthName };