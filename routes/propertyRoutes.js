'use strict';
/**
 * backend/routes/propertyRoutes.js
 * Mounted at /api/properties
 *
 * STORAGE CHANGES FROM ORIGINAL:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. POST /upload-attachment
 *      BEFORE: multer diskStorage → /uploads/internalApp/property/{type}/{file}
 *      AFTER:  upload.single('file') → R2 /website/internalApp/portal/
 *              Returns full https:// URL instead of /uploads/... path
 *
 * 2. Removed: attachStorage (diskStorage), uploadAttachment (multer instance),
 *             getPropertyDir, getPropertyUrl, PROPERTY_TYPE_DIRS, path, fs imports
 *
 * Property model has:
 *   imageUrl     — single image URL (set by frontend directly, not via this route)
 *   attachments  — array of { name, url, mimeType, size }
 *                  url now stores R2 https:// URL instead of /uploads/... path
 *
 * All other routes (GET, POST, PUT, DELETE) — UNCHANGED.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express  = require('express');
const router   = express.Router();
const Property = require('../models/Property');
const upload   = require('../middleware/upload');
const logger   = require('../utils/logger').child({ module: 'propertyRoutes' });

// ─── GET / — list all properties (UNCHANGED) ─────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const properties = await Property.find().sort({ propertyName: 1 }).lean();
    logger.debug('Properties listed', { count: properties.length, userId: req.user?.id });
    res.json(properties);
  } catch (err) {
    logger.error('Failed to list properties', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── POST / — create property (UNCHANGED) ────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const property = new Property(req.body);
    await property.save();
    logger.info('Property created', { propertyId: property._id, name: property.propertyName, userId: req.user?.id });
    res.status(201).json(property);
  } catch (err) {
    logger.error('Property creation failed', { error: err.message, stack: err.stack, userId: req.user?.id });
    res.status(400).json({ message: err.message });
  }
});

// ─── PUT /:id — update property (UNCHANGED) ──────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const property = await Property.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!property) return res.status(404).json({ message: 'Property not found.' });
    logger.info('Property updated', { propertyId: req.params.id, name: property.propertyName, userId: req.user?.id });
    res.json(property);
  } catch (err) {
    logger.error('Property update failed', { propertyId: req.params.id, error: err.message, stack: err.stack });
    res.status(400).json({ message: err.message });
  }
});

// ─── DELETE /:id — delete property (UNCHANGED) ───────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const property = await Property.findByIdAndDelete(req.params.id);
    if (!property) return res.status(404).json({ message: 'Property not found.' });
    logger.info('Property deleted', { propertyId: req.params.id, name: property.propertyName, userId: req.user?.id });
    res.json({ message: 'Property deleted.' });
  } catch (err) {
    logger.error('Property delete failed', { propertyId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /upload-attachment
 * Upload a single property attachment (PDF, image, doc) to R2.
 *
 * CHANGED:
 *   uploadAttachment.single('file')  →  upload.single('file')
 *   url = getPropertyUrl(...)        →  url = req.uploadedFile.url  (R2 https://)
 *
 * storageRouter decision:
 *   images (jpeg, png, webp…) → R2 /website/internalApp/portal/
 *   PDFs / docs               → OneDrive /website/uploads/files/
 *
 * Response shape unchanged: { url, name, mimeType, size }
 * The url field now holds a full https:// URL — frontend renders it directly.
 */
router.post('/upload-attachment',
  (req, _res, next) => { req.r2Folder = 'portal'; next(); },
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.uploadedFile) return res.status(400).json({ message: 'No file provided.' });

      logger.debug('Property attachment uploaded', {
        storage:  req.uploadedFile.storage,
        url:      req.uploadedFile.url,
        userId:   req.user?.id,
      });

      res.json({
        url:      req.uploadedFile.url,       // R2 or OneDrive https:// URL
        key:      req.uploadedFile.key,       // for future deletion
        storage:  req.uploadedFile.storage,   // 'r2' | 'onedrive'
        name:     req.file.originalname,
        mimeType: req.file.mimetype,
        size:     req.file.size,
      });
    } catch (err) {
      logger.error('Property attachment upload failed', { error: err.message, stack: err.stack });
      res.status(500).json({ message: err.message });
    }
  }
);

module.exports = router;