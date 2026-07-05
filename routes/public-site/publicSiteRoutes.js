'use strict';
/**
 * backend/routes/public-site/publicSiteRoutes.js
 * Mounted at /api/public-site in server.js.
 *
 * STORAGE CHANGES FROM ORIGINAL:
 * ─────────────────────────────────────────────────────────────────────────────
 * ALL image uploads now go to Cloudflare R2 instead of local disk.
 *
 * R2 layout (maps 1:1 to old disk layout):
 *   OLD: uploads/publicApp/category/{CategoryName}/{filename}
 *   NEW: website/publicApp/category/{CategoryName}/{filename}   → R2
 *
 *   OLD: uploads/publicApp/category/{Cat}/{Sub}/{filename}
 *   NEW: website/publicApp/category/{Cat}/{Sub}/{filename}      → R2
 *
 *   OLD: uploads/publicApp/testimonials/{filename}
 *   NEW: website/publicApp/testimonials/{filename}              → R2
 *
 * What was removed:
 *   - path, fs imports
 *   - PUBLIC_APP_BASE, getCategoryDir, getSubcategoryDir, getTestimonialDir
 *   - getCategoryUrl, getSubcategoryUrl, getTestimonialUrl
 *   - saveImageBuffer (sharp → toFile)  →  saveImageToR2 (sharp → uploadBuffer)
 *   - deleteFileSafe (fs.unlinkSync)    →  deleteFromR2(key)
 *   - deleteDirSafe (fs.rmSync)         →  deleteR2Prefix(prefix) [batch delete]
 *   - Two inline multer instances       →  single shared imageUpload (memoryStorage)
 *
 * StoreCategory imageSchema:
 *   url field now stores full R2 https:// URL (was /uploads/... relative path)
 *   filename field now stores R2 key (was local filename)  — used for deletion
 *
 * Testimonial imageUrl now stores full R2 https:// URL.
 *
 * All other routes (categories CRUD, subcategories CRUD, reorder,
 * inquiries, GET /store, POST /inquiry) — UNCHANGED.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const sharp    = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const StoreCategory = require('../../models/public-site/StoreCategory');
const Testimonial   = require('../../models/public-site/Testimonial');
const PublicInquiry = require('../../models/public-site/PublicInquiry');
const PartnerLead   = require('../../models/public-site/PartnerLead'); // NEW — Partner tab lead capture
const User          = require('../../models/User'); // NEW — duplicate-registration check
const { authenticate, authorize } = require('../../middleware/authMiddleware');
const { validateBody, normalizeUrl } = require('../../utils/inputValidation'); // NEW — security hardening
const { uploadSingleFileBuffer } = require('../../services/msGraphService'); // NEW — portfolio -> OneDrive
const { sendPartnerRejectionEmail } = require('../../services/emailService'); // NEW — reject-and-notify
const { odvPath } = require('../../utils/oneDrivePaths'); // NEW
const logger = require('../../utils/logger').child({ module: 'publicSiteRoutes' });

const adminOnly = [authenticate, authorize(['admin'])];

// ─── R2 client (reuses same credentials as r2Service.js) ─────────────────────
const r2 = new S3Client({
  region:   'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const BUCKET     = () => process.env.R2_BUCKET_NAME;
const PUBLIC_URL = () => (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

// ── Sanitise names for use in R2 key paths ────────────────────────────────────
const safeName = (name) =>
  (name || 'uncategorised').trim()
    .replace(/[^a-zA-Z0-9_\- ]/g, '')
    .replace(/\s+/g, '_');

// ── R2 key builders (mirror old disk folder structure) ────────────────────────
const categoryKey    = (catName, filename) =>
  `website/publicApp/category/${safeName(catName)}/${filename}`;
const subcategoryKey = (catName, subName, filename) =>
  `website/publicApp/category/${safeName(catName)}/${safeName(subName)}/${filename}`;
const testimonialKey = (filename) =>
  `website/publicApp/testimonials/${filename}`;

// ── Core R2 helpers ───────────────────────────────────────────────────────────

/**
 * Process buffer with sharp → WebP, upload to R2, return { key, url, aspectRatio }.
 */
const saveImageToR2 = async (buffer, r2Key) => {
  const [aspectRatio, webpBuffer] = await Promise.all([
    // Aspect ratio — needed for the bento grid layout
    sharp(buffer).metadata().then(({ width, height }) =>
      width && height ? width / height : null
    ).catch(() => null),
    // WebP conversion — matches original saveImageBuffer quality
    sharp(buffer)
      .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 88 })
      .toBuffer(),
  ]);

  await r2.send(new PutObjectCommand({
    Bucket:      BUCKET(),
    Key:         r2Key,
    Body:        webpBuffer,
    ContentType: 'image/webp',
  }));

  return { key: r2Key, url: `${PUBLIC_URL()}/${r2Key}`, aspectRatio };
};

/**
 * Delete a single R2 object by key. Non-fatal.
 * @param {string} key  R2 key stored in img.filename (or img.url won't work for deletion)
 */
const deleteFromR2 = async (key) => {
  if (!key) return;
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key }));
    logger.debug('R2 file deleted', { key });
  } catch (e) {
    logger.warn('R2 file delete failed (non-fatal)', { key, error: e.message });
  }
};

/**
 * Delete all R2 objects under a key prefix (equivalent to deleting a folder).
 * Used when an entire category or subcategory is deleted.
 * Non-fatal — logs on failure.
 */
const deleteR2Prefix = async (prefix) => {
  if (!prefix) return;
  try {
    let continuationToken;
    do {
      const listRes = await r2.send(new ListObjectsV2Command({
        Bucket:            BUCKET(),
        Prefix:            prefix,
        ContinuationToken: continuationToken,
      }));
      const keys = (listRes.Contents || []).map(o => o.Key).filter(Boolean);
      await Promise.all(keys.map(k => deleteFromR2(k)));
      continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
    } while (continuationToken);
    logger.debug('R2 prefix deleted', { prefix });
  } catch (e) {
    logger.warn('R2 prefix delete failed (non-fatal)', { prefix, error: e.message });
  }
};

// ─── multer — memory only, images only ───────────────────────────────────────
// Single instance replaces the two inline ones (upload + testimonialUpload).
const imageUpload = multer({
  storage:    multer.memoryStorage(),
  limits:     { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Only image files allowed.')),
});

// NEW — Partner registration "Upload Catalog/Portfolio" — PDF or ZIP only, goes to OneDrive not R2.
const portfolioUpload = multer({
  storage:    multer.memoryStorage(),
  limits:     { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'application/zip', 'application/x-zip-compressed'];
    return allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only PDF or ZIP files are allowed.'));
  },
});

// ─── Public store payload (UNCHANGED) ────────────────────────────────────────
const buildStorePayload = async () => {
  const [categories, testimonials] = await Promise.all([
    StoreCategory.find().sort({ order: 1, createdAt: 1 }).lean(),
    Testimonial.find().sort({ order: 1, createdAt: 1 }).lean(),
  ]);

  const shapedCategories = categories.map(cat => ({
    id:   cat._id.toString(),
    name: cat.name,
    images: (cat.images || [])
      .sort((a, b) => a.order - b.order)
      .map(img => ({
        id:          img._id.toString(),
        url:         img.url,         // now R2 https:// URL — frontend uses directly
        isCover:     img.isCover,
        aspectRatio: img.aspectRatio,
      })),
    subcategories: (cat.subcategories || [])
      .sort((a, b) => a.order - b.order)
      .map(sub => ({
        id:   sub._id.toString(),
        name: sub.name,
        images: (sub.images || [])
          .sort((a, b) => a.order - b.order)
          .map(img => ({
            id:          img._id.toString(),
            url:         img.url,
            aspectRatio: img.aspectRatio,
          })),
      })),
  }));

  const shapedTestimonials = testimonials.map(t => ({
    id:       t._id.toString(),
    author:   t.author,
    company:  t.company,
    role:     t.role,
    feedback: t.text,
    content:  t.text,
    imageUrl: t.imageUrl || '',
  }));

  return { categories: shapedCategories, testimonials: shapedTestimonials };
};


// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES — UNCHANGED
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/store', async (req, res) => {
  try {
    const payload = await buildStorePayload();
    logger.debug('Public store payload served', { categories: payload.categories.length, testimonials: payload.testimonials.length });
    res.json(payload);
  } catch (err) {
    logger.error('Failed to build store payload', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.post('/inquiry',
  validateBody(
    { name: 'name', company: 'name', email: 'email', phone: 'phone', message: 'message', hearAbout: 'message' },
    ['name', 'email']
  ),
  async (req, res) => {
    try {
      const { name, company, email, phone, message, hearAbout } = req.body;
      const inq = await PublicInquiry.create({ name, company, email, phone, message, hearAbout });
      logger.info('Public inquiry received', { inquiryId: inq._id, email });
      res.status(201).json({ message: 'Inquiry received.', id: inq._id });
    } catch (err) {
      logger.error('Public inquiry creation failed', { error: err.message, stack: err.stack });
      res.status(500).json({ message: 'Submission failed. Please try again.' });
    }
  }
);

// NEW — Partner tab registration form (interest capture, not full Supplier onboarding)
router.post('/partner-leads',
  (req, res, next) => portfolioUpload.single('portfolio')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ message: 'That file is larger than the 50MB limit. Please upload a smaller file.' });
      }
      return res.status(400).json({ message: err.message.includes('PDF or ZIP') ? err.message : 'File upload failed.' });
    }
    next();
  }),
  validateBody(
    { companyName: 'name', contactName: 'name', email: 'email', phone: 'phone', website: 'url', productCategories: 'name', message: 'message' },
    ['companyName', 'contactName', 'email']
  ),
  async (req, res) => {
    try {
      const { companyName, contactName, phone, productCategories, message } = req.body;
      const email = req.body.email.toLowerCase().trim();
      const website = normalizeUrl(req.body.website); // e.g. "www.acme.com" -> "https://www.acme.com"

      // NEW — don't let the same email submit twice, and point them to the
      // right next step depending on where they already are in the flow.
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(409).json({ message: 'User is already registered. You can login.' });
      }
      const existingLead = await PartnerLead.findOne({ email });
      if (existingLead) {
        return res.status(409).json({ message: 'Registration is pending for approval.' });
      }

      let attachmentOneDrivePath = '';
      let attachmentWebUrl = '';
      if (req.file) {
        // Same folder convention as Supplier video uploads (supplierRoutes.js):
        //   dev  -> development / supplier folder / {companyName}
        //   prod -> website     / supplier folder / {companyName}
        const folderName = companyName.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'unknown-partner';
        const folderPath = odvPath('supplier folder', folderName);
        const ext = (req.file.originalname.match(/\.[a-zA-Z0-9]+$/) || [''])[0];
        const filename = `portfolio-${Date.now()}${ext}`;
        const result = await uploadSingleFileBuffer(folderPath, filename, req.file.buffer, req.file.mimetype);
        attachmentOneDrivePath = `${folderPath.join('/')}/${filename}`;
        attachmentWebUrl = result?.webUrl || '';
      }

      const lead = await PartnerLead.create({
        companyName, contactName, email, phone, website, productCategories, message, attachmentOneDrivePath, attachmentWebUrl,
      });
      logger.info('Partner lead received', { leadId: lead._id, email, company: companyName, hasAttachment: !!attachmentOneDrivePath });
      res.status(201).json({ message: 'Thanks! Our team will be in touch shortly.', id: lead._id });
    } catch (err) {
      logger.error('Partner lead creation failed', { error: err.message, stack: err.stack });
      res.status(500).json({ message: 'Submission failed. Please try again.' });
    }
  }
);


// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — categories + subcategories CRUD — UNCHANGED logic
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/categories', adminOnly, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Name required.' });
    const count = await StoreCategory.countDocuments();
    const cat   = await StoreCategory.create({ name: name.trim(), order: count });
    logger.info('Category created', { categoryId: cat._id, name: cat.name, userId: req.user?.id });
    res.status(201).json({ id: cat._id, name: cat.name });
  } catch (err) {
    logger.error('Category creation failed', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

/**
 * DELETE /categories/:catId
 * CHANGED: deleteFileSafe + deleteDirSafe → deleteR2Prefix
 * Deletes all R2 objects under website/publicApp/category/{catName}/
 */
router.delete('/categories/:catId', adminOnly, async (req, res) => {
  try {
    const cat = await StoreCategory.findByIdAndDelete(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });

    // Delete entire category folder from R2 in one prefix sweep
    await deleteR2Prefix(`website/publicApp/category/${safeName(cat.name)}/`);

    logger.info('Category deleted', { categoryId: req.params.catId, name: cat.name, userId: req.user?.id });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    logger.error('Category delete failed', { categoryId: req.params.catId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.put('/categories/:catId/cover/:imgId', adminOnly, async (req, res) => {
  try {
    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });
    cat.images.forEach(img => { img.isCover = (img._id.toString() === req.params.imgId); });
    await cat.save();
    logger.info('Category cover updated', { categoryId: req.params.catId, imgId: req.params.imgId, userId: req.user?.id });
    res.json({ message: 'Cover updated.' });
  } catch (err) {
    logger.error('Category cover update failed', { categoryId: req.params.catId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.post('/categories/:catId/subcategories', adminOnly, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Name required.' });
    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });
    cat.subcategories.push({ name: name.trim(), order: cat.subcategories.length });
    await cat.save();
    const newSub = cat.subcategories[cat.subcategories.length - 1];
    logger.info('Subcategory created', { categoryId: req.params.catId, subId: newSub._id, name: newSub.name, userId: req.user?.id });
    res.status(201).json({ id: newSub._id, name: newSub.name });
  } catch (err) {
    logger.error('Subcategory creation failed', { categoryId: req.params.catId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.put('/categories/:catId/subcategories/:subId', adminOnly, async (req, res) => {
  try {
    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });
    const sub = cat.subcategories.id(req.params.subId);
    if (!sub) return res.status(404).json({ message: 'Subcategory not found.' });
    sub.name = req.body.name?.trim() || sub.name;
    await cat.save();
    logger.info('Subcategory renamed', { categoryId: req.params.catId, subId: req.params.subId, userId: req.user?.id });
    res.json({ id: sub._id, name: sub.name });
  } catch (err) {
    logger.error('Subcategory rename failed', { categoryId: req.params.catId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

/**
 * DELETE /categories/:catId/subcategories/:subId
 * CHANGED: deleteFileSafe loop → deleteR2Prefix for the subcategory folder
 */
router.delete('/categories/:catId/subcategories/:subId', adminOnly, async (req, res) => {
  try {
    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });
    const sub = cat.subcategories.id(req.params.subId);
    if (!sub) return res.status(404).json({ message: 'Subcategory not found.' });

    await deleteR2Prefix(`website/publicApp/category/${safeName(cat.name)}/${safeName(sub.name)}/`);
    sub.deleteOne();
    await cat.save();

    logger.info('Subcategory deleted', { categoryId: req.params.catId, subId: req.params.subId, userId: req.user?.id });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    logger.error('Subcategory delete failed', { categoryId: req.params.catId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// IMAGE UPLOAD — category + subcategory
// CHANGED: saveImageBuffer(buffer, destDir) → saveImageToR2(buffer, r2Key)
//          url stored is now full R2 https:// URL
//          filename stored is now R2 key (used for deletion)
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/upload/:catId', adminOnly, imageUpload.array('image', 20), async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ message: 'No files uploaded.' });

    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });

    const baseOrder = cat.images?.length || 0;

    const newImages = await Promise.all(req.files.map(async (file, i) => {
      const filename = `${uuidv4()}.webp`;
      const r2Key    = categoryKey(cat.name, filename);
      const { url, aspectRatio } = await saveImageToR2(file.buffer, r2Key);
      return { url, filename: r2Key, isCover: false, aspectRatio, order: baseOrder + i };
      //             ↑ full R2 URL   ↑ key stored in filename field — used for deletion
    }));

    cat.images.push(...newImages);
    if (!cat.images.some(img => img.isCover)) cat.images[0].isCover = true;
    await cat.save();

    logger.info('Category images uploaded to R2', { categoryId: req.params.catId, name: cat.name, count: req.files.length, userId: req.user?.id });
    res.json({ message: `${req.files.length} image(s) uploaded.` });
  } catch (err) {
    logger.error('Category image upload failed', { categoryId: req.params.catId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.post('/upload/:catId/sub/:subId', adminOnly, imageUpload.array('image', 20), async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ message: 'No files uploaded.' });

    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });
    const sub = cat.subcategories.id(req.params.subId);
    if (!sub) return res.status(404).json({ message: 'Subcategory not found.' });

    const baseOrder = sub.images?.length || 0;

    const newImages = await Promise.all(req.files.map(async (file, i) => {
      const filename = `${uuidv4()}.webp`;
      const r2Key    = subcategoryKey(cat.name, sub.name, filename);
      const { url, aspectRatio } = await saveImageToR2(file.buffer, r2Key);
      return { url, filename: r2Key, isCover: false, aspectRatio, order: baseOrder + i };
    }));

    sub.images.push(...newImages);
    await cat.save();

    logger.info('Subcategory images uploaded to R2', { categoryId: req.params.catId, subId: req.params.subId, count: req.files.length, userId: req.user?.id });
    res.json({ message: `${req.files.length} image(s) uploaded.` });
  } catch (err) {
    logger.error('Subcategory image upload failed', { categoryId: req.params.catId, subId: req.params.subId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// IMAGE DELETION
// CHANGED: deleteFileSafe(img.url) → deleteFromR2(img.filename)
//          img.filename now stores the R2 key, img.url is the public URL
// ═══════════════════════════════════════════════════════════════════════════════

router.delete('/images/:catId/:imgId', adminOnly, async (req, res) => {
  try {
    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });
    const img = cat.images.id(req.params.imgId);
    if (!img) return res.status(404).json({ message: 'Image not found.' });

    await deleteFromR2(img.filename); // img.filename = R2 key
    img.deleteOne();
    await cat.save();

    logger.info('Category image deleted from R2', { categoryId: req.params.catId, imgId: req.params.imgId, userId: req.user?.id });
    res.json({ message: 'Image deleted.' });
  } catch (err) {
    logger.error('Category image delete failed', { categoryId: req.params.catId, imgId: req.params.imgId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.delete('/images/:catId/sub/:subId/:imgId', adminOnly, async (req, res) => {
  try {
    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });
    const sub = cat.subcategories.id(req.params.subId);
    if (!sub) return res.status(404).json({ message: 'Subcategory not found.' });
    const img = sub.images.id(req.params.imgId);
    if (!img) return res.status(404).json({ message: 'Image not found.' });

    await deleteFromR2(img.filename); // img.filename = R2 key
    img.deleteOne();
    await cat.save();

    logger.info('Subcategory image deleted from R2', { categoryId: req.params.catId, subId: req.params.subId, imgId: req.params.imgId, userId: req.user?.id });
    res.json({ message: 'Image deleted.' });
  } catch (err) {
    logger.error('Subcategory image delete failed', { categoryId: req.params.catId, subId: req.params.subId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// REORDER — UNCHANGED
// ═══════════════════════════════════════════════════════════════════════════════

router.put('/reorder/:catId', adminOnly, async (req, res) => {
  try {
    const { imageIds } = req.body;
    if (!Array.isArray(imageIds)) return res.status(400).json({ message: 'imageIds array required.' });
    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });
    imageIds.forEach((id, idx) => { const img = cat.images.id(id); if (img) img.order = idx; });
    await cat.save();
    logger.info('Category images reordered', { categoryId: req.params.catId, count: imageIds.length, userId: req.user?.id });
    res.json({ message: 'Order updated.' });
  } catch (err) {
    logger.error('Category reorder failed', { categoryId: req.params.catId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.put('/reorder/:catId/sub/:subId', adminOnly, async (req, res) => {
  try {
    const { imageIds } = req.body;
    if (!Array.isArray(imageIds)) return res.status(400).json({ message: 'imageIds array required.' });
    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });
    const sub = cat.subcategories.id(req.params.subId);
    if (!sub) return res.status(404).json({ message: 'Subcategory not found.' });
    imageIds.forEach((id, idx) => { const img = sub.images.id(id); if (img) img.order = idx; });
    await cat.save();
    logger.info('Subcategory images reordered', { categoryId: req.params.catId, subId: req.params.subId, count: imageIds.length, userId: req.user?.id });
    res.json({ message: 'Order updated.' });
  } catch (err) {
    logger.error('Subcategory reorder failed', { categoryId: req.params.catId, subId: req.params.subId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// TESTIMONIALS
// CHANGED: saveImageBuffer → saveImageToR2, deleteFileSafe → deleteFromR2
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/testimonials', adminOnly, imageUpload.single('photo'), async (req, res) => {
  try {
    const { author, company, role, text } = req.body;
    if (!author?.trim() || !text?.trim())
      return res.status(400).json({ message: 'Author and text are required.' });

    let imageUrl = '';
    let imageKey = '';
    if (req.file) {
      const filename  = `${uuidv4()}.webp`;
      const r2Key     = testimonialKey(filename);
      const r2Result  = await saveImageToR2(req.file.buffer, r2Key);
      imageUrl = r2Result.url;
      imageKey = r2Key;
    }

    const count = await Testimonial.countDocuments();
    const t = await Testimonial.create({ author, company, role, text, imageUrl, imageKey, order: count });

    logger.info('Testimonial created', { testimonialId: t._id, author, userId: req.user?.id });
    res.status(201).json({ id: t._id, author: t.author, company: t.company, role: t.role, text: t.text, imageUrl: t.imageUrl });
  } catch (err) {
    logger.error('Testimonial creation failed', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.put('/testimonials/:id', adminOnly, imageUpload.single('photo'), async (req, res) => {
  try {
    const existing = await Testimonial.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Testimonial not found.' });

    let imageUrl = existing.imageUrl;
    let imageKey = existing.imageKey || '';
    if (req.file) {
      if (imageKey) await deleteFromR2(imageKey);  // delete old R2 image
      const filename  = `${uuidv4()}.webp`;
      const r2Key     = testimonialKey(filename);
      const r2Result  = await saveImageToR2(req.file.buffer, r2Key);
      imageUrl = r2Result.url;
      imageKey = r2Key;
    }

    const { author, company, role, text } = req.body;
    const t = await Testimonial.findByIdAndUpdate(
      req.params.id,
      { author, company, role, text, imageUrl, imageKey },
      { new: true }
    );

    logger.info('Testimonial updated', { testimonialId: req.params.id, userId: req.user?.id });
    res.json({ id: t._id, author: t.author, company: t.company, role: t.role, text: t.text, imageUrl: t.imageUrl });
  } catch (err) {
    logger.error('Testimonial update failed', { testimonialId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.delete('/testimonials/:id', adminOnly, async (req, res) => {
  try {
    const t = await Testimonial.findByIdAndDelete(req.params.id);
    if (!t) return res.status(404).json({ message: 'Testimonial not found.' });
    if (t.imageKey) await deleteFromR2(t.imageKey);
    logger.info('Testimonial deleted', { testimonialId: req.params.id, userId: req.user?.id });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    logger.error('Testimonial delete failed', { testimonialId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// INQUIRIES — UNCHANGED
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/inquiries', adminOnly, async (req, res) => {
  try {
    const inquiries = await PublicInquiry.find().sort({ createdAt: -1 }).lean();
    logger.debug('Admin inquiries listed', { count: inquiries.length, userId: req.user?.id });
    res.json(inquiries.map(i => ({
      id: i._id.toString(), name: i.name, company: i.company,
      email: i.email, phone: i.phone, message: i.message,
      hearAbout: i.hearAbout, read: i.read, createdAt: i.createdAt,
    })));
  } catch (err) {
    logger.error('Failed to list inquiries', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.delete('/inquiries/:id', adminOnly, async (req, res) => {
  try {
    const inq = await PublicInquiry.findByIdAndDelete(req.params.id);
    if (!inq) return res.status(404).json({ message: 'Inquiry not found.' });
    logger.info('Inquiry deleted', { inquiryId: req.params.id, userId: req.user?.id });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    logger.error('Inquiry delete failed', { inquiryId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.patch('/inquiries/:id/read', adminOnly, async (req, res) => {
  try {
    const inq = await PublicInquiry.findByIdAndUpdate(req.params.id, { read: true }, { new: true });
    if (!inq) return res.status(404).json({ message: 'Inquiry not found.' });
    logger.info('Inquiry marked read', { inquiryId: req.params.id, userId: req.user?.id });
    res.json({ id: inq._id, read: inq.read });
  } catch (err) {
    logger.error('Inquiry mark-read failed', { inquiryId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// PARTNER LEADS — NEW (Partner tab registration submissions)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/partner-leads', adminOnly, async (req, res) => {
  try {
    const leads = await PartnerLead.find().sort({ createdAt: -1 });
    res.json(leads);
  } catch (err) {
    logger.error('Failed to list partner leads', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.patch('/partner-leads/:id/status', adminOnly, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['new', 'contacted', 'invited', 'declined'];
    if (!valid.includes(status))
      return res.status(400).json({ message: `Status must be one of: ${valid.join(', ')}` });

    const lead = await PartnerLead.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    logger.info('Partner lead status updated', { leadId: lead._id, status, userId: req.user?.id });
    res.json(lead);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.patch('/partner-leads/:id/read', adminOnly, async (req, res) => {
  try {
    const lead = await PartnerLead.findByIdAndUpdate(req.params.id, { read: true }, { new: true });
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    res.json(lead);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/partner-leads/:id', adminOnly, async (req, res) => {
  try {
    await PartnerLead.findByIdAndDelete(req.params.id);
    logger.info('Partner lead deleted', { leadId: req.params.id, userId: req.user?.id });
    res.json({ message: 'Lead deleted.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// NEW — "Delete" action from AdminView.js: sends the applicant a note
// explaining why they weren't onboarded, then removes the lead.
router.post('/partner-leads/:id/reject',
  adminOnly,
  validateBody({ reason: 'message' }, ['reason']),
  async (req, res) => {
  try {
    const lead = await PartnerLead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });

    await sendPartnerRejectionEmail({
      to: lead.email,
      companyName: lead.companyName,
      contactName: lead.contactName,
      reason: req.body.reason,
    });

    await lead.deleteOne();
    logger.info('Partner lead rejected + notified', { leadId: req.params.id, email: lead.email, userId: req.user?.id });
    res.json({ message: `${lead.email} has been notified, and the lead was removed.` });
  } catch (err) {
    logger.error('Partner lead reject-and-notify failed', { leadId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: 'Failed to send notification. The lead was not deleted.' });
  }
});

module.exports = router;