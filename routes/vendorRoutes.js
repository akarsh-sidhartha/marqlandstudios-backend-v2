'use strict';
/**
 * backend/routes/vendorRoutes.js
 * Mounted at /api/vendors
 *
 * STORAGE CHANGES:
 *   - Removed: multer diskStorage, uploadDir, toMediaItem (disk path version)
 *   - Removed: deleteFileSafe (fs.unlinkSync)
 *   - Added:   upload = require('../middleware/upload')
 *   - Added:   deleteFromR2 for cleanup
 *   - Images   → R2 /website/internalApp/vendors/
 *   - Videos   → OneDrive /uploads/videos/
 *   - Docs/PDFs → OneDrive /uploads/files/
 *   - media[].url now stores the full cloud URL (https://...)
 *   - media[].key added to schema for cloud deletion
 */

const express = require('express');
const router  = express.Router();
const Vendor  = require('../models/Vendor');
const upload  = require('../middleware/upload');
const { deleteFromR2 } = require('../services/storageRouter');
const { extractFromBusinessCard } = require('../services/aiService');
const logger  = require('../utils/logger').child({ module: 'vendorRoutes' });

// ─── Helper: map uploaded cloud result → vendor media shape ──────────────────
// req.uploadedFiles[i] = { storage, url, key }
// file                 = original multer file object (has originalname, mimetype, size)
const toMediaItem = (cloudResult, file) => ({
  name:     file.originalname,
  url:      cloudResult.url,          // full https:// URL
  key:      cloudResult.key,          // R2 key or OneDrive path — for deletion
  storage:  cloudResult.storage,      // 'r2' | 'onedrive'
  mimeType: file.mimetype,
  size:     file.size,
  label:    '',
});

// ─── Helper: delete a cloud file, non-fatal ───────────────────────────────────
const deleteCloudFile = async (mediaItem) => {
  if (!mediaItem?.key) return;
  if (mediaItem.storage === 'r2') {
    await deleteFromR2(mediaItem.key);
  }
  // OneDrive deletion not implemented here (videos/files) — extend if needed
};

// ─── GET / ────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const vendors = await Vendor.find().sort({ companyName: 1 }).lean();
    res.json(vendors);
  } catch (err) {
    logger.error('Failed to list vendors', { error: err.message });
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST / — create vendor
 * CHANGED:
 *   - upload.array('mediaFiles', 20)  via shared middleware
 *   - req.files still available (multer populates it)
 *   - req.uploadedFiles[i] contains cloud result
 *   - toMediaItem(cloudResult, file) builds the media shape
 */
router.post('/',
  (req, _res, next) => { req.r2Folder = 'vendors'; next(); },
  upload.array('mediaFiles', 20),
  async (req, res) => {
    try {
      const { companyName, state, category, suppliedProducts, description, gstNumber } = req.body;
      if (!companyName?.trim())
        return res.status(400).json({ message: 'Company name is required.' });

      let contacts = [];
      if (req.body.contacts) {
        try { contacts = JSON.parse(req.body.contacts); }
        catch (e) { logger.warn('Vendor contacts JSON parse failed', { error: e.message }); }
      }

      // Zip multer files with cloud results
      const mediaFiles = req.files || [];
      const cloudResults = req.uploadedFiles || [];
      const media = mediaFiles.map((file, i) => toMediaItem(cloudResults[i], file));

      const vendor = await Vendor.create({
        companyName: companyName.trim(),
        state, category, suppliedProducts, description, gstNumber,
        contacts,
        media,
      });

      logger.info('Vendor created', { vendorId: vendor._id, name: vendor.companyName, userId: req.user?.id });
      res.status(201).json(vendor);
    } catch (err) {
      logger.error('Vendor creation failed', { error: err.message, userId: req.user?.id });
      res.status(400).json({ message: err.message });
    }
  }
);

/**
 * PUT /:id — update vendor
 * CHANGED:
 *   - deleteFileSafe → deleteCloudFile (deletes from R2/OneDrive)
 *   - toMediaItem builds cloud-aware media items
 */
router.put('/:id',
  (req, _res, next) => { req.r2Folder = 'vendors'; next(); },
  upload.array('mediaFiles', 20),
  async (req, res) => {
    try {
      const vendor = await Vendor.findById(req.params.id);
      if (!vendor) return res.status(404).json({ message: 'Vendor not found.' });

      const { companyName, state, category, suppliedProducts, description, gstNumber, keepMediaIds } = req.body;

      const keepIds = keepMediaIds
        ? keepMediaIds.split(',').map(s => s.trim()).filter(Boolean)
        : vendor.media.map(m => m._id.toString());

      // Delete removed media from cloud
      for (const m of vendor.media) {
        if (!keepIds.includes(m._id.toString())) {
          await deleteCloudFile(m);
        }
      }

      let contacts = vendor.contacts;
      if (req.body.contacts) {
        try { contacts = JSON.parse(req.body.contacts); }
        catch (e) { logger.warn('Vendor contacts JSON parse failed on update', { error: e.message }); }
      }

      const retainedMedia = vendor.media.filter(m => keepIds.includes(m._id.toString()));
      const mediaFiles    = req.files || [];
      const cloudResults  = req.uploadedFiles || [];
      const newMedia      = mediaFiles.map((file, i) => toMediaItem(cloudResults[i], file));

      const updated = await Vendor.findByIdAndUpdate(
        req.params.id,
        {
          companyName:      companyName?.trim()     ?? vendor.companyName,
          state:            state                   ?? vendor.state,
          category:         category                ?? vendor.category,
          suppliedProducts: suppliedProducts         ?? vendor.suppliedProducts,
          description:      description              ?? vendor.description,
          gstNumber:        gstNumber                ?? vendor.gstNumber,
          contacts,
          media: [...retainedMedia, ...newMedia],
        },
        { new: true }
      );

      logger.info('Vendor updated', {
        vendorId: req.params.id,
        newFiles: newMedia.length,
        removedFiles: vendor.media.length - retainedMedia.length,
        userId: req.user?.id,
      });
      res.json(updated);
    } catch (err) {
      logger.error('Vendor update failed', { vendorId: req.params.id, error: err.message });
      res.status(400).json({ message: err.message });
    }
  }
);

/**
 * DELETE /:id/media/:mediaId — remove one media file
 * CHANGED: deleteCloudFile instead of deleteFileSafe
 */
router.delete('/:id/media/:mediaId', async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found.' });

    const media = vendor.media.id(req.params.mediaId);
    if (!media) return res.status(404).json({ message: 'Media not found.' });

    await deleteCloudFile(media);
    media.deleteOne();
    await vendor.save();

    logger.info('Vendor media deleted', { vendorId: req.params.id, mediaId: req.params.mediaId });
    res.json({ message: 'Media deleted.' });
  } catch (err) {
    logger.error('Vendor media delete failed', { vendorId: req.params.id, error: err.message });
    res.status(500).json({ message: err.message });
  }
});

/**
 * DELETE /:id — delete vendor + all media
 * CHANGED: deleteCloudFile loop instead of deleteFileSafe loop
 */
router.delete('/:id', async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found.' });

    for (const m of vendor.media || []) {
      await deleteCloudFile(m);
    }
    await Vendor.findByIdAndDelete(req.params.id);

    logger.info('Vendor deleted', { vendorId: req.params.id, name: vendor.companyName });
    res.json({ message: 'Vendor deleted.' });
  } catch (err) {
    logger.error('Vendor delete failed', { vendorId: req.params.id, error: err.message });
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /scan-card — AI business card scan (UNCHANGED) ─────────────────────
router.post('/scan-card', async (req, res) => {
  try {
    const { image, mimeType } = req.body;
    if (!image) return res.status(400).json({ message: 'Image is required.' });
    const result = await extractFromBusinessCard(image);
    res.json(result);
  } catch (err) {
    logger.error('Business card scan failed', { error: err.message });
    res.status(500).json({ message: 'Card scan failed.', error: err.message });
  }
});

module.exports = router;