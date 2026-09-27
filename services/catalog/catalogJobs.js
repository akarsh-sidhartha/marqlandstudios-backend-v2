'use strict';
/**
 * services/catalog/catalogJobs.js
 *
 * product.image.process — Gemini "studio" treatment of a product's primary
 * image. Previously a fire-and-forget setImmediate() inside the request
 * (no retry, failures only visible in server logs); now a queued job with
 * retries and progress the admin can watch in the task tray.
 *
 * The processed image is written to a NEW R2 key (so CDN/browser caches
 * never serve the old picture) and only swapped in if the product's
 * primary image hasn't been changed in the meantime.
 */
const axios = require('axios');
const Product = require('../../models/Product');
const MediaAsset = require('../../models/MediaAsset');
const jobQueue = require('../../lib/jobs/jobQueue');
const { withRetry } = require('../../lib/resilience/retry');
const { processProductImage } = require('../imageProcessingService');
const { uploadBuffer, FOLDER_MAP } = require('../r2Service');
const { releaseImages } = require('../media/productMediaService');

const { PermanentJobError } = jobQueue;

const processPrimaryImage = async (job, ctx) => {
  const { productId, imageKey, imageUrl, prompt, category } = job.payload;
  const product = await Product.findById(productId).select('imageKey imageUrl').lean();
  if (!product) throw new PermanentJobError('Product no longer exists.', 'TARGET_DELETED');
  if (product.imageUrl !== imageUrl) return { superseded: true };

  await ctx.progress(10, 'downloading', 'Fetching original image…');
  const res = await withRetry(() => axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15_000 }), { label: 'image.fetch', retries: 3 });

  await ctx.progress(30, 'processing', 'Generating studio image…');
  const processed = await processProductImage(Buffer.from(res.data), { category, promptText: prompt });

  await ctx.progress(85, 'saving', 'Saving processed image…');
  const { key, url } = await withRetry(
    () => uploadBuffer(processed, FOLDER_MAP.products, '.webp', 'image/webp'),
    { label: 'r2.upload', retries: 3 }
  );

  const swapped = await Product.findOneAndUpdate(
    { _id: productId, imageUrl },
    { $set: { imageUrl: url, imageKey: key } },
    { new: true }
  ).lean();
  if (!swapped) {
    releaseImages([{ key }]);
    return { superseded: true };
  }
  await MediaAsset.create({
    key, url, owner: { userId: job.owner.userId || 'system', role: job.owner.role || 'system' },
    status: 'attached', attachedTo: { kind: 'product', id: String(productId) }, bytes: processed.length,
  }).catch(() => {});
  if (imageKey) releaseImages([{ key: imageKey }]);
  return { productId, imageUrl: url };
};

const registerCatalogJobs = () => {
  jobQueue.registerHandler('product.image.process', processPrimaryImage, { concurrency: 1, maxAttempts: 3 });
};

module.exports = { registerCatalogJobs };
