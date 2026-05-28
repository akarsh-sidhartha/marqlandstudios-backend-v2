'use strict';
/**
 * utils/oneDrivePaths.js
 *
 * Central helper for OneDrive folder paths.
 *
 * In PRODUCTION all paths sit under the real 'website' root:
 *   website/orders, website/Invoices, website/Payments, website/PI-Attachments, …
 *
 * In DEVELOPMENT every path is re-rooted under 'development' instead:
 *   development/orders, development/Invoices, development/Payments, …
 *
 * This keeps dev uploads completely isolated in a single sandbox folder so
 * you never touch production data while iterating locally.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   const { odvPath, odvSegments } = require('../utils/oneDrivePaths');
 *
 *   // Full path array — pass directly to uploadSingleFileBuffer / uploadToOneDrive
 *   odvPath('Invoices', '25-26', 'April')
 *   // production  → ['website',     'Invoices', '25-26', 'April']
 *   // development → ['development', 'Invoices', '25-26', 'April']
 *
 *   odvPath('Payments', 'PAY-00042')
 *   // production  → ['website',     'Payments', 'PAY-00042']
 *   // development → ['development', 'Payments', 'PAY-00042']
 *
 *   odvPath('PI-Attachments', 'PI-2025-001')
 *   // production  → ['website',     'PI-Attachments', 'PI-2025-001']
 *   // development → ['development', 'PI-Attachments', 'PI-2025-001']
 *
 *   // Root + bucket only — for deleteFolderByPath root segments, or folderRoot strings
 *   odvSegments('orders')
 *   // production  → ['website',     'orders']
 *   // development → ['development', 'orders']
 *
 *   odvSegments('orders').join('/')
 *   // production  → 'website/orders'
 *   // development → 'development/orders'
 *
 * ─── Adding a new bucket ─────────────────────────────────────────────────────
 *   Just call odvPath('YourNewBucket', ...rest) — no registration needed.
 *   The helper is bucket-agnostic; it only switches the root prefix.
 */

const IS_DEV = process.env.NODE_ENV !== 'production';

// Log once at startup so it is always visible in the server boot output.
// Using console.log intentionally — logger may not be initialised yet.
if (IS_DEV) {
  console.log('[oneDrivePaths] NODE_ENV=%s → OneDrive root: development/', process.env.NODE_ENV);
} else {
  console.log('[oneDrivePaths] NODE_ENV=production → OneDrive root: website/');
}

/**
 * Returns a fully-qualified OneDrive path array.
 *
 * @param {string}    bucket  Logical folder name: 'orders', 'Invoices', 'Payments', 'PI-Attachments', …
 * @param {...string} rest    Additional path segments appended after the bucket.
 * @returns {string[]}        Path array ready for msGraphService helpers.
 */
const odvPath = (bucket, ...rest) =>
  IS_DEV
    ? ['development', bucket, ...rest]
    : ['website',     bucket, ...rest];

/**
 * Returns just the [root, bucket] pair as an array.
 * Useful when you need the base segments without any deeper path
 * (e.g. deleteFolderByPath root, or building a folderRoot string).
 *
 * @param {string} bucket
 * @returns {string[]}
 */
const odvSegments = (bucket) => odvPath(bucket);

module.exports = { odvPath, odvSegments, IS_DEV };