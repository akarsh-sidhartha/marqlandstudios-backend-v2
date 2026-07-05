'use strict';
/**
 * backend/routes/productRoutes.js
 * Mounted at /api/products
 *
 * STORAGE CHANGES:
 *   - Removed: multer diskStorage, getCategoryDir, INTERNAL_PRODUCTS_BASE, getCategoryUrl
 *   - Added:   upload = require('../middleware/upload')  [imageOnly variant]
 *   - Added:   deleteFromR2 for cleanup on delete/replace
 *   - Images now live in R2 at: website/internalApp/products/{uuid}.webp
 *   - Background AI processing now uploads processed buffer directly to R2
 *     (replaces the same key so the URL in MongoDB stays the same)
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const sharp   = require('sharp');

const Product      = require('../models/Product');
const ImagePrompt  = require('../models/ImagePrompt');
const SupplierProduct = require('../models/SupplierProduct'); // NEW — cascading deletion notice to the originating Partner
const { processProductImage } = require('../services/imageProcessingService');
const upload       = require('../middleware/upload');
const { deleteFromR2, uploadBuffer, resolveFolder } = require('../services/r2Service');
const logger       = require('../utils/logger').child({ module: 'productRoutes' });

// ─── Shared: resolve AI prompt ────────────────────────────────────────────────
async function resolvePrompt(promptText, promptId, category) {
  if (promptText?.trim()) return promptText.trim();
  if (promptId) {
    const saved = await ImagePrompt.findById(promptId);
    if (saved) return saved.prompt;
  }
  if (category) {
    const def = await ImagePrompt.findOne({ category, isDefault: true });
    if (def) return def.prompt;
  }
  return null;
}

// ─── Image gallery helper — download remote URL → WebP → R2 ──────────────────
async function downloadAndSave(remoteUrl, req) {
  const res = await axios.get(remoteUrl, {
    responseType:     'arraybuffer',
    timeout:          15_000,
    headers:          { 'User-Agent': 'Mozilla/5.0 (compatible; ProductGalleryBot/1.0)', Accept: 'image/*,*/*' },
    maxContentLength: 10 * 1024 * 1024,
  });
  const contentType = res.headers['content-type'] || '';
  if (!contentType.startsWith('image/')) throw new Error(`Not an image: ${contentType}`);

  const webpBuf = await sharp(Buffer.from(res.data))
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88 })
    .toBuffer();

  // req.r2Folder already set to 'products' by the route — resolveFolder picks it up
  const folder = resolveFolder(req);
  const result = await uploadBuffer(webpBuf, folder, '.webp', 'image/webp');
  return result; // { key, url }
}


// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/meta', async (req, res) => {
  try {
    const [brands, categories, products] = await Promise.all([
      Product.distinct('brand'),
      Product.distinct('category'),
      Product.find({}, 'category subCategory').lean(),
    ]);
    const subCategories = {};
    for (const p of products) {
      if (!p.category || !p.subCategory) continue;
      if (!subCategories[p.category]) subCategories[p.category] = [];
      if (!subCategories[p.category].includes(p.subCategory))
        subCategories[p.category].push(p.subCategory);
    }
    res.json({ brands, categories, subCategories });
  } catch (err) {
    logger.error('Failed to fetch product meta', { error: err.message });
    res.status(500).json({ message: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const products = await Product.find().sort({ updatedAt: -1 }).lean();
    res.json(products);
  } catch (err) {
    logger.error('Failed to list products', { error: err.message });
    res.status(500).json({ message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: 'Product not found.' });
    res.json(product);
  } catch (err) {
    logger.error('Failed to fetch product', { productId: req.params.id, error: err.message });
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /
 * Create product. Responds immediately; AI processing runs in background.
 *
 * CHANGED:
 *   - upload.imageOnly.single('image')  ← was multer diskStorage
 *   - imageUrl = req.uploadedFile.url   ← was getCategoryUrl(category, req.file.filename)
 *   - imageKey stored for later R2 deletion
 *   - Background AI: uploads processed buffer back to R2 replacing the same key
 */
router.post('/',
  (req, _res, next) => { req.r2Folder = 'products'; next(); },
  upload.imageOnly.single('image'),
  async (req, res) => {
    try {
      const category = req.body.category || 'uncategorised';
      const imageUrl = req.uploadedFile?.url || '';
      const imageKey = req.uploadedFile?.key || '';

      const product = new Product({ ...req.body, imageUrl, imageKey });
      await product.save();

      logger.info('Product created', { productId: product._id, name: product.name, category, userId: req.user?.id });
      res.status(201).json(product);

      // Background AI processing — replaces uploaded image with AI-processed version
      if (req.file && req.body.processImage === 'true' && imageKey) {
        setImmediate(async () => {
          try {
            const finalPrompt = await resolvePrompt(req.body.promptText, req.body.promptId, category);
            const processed   = await processProductImage(req.file.buffer, { category, promptText: finalPrompt });
            // Re-upload processed buffer to the same R2 key → URL in MongoDB stays valid
            await uploadBuffer(processed, imageKey.replace(/\/[^/]+$/, ''), '.webp', 'image/webp', imageKey);
            logger.info('Background image processing complete', { productId: product._id });
          } catch (e) {
            logger.error('Background image processing failed', { productId: product._id, error: e.message });
          }
        });
      }
    } catch (err) {
      logger.error('Product creation failed', { error: err.message, userId: req.user?.id });
      res.status(400).json({ message: err.message });
    }
  }
);

/**
 * PUT /:id
 * Update product.
 *
 * CHANGED:
 *   - No more fs.unlinkSync — deleteFromR2(existing.imageKey) instead
 *   - imageUrl + imageKey updated from req.uploadedFile
 */
router.put('/:id',
  (req, _res, next) => { req.r2Folder = 'products'; next(); },
  upload.imageOnly.single('image'),
  async (req, res) => {
    try {
      const existing = await Product.findById(req.params.id);
      if (!existing) return res.status(404).json({ message: 'Product not found.' });

      const category = req.body.category || existing.category || 'uncategorised';
      const updateData = {
        name:          req.body.name          || existing.name,
        description:   req.body.description   || existing.description,
        brand:         req.body.brand         || existing.brand,
        category,
        subCategory:   req.body.subCategory   || existing.subCategory,
        markupPercent: req.body.markupPercent  !== undefined ? Number(req.body.markupPercent)  : existing.markupPercent,
        purchasePrice: req.body.purchasePrice  !== undefined ? Number(req.body.purchasePrice)  : existing.purchasePrice,
        sellingPrice:  req.body.sellingPrice   !== undefined ? Number(req.body.sellingPrice)   : existing.sellingPrice, // NEW
      };

      if (req.uploadedFile) {
        updateData.imageUrl = req.uploadedFile.url;
        updateData.imageKey = req.uploadedFile.key;
        // Delete old R2 file — non-fatal
        if (existing.imageKey) await deleteFromR2(existing.imageKey);
      } else {
        updateData.imageUrl = existing.imageUrl;
        updateData.imageKey = existing.imageKey;
      }

      const updated = await Product.findByIdAndUpdate(
        req.params.id,
        { $set: updateData },
        { new: true, runValidators: true }
      );

      logger.info('Product updated', { productId: req.params.id, name: updated.name, userId: req.user?.id });
      res.json(updated);

      if (req.file && req.body.processImage === 'true' && updateData.imageKey) {
        setImmediate(async () => {
          try {
            const finalPrompt = await resolvePrompt(req.body.promptText, req.body.promptId, category);
            const processed   = await processProductImage(req.file.buffer, { category, promptText: finalPrompt });
            await uploadBuffer(processed, updateData.imageKey.replace(/\/[^/]+$/, ''), '.webp', 'image/webp', updateData.imageKey);
            logger.info('Background image processing complete (update)', { productId: req.params.id });
          } catch (e) {
            logger.error('Background image processing failed (update)', { productId: req.params.id, error: e.message });
          }
        });
      }
    } catch (err) {
      logger.error('Product update failed', { productId: req.params.id, error: err.message });
      res.status(500).json({ message: err.message });
    }
  }
);

/**
 * DELETE /:id
 * CHANGED: deleteFromR2(product.imageKey) instead of fs.unlinkSync
 */
router.delete('/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found.' });

    // NEW — if this product originated from a Partner submission, keep that
    // submission's record (already marked 'approved' at approval time — see
    // adminSupplierRoutes.js) but flip it to 'deleted' with the admin's
    // reason, so the partner sees why it was removed in "Review My Products".
    const reason = (req.body?.reason || '').trim();
    const originSubmission = await SupplierProduct.findOne({ convertedProductId: product._id });
    if (originSubmission) {
      originSubmission.status = 'deleted';
      originSubmission.deletionReason = reason || 'Removed by Marqland Studios.';
      await originSubmission.save();
      logger.info('Notified originating supplier of product deletion', {
        productId: product._id, supplierProductId: originSubmission._id, supplierId: originSubmission.supplier,
      });
    }

    // Delete primary image from R2
    if (product.imageKey) await deleteFromR2(product.imageKey);

    // Delete gallery images from R2
    for (const key of product.additionalImageKeys || []) {
      await deleteFromR2(key);
    }

    await Product.findByIdAndDelete(req.params.id);
    logger.info('Product deleted', { productId: req.params.id, name: product.name, userId: req.user?.id });
    res.json({ message: 'Product deleted.' });
  } catch (err) {
    logger.error('Product delete failed', { productId: req.params.id, error: err.message });
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /:id/image-search — Serper reverse image search (UNCHANGED) ─────────
router.post('/:id/image-search', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: 'Product not found.' });
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) return res.status(503).json({ message: 'SERPER_API_KEY not configured' });
    const query = req.body.query?.trim()
      || [product.brand, product.name, product.category].filter(Boolean).join(' ');
    const serperRes = await axios.post(
      'https://google.serper.dev/images',
      { q: query, num: 20, gl: 'in', hl: 'en' },
      { headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' }, timeout: 10_000 }
    );
    const results = (serperRes.data?.images || [])
      .filter(img => img.imageUrl?.startsWith('http'))
      .map(img => ({
        url: img.imageUrl, thumbnail: img.thumbnailUrl || img.imageUrl,
        source: img.source || img.link || '', title: img.title || '',
        width: img.imageWidth || null, height: img.imageHeight || null,
      }));
    res.json({ query, results });
  } catch (err) {
    const status = err.response?.status;
    logger.error('Serper image search failed', { productId: req.params.id, error: err.message });
    if (status === 401 || status === 403)
      return res.status(503).json({ message: `Serper API key rejected (${status})` });
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /:id/save-images — download & persist selected gallery URLs to R2
 * CHANGED: downloadAndSave now returns { key, url } from R2 instead of local path
 */
router.post('/:id/save-images', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: 'Product not found.' });
    const urls = req.body.urls || [];
    if (!Array.isArray(urls) || !urls.length)
      return res.status(400).json({ message: 'urls array is required.' });

    // Attach r2Folder so downloadAndSave resolves the right folder
    req.r2Folder = 'products';

    const saved = [], failed = [], savedKeys = [];
    for (const url of urls) {
      try {
        const result = await downloadAndSave(url, req);
        saved.push(result.url);
        savedKeys.push(result.key);
      } catch (e) {
        failed.push({ url, reason: e.message });
      }
    }

    const existingUrls = product.additionalImages     || [];
    const existingKeys = product.additionalImageKeys  || [];
    const nextUrls     = [...existingUrls, ...saved].slice(0, 30);
    const nextKeys     = [...existingKeys, ...savedKeys].slice(0, 30);

    await Product.findByIdAndUpdate(req.params.id, {
      additionalImages:    nextUrls,
      additionalImageKeys: nextKeys,
    });

    logger.info('Gallery images saved to R2', { productId: req.params.id, saved: saved.length, failed: failed.length });
    res.json({ saved, failed, total: nextUrls.length });
  } catch (err) {
    logger.error('Save images failed', { productId: req.params.id, error: err.message });
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /:id/upload-images — direct multi-file upload to gallery
 * CHANGED: sharp + R2 instead of sharp + fs.writeFileSync
 */
router.post('/:id/upload-images',
  (req, _res, next) => { req.r2Folder = 'products'; next(); },
  upload.imageOnly.array('images', 20),
  async (req, res) => {
    try {
      const product = await Product.findById(req.params.id).lean();
      if (!product) return res.status(404).json({ message: 'Product not found.' });
      if (!req.uploadedFiles?.length)
        return res.status(400).json({ message: 'No images uploaded.' });

      // req.uploadedFiles already contains R2 results (upload middleware ran sharp + upload)
      const saved     = req.uploadedFiles.map(f => f.url);
      const savedKeys = req.uploadedFiles.map(f => f.key);

      const existingUrls = product.additionalImages     || [];
      const existingKeys = product.additionalImageKeys  || [];
      const nextUrls     = [...existingUrls, ...saved].slice(0, 30);
      const nextKeys     = [...existingKeys, ...savedKeys].slice(0, 30);

      await Product.findByIdAndUpdate(req.params.id, {
        additionalImages:    nextUrls,
        additionalImageKeys: nextKeys,
      });

      logger.info('Gallery images uploaded to R2', { productId: req.params.id, count: saved.length });
      res.json({ saved, total: nextUrls.length });
    } catch (err) {
      logger.error('Upload images failed', { productId: req.params.id, error: err.message });
      res.status(500).json({ message: err.message });
    }
  }
);

/**
 * DELETE /:id/images/:index
 * CHANGED: deleteFromR2(key) instead of fs.unlinkSync
 */
router.delete('/:id/images/:index', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: 'Product not found.' });

    const idx   = parseInt(req.params.index, 10);
    const urls  = [...(product.additionalImages    || [])];
    const keys  = [...(product.additionalImageKeys || [])];
    if (idx < 0 || idx >= urls.length)
      return res.status(400).json({ message: 'Invalid image index.' });

    if (keys[idx]) await deleteFromR2(keys[idx]);
    urls.splice(idx, 1);
    keys.splice(idx, 1);

    await Product.findByIdAndUpdate(req.params.id, {
      additionalImages:    urls,
      additionalImageKeys: keys,
    });

    logger.info('Gallery image removed from R2', { productId: req.params.id, index: idx });
    res.json({ additionalImages: urls });
  } catch (err) {
    logger.error('Gallery image delete failed', { productId: req.params.id, error: err.message });
    res.status(500).json({ message: err.message });
  }
});

// ─── PUT /:id/primary-image/:index — promote gallery image (UNCHANGED logic) ──
router.put('/:id/primary-image/:index', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: 'Product not found.' });

    const idx  = parseInt(req.params.index, 10);
    const urls = [...(product.additionalImages    || [])];
    const keys = [...(product.additionalImageKeys || [])];
    if (idx < 0 || idx >= urls.length)
      return res.status(400).json({ message: 'Invalid image index.' });

    const newPrimaryUrl = urls[idx];
    const newPrimaryKey = keys[idx];
    urls[idx] = product.imageUrl  || '';
    keys[idx] = product.imageKey  || '';

    await Product.findByIdAndUpdate(req.params.id, {
      imageUrl:            newPrimaryUrl,
      imageKey:            newPrimaryKey,
      additionalImages:    urls.filter(Boolean),
      additionalImageKeys: keys.filter(Boolean),
    });

    logger.info('Primary image promoted', { productId: req.params.id, index: idx });
    res.json({ imageUrl: newPrimaryUrl, additionalImages: urls.filter(Boolean) });
  } catch (err) {
    logger.error('Primary image promote failed', { productId: req.params.id, error: err.message });
    res.status(500).json({ message: err.message });
  }
});

// ─── PUT /:id/video — save video URL (UNCHANGED) ─────────────────────────────
router.put('/:id/video', async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { videoUrl: req.body.videoUrl?.trim() || '' },
      { new: true }
    );
    if (!product) return res.status(404).json({ message: 'Product not found.' });
    res.json({ videoUrl: product.videoUrl });
  } catch (err) {
    logger.error('Video URL update failed', { productId: req.params.id, error: err.message });
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /upload-temp-image — portal discussion items
 * CHANGED: uploads to R2 instead of disk
 */
router.post('/upload-temp-image',
  (req, _res, next) => { req.r2Folder = 'portal'; next(); },
  upload.imageOnly.single('image'),
  async (req, res) => {
    try {
      if (!req.uploadedFile) return res.status(400).json({ message: 'No image uploaded.' });
      logger.debug('Temp image uploaded to R2', { url: req.uploadedFile.url });
      res.json({ imageUrl: req.uploadedFile.url });
    } catch (err) {
      logger.error('Temp image upload failed', { error: err.message });
      res.status(500).json({ message: err.message });
    }
  }
);

module.exports = router;