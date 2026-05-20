/**
 * lib/storage/storageRouter.js
 *
 * The single source of truth for "which file goes where".
 *
 * Decision table
 * ──────────────
 * mimetype          | route context        | destination
 * ──────────────────|─────────────────────|──────────────────────────────
 * image/*           | req.isInvoice=true   | OneDrive  /Invoices/{FY}/{Month}
 * application/pdf   | any                  | OneDrive  /Invoices/{FY}/{Month}
 * image/*           | everything else      | Cloudflare R2
 * video/*           | any                  | OneDrive  /uploads/videos
 * anything else     | any                  | OneDrive  /uploads/files
 *
 * Usage in route files:
 *
 *   // Mark a route as invoice-related so images also go to OneDrive:
 *   router.post('/create', (req, _res, next) => { req.isInvoice = true; next(); }, upload.single('file'), handler)
 *
 *   // Mark explicit R2 folder (optional — auto-detected from URL otherwise):
 *   router.post('/create', (req, _res, next) => { req.r2Folder = 'products'; next(); }, upload.array('images'), handler)
 */

const { uploadToR2 } = require("./r2Client");
const { uploadInvoice, uploadVideo, uploadFile } = require("./onedriveUploader");

/**
 * Route a single multer file (memoryStorage) to the correct storage.
 *
 * @param {Express.Multer.File} file   multer file object
 * @param {import("express").Request} req   Express request (for context flags)
 * @returns {Promise<StorageResult>}
 *
 * @typedef {Object} StorageResult
 * @property {"r2"|"onedrive"}  storage     Which backend was used
 * @property {string}           url         Public/web URL to store in MongoDB
 * @property {string}           key         Storage key / path (for deletion later)
 * @property {string}           [webUrl]    OneDrive web URL (if onedrive)
 * @property {string}           [remotePath] OneDrive path (if onedrive)
 */
async function routeFile(file, req) {
  const mime = file.mimetype.toLowerCase();
  const isImage = mime.startsWith("image/");
  const isPdf = mime === "application/pdf";
  const isVideo = mime.startsWith("video/");
  const isInvoiceRoute = !!req.isInvoice;

  // ── PDF → always OneDrive Invoices ──────────────────────────────────────────
  if (isPdf) {
    const result = await uploadInvoice(file);
    return {
      storage: "onedrive",
      url: result.downloadUrl,
      key: result.remotePath,
      webUrl: result.webUrl,
      remotePath: result.remotePath,
    };
  }

  // ── Invoice image → OneDrive Invoices ───────────────────────────────────────
  if (isImage && isInvoiceRoute) {
    const result = await uploadInvoice(file);
    return {
      storage: "onedrive",
      url: result.downloadUrl,
      key: result.remotePath,
      webUrl: result.webUrl,
      remotePath: result.remotePath,
    };
  }

  // ── Regular image → R2 ──────────────────────────────────────────────────────
  if (isImage) {
    const result = await uploadToR2(file, req);
    return {
      storage: "r2",
      url: result.url,
      key: result.key,
    };
  }

  // ── Video → OneDrive /uploads/videos ────────────────────────────────────────
  if (isVideo) {
    const result = await uploadVideo(file);
    return {
      storage: "onedrive",
      url: result.downloadUrl,
      key: result.remotePath,
      webUrl: result.webUrl,
      remotePath: result.remotePath,
    };
  }

  // ── Everything else → OneDrive /uploads/files ────────────────────────────────
  const result = await uploadFile(file);
  return {
    storage: "onedrive",
    url: result.downloadUrl,
    key: result.remotePath,
    webUrl: result.webUrl,
    remotePath: result.remotePath,
  };
}

/**
 * Route multiple files in parallel.
 *
 * @param {Express.Multer.File[]} files
 * @param {import("express").Request} req
 * @returns {Promise<StorageResult[]>}
 */
async function routeFiles(files, req) {
  return Promise.all(files.map((f) => routeFile(f, req)));
}

module.exports = { routeFile, routeFiles };