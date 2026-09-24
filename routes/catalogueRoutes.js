'use strict';
/**
 * backend/routes/catalogueRoutes.js
 * Mounted at /api/catalogues
 *
 *   GET    /                 — list all catalogues with items (newest first)
 *   GET    /summary          — light list for pickers / Saved Catalogues (no item content)
 *   GET    /image?src=...    — product image bytes for the PDF export (see below)
 *   GET    /:id              — one catalogue with its items (Catalogue Builder)
 *   POST   /                 — create new or update existing (pass id in body to update)
 *   POST   /:id/items/add    — append items on the server (ProductList "Add to Existing")
 *   DELETE /:id              — delete by id
 */

const express   = require('express');
const router    = express.Router();
const mongoose  = require('mongoose');
const path      = require('path');
const fs        = require('fs');
const Catalogue = require('../models/catalogue');
const logger    = require('../utils/logger').child({ module: 'catalogueRoutes' });

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

/** Keep only the fields the schema stores; price is stored as a string. */
const cleanItem = (item = {}) => ({
  _id:         item._id != null && item._id !== '' ? String(item._id) : undefined,
  name:        item.name || 'Unnamed',
  description: item.description || '',
  price:       item.price != null ? String(item.price) : '0',
  imageUrl:    item.imageUrl || '',
});

// ─── List all catalogues ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const catalogues = await Catalogue.find().sort({ createdAt: -1 }).lean();
    res.json(catalogues);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Light list ───────────────────────────────────────────────────────────────
// Items can carry base64 images (custom products added in the builder), so the
// full list gets heavy. Pickers only need names, counts and the item ids (to
// show "already in this catalogue").
router.get('/summary', async (req, res) => {
  try {
    const rows = await Catalogue.aggregate([
      { $sort: { updatedAt: -1 } },
      { $project: {
          name: 1, subtitle: 1, createdAt: 1, updatedAt: 1,
          itemCount: { $size: { $ifNull: ['$items', []] } },
          itemIds:   { $ifNull: ['$items._id', []] },
      } },
    ]);
    res.json(rows.map((r) => ({ ...r, itemIds: (r.itemIds || []).filter(Boolean) })));
  } catch (err) {
    logger.error('Catalogue summary failed', { error: err.message });
    res.status(500).json({ message: err.message });
  }
});

// ─── Image for PDF export ─────────────────────────────────────────────────────
// The browser builds the PDF by drawing the pages onto a canvas, which only
// works for images it may read cross-origin. R2 (and the API host, when it
// differs from the admin host) don't send CORS headers, so the images came
// out blank. The builder fetches them through here instead (authenticated,
// same API origin) and embeds them as data URLs.
//
// Only our own images are served: R2_PUBLIC_URL (plus optional comma-separated
// CATALOGUE_IMAGE_HOSTS origins) and files under public/uploads.
const UPLOADS_DIR   = path.join(__dirname, '..', 'public', 'uploads');
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_EXT       = /\.(jpe?g|png|webp|gif|avif)$/i;   // never serve other upload types (e.g. invoices)

const allowedImageOrigins = () => [process.env.R2_PUBLIC_URL, ...(process.env.CATALOGUE_IMAGE_HOSTS || '').split(',')]
  .map((u) => { try { return u && new URL(u.trim()).origin; } catch { return null; } })
  .filter(Boolean);

router.get('/image', async (req, res) => {
  const src = String(req.query.src || '');
  try {
    // Local upload: /uploads/... (optionally given as a full URL on any host)
    let pathname = null;
    if (src.startsWith('/uploads/')) pathname = src;
    else {
      let url;
      try { url = new URL(src); } catch { return res.status(400).json({ message: 'Invalid image URL.' }); }
      if (!['http:', 'https:'].includes(url.protocol)) return res.status(400).json({ message: 'Invalid image URL.' });
      if (url.pathname.startsWith('/uploads/') && !allowedImageOrigins().includes(url.origin)) pathname = url.pathname;
      else if (!allowedImageOrigins().includes(url.origin)) return res.status(403).json({ message: 'Image host not allowed.' });
      else {
        const upstream = await fetch(url, { signal: AbortSignal.timeout(20000) });
        const type = upstream.headers.get('content-type') || '';
        if (!upstream.ok || !type.startsWith('image/')) return res.status(502).json({ message: 'Image not available.' });
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (buf.length > MAX_IMAGE_BYTES) return res.status(413).json({ message: 'Image too large.' });
        res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' });
        return res.send(buf);
      }
    }

    const file = path.resolve(UPLOADS_DIR, '.' + decodeURIComponent(pathname.slice('/uploads'.length)));
    if (!file.startsWith(UPLOADS_DIR + path.sep)) return res.status(400).json({ message: 'Invalid image path.' });
    if (!IMAGE_EXT.test(file)) return res.status(400).json({ message: 'Not an image.' });
    if (!fs.existsSync(file)) return res.status(404).json({ message: 'Image not found.' });
    res.set('Cache-Control', 'private, max-age=3600');
    return res.sendFile(file);
  } catch (err) {
    logger.warn('Catalogue image fetch failed', { src, error: err.message });
    res.status(502).json({ message: 'Image not available.' });
  }
});

// ─── One catalogue ────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ message: 'Catalogue not found.' });
    const catalogue = await Catalogue.findById(req.params.id).lean();
    if (!catalogue) return res.status(404).json({ message: 'Catalogue not found.' });
    res.json(catalogue);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Create or update catalogue ───────────────────────────────────────────────
// If a valid MongoDB ObjectId is provided in the body as `id`, the matching
// catalogue is updated. Otherwise a new one is created.
// Optional `expectedUpdatedAt`: when sent, the update only applies if the
// catalogue hasn't changed since the caller loaded it (409 otherwise), so a
// builder save can't silently drop products added from the Products page.
router.post('/', async (req, res) => {
  try {
    const { name, subtitle, items, id, expectedUpdatedAt } = req.body;

    // Only treat `id` as an update key if it looks like a valid ObjectId
    if (id && isValidId(id)) {
      const filter = { _id: id };
      if (expectedUpdatedAt) filter.updatedAt = new Date(expectedUpdatedAt);

      const updated = await Catalogue.findOneAndUpdate(
        filter,
        { name, subtitle, items },
        { new: true }
      );
      if (!updated) {
        if (expectedUpdatedAt && await Catalogue.exists({ _id: id })) {
          return res.status(409).json({ message: 'Catalogue was changed elsewhere since it was opened.' });
        }
        return res.status(404).json({ message: 'Catalogue not found.' });
      }
      logger.info('Catalogue updated', { catalogueId: updated._id, name: updated.name, userId: req.user?.id });
      return res.json(updated);
    }

    const catalogue = new Catalogue({ name, subtitle, items });
    await catalogue.save();
    logger.info('Catalogue created', { catalogueId: catalogue._id, name: catalogue.name, userId: req.user?.id });
    res.status(201).json(catalogue);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ─── Append items ─────────────────────────────────────────────────────────────
// body: { items: [ { _id, name, description, price, imageUrl } ] }
// Items whose _id (product id) is already in the catalogue are skipped; items
// without an _id are always added. The push is done on the server so the
// browser never sends the whole list back.
router.post('/:id/items/add', async (req, res) => {
  try {
    const incoming = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!incoming.length) return res.status(400).json({ message: 'No items to add.' });
    if (!isValidId(req.params.id)) return res.status(404).json({ message: 'Catalogue not found.' });

    const catalogue = await Catalogue.findById(req.params.id).select('name items._id').lean();
    if (!catalogue) return res.status(404).json({ message: 'Catalogue not found.' });

    const existing = new Set((catalogue.items || []).map((i) => i._id).filter(Boolean).map(String));
    const toAdd = incoming.map(cleanItem).filter((item) => {
      if (!item._id) return true;
      if (existing.has(item._id)) return false;
      existing.add(item._id);        // also de-dupes within the request
      return true;
    });

    if (toAdd.length) {
      await Catalogue.updateOne({ _id: catalogue._id }, { $push: { items: { $each: toAdd } } });
    }

    const skipped = incoming.length - toAdd.length;
    logger.info('Catalogue items added', { catalogueId: catalogue._id, added: toAdd.length, skipped, userId: req.user?.id });
    res.json({ added: toAdd.length, skipped, itemCount: (catalogue.items || []).length + toAdd.length });
  } catch (err) {
    logger.error('Catalogue items add failed', { catalogueId: req.params.id, error: err.message });
    res.status(500).json({ message: err.message });
  }
});

// ─── Delete catalogue ─────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const catalogue = await Catalogue.findByIdAndDelete(req.params.id);
    if (!catalogue) return res.status(404).json({ message: 'Catalogue not found.' });
    logger.info('Catalogue deleted', { catalogueId: req.params.id, userId: req.user?.id });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
