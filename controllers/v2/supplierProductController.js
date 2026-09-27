'use strict';
/**
 * controllers/v2/supplierProductController.js — thin HTTP layer for
 * /api/v2/supplier/products (partner portal).
 */
const service = require('../../services/catalog/supplierProductService');
const { ok, created, paging, pageMeta } = require('../../lib/http/apiResponse');

const list = async (req, res) => {
  const page = paging(req.query, { defaultLimit: 20, maxLimit: 50 });
  const { items, total, statusCounts } = await service.list(req.user, req.query, page);
  ok(res, items, { ...pageMeta(page, total), statusCounts });
};

const getOne = async (req, res) => ok(res, await service.get(req.params.id, req.user));
const create = async (req, res) => created(res, await service.create(req.body, req.user));
const update = async (req, res) => ok(res, await service.update(req.params.id, req.body, req.user));

const remove = async (req, res) => {
  await service.remove(req.params.id, req.user);
  ok(res, { id: req.params.id, deleted: true });
};

module.exports = { list, getOne, create, update, remove };
