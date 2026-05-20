/**
 * backend/scripts/processExistingImages.js
 *
 * ONE-TIME migration + processing script.
 * Reads existing product images from local disk (public/uploads/...),
 * processes them through Gemini AI, uploads to R2, updates MongoDB.
 *
 * WHAT IT DOES:
 *   1. Finds all products whose imageUrl is a local /uploads/... path
 *   2. Reads the file from disk
 *   3. Runs it through Gemini image processing (or sharp fallback)
 *   4. Uploads the processed WebP to R2 /website/internalApp/products/
 *   5. Updates Product.imageUrl (R2 https:// URL) + Product.imageKey (R2 key)
 *
 * Also migrates additionalImages[] in the same pass.
 *
 * Usage:
 *   node scripts/processExistingImages.js
 *   node scripts/processExistingImages.js --dry-run        (preview, no changes)
 *   node scripts/processExistingImages.js --limit 20       (process first 20 only)
 *   node scripts/processExistingImages.js --category "Bags"
 *   node scripts/processExistingImages.js --skip-ai        (upload as-is, no Gemini)
 *
 * Progress is saved to scripts/process-progress.json so if interrupted
 * you can re-run and it will skip already-migrated products.
 *
 * SAFE TO RE-RUN: products already on R2 (imageUrl starts with https://) are skipped.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const mongoose = require('mongoose');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');

const Product  = require('../models/product');
const { processProductImage } = require('../services/imageProcessingService');
const { uploadBuffer }        = require('../services/r2Service');

const PROGRESS_FILE = path.join(__dirname, 'process-progress.json');
const PUBLIC_DIR    = path.join(__dirname, '../public');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const DRY_RUN    = args.includes('--dry-run');
const SKIP_AI    = args.includes('--skip-ai');
const limitArg   = args.indexOf('--limit');
const LIMIT      = limitArg !== -1 ? parseInt(args[limitArg + 1]) : Infinity;
const catArg     = args.indexOf('--category');
const FILTER_CAT = catArg  !== -1 ? args[catArg + 1] : null;

// ── Progress tracking ─────────────────────────────────────────────────────────
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch { /* ignore corrupt file */ }
  return { processed: [], failed: [], lastRun: null };
}
function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

// ── Upload a single image buffer to R2 ───────────────────────────────────────
async function uploadToR2(buffer, category) {
  const folder = 'website/internalApp/products';
  const key    = `${folder}/${uuidv4()}.webp`;
  const { url } = await uploadBuffer(buffer, folder, '.webp', 'image/webp', key);
  return { url, key };
}

// ── Process + upload one image file ──────────────────────────────────────────
async function migrateImage(localUrl, category, skipAI) {
  const imgPath = path.join(PUBLIC_DIR, localUrl);
  if (!fs.existsSync(imgPath)) return null;

  const inputBuffer = fs.readFileSync(imgPath);

  let processedBuffer;
  if (skipAI) {
    // Upload as-is (just convert to WebP via sharp)
    const sharp = require('sharp');
    processedBuffer = await sharp(inputBuffer)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 88 })
      .toBuffer();
  } else {
    // Full Gemini AI processing
    processedBuffer = await processProductImage(inputBuffer, { category });
  }

  return uploadToR2(processedBuffer, category);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bizManager');
  console.log('✅ Connected to MongoDB');

  // Validate R2 config before starting
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_BUCKET_NAME || !process.env.R2_PUBLIC_URL) {
    console.error('❌ R2 credentials missing — check R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_PUBLIC_URL in .env');
    process.exit(1);
  }

  const progress = loadProgress();

  const query = {};
  if (FILTER_CAT) query.category = FILTER_CAT;

  // Only products whose primary image is still a local path (not already on R2)
  const products = await Product.find({
    ...query,
    imageUrl: { $regex: '^/uploads/' },  // local path only
  }).lean();

  const pending = products
    .filter(p => p.imageUrl && !progress.processed.includes(p._id.toString()))
    .slice(0, LIMIT);

  console.log(`\n📦 Total products with local images: ${products.length}`);
  console.log(`⏳ Pending migration:                ${pending.length}`);
  console.log(`✅ Already migrated:                 ${progress.processed.length}`);
  console.log(`❌ Previously failed:                ${progress.failed.length}`);
  if (FILTER_CAT) console.log(`🔍 Category filter:                  ${FILTER_CAT}`);
  if (SKIP_AI)    console.log(`⚡ AI processing:                    SKIPPED (--skip-ai)`);
  if (DRY_RUN)    console.log(`\n🔍 DRY RUN — no changes will be made`);
  console.log('\n' + '─'.repeat(70));

  let done = 0, failed = 0;

  for (const product of pending) {
    const id    = product._id.toString();
    const label = `[${done + failed + 1}/${pending.length}] ${product.name} (${product.category})`;
    process.stdout.write(`  ${label}\n`);

    if (DRY_RUN) {
      process.stdout.write(`    → would migrate: ${product.imageUrl}\n`);
      done++;
      continue;
    }

    try {
      const updateData = {};

      // ── Primary image ───────────────────────────────────────────────────────
      process.stdout.write(`    Primary image ... `);
      const primary = await migrateImage(product.imageUrl, product.category, SKIP_AI);
      if (primary) {
        updateData.imageUrl  = primary.url;
        updateData.imageKey  = primary.key;
        process.stdout.write(`✅ ${primary.url.slice(-40)}\n`);
      } else {
        process.stdout.write(`⚠  file not found on disk\n`);
      }

      // ── Additional gallery images ───────────────────────────────────────────
      if (product.additionalImages?.length) {
        const newUrls = [];
        const newKeys = [];
        for (let i = 0; i < product.additionalImages.length; i++) {
          const imgUrl = product.additionalImages[i];
          if (imgUrl?.startsWith('http')) {
            // Already on R2 — keep as-is
            newUrls.push(imgUrl);
            newKeys.push((product.additionalImageKeys || [])[i] || '');
            continue;
          }
          process.stdout.write(`    Gallery [${i + 1}/${product.additionalImages.length}] ... `);
          try {
            const sharp    = require('sharp');
            const imgPath  = path.join(PUBLIC_DIR, imgUrl);
            if (!fs.existsSync(imgPath)) {
              process.stdout.write(`⚠  not found\n`);
              continue;
            }
            const buf = fs.readFileSync(imgPath);
            const webp = await sharp(buf)
              .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
              .webp({ quality: 88 })
              .toBuffer();
            const result = await uploadToR2(webp, product.category);
            newUrls.push(result.url);
            newKeys.push(result.key);
            process.stdout.write(`✅\n`);
          } catch (galleryErr) {
            process.stdout.write(`❌ ${galleryErr.message}\n`);
          }
        }
        if (newUrls.length) {
          updateData.additionalImages    = newUrls;
          updateData.additionalImageKeys = newKeys;
        }
      }

      if (Object.keys(updateData).length > 0) {
        await Product.findByIdAndUpdate(id, { $set: updateData });
      }

      progress.processed.push(id);
      saveProgress(progress);
      done++;
    } catch (err) {
      console.log(`    ❌ ${err.message}`);
      progress.failed.push(id);
      saveProgress(progress);
      failed++;
    }

    // Small delay between products to avoid R2 rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  progress.lastRun = new Date().toISOString();
  saveProgress(progress);

  console.log('\n' + '─'.repeat(70));
  console.log(`✅ Migrated:  ${done}`);
  console.log(`❌ Failed:    ${failed}`);
  console.log(`\nProgress saved → scripts/process-progress.json`);
  if (failed > 0) {
    console.log('Tip: remove failed IDs from the "failed" array in process-progress.json and re-run.');
  }
  if (!DRY_RUN && done > 0) {
    console.log('\n⚠  Old files in public/uploads/internalApp/products/ can now be deleted.');
    console.log('   Verify images are live in R2 first, then remove the local directory.');
  }

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('\n❌ Fatal:', err.message);
  process.exit(1);
});