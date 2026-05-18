'use strict';
/**
 * backend/routes/productRoutes.js
 * Mounted at /api/products
 *
 *   GET    /meta                  — distinct brands, categories, subCategories
 *   GET    /                      — list all products
 *   GET    /:id                   — single product
 *   POST   /                      — create product (with optional image upload + background AI processing)
 *   PUT    /:id                   — update product (with optional image upload + background AI processing)
 *   DELETE /:id                   — delete product + image file
 *
 * Image gallery:
 *   POST   /:id/image-search      — Serper reverse image search
 *   POST   /:id/save-images       — download & persist selected URLs to gallery
 *   POST   /:id/upload-images     — direct multi-file upload to gallery
 *   DELETE /:id/images/:index     — remove one gallery image
 *   PUT    /:id/primary-image/:index — promote gallery image to primary
 *   PUT    /:id/video             — save video URL
 *
 * Portal:
 *   POST   /upload-temp-image     — upload image for portal discussion items (no Product doc)
 */

const express = require('express');
console.log('express loaded from ProductRoutes OK');
const router  = express.Router();
console.log('router loaded from ProductRoutes OK');
const fs      = require('fs');
console.log('fs loaded from ProductRoutes OK');
const path    = require('path');
console.log('path loaded from ProductRoutes OK');
const multer  = require('multer');
console.log('multer loaded from ProductRoutes OK');
const axios   = require('axios');
console.log('axios loaded from ProductRoutes OK');
const sharp   = require('sharp');
console.log('sharp loaded from ProductRoutes OK');

const Product      = require('../models/product');
console.log('Product loaded from ProductRoutes OK');
const ImagePrompt  = require('../models/ImagePrompt');
console.log('ImagePrompt loaded from ProductRoutes OK');
const { processProductImage } = require('../services/imageProcessingService');
console.log('processProductImage loaded from ProductRoutes OK');
const logger       = require('../utils/logger').child({ module: 'productRoutes' });
console.log('logger loaded from ProductRoutes OK');

// ─── Upload directory helpers ─────────────────────────────────────────────────

const INTERNAL_PRODUCTS_BASE = path.join(process.cwd(), 'public', 'uploads', 'internalApp', 'products');
console.log('INTERNAL_PRODUCTS_BASE value = '+INTERNAL_PRODUCTS_BASE);

const safeCategoryName = (category) =>
  (category || 'uncategorised').trim()
    .replace(/[^a-zA-Z0-9_\- ]/g, '')
    .replace(/\s+/g, '_');

const getCategoryDir = (category) => {
  const dir = path.join(INTERNAL_PRODUCTS_BASE, safeCategoryName(category));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const getCategoryUrl = (category, filename) =>
  `/uploads/internalApp/products/${safeCategoryName(category)}/${filename}`;

// ─── Image gallery helper — download remote URL → WebP → disk ─────────────────
async function downloadAndSave(remoteUrl, category) {
  const res = await axios.get(remoteUrl, {
    responseType:     'arraybuffer',
    timeout:          15_000,
    headers:          { 'User-Agent': 'Mozilla/5.0 (compatible; ProductGalleryBot/1.0)', Accept: 'image/*,*/*' },
    maxContentLength: 10 * 1024 * 1024,
  });
  const contentType = res.headers['content-type'] || '';
  if (!contentType.startsWith('image/')) throw new Error(`Not an image: ${contentType}`);

  const processed = await sharp(Buffer.from(res.data))
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88 })
    .toBuffer();
  const filename    = `gallery-${Date.now()}-${Math.round(Math.random() * 1e6)}.webp`;
  fs.writeFileSync(path.join(getCategoryDir(category), filename), processed);
  return getCategoryUrl(category, filename);
}

// ─── Shared: resolve AI prompt (text → saved prompt → category default) ───────
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

// ─── Multer configuration ─────────────────────────────────────────────────────
// Destination reads req.body.category so files go straight into the right subfolder.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, getCategoryDir(req.body.category)),
  filename:    (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${file.fieldname}-${unique}${path.extname(file.originalname)}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });


// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /meta
 * Returns distinct brands, categories, and subCategory map.
 * Used to populate filter dropdowns — must stay fast.
 */
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
      if (!subCategories[p.category].includes(p.subCategory)) {
        subCategories[p.category].push(p.subCategory);
      }
    }

    res.json({ brands, categories, subCategories });
  } catch (err) {
    logger.error('Failed to fetch product meta', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

/**
 * GET /
 * List all products, newest first.
 * .lean() returns plain JS objects — significantly faster for large catalogues.
 */
router.get('/', async (req, res) => {
  try {
    const products = await Product.find().sort({ updatedAt: -1 }).lean();
    logger.debug('Products listed', { count: products.length, userId: req.user?.id });
    res.json(products);
  } catch (err) {
    logger.error('Failed to list products', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

/**
 * GET /:id
 */
router.get('/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: 'Product not found.' });
    res.json(product);
  } catch (err) {
    logger.error('Failed to fetch product', { productId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /
 * Create a product. Responds immediately; AI image processing runs in background.
 */
router.post('/', upload.single('image'), async (req, res) => {
  try {
    const category = req.body.category || 'uncategorised';
    const imageUrl = req.file ? getCategoryUrl(category, req.file.filename) : '';
    const product  = new Product({ ...req.body, imageUrl });
    await product.save();

    logger.info('Product created', {
      productId: product._id,
      name:      product.name,
      category,
      userId:    req.user?.id,
    });

    // Respond before AI processing — client should never wait for this
    res.status(201).json(product);

    if (req.file && req.body.processImage === 'true') {
      setImmediate(async () => {
        try {
          const finalPrompt = await resolvePrompt(req.body.promptText, req.body.promptId, category);
          const inputBuf    = fs.readFileSync(path.join(process.cwd(), 'public', imageUrl));
          const processed   = await processProductImage(inputBuf, { category, promptText: finalPrompt });
          const procFilename = req.file.filename.replace(/\.[^.]+$/, '-proc.webp');
          fs.writeFileSync(path.join(getCategoryDir(category), procFilename), processed);
          const procUrl = getCategoryUrl(category, procFilename);
          await Product.findByIdAndUpdate(product._id, { imageUrl: procUrl });
          logger.info('Background image processing complete', { productId: product._id, name: product.name });
        } catch (e) {
          logger.error('Background image processing failed', { productId: product._id, error: e.message, stack: e.stack });
        }
      });
    }
  } catch (err) {
    logger.error('Product creation failed', { error: err.message, stack: err.stack, userId: req.user?.id });
    res.status(400).json({ message: err.message });
  }
});

/**
 * PUT /:id
 * Update a product. Responds immediately; AI image processing runs in background.
 */
router.put('/:id', upload.single('image'), async (req, res) => {
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
    };

    if (req.file) {
      updateData.imageUrl = getCategoryUrl(category, req.file.filename);
      // Delete old image file — non-fatal if it fails
      if (existing.imageUrl) {
        const oldPath = path.join(process.cwd(), 'public', existing.imageUrl);
        if (fs.existsSync(oldPath)) {
          try { fs.unlinkSync(oldPath); }
          catch (e) { logger.warn('Old image cleanup failed', { path: oldPath, error: e.message }); }
        }
      }
    } else {
      updateData.imageUrl = existing.imageUrl;
    }

    const updated = await Product.findByIdAndUpdate(req.params.id, { $set: updateData }, { new: true, runValidators: true });

    logger.info('Product updated', { productId: req.params.id, name: updated.name, userId: req.user?.id });
    res.json(updated);

    if (req.file && req.body.processImage === 'true') {
      setImmediate(async () => {
        try {
          const finalPrompt = await resolvePrompt(req.body.promptText, req.body.promptId, category);
          const inputBuf    = fs.readFileSync(path.join(process.cwd(), 'public', updateData.imageUrl));
          const processed   = await processProductImage(inputBuf, { category, promptText: finalPrompt });
          const procFilename = req.file.filename.replace(/\.[^.]+$/, '-proc.webp');
          fs.writeFileSync(path.join(getCategoryDir(category), procFilename), processed);
          const procUrl = getCategoryUrl(category, procFilename);
          await Product.findByIdAndUpdate(req.params.id, { imageUrl: procUrl });
          logger.info('Background image processing complete (update)', { productId: req.params.id, name: updated.name });
        } catch (e) {
          logger.error('Background image processing failed (update)', { productId: req.params.id, error: e.message, stack: e.stack });
        }
      });
    }
  } catch (err) {
    logger.error('Product update failed', { productId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

/**
 * DELETE /:id
 * Deletes product and its primary image file from disk.
 */
router.delete('/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found.' });

    if (product.imageUrl) {
      const abs = path.join(process.cwd(), 'public', product.imageUrl);
      if (fs.existsSync(abs)) {
        try { fs.unlinkSync(abs); }
        catch (e) { logger.warn('Product image file delete failed', { path: abs, error: e.message }); }
      }
    }

    await Product.findByIdAndDelete(req.params.id);
    logger.info('Product deleted', { productId: req.params.id, name: product.name, userId: req.user?.id });
    res.json({ message: 'Product deleted.' });
  } catch (err) {
    logger.error('Product delete failed', { productId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /:id/image-search — Serper reverse image search ────────────────────
router.post('/:id/image-search', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: 'Product not found.' });

    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) {
      logger.warn('Serper API key not configured');
      return res.status(503).json({ message: 'SERPER_API_KEY not configured in .env' });
    }

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
        url:       img.imageUrl,
        thumbnail: img.thumbnailUrl || img.imageUrl,
        source:    img.source || img.link || '',
        title:     img.title  || '',
        width:     img.imageWidth  || null,
        height:    img.imageHeight || null,
      }));

    logger.debug('Image search complete', { productId: req.params.id, query, results: results.length });
    res.json({ query, results });
  } catch (err) {
    const status     = err.response?.status;
    const serperMsg  = err.response?.data?.message || err.message;
    logger.error('Serper image search failed', { productId: req.params.id, status, error: serperMsg });
    if (status === 401 || status === 403) {
      return res.status(503).json({ message: `Serper API key rejected (${status}). Check SERPER_API_KEY in .env.` });
    }
    res.status(500).json({ message: serperMsg });
  }
});

// ─── POST /:id/save-images — download & persist selected gallery URLs ──────────
router.post('/:id/save-images', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: 'Product not found.' });

    const urls = req.body.urls || [];
    if (!Array.isArray(urls) || urls.length === 0)
      return res.status(400).json({ message: 'urls array is required.' });

    const saved = [], failed = [];
    for (const url of urls) {
      try   { saved.push(await downloadAndSave(url, product.category)); }
      catch (e) { failed.push({ url, reason: e.message }); }
    }

    const next = [...(product.additionalImages || []), ...saved].slice(0, 30);
    await Product.findByIdAndUpdate(req.params.id, { additionalImages: next });

    logger.info('Gallery images saved', { productId: req.params.id, saved: saved.length, failed: failed.length, userId: req.user?.id });
    res.json({ saved, failed, total: next.length });
  } catch (err) {
    logger.error('Save images failed', { productId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /:id/upload-images — direct multi-file upload to gallery ─────────────
router.post('/:id/upload-images', upload.array('images', 20), async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: 'Product not found.' });
    if (!req.files?.length) return res.status(400).json({ message: 'No images uploaded.' });

    const category    = product.category || 'uncategorised';
    const categoryDir = getCategoryDir(category);
    const saved       = [];

    for (const file of req.files) {
      try {
        const processed   = await sharp(file.path)
          .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 88 })
          .toBuffer();
        const newFilename = file.filename.replace(/\.[^.]+$/, '') + '-gallery.webp';
        fs.writeFileSync(path.join(categoryDir, newFilename), processed);
        try { fs.unlinkSync(file.path); } catch {} // remove multer temp
        saved.push(getCategoryUrl(category, newFilename));
      } catch (e) {
        logger.warn('Image normalise failed — keeping original', { file: file.filename, error: e.message });
        saved.push(getCategoryUrl(category, file.filename));
      }
    }

    const next = [...(product.additionalImages || []), ...saved].slice(0, 30);
    await Product.findByIdAndUpdate(req.params.id, { additionalImages: next });

    logger.info('Gallery images uploaded', { productId: req.params.id, count: saved.length, userId: req.user?.id });
    res.json({ saved, total: next.length });
  } catch (err) {
    logger.error('Upload images failed', { productId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── DELETE /:id/images/:index — remove one gallery image ────────────────────
router.delete('/:id/images/:index', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: 'Product not found.' });

    const idx  = parseInt(req.params.index, 10);
    const imgs = [...(product.additionalImages || [])];
    if (idx < 0 || idx >= imgs.length)
      return res.status(400).json({ message: 'Invalid image index.' });

    const imgPath = imgs[idx];
    if (imgPath?.startsWith('/uploads/')) {
      const abs = path.join(process.cwd(), 'public', imgPath);
      if (fs.existsSync(abs)) {
        try { fs.unlinkSync(abs); }
        catch (e) { logger.warn('Gallery image file delete failed', { path: abs, error: e.message }); }
      }
    }

    imgs.splice(idx, 1);
    await Product.findByIdAndUpdate(req.params.id, { additionalImages: imgs });
    logger.info('Gallery image removed', { productId: req.params.id, index: idx, userId: req.user?.id });
    res.json({ additionalImages: imgs });
  } catch (err) {
    logger.error('Gallery image delete failed', { productId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── PUT /:id/primary-image/:index — promote gallery image to primary ──────────
router.put('/:id/primary-image/:index', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: 'Product not found.' });

    const idx  = parseInt(req.params.index, 10);
    const imgs = [...(product.additionalImages || [])];
    if (idx < 0 || idx >= imgs.length)
      return res.status(400).json({ message: 'Invalid image index.' });

    const newPrimary = imgs[idx];
    imgs[idx]        = product.imageUrl || '';

    await Product.findByIdAndUpdate(req.params.id, {
      imageUrl:         newPrimary,
      additionalImages: imgs.filter(Boolean),
    });

    logger.info('Primary image promoted', { productId: req.params.id, index: idx, userId: req.user?.id });
    res.json({ imageUrl: newPrimary, additionalImages: imgs.filter(Boolean) });
  } catch (err) {
    logger.error('Primary image promote failed', { productId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── PUT /:id/video — save video URL ─────────────────────────────────────────
router.put('/:id/video', async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { videoUrl: req.body.videoUrl?.trim() || '' },
      { new: true }
    );
    if (!product) return res.status(404).json({ message: 'Product not found.' });
    logger.info('Product video URL updated', { productId: req.params.id, userId: req.user?.id });
    res.json({ videoUrl: product.videoUrl });
  } catch (err) {
    logger.error('Video URL update failed', { productId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /upload-temp-image — portal discussion items (no Product doc) ────────
router.post('/upload-temp-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No image uploaded.' });
    const category    = req.body.category || 'uncategorised';
    const categoryDir = getCategoryDir(category);
    const processed   = await sharp(req.file.path)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 88 })
      .toBuffer();
    const newFilename = req.file.filename.replace(/\.[^.]+$/, '') + '-custom.webp';
    fs.writeFileSync(path.join(categoryDir, newFilename), processed);
    try { fs.unlinkSync(req.file.path); } catch {}

    const imageUrl = getCategoryUrl(category, newFilename);
    logger.debug('Temp image uploaded', { category, imageUrl, userId: req.user?.id });
    res.json({ imageUrl });
  } catch (err) {
    logger.error('Temp image upload failed', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;