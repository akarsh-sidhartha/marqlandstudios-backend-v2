'use strict';
/**
 * routes/orderInquiryRoute.js — legacy /api/orders (kept for older screens).
 *
 *   GET  /               — order list (CourierTracking's order picker)
 *   POST /:id/timeline   — post a timeline update (older OrderTimeline builds)
 *
 * Both are thin adapters over services/orders/orderService.js, the same code
 * behind /api/v2/orders — there is one implementation of each rule. They keep
 * their original un-enveloped response shapes.
 *
 * Everything else moved to /api/v2/orders (routes/v2/index.js):
 *   create / update / delete        → POST, PATCH, DELETE /api/v2/orders[/:id]
 *   attachments (base64 in JSON)    → multipart POST /api/v2/orders/:id/files
 *   GET /:id/attachments            → GET /api/v2/orders/:id/files
 *   GET /shipment-counts            → folded into GET /api/v2/orders (shipmentCount)
 *   GET /proxy-attachment (PUBLIC)  → GET /api/v2/orders/:id/files/:itemId/content
 *     The old proxy streamed ANY OneDrive item id without a login; the
 *     replacement requires auth and only serves files inside that order's folder.
 */
const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const validate = require('../validation/validate');
const orderService = require('../services/orders/orderService');
const { idParam, timeline } = require('../validation/schemas/order.schema');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await orderService.listOrders());
}));

router.post('/:id/timeline', validate({ params: idParam, body: timeline }), asyncHandler(async (req, res) => {
  res.status(201).json(await orderService.postTimeline(req.params.id, req.validated.body, req.user));
}));

module.exports = router;
