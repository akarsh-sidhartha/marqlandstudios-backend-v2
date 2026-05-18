'use strict';
/**
 * backend/routes/imageProcessingRoutes.js
 * Mounted at /api/image-processing
 *
 * Prompt management:
 *   GET    /prompts              — list all saved prompts
 *   POST   /prompts              — create
 *   PUT    /prompts/:id          — edit
 *   DELETE /prompts/:id          — delete
 *   PATCH  /prompts/:id/default  — set as default for category
 *
 * Image processing:
 *   POST   /preview              — process image, return base64 data URL (before/after compare)
 *   POST   /process-single       — reprocess one product (non-blocking, saves to disk)
 *   POST   /pdf/same-category    — PDF → extract images → AI process → save as draft products
 *   POST   /pdf/extract          — PDF → extract raw images → download as ZIP (no AI)
 *
 * All AI processing is delegated to imageProcessingService.js — single source of truth.
 */

const express    = require('express');
const router     = express.Router();
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const zlib       = require('zlib');
const archiver   = require('archiver');
const sharp      = require('sharp');

const Product     = require('../models/Product');
const ImagePrompt = require('../models/ImagePrompt');
const { processProductImage }    = require('../services/imageProcessingService');
const { authenticate, authorize } = require('../middleware/authMiddleware');
const logger     = require('../utils/logger').child({ module: 'imageProcessingRoutes' });

const adminOnly = [authenticate, authorize(['admin', 'inventory'])];

const tmpDir = path.join(process.cwd(), 'public', 'uploads', 'internalApp', 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const pdfUpload = multer({
  dest: tmpDir,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB — product catalog PDFs can be large
  fileFilter: (req, file, cb) =>
    file.mimetype === 'application/pdf' ? cb(null, true) : cb(new Error('PDF files only')),
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Image files only')),
});

// ── Resolve prompt: explicit text → saved prompt by ID → category default ─────
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
  return null; // imageProcessingService will use its built-in default
}

// ═══════════════════════════════════════════════════════════
// PROMPT MANAGEMENT
// ═══════════════════════════════════════════════════════════

router.get('/prompts', adminOnly, async (req, res) => {
  try {
    const prompts = await ImagePrompt.find().sort({ category: 1, createdAt: 1 }).lean();
    res.json(prompts);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/prompts', adminOnly, async (req, res) => {
  try {
    const { name, category, prompt, isDefault } = req.body;
    if (!name?.trim() || !category?.trim() || !prompt?.trim())
      return res.status(400).json({ message: 'name, category and prompt are required.' });
    if (isDefault)
      await ImagePrompt.updateMany({ category, isDefault: true }, { isDefault: false });
    const p = await ImagePrompt.create({ name, category, prompt, isDefault: !!isDefault });
    res.status(201).json(p);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/prompts/:id', adminOnly, async (req, res) => {
  try {
    const { name, category, prompt, isDefault } = req.body;
    if (isDefault)
      await ImagePrompt.updateMany({ category, isDefault: true }, { isDefault: false });
    const p = await ImagePrompt.findByIdAndUpdate(
      req.params.id,
      { name, category, prompt, isDefault: !!isDefault },
      { new: true }
    );
    if (!p) return res.status(404).json({ message: 'Prompt not found.' });
    res.json(p);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/prompts/:id', adminOnly, async (req, res) => {
  try {
    const p = await ImagePrompt.findByIdAndDelete(req.params.id);
    if (!p) return res.status(404).json({ message: 'Prompt not found.' });
    res.json({ message: 'Deleted.' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/prompts/:id/default', adminOnly, async (req, res) => {
  try {
    const p = await ImagePrompt.findById(req.params.id);
    if (!p) return res.status(404).json({ message: 'Prompt not found.' });
    await ImagePrompt.updateMany({ category: p.category, isDefault: true }, { isDefault: false });
    p.isDefault = true;
    await p.save();
    res.json(p);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ═══════════════════════════════════════════════════════════
// PREVIEW — process image, return as base64 data URL.
// Image is NOT saved to disk — user decides on Save Product.
// ═══════════════════════════════════════════════════════════

router.post('/preview', adminOnly, imageUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No image uploaded.' });
    const { promptText, promptId, category } = req.body;
    const finalPrompt = await resolvePrompt(promptText, promptId, category || null);
    const processed   = await processProductImage(req.file.buffer, { category, promptText: finalPrompt });
    res.json({ imageDataUrl: `data:image/webp;base64,${processed.toString('base64')}` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// SINGLE PRODUCT RE-PROCESS
// Non-blocking: returns immediately, processes in background.
// ═══════════════════════════════════════════════════════════

router.post('/process-single', adminOnly, async (req, res) => {
  try {
    const { productId, promptText, promptId } = req.body;
    const product = await Product.findById(productId);
    if (!product)          return res.status(404).json({ message: 'Product not found.' });
    if (!product.imageUrl) return res.status(400).json({ message: 'No image on product.' });

    const imgPath = path.join(process.cwd(), 'public', product.imageUrl);
    if (!fs.existsSync(imgPath)) return res.status(404).json({ message: 'Image file missing.' });

    const finalPrompt = await resolvePrompt(promptText, promptId, product.category);
    logger.info('Product reprocess started', { productId, category: product.category, userId: req.user?.id });
    res.json({ message: 'Processing started', productId });

    setImmediate(async () => {
      try {
        const buf  = fs.readFileSync(imgPath);
        const out  = await processProductImage(buf, { category: product.category, promptText: finalPrompt });
        const name = product.imageUrl.replace(/\.[^.]+$/, '-proc.webp');
        fs.writeFileSync(path.join(process.cwd(), 'public', name), out);
        await Product.findByIdAndUpdate(productId, { imageUrl: name });
        logger.info('Product reprocess complete', { productId, name: product.name });
      } catch (e) {
        logger.error('Product reprocess failed', { productId, error: e.message, stack: e.stack });
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// PDF IMAGE EXTRACTOR
//
// Extracts all raster images from a PDF using pdf-lib + Node built-ins only.
// No canvas, no pdfjs, no native system deps beyond sharp (already required).
//
// Handles: DCTDecode (JPEG), JPXDecode (JPEG2000), FlateDecode (raw pixels / PNG).
// Recursively walks ALL XObject dicts at every nesting depth.
// ═══════════════════════════════════════════════════════════

async function extractPdfPages(pdfPath) {
  let PDFLib;
  try { PDFLib = require('pdf-lib'); }
  catch { throw new Error('pdf-lib not installed — run: npm install pdf-lib'); }

  const { PDFName, PDFDocument } = PDFLib;

  const outDir = path.join(tmpDir, `pdf_${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });

  const bytes = fs.readFileSync(pdfPath);
  const doc   = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  logger.info('PDF extraction started', { pages: pages.length, pdfPath });

  // ── Helpers ──────────────────────────────────────────────────────────────────

  const deref = (refOrObj) => {
    if (!refOrObj) return null;
    try {
      if (typeof refOrObj.tag === 'number' || refOrObj.constructor?.name === 'PDFRef') {
        return doc.context.lookup(refOrObj) ?? null;
      }
      return refOrObj;
    } catch { return null; }
  };

  const numOf = (dict, key) => {
    try {
      const v = dict.get(PDFName.of(key));
      if (v == null) return 0;
      if (typeof v.asNumber === 'function') return v.asNumber();
      if (typeof v.value    === 'function') return v.value();
      if (typeof v          === 'number')   return v;
      const n = parseInt(String(v), 10);
      return isNaN(n) ? 0 : n;
    } catch { return 0; }
  };

  const dictOf = (obj) => {
    if (!obj) return null;
    if (typeof obj.get === 'function') return obj;
    if (obj.dict && typeof obj.dict.get === 'function') return obj.dict;
    return null;
  };

  // ── Image decoder ─────────────────────────────────────────────────────────────
  const imagePaths = [];
  let imgSeq = 0;

  async function decodeImage(obj, pageNum, label) {
    const dict = dictOf(obj);
    if (!dict) return;

    const subtype = dict.get(PDFName.of('Subtype'))?.toString();
    if (subtype !== '/Image') return;

    const w = numOf(dict, 'Width');
    const h = numOf(dict, 'Height');
    if (w < 80 || h < 80) return; // skip logos, bullets, decorations

    const rawData = obj.contents;
    if (!rawData || rawData.length < 256) return;

    const filterVal = dict.get(PDFName.of('Filter'));
    const filter    = filterVal ? (filterVal.toString?.() ?? JSON.stringify(filterVal)) : '';

    imgSeq++;
    const seq = String(imgSeq).padStart(4, '0');

    try {
      // ── DCTDecode → JPEG ─────────────────────────────────────────────────────
      if (filter.includes('DCTDecode')) {
        if (rawData[0] !== 0xFF || rawData[1] !== 0xD8) {
          logger.warn('pdf-extract: DCT but no JPEG magic — skipping', { label, pageNum });
          imgSeq--; return;
        }
        const webp = await sharp(Buffer.from(rawData))
          .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 90 }).toBuffer();
        const out = path.join(outDir, `img-${seq}-p${pageNum}-dct.webp`);
        fs.writeFileSync(out, webp);
        imagePaths.push(out);
        logger.debug('pdf-extract: DCT image extracted', { seq, pageNum, label, w, h, sizeKB: Math.round(rawData.length / 1024) });
        return;
      }

      // ── JPXDecode → JPEG 2000 ─────────────────────────────────────────────────
      if (filter.includes('JPXDecode')) {
        const webp = await sharp(Buffer.from(rawData))
          .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 90 }).toBuffer();
        const out = path.join(outDir, `img-${seq}-p${pageNum}-jpx.webp`);
        fs.writeFileSync(out, webp);
        imagePaths.push(out);
        logger.debug('pdf-extract: JPX image extracted', { seq, pageNum, label, w, h });
        return;
      }

      // ── FlateDecode → zlib-compressed raw pixels ──────────────────────────────
      if (filter.includes('FlateDecode')) {
        const raw = zlib.inflateSync(Buffer.from(rawData));

        const csVal    = dict.get(PDFName.of('ColorSpace'));
        const cs       = csVal?.toString?.() ?? '';
        const bpc      = numOf(dict, 'BitsPerComponent') || 8;
        let channels   = 3;
        if (cs.includes('Gray'))      channels = 1;
        else if (cs.includes('CMYK')) channels = 4;

        // PNG predictor: each row is prefixed with a 1-byte filter tag
        const dpVal = dict.get(PDFName.of('DecodeParms'));
        let predictor = 1;
        if (dpVal) {
          const dp     = deref(dpVal) ?? dpVal;
          const dpDict = dictOf(dp);
          if (dpDict) predictor = numOf(dpDict, 'Predictor') || 1;
        }

        let pixels = raw;
        if (predictor >= 10) {
          const rowBytes = Math.ceil(w * channels * bpc / 8);
          const srcStride = rowBytes + 1;
          const dst = Buffer.allocUnsafe(rowBytes * h);
          for (let row = 0; row < h; row++) {
            raw.copy(dst, row * rowBytes, row * srcStride + 1, row * srcStride + 1 + rowBytes);
          }
          pixels = dst;
        }

        const rawOpts = { raw: { width: w, height: h, channels } };
        let inst = channels === 4 && cs.includes('CMYK')
          ? sharp(Buffer.from(pixels).map(b => 255 - b), rawOpts).toColorspace('srgb')
          : sharp(pixels, rawOpts);

        const webp = await inst
          .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 90 }).toBuffer();
        const out = path.join(outDir, `img-${seq}-p${pageNum}-flat.webp`);
        fs.writeFileSync(out, webp);
        imagePaths.push(out);
        logger.debug('pdf-extract: Flat image extracted', { seq, pageNum, label, w, h, colorSpace: cs || 'RGB', bpc });
        return;
      }

      logger.warn('pdf-extract: Unknown filter — skipping', { filter, pageNum, label });
      imgSeq--;
    } catch (err) {
      logger.warn('pdf-extract: Decode error', { pageNum, label, error: err.message });
      imgSeq--;
    }
  }

  // ── Recursive XObject walker ──────────────────────────────────────────────────
  async function walkResources(resObj, pageNum, depth, visited) {
    if (depth > 6) return;
    const resDict = dictOf(deref(resObj));
    if (!resDict) return;

    const xobjVal  = resDict.get(PDFName.of('XObject'));
    if (!xobjVal) return;
    const xobjDict = dictOf(deref(xobjVal));
    if (!xobjDict?.entries) return;

    for (const [nameObj, ref] of xobjDict.entries()) {
      const label  = nameObj?.toString?.() ?? '?';
      try {
        const obj    = deref(ref);
        if (!obj) continue;

        const objKey = ref?.objectNumber ?? label;
        if (visited.has(objKey)) continue;
        visited.add(objKey);

        const dict    = dictOf(obj);
        if (!dict) continue;
        const subtype = dict.get(PDFName.of('Subtype'))?.toString();

        if (subtype === '/Image') {
          await decodeImage(obj, pageNum, label);
        } else if (subtype === '/Form') {
          const nestedRes = dict.get(PDFName.of('Resources'));
          if (nestedRes) await walkResources(nestedRes, pageNum, depth + 1, visited);
        }
      } catch (e) {
        logger.warn('pdf-extract: XObject error', { label, pageNum, error: e.message });
      }
    }
  }

  // ── Main pass: walk every page ────────────────────────────────────────────────
  for (let pi = 0; pi < pages.length; pi++) {
    const pageNum = pi + 1;
    try {
      const pageRes = pages[pi].node.get(PDFName.of('Resources'));
      if (!pageRes) continue;
      await walkResources(pageRes, pageNum, 0, new Set());
    } catch (e) {
      logger.warn('pdf-extract: Page walk error', { pageNum, error: e.message });
    }
  }

  // ── Fallback: scan entire xref table ──────────────────────────────────────────
  // Some PDFs (InDesign exports) store image XObjects only via the xref table.
  if (imagePaths.length === 0) {
    console.log('[pdf-extract] No images via page Resources — scanning xref table...');
    const visited = new Set();
    try {
      for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        try {
          if (visited.has(ref.objectNumber)) continue;
          visited.add(ref.objectNumber);
          const dict    = dictOf(obj);
          if (!dict) continue;
          const subtype = dict.get(PDFName.of('Subtype'))?.toString();
          if (subtype !== '/Image') continue;
          await decodeImage(obj, 0, `xref#${ref.objectNumber}`);
        } catch { /* skip bad object */ }
      }
    } catch (e) {
      logger.warn('pdf-extract: xref scan error', { error: e.message });
    }
  }

  if (imagePaths.length === 0) {
    // Log a sample of what WAS found to help diagnose vector-only PDFs
    let sampleInfo = '';
    try {
      const sample = [];
      for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        const d = dictOf(obj);
        if (!d) continue;
        const type    = d.get(PDFName.of('Type'))?.toString()    ?? '';
        const subtype = d.get(PDFName.of('Subtype'))?.toString() ?? '';
        const filter  = d.get(PDFName.of('Filter'))?.toString()  ?? '';
        if (type || subtype || filter)
          sample.push(`${type}${subtype}${filter ? ' filter=' + filter : ''}`);
        if (sample.length >= 12) break;
      }
      if (sample.length) sampleInfo = '\nPDF objects found: ' + [...new Set(sample)].join(', ');
    } catch { /* ignore */ }

    logger.warn('PDF extraction found no raster images', { pdfPath, sampleInfo });
    throw new Error(
      'No raster images found in this PDF.' + sampleInfo + '\n' +
      'The PDF likely contains only vector graphics — these cannot be extracted as raster images.\n' +
      'Export the PDF pages as JPEGs from Adobe Acrobat, Preview (Mac), or an online converter first.'
    );
  }

  logger.info('PDF extraction complete', { images: imagePaths.length });
  return { imagePaths, outDir };
}

// ── PDF: Same category — process with AI, save as draft products ──────────────
router.post('/pdf/same-category', adminOnly, (req, res, next) => {
  pdfUpload.single('pdf')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ message: 'PDF too large. Maximum allowed size is 200 MB.' });
    if (err) return res.status(400).json({ message: err.message });
    next();
  });
}, async (req, res) => {
  const tmpPdf = req.file?.path;
  let outDir;
  try {
    if (!req.file) return res.status(400).json({ message: 'No PDF uploaded.' });
    const { category, brand, promptText, promptId } = req.body;
    if (!category || !brand)
      return res.status(400).json({ message: 'category and brand required.' });

    const finalPrompt          = await resolvePrompt(promptText, promptId, category);
    const { imagePaths, outDir: od } = await extractPdfPages(tmpPdf);
    outDir = od;
    if (!imagePaths.length) return res.status(400).json({ message: 'No pages extracted from PDF.' });

    const created = [];
    const safeCat = (category || 'uncategorised').trim()
      .replace(/[^a-zA-Z0-9_\- ]/g, '')
      .replace(/\s+/g, '_');
    const catDir = path.join(process.cwd(), 'public', 'uploads', 'internalApp', 'products', safeCat);
    if (!fs.existsSync(catDir)) fs.mkdirSync(catDir, { recursive: true });

    for (let i = 0; i < imagePaths.length; i++) {
      try {
        const buf  = fs.readFileSync(imagePaths[i]);
        const out  = await processProductImage(buf, { category, promptText: finalPrompt });
        const name = `pdf-${Date.now()}-${i}.webp`;
        fs.writeFileSync(path.join(catDir, name), out);
        const p = await Product.create({
          brand, category,
          name:          `${brand} — Import ${i + 1}`,
          description:   '',
          imageUrl:      `/uploads/internalApp/products/${safeCat}/${name}`,
          purchasePrice: 0,
          markupPercent: 30,
        });
        created.push(p._id);
      } catch (e) {
        logger.warn('PDF page processing failed', { page: i + 1, error: e.message });
      }
    }

    fs.rmSync(outDir, { recursive: true, force: true });
    if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);

    logger.info('PDF same-category import complete', { created: created.length, category, brand, userId: req.user?.id });
    res.json({ message: `${created.length} draft products created`, productIds: created });
  } catch (err) {
    try { if (tmpPdf && fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf); } catch {}
    try { if (outDir) fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
    res.status(500).json({ message: err.message });
  }
});

// ── PDF: Extract raw images only — download as ZIP, no AI ────────────────────
router.post('/pdf/extract', adminOnly, (req, res, next) => {
  pdfUpload.single('pdf')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ message: 'PDF too large. Maximum allowed size is 200 MB.' });
    if (err) return res.status(400).json({ message: err.message });
    next();
  });
}, async (req, res) => {
  const tmpPdf = req.file?.path;
  let outDir;
  try {
    if (!req.file) return res.status(400).json({ message: 'No PDF uploaded.' });

    const { imagePaths, outDir: od } = await extractPdfPages(tmpPdf);
    outDir = od;
    if (!imagePaths.length)
      return res.status(400).json({ message: 'No images extracted from PDF.' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="pdf-images-${Date.now()}.zip"`);

    const archive        = archiver('zip', { zlib: { level: 6 } });
    const capturedOutDir = outDir;

    // Register cleanup before pipe so 'finish' is never missed
    res.on('finish', () => {
      try { fs.rmSync(capturedOutDir, { recursive: true, force: true }); } catch {}
      try { if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf); } catch {}
    });

    archive.on('error', e => {
      if (!res.headersSent) {
        res.status(500).json({ message: e.message });
      } else {
        logger.error('PDF extract archive error after headers sent', { error: e.message });
        res.destroy(e);
      }
    });

    archive.pipe(res);
    imagePaths.forEach((imgPath, i) => {
      archive.file(imgPath, { name: `image-${i + 1}${path.extname(imgPath)}` });
    });
    await archive.finalize();
  } catch (err) {
    try { if (tmpPdf && fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf); } catch {}
    try { if (outDir) fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
    if (!res.headersSent)
      res.status(500).json({ message: err.message });
  }
});

module.exports = router;