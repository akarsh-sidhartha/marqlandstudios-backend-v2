'use strict';
/**
 * routes/v2/index.js — mounted at /api/v2 (see server.js).
 *
 * The v2 API follows one contract end to end:
 *   - every response is { success, data, error, meta }  (lib/http/apiResponse.js)
 *   - every synchronous request answers within 10s or gets a 504
 *     (middleware/requestTimeout.js); chunk uploads get 60s per 4 MB chunk
 *   - anything slower (OneDrive, image imports, AI processing) returns
 *     202 + jobId and runs in the background queue (lib/jobs/jobQueue.js)
 *   - mutating requests accept an Idempotency-Key header (middleware/idempotency.js)
 *   - input is validated with zod before any handler runs
 *
 * Auth: the global routeGuard in server.js enforces roles per prefix
 * (middleware/authMiddleware.js ROUTE_PERMISSIONS '/v2/...'); handlers
 * additionally scope every query to the calling user where relevant.
 *
 * Legacy /api/products and /api/suppliers stay untouched for the screens
 * that still use them (ComboCreator, ClientPortalEditor, …).
 */
const express = require('express');
const multer = require('multer');

const asyncHandler = require('../../middleware/asyncHandler');
const validate = require('../../validation/validate');
const idempotency = require('../../middleware/idempotency');
const { requestTimeout } = require('../../middleware/requestTimeout');
const { createRateLimiter } = require('../../middleware/security/rateLimiter');
const AppError = require('../../lib/errors/AppError');
const schema = require('../../validation/schemas/v2.schema');
const { MAX_CHUNK_BYTES } = require('../../services/media/uploadSessionService');

const products = require('../../controllers/v2/productController');
const supplier = require('../../controllers/v2/supplierProductController');
const mediaCtl = require('../../controllers/v2/mediaController');
const uploads = require('../../controllers/v2/uploadController');
const jobs = require('../../controllers/v2/jobController');

const router = express.Router();
router.use(requestTimeout(10_000));

const h = asyncHandler;
const once = idempotency();

// Image staging — one image per request so the browser can upload several in
// parallel and show per-image progress while the user keeps filling the form.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
}).single('image');

// Chunks are plain bytes; their own bucket so a 500 MB upload (125 chunks)
// neither trips nor drains the per-IP global limiter.
const chunkLimiter = createRateLimiter({ capacity: 40, refillPerSec: 4, keyGenerator: (req) => `${req.user?.id || req.ip}:chunks` });
const rawChunk = express.raw({ type: () => true, limit: MAX_CHUNK_BYTES });

// ── Catalogue products (admin app) ──────────────────────────────────────────
router.get('/products/categories', h(products.categories));
router.get('/products/duplicates', validate({ query: schema.duplicateQuery }), h(products.duplicates));
router.get('/products', validate({ query: schema.listProducts }), h(products.list));
router.post('/products', validate({ body: schema.createProduct }), once, h(products.create));
router.get('/products/:id', validate({ params: schema.idParam }), h(products.getOne));
router.patch('/products/:id', validate({ params: schema.idParam, body: schema.updateProduct }), once, h(products.update));
router.delete('/products/:id', validate({ params: schema.idParam, body: schema.deleteProduct }), h(products.remove));
router.get('/products/:id/video-stream', validate({ params: schema.idParam }), h(products.videoStream));

// ── Partner products (partner portal) ────────────────────────────────────────
router.get('/supplier/products', validate({ query: schema.listSupplierProducts }), h(supplier.list));
router.post('/supplier/products', validate({ body: schema.createSupplierProduct }), once, h(supplier.create));
router.get('/supplier/products/:id', validate({ params: schema.idParam }), h(supplier.getOne));
router.patch('/supplier/products/:id', validate({ params: schema.idParam, body: schema.updateSupplierProduct }), once, h(supplier.update));
router.delete('/supplier/products/:id', validate({ params: schema.idParam }), h(supplier.remove));

// ── Media ────────────────────────────────────────────────────────────────────
router.post('/media/images', requestTimeout(30_000), (req, res, next) => imageUpload(req, res, (err) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return next(AppError.payloadTooLarge('Images can be at most 10 MB.'));
  next(err);
}), h(mediaCtl.uploadImage));
router.post('/media/image-search', validate({ body: schema.imageSearch }), h(mediaCtl.imageSearch));
router.post('/media/image-imports', validate({ body: schema.imageImport }), h(mediaCtl.importImages));

// ── Resumable uploads ────────────────────────────────────────────────────────
router.post('/uploads', validate({ body: schema.createUpload }), h(uploads.start));
router.get('/uploads/:id', validate({ params: schema.idParam }), h(uploads.status));
router.put('/uploads/:id/chunks', requestTimeout(60_000), chunkLimiter, validate({ params: schema.idParam, query: schema.chunkQuery }), rawChunk, h(uploads.chunk));
router.post('/uploads/:id/complete', validate({ params: schema.idParam }), h(uploads.complete));
router.delete('/uploads/:id', validate({ params: schema.idParam }), h(uploads.abort));

// ── Background jobs ─────────────────────────────────────────────────────────
router.get('/jobs', validate({ query: schema.jobList }), h(jobs.list));
router.get('/jobs/:id', validate({ params: schema.idParam }), h(jobs.getOne));
router.post('/jobs/:id/retry', validate({ params: schema.idParam }), h(jobs.retry));
router.post('/jobs/:id/cancel', validate({ params: schema.idParam }), h(jobs.cancel));

// Unknown /api/v2 path → enveloped 404 instead of falling through.
router.use((req, res, next) => next(AppError.notFound(`No such endpoint: ${req.method} ${req.originalUrl.split('?')[0]}`)));

module.exports = router;
