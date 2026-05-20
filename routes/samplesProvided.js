'use strict';
/**
 * backend/routes/samplesProvided.js
 * Mounted at /api/challans
 *
 * STORAGE CHANGES FROM ORIGINAL:
 * ─────────────────────────────────────────────────────────────────────────────
 * The original routes accepted raw base64 in req.body.samples[].image and
 * req.body.dcAttachments[].data, storing them directly in MongoDB.
 * This causes document size bloat and hits MongoDB's 16MB document limit.
 *
 * NEW APPROACH — two upload patterns:
 *
 * 1. Sample item images  → upload endpoint: POST /samples/:challanId/:sampleId/image
 *    Frontend uploads image file → stored in R2 /website/internalApp/portal/
 *    Response: { imageUrl, imageKey } → frontend PATCHes these onto the sample item
 *
 * 2. DC attachments (PDF, image, doc) → upload endpoint: POST /:id/attachments
 *    Frontend uploads file(s) via multipart → storageRouter decides:
 *      images → R2 /website/internalApp/portal/
 *      PDFs/docs → OneDrive /website/uploads/files/
 *    Returns array of { url, key, storage, name, type, size }
 *
 * The main CRUD routes (GET, POST, PUT) still accept the old shape for backward
 * compat — but base64 fields are stripped before saving to MongoDB.
 *
 * NEW ROUTES:
 *   POST /:id/attachments              — upload DC attachment files
 *   POST /samples/:challanId/:sampleId/image — upload a sample item image
 *   DELETE /:id/attachments/:idx       — remove an attachment + delete from cloud
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router  = express.Router();
const Challan = require('../models/samplesprovided');
const upload  = require('../middleware/upload');
const { deleteFromR2 } = require('../services/storageRouter');
const logger  = require('../utils/logger').child({ module: 'samplesProvided' });

// ── Helper: strip base64 from incoming data ───────────────────────────────────
// Cleans legacy fields so they never reach MongoDB even from old frontend clients.
const cleanSamples = (samples = []) =>
  samples.map(({ image, ...rest }) => rest); // drop base64 image field

const cleanDcAttachments = (attachments = []) =>
  attachments.map(({ data, ...rest }) => rest); // drop base64 data field


// ═══════════════════════════════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET / ────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const challans = await Challan.find().sort({ createdAt: -1 }).lean();
    logger.debug('Challans listed', { count: challans.length, userId: req.user?.id });
    res.json(challans);
  } catch (err) {
    logger.error('Failed to list challans', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /
 * CHANGED: strips base64 fields from samples and dcAttachments before saving.
 * The frontend should upload files separately via the new upload endpoints
 * and then include only { imageUrl, imageKey } / { url, key, storage } in the body.
 */
router.post('/', async (req, res) => {
  try {
    const data = {
      ...req.body,
      samples:       cleanSamples(Array.isArray(req.body.samples) ? req.body.samples : []),
      dcAttachments: cleanDcAttachments(Array.isArray(req.body.dcAttachments) ? req.body.dcAttachments : []),
    };
    const challan = new Challan(data);
    await challan.save();
    logger.info('Challan created', { challanId: challan._id, userId: req.user?.id });
    res.status(201).json(challan);
  } catch (err) {
    logger.error('Challan creation failed', { error: err.message, stack: err.stack, userId: req.user?.id });
    res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /:id
 * CHANGED: strips base64 fields before saving.
 */
router.put('/:id', async (req, res) => {
  try {
    const data = {
      ...req.body,
      samples:       cleanSamples(Array.isArray(req.body.samples) ? req.body.samples : []),
      dcAttachments: cleanDcAttachments(Array.isArray(req.body.dcAttachments) ? req.body.dcAttachments : []),
    };
    const challan = await Challan.findByIdAndUpdate(
      req.params.id,
      data,
      { new: true, runValidators: true }
    );
    if (!challan) return res.status(404).json({ error: 'Challan not found.' });
    logger.info('Challan updated', { challanId: req.params.id, userId: req.user?.id });
    res.json(challan);
  } catch (err) {
    logger.error('Challan update failed', { challanId: req.params.id, error: err.message, stack: err.stack });
    res.status(400).json({ error: err.message });
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const challan = await Challan.findByIdAndDelete(req.params.id);
    if (!challan) return res.status(404).json({ error: 'Challan not found.' });

    // Clean up R2 files for sample images
    for (const sample of challan.samples || []) {
      if (sample.imageKey) await deleteFromR2(sample.imageKey).catch(() => {});
    }
    // Clean up R2 files for DC attachments (OneDrive files are left — no delete API needed for files)
    for (const att of challan.dcAttachments || []) {
      if (att.storage === 'r2' && att.key) await deleteFromR2(att.key).catch(() => {});
    }

    logger.info('Challan deleted', { challanId: req.params.id, userId: req.user?.id });
    res.json({ message: 'Challan deleted.' });
  } catch (err) {
    logger.error('Challan delete failed', { challanId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// NEW: FILE UPLOAD ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /:id/attachments
 * Upload one or more DC attachment files for a challan.
 * storageRouter decision:
 *   images → R2 /website/internalApp/portal/
 *   PDFs/docs → OneDrive /website/uploads/files/
 *
 * Returns array of attachment objects to merge into dcAttachments[].
 * Frontend should then PUT /:id with the updated dcAttachments array.
 *
 * Example frontend flow:
 *   1. POST /api/challans/:id/attachments  (multipart, field: 'files')
 *   2. Receive [{ url, key, storage, name, type, size }, ...]
 *   3. PUT /api/challans/:id  with dcAttachments: [...existing, ...newOnes]
 */
router.post('/:id/attachments',
  (req, _res, next) => { req.r2Folder = 'portal'; next(); },
  upload.array('files', 10),
  async (req, res) => {
    try {
      if (!req.uploadedFiles?.length)
        return res.status(400).json({ error: 'No files provided.' });

      const challan = await Challan.findById(req.params.id);
      if (!challan) return res.status(404).json({ error: 'Challan not found.' });

      const newAttachments = req.files.map((f, i) => ({
        name:    f.originalname,
        type:    f.mimetype,
        size:    String(f.size),
        url:     req.uploadedFiles[i].url,
        key:     req.uploadedFiles[i].key,
        storage: req.uploadedFiles[i].storage,
      }));

      // Append to existing attachments and save
      challan.dcAttachments.push(...newAttachments);
      await challan.save();

      logger.info('DC attachments uploaded', {
        challanId: req.params.id,
        count:     newAttachments.length,
        userId:    req.user?.id,
      });
      res.json({ attachments: newAttachments, total: challan.dcAttachments.length });
    } catch (err) {
      logger.error('DC attachment upload failed', { challanId: req.params.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * DELETE /:id/attachments/:idx
 * Remove a DC attachment by index, deleting from R2 if applicable.
 * Returns the updated dcAttachments array.
 */
router.delete('/:id/attachments/:idx', async (req, res) => {
  try {
    const challan = await Challan.findById(req.params.id);
    if (!challan) return res.status(404).json({ error: 'Challan not found.' });

    const idx = parseInt(req.params.idx, 10);
    if (isNaN(idx) || idx < 0 || idx >= challan.dcAttachments.length)
      return res.status(400).json({ error: 'Invalid attachment index.' });

    const att = challan.dcAttachments[idx];
    if (att.storage === 'r2' && att.key) {
      await deleteFromR2(att.key).catch(e =>
        logger.warn('R2 attachment delete failed (non-fatal)', { key: att.key, error: e.message })
      );
    }

    challan.dcAttachments.splice(idx, 1);
    await challan.save();

    logger.info('DC attachment removed', { challanId: req.params.id, idx, userId: req.user?.id });
    res.json({ dcAttachments: challan.dcAttachments });
  } catch (err) {
    logger.error('DC attachment delete failed', { challanId: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /samples/:challanId/:sampleId/image
 * Upload an image for a specific sample item within a challan.
 * Stores the image in R2 and updates the sample's imageUrl + imageKey in MongoDB.
 *
 * Example frontend flow:
 *   POST /api/challans/samples/:challanId/:sampleId/image  (multipart, field: 'image')
 *   Receive { imageUrl, imageKey } → already saved to DB
 */
router.post('/samples/:challanId/:sampleId/image',
  (req, _res, next) => { req.r2Folder = 'portal'; next(); },
  upload.imageOnly.single('image'),
  async (req, res) => {
    try {
      if (!req.uploadedFile)
        return res.status(400).json({ error: 'No image provided.' });

      const challan = await Challan.findById(req.params.challanId);
      if (!challan) return res.status(404).json({ error: 'Challan not found.' });

      const sample = challan.samples.id(req.params.sampleId);
      if (!sample) return res.status(404).json({ error: 'Sample item not found.' });

      // Delete old R2 image if replacing
      if (sample.imageKey) {
        await deleteFromR2(sample.imageKey).catch(e =>
          logger.warn('Old sample image delete failed (non-fatal)', { key: sample.imageKey, error: e.message })
        );
      }

      sample.imageUrl = req.uploadedFile.url;
      sample.imageKey = req.uploadedFile.key;
      await challan.save();

      logger.info('Sample image uploaded', {
        challanId: req.params.challanId,
        sampleId:  req.params.sampleId,
        imageUrl:  req.uploadedFile.url,
        userId:    req.user?.id,
      });
      res.json({ imageUrl: req.uploadedFile.url, imageKey: req.uploadedFile.key });
    } catch (err) {
      logger.error('Sample image upload failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;