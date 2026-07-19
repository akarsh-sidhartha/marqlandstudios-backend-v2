'use strict';
/**
 * backend/routes/shipmentRoutes.js
 * Mounted at /api/shipments
 *
 *   GET    /               — list shipments (couriers see only their own)
 *   GET    /:id            — single shipment
 *   POST   /               — create shipment (stamps vendorId for couriers)
 *   POST   /bulk           — bulk create from Excel import (max 500)
 *   PUT    /:id            — update shipment
 *   DELETE /:id            — delete shipment
 *   POST   /refresh-status — trigger shipment tracking refresh
 */

const express    = require('express');
const router     = express.Router();
const Shipment   = require('../models/Shipment');
const { authenticate }               = require('../middleware/authMiddleware');
const { refreshShipmentStatuses }    = require('../services/shipmentTrackingService');
const logger     = require('../utils/logger').child({ module: 'shipmentRoutes' });

const BULK_INSERT_LIMIT = 500; // safety cap for bulk imports

// All shipment routes require a valid token
router.use(authenticate);

// ─── GET / ────────────────────────────────────────────────────────────────────
// Couriers only see their own rows. Staff see all, with optional ?orderId filter.
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.orderId)           filter.orderId  = req.query.orderId;
    if (req.user?.role === 'courier') filter.vendorId = req.user.id;

    const shipments = await Shipment.find(filter).sort({ createdAt: -1 }).lean();
    logger.debug('Shipments listed', { count: shipments.length, userId: req.user?.id, role: req.user?.role });
    res.json(shipments);
  } catch (err) {
    logger.error('Failed to list shipments', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────
// CHANGED — security hardening: a courier could previously fetch ANY shipment
// by ID even though the list view (GET /) already scoped them to their own.
// Ownership is now enforced here too, matching the list filter.
router.get('/:id', async (req, res) => {
  try {
    const shipment = await Shipment.findById(req.params.id).lean();
    if (!shipment) return res.status(404).json({ message: 'Shipment not found.' });
    if (req.user?.role === 'courier' && String(shipment.vendorId) !== String(req.user.id))
      return res.status(404).json({ message: 'Shipment not found.' });
    res.json(shipment);
  } catch (err) {
    logger.error('Failed to fetch shipment', { shipmentId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── POST / — create single shipment ─────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const body = { ...req.body };

    // Couriers: stamp vendor identity from token
    if (req.user?.role === 'courier') {
      body.vendorId   = req.user.id;
      body.vendorName = req.user.name || req.user.email;
    }

    // Coerce empty orderId to null to avoid ObjectId cast errors
    if (!body.orderId) body.orderId = null;

    const shipment = new Shipment(body);
    await shipment.save();

    logger.info('Shipment created', {
      shipmentId:  shipment._id,
      trackingId:  shipment.trackingId,
      orderId:     shipment.orderId,
      userId:      req.user?.id,
    });
    res.status(201).json(shipment);
  } catch (err) {
    logger.error('Shipment creation failed', { error: err.message, stack: err.stack, userId: req.user?.id });
    res.status(400).json({ message: err.message });
  }
});

// ─── POST /bulk — bulk create from Excel import ───────────────────────────────
router.post('/bulk', async (req, res) => {
  try {
    const { shipments } = req.body;
    if (!Array.isArray(shipments) || shipments.length === 0)
      return res.status(400).json({ message: 'shipments array required.' });
    if (shipments.length > BULK_INSERT_LIMIT)
      return res.status(400).json({ message: `Bulk import limit is ${BULK_INSERT_LIMIT} shipments per request.` });

    const cleaned = shipments.map(s => ({
      ...s,
      orderId: s.orderId || null,
      ...(req.user?.role === 'courier' ? {
        vendorId:   req.user.id,
        vendorName: req.user.name || req.user.email,
      } : {}),
    }));

    const created = await Shipment.insertMany(cleaned);
    logger.info('Bulk shipments created', { count: created.length, userId: req.user?.id });
    res.status(201).json({ count: created.length, shipments: created });
  } catch (err) {
    logger.error('Bulk shipment creation failed', { error: err.message, stack: err.stack, userId: req.user?.id });
    res.status(400).json({ message: err.message });
  }
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────
// CHANGED — security hardening: couriers could previously edit ANY shipment.
// Now restricted to shipments they own (vendorId === their own id); a courier
// also can't reassign a shipment to a different vendorId via the body.
router.put('/:id', async (req, res) => {
  try {
    const body = { ...req.body };
    if (!body.orderId) body.orderId = null;

    if (req.user?.role === 'courier') {
      const existing = await Shipment.findById(req.params.id).lean();
      if (!existing || String(existing.vendorId) !== String(req.user.id))
        return res.status(404).json({ message: 'Shipment not found.' });
      body.vendorId   = req.user.id;
      body.vendorName = req.user.name || req.user.email;
    }

    const shipment = await Shipment.findByIdAndUpdate(req.params.id, body, { new: true });
    if (!shipment) return res.status(404).json({ message: 'Shipment not found.' });
    logger.info('Shipment updated', { shipmentId: req.params.id, userId: req.user?.id });
    res.json(shipment);
  } catch (err) {
    logger.error('Shipment update failed', { shipmentId: req.params.id, error: err.message, stack: err.stack });
    res.status(400).json({ message: err.message });
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────
// CHANGED — security hardening: couriers restricted to deleting their own
// shipments, same ownership check as GET/PUT above.
router.delete('/:id', async (req, res) => {
  try {
    if (req.user?.role === 'courier') {
      const existing = await Shipment.findById(req.params.id).lean();
      if (!existing || String(existing.vendorId) !== String(req.user.id))
        return res.status(404).json({ message: 'Shipment not found.' });
    }

    const shipment = await Shipment.findByIdAndDelete(req.params.id);
    if (!shipment) return res.status(404).json({ message: 'Shipment not found.' });
    logger.info('Shipment deleted', { shipmentId: req.params.id, userId: req.user?.id });
    res.json({ message: 'Shipment deleted.' });
  } catch (err) {
    logger.error('Shipment delete failed', { shipmentId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /refresh-status ─────────────────────────────────────────────────────
// CHANGED — restricted to internal staff; this triggers a system-wide
// tracking refresh across ALL shipments, not something a single courier
// vendor should be able to trigger.
router.post('/refresh-status', async (req, res) => {
  if (req.user?.role === 'courier')
    return res.status(403).json({ message: 'Not permitted for this role.' });
  try {
    logger.info('Shipment status refresh triggered', { userId: req.user?.id });
    const result = await refreshShipmentStatuses();
    logger.info('Shipment status refresh complete', { result });
    res.json(result);
  } catch (err) {
    logger.error('Shipment status refresh failed', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;