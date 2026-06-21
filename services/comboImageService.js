'use strict';
/**
 * backend/services/comboImageService.js
 *
 * Stitches N product images into one composite "combo" image, the same way
 * productRoutes.js's downloadAndSave() / upload-images route already does
 * resize→webp→disk for individual product galleries — this just composites
 * onto a single canvas instead of saving each image separately.
 *
 * Only called from clientPortalRoutes.js's POST /:slug/combos route, at the
 * moment an admin publishes a candidate — never during stateless generation.
 *
 * IMPORTANT — path choice is deliberate, not arbitrary:
 * Combo images are stored under .../uploads/internalApp/products/_combo-bundles/,
 * i.e. inside the SAME path tree as regular product images, not a sibling
 * .../uploads/internalApp/combos/ folder. Regular product images already render
 * fine on the public, unauthenticated client portal — which means whatever
 * static-file-serving rule in server.js makes /uploads/internalApp/products/...
 * publicly viewable is scoped to that specific subpath. A brand-new sibling
 * folder isn't covered by that rule and falls through to your default
 * auth-required static handler (401 "Access denied. Please log in..."), even
 * though the portal page itself is public. Reusing the already-public path
 * sidesteps that without needing to touch server.js. If you'd rather give
 * combo images their own dedicated public folder long-term, that requires a
 * matching change in server.js's static-serving setup — happy to wire that up
 * if you share that file.
 */

const sharp = require('sharp');
const fs    = require('fs');
const path  = require('path');

// '_combo-bundles' (leading underscore, hyphenated) is deliberately unlikely to
// collide with any real product category name created via the admin's
// CustomCreatableSelect category field.
const COMBO_BASE = path.join(process.cwd(), 'public', 'uploads', 'internalApp', 'products', '_combo-bundles');

/**
 * stitchComboImage
 * @param {string[]} absoluteImagePaths - resolved disk paths of each component product's image
 * @param {string} portalSlug - used as the folder name (human-readable, matches /p/:slug URLs)
 * @param {string} comboSignature - sorted-productIds dedupe key, used to name the file
 * @returns {Promise<string>} the public /uploads/... URL of the stitched image
 */
async function stitchComboImage(absoluteImagePaths, portalSlug, comboSignature) {
  const usable = absoluteImagePaths.filter(p => p && fs.existsSync(p));
  if (usable.length === 0) {
    throw new Error('No usable product images to stitch — every selected product is missing an image.');
  }

  const TILE = 420;
  const COLS = Math.min(3, usable.length);
  const ROWS = Math.ceil(usable.length / COLS);

  const tiles = await Promise.all(
    usable.map((imgPath) =>
      sharp(imgPath).resize(TILE, TILE, { fit: 'cover' }).toBuffer()
    )
  );

  const composites = tiles.map((buf, i) => ({
    input: buf,
    left: (i % COLS) * TILE,
    top: Math.floor(i / COLS) * TILE,
  }));

  const outBuf = await sharp({
    create: {
      width: TILE * COLS,
      height: TILE * ROWS,
      channels: 4,
      background: { r: 250, g: 248, b: 245, alpha: 1 }, // matches the app's off-white token
    },
  })
    .composite(composites)
    .webp({ quality: 88 })
    .toBuffer();

  const safeSlug = (portalSlug || 'unknown-portal').replace(/[^a-zA-Z0-9-]/g, '');
  const dir = path.join(COMBO_BASE, safeSlug);
  fs.mkdirSync(dir, { recursive: true });

  const safeSig = (comboSignature || `${Date.now()}`).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  const filename = `combo-${safeSig}-${Date.now()}.webp`;
  fs.writeFileSync(path.join(dir, filename), outBuf);

  return `/uploads/internalApp/products/_combo-bundles/${safeSlug}/${filename}`;
}

module.exports = { stitchComboImage };