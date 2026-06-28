'use strict';
/**
 * backend/routes/comboRoutes.js
 * Mounted at /api/combos in app.js:
 *   app.use('/api/combos', require('./routes/comboRoutes'));
 *
 * Routes:
 *   POST /api/combos/generate   — generate & save combos from budget + filters
 *   GET  /api/combos            — list all saved combos (admin only)
 *   DELETE /api/combos/:id      — remove a combo document
 *
 * ── Portal combo-item attachment ──────────────────────────────────────────────
 * Add the following route to clientPortalRoutes.js (see inline comment below):
 *
 *   PUT /api/portal/:slug/combo-items
 *   Body: { comboItems: ComboPortalItem[] }
 *
 * This follows the same pattern as PUT /api/portal/:slug/items.
 */

const express = require('express');
const router  = express.Router();
const Combo   = require('../models/Combo');
const { generateCombos, getBudgetRange } = require('../services/comboService');

// ── POST /api/combos/generate ─────────────────────────────────────────────────
// Body: { budget: Number, categories?: String[], subCategories?: String[], maxResults?: Number }
router.post('/generate', async (req, res) => {
  try {
    const { budget, categories, subCategories, maxResults } = req.body;

    if (!budget || isNaN(Number(budget)) || Number(budget) <= 0) {
      return res.status(400).json({ message: 'budget must be a positive number' });
    }

    const combos = await generateCombos({
      budget:        Number(budget),
      categories:    Array.isArray(categories)    ? categories    : [],
      subCategories: Array.isArray(subCategories) ? subCategories : [],
      maxResults:    Number(maxResults) || 20,
    });

    const { min, max } = getBudgetRange(Number(budget));
    res.json({ count: combos.length, range: { min, max }, combos });
  } catch (err) {
    console.error('[comboRoutes] generate error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/combos ───────────────────────────────────────────────────────────
// Returns all combos sorted newest-first (admin-only view).
router.get('/', async (req, res) => {
  try {
    const combos = await Combo.find({ isCombo: true }).sort({ createdAt: -1 }).lean();
    res.json(combos);
  } catch (err) {
    console.error('[comboRoutes] list error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ── DELETE /api/combos/:id ────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Combo.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Combo not found' });
    res.json({ ok: true, id: req.params.id });
  } catch (err) {
    console.error('[comboRoutes] delete error:', err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;

/* ─────────────────────────────────────────────────────────────────────────────
 * ADD THIS ROUTE TO backend/routes/clientPortalRoutes.js
 * (Place alongside the existing PUT /:slug/items handler)
 * ─────────────────────────────────────────────────────────────────────────────

// PUT /api/portal/:slug/combo-items
// Body: { comboItems: ComboPortalItem[] }
// Replaces the comboItems array on the portal (same pattern as /items).
router.put('/:slug/combo-items', async (req, res) => {
  try {
    const portal = await ClientPortal.findOne({ slug: req.params.slug });
    if (!portal) return res.status(404).json({ message: 'Portal not found' });

    portal.comboItems = req.body.comboItems || [];
    await portal.save();
    res.json(portal);
  } catch (err) {
    console.error('[portalRoutes] combo-items error:', err);
    res.status(500).json({ message: err.message });
  }
});

 * ───────────────────────────────────────────────────────────────────────────── */