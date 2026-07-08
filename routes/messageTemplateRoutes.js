'use strict';
/**
 * backend/routes/messageTemplateRoutes.js
 * Mount at /api/message-templates in your main server file, e.g.:
 *
 *   const messageTemplateRoutes = require('./routes/messageTemplateRoutes');
 *   app.use('/api/message-templates', messageTemplateRoutes);
 *
 * Backs the "Manage Statements" control in OrderTracker.js's filter bar
 * and the Quick Statement dropdown in OrderTimeline.js. Rows are plain
 * CRUD — no auth gate applied here since every other route in this app
 * mounts its own `authenticate` middleware at the app level; add it here
 * too if that's not already the case for you.
 */

const express         = require('express');
const router          = express.Router();
const MessageTemplate = require('../models/MessageTemplate');
const logger          = require('../utils/logger').child({ module: 'messageTemplateRoutes' });

/** GET /api/message-templates — list all, grouped-friendly (sorted by status, then order) */
router.get('/', async (req, res) => {
  try {
    const templates = await MessageTemplate.find()
      .sort({ status: 1, order: 1, createdAt: 1 })
      .lean();
    res.json(templates);
  } catch (err) {
    logger.error('List templates failed', { error: err.message });
    res.status(500).json({ message: err.message });
  }
});

/** POST /api/message-templates — create a new statement row */
router.post('/', async (req, res) => {
  try {
    const { status, text, order } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ message: 'Statement text is required.' });
    }

    const template = new MessageTemplate({
      status: status || 'update',
      text: text.trim(),
      order: Number.isFinite(order) ? order : 0,
    });
    await template.save();

    logger.info('Template created', { id: template._id, status: template.status });
    res.status(201).json(template);
  } catch (err) {
    logger.error('Create template failed', { error: err.message });
    res.status(500).json({ message: err.message });
  }
});

/** PATCH /api/message-templates/:id — edit status/text/order */
router.patch('/:id', async (req, res) => {
  try {
    const { status, text, order } = req.body;
    if (text !== undefined && !text.trim()) {
      return res.status(400).json({ message: 'Statement text cannot be empty.' });
    }

    const update = {};
    if (status !== undefined) update.status = status;
    if (text !== undefined)   update.text   = text.trim();
    if (order !== undefined)  update.order  = order;

    const template = await MessageTemplate.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!template) return res.status(404).json({ message: 'Template not found.' });

    res.json(template);
  } catch (err) {
    logger.error('Update template failed', { id: req.params.id, error: err.message });
    res.status(500).json({ message: err.message });
  }
});

/** DELETE /api/message-templates/:id */
router.delete('/:id', async (req, res) => {
  try {
    const template = await MessageTemplate.findByIdAndDelete(req.params.id);
    if (!template) return res.status(404).json({ message: 'Template not found.' });
    logger.info('Template deleted', { id: req.params.id });
    res.json({ message: 'Template deleted.' });
  } catch (err) {
    logger.error('Delete template failed', { id: req.params.id, error: err.message });
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;