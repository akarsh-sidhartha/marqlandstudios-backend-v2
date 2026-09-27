'use strict';
/**
 * controllers/v2/mediaController.js
 *
 *   POST /api/v2/media/images         stage one image (sync, small, ~1s)
 *   POST /api/v2/media/image-search   Google image search via Serper (sync, 8s cap)
 *   POST /api/v2/media/image-imports  download chosen results → 202 + job
 */
const axios = require('axios');
const AppError = require('../../lib/errors/AppError');
const jobQueue = require('../../lib/jobs/jobQueue');
const { stageImage } = require('../../services/media/productMediaService');
const { ok, created, accepted } = require('../../lib/http/apiResponse');
const { withRetry } = require('../../lib/resilience/retry');

const INTERNAL_ROLES = ['inventory', 'sales', 'accounts', 'admin'];
const requireInternal = (user) => { if (!INTERNAL_ROLES.includes(user.role)) throw AppError.forbidden(); };

const uploadImage = async (req, res) => {
  const folder = req.user.role === 'supplier' ? 'supplierSubmissions' : 'products';
  created(res, await stageImage(req.file, req.user, { folder }));
};

const imageSearch = async (req, res) => {
  requireInternal(req.user);
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new AppError('Image search is not configured (SERPER_API_KEY).', 503, { errorCode: 'NOT_CONFIGURED' });

  let data;
  try {
    ({ data } = await withRetry(() => axios.post(
      'https://google.serper.dev/images',
      { q: req.body.query, num: 20, gl: 'in', hl: 'en' },
      { headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' }, timeout: 7_000 }
    ), { label: 'serper.images', retries: 1, maxMs: 1_000 }));
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) throw AppError.upstream(`Image search key was rejected (${status}).`);
    throw AppError.upstream('Image search is temporarily unavailable. Please try again.');
  }

  const results = (data?.images || [])
    .filter((img) => img.imageUrl?.startsWith('http'))
    .map((img) => ({
      url: img.imageUrl,
      thumbnail: img.thumbnailUrl || img.imageUrl,
      source: img.source || img.link || '',
      title: img.title || '',
    }));
  ok(res, results, { query: req.body.query });
};

const importImages = async (req, res) => {
  requireInternal(req.user);
  const job = await jobQueue.enqueue({
    type: 'media.images.import',
    title: `Importing ${req.body.urls.length} image${req.body.urls.length === 1 ? '' : 's'}`,
    payload: { urls: req.body.urls, userId: String(req.user.id), role: req.user.role, folder: 'products' },
    owner: { userId: req.user.id, role: req.user.role },
    idempotencyKey: req.get('Idempotency-Key') || undefined,
  });
  accepted(res, job);
};

module.exports = { uploadImage, imageSearch, importImages };
