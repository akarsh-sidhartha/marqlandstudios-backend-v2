'use strict';
/**
 * controllers/v2/productController.js — thin HTTP layer for /api/v2/products.
 */
const productService = require('../../services/catalog/productService');
const { ok, created, paging, pageMeta } = require('../../lib/http/apiResponse');

const categories = async (req, res) => ok(res, await productService.categorySummary());

const list = async (req, res) => {
  const page = paging(req.query, { defaultLimit: 24, maxLimit: 100 });
  const { items, total } = await productService.listProducts(req.query, page);
  ok(res, items, pageMeta(page, total));
};

const duplicates = async (req, res) => ok(res, await productService.findDuplicates(req.query));

const getOne = async (req, res) => ok(res, await productService.getProduct(req.params.id));

const create = async (req, res) => {
  const { product, jobs } = await productService.createProduct(req.body, req.user);
  created(res, product, { jobs });
};

const update = async (req, res) => {
  const { product, jobs } = await productService.updateProduct(req.params.id, req.body, req.user);
  ok(res, product, { jobs });
};

const remove = async (req, res) => {
  await productService.deleteProduct(req.params.id, req.body?.reason, req.user);
  ok(res, { id: req.params.id, deleted: true });
};

const videoStream = async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  ok(res, await productService.getVideoStream(req.params.id));
};

module.exports = { categories, list, duplicates, getOne, create, update, remove, videoStream };
