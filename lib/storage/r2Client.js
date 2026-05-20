/**
 * lib/storage/r2Client.js
 *
 * Cloudflare R2 client (S3-compatible via @aws-sdk/client-s3).
 *
 * R2 bucket layout
 * ─────────────────
 * website/
 *   products/    ← product images
 *   vendors/     ← vendor images
 *   portal/      ← client portal images
 *   publicApp/   ← public site images
 *
 * The public URL format (after you enable R2 public access or use a custom domain):
 *   https://<your-r2-public-domain>/website/products/<filename>
 *
 * Required .env vars:
 *   R2_ACCOUNT_ID          (from Cloudflare dashboard → R2 → top-right "API" popup)
 *   R2_ACCESS_KEY_ID       (from API token you create)
 *   R2_SECRET_ACCESS_KEY   (from API token you create)
 *   R2_BUCKET_NAME         (e.g. "marqlandstudios")
 *   R2_PUBLIC_URL          (e.g. "https://pub-xxxx.r2.dev" or your custom domain)
 */

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

// ─── Client singleton ────────────────────────────────────────────────────────

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;
const PUBLIC_URL = process.env.R2_PUBLIC_URL?.replace(/\/$/, ""); // strip trailing slash

// ─── Folder map  (route-prefix → R2 folder) ──────────────────────────────────
//
// Pass the Express route hint via req.r2Folder (set in the route before multer)
// OR let the auto-detect below pick from the URL path.
//
const FOLDER_MAP = {
  products: "website/products",
  vendors: "website/vendors",
  portal: "website/portal",
  publicApp: "website/publicApp",
};

/**
 * Derive the R2 folder from the incoming request.
 * Priority: req.r2Folder (set explicitly) > URL path keywords > fallback
 */
function resolveFolder(req) {
  if (req.r2Folder && FOLDER_MAP[req.r2Folder]) return FOLDER_MAP[req.r2Folder];

  const url = req.originalUrl.toLowerCase();
  if (url.includes("product")) return FOLDER_MAP.products;
  if (url.includes("vendor")) return FOLDER_MAP.vendors;
  if (url.includes("portal")) return FOLDER_MAP.portal;
  if (url.includes("public")) return FOLDER_MAP.publicApp;

  return "website/misc"; // safe fallback — extend as needed
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Upload a single file buffer to R2.
 *
 * @param {Object} file   - multer file object (memoryStorage) → has .buffer, .mimetype, .originalname
 * @param {Object} req    - Express request (used to resolve target folder)
 * @returns {Promise<{ key: string, url: string }>}
 */
async function uploadToR2(file, req) {
  const folder = resolveFolder(req);
  const ext = path.extname(file.originalname).toLowerCase();
  const key = `${folder}/${uuidv4()}${ext}`;

  await r2.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      // Optional: make object publicly readable (only works if bucket has public access enabled)
      // ACL: "public-read",
    })
  );

  const url = `${PUBLIC_URL}/${key}`;
  return { key, url };
}

/**
 * Delete a file from R2 by its key (the path stored in MongoDB).
 *
 * @param {string} key  e.g. "website/products/uuid.jpg"
 */
async function deleteFromR2(key) {
  await r2.send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key,
    })
  );
}

module.exports = { uploadToR2, deleteFromR2, resolveFolder, FOLDER_MAP };