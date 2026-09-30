'use strict';
/**
 * controllers/v2/orderController.js — thin HTTP layer for /api/v2/orders.
 *
 * Reads only req.validated (zod output, unknown keys stripped) so no client
 * field can reach the service unchecked. Business rules live in
 * services/orders/orderService.js; errors bubble to middleware/errorHandler.js.
 */
const orders = require('../../services/orders/orderService');
const { ok, created } = require('../../lib/http/apiResponse');

const body = (req) => req.validated?.body || {};
const id = (req) => req.params.id;

const meta = async (req, res) => {
  res.setHeader('Cache-Control', 'private, max-age=3600');
  ok(res, orders.meta());
};

const vendorOptions = async (req, res) => {
  res.setHeader('Cache-Control', 'private, max-age=300');
  ok(res, await orders.vendorOptions());
};

const list = async (req, res) => {
  const items = await orders.listOrders(req.validated?.query || {});
  ok(res, items, { total: items.length });
};

const getOne = async (req, res) => ok(res, await orders.getOrder(id(req)));
const create = async (req, res) => created(res, await orders.createOrder(body(req), req.user));
const update = async (req, res) => ok(res, await orders.updateOrder(id(req), body(req), req.user));
const remove = async (req, res) => ok(res, await orders.deleteOrder(id(req), req.user));

const start = async (req, res) => ok(res, await orders.startProject(id(req), body(req), req.file || null, req.user));
const complete = async (req, res) => ok(res, await orders.completeOrder(id(req), body(req), req.user));
const parseQuote = async (req, res) => ok(res, await orders.parseQuoteFile(req.file));

const addItems = async (req, res) => created(res, await orders.addItems(id(req), body(req).items, req.user));
const updateItem = async (req, res) => ok(res, await orders.updateItem(id(req), req.params.itemId, body(req), req.user));
const removeItem = async (req, res) => ok(res, await orders.removeItem(id(req), req.params.itemId));

const listFiles = async (req, res) => {
  const { files, live } = await orders.listFiles(id(req));
  ok(res, files, { live });
};

const uploadFiles = async (req, res) => {
  const { files, failed } = await orders.uploadFiles(id(req), req.files, req.validated.query.category, req.user);
  created(res, files, { failed });
};

const removeFile = async (req, res) => ok(res, await orders.deleteFile(id(req), req.params.itemId, req.user));

/** Streams the file bytes (not enveloped — this is a download). */
const fileContent = async (req, res) => {
  const file = await orders.openFile(id(req), req.params.itemId);
  const disposition = req.query.download === '1' ? 'attachment' : 'inline';
  res.setHeader('Content-Type', file.mimeType);
  if (file.size) res.setHeader('Content-Length', file.size);
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  file.stream.on('error', (err) => res.destroy(err));
  file.stream.pipe(res);
};

const postTimeline = async (req, res) => created(res, await orders.postTimeline(id(req), body(req), req.user));

module.exports = {
  meta, vendorOptions, list, getOne, create, update, remove, start, complete, parseQuote,
  addItems, updateItem, removeItem, listFiles, uploadFiles, removeFile, fileContent, postTimeline,
};
