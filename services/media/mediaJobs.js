'use strict';
/**
 * services/media/mediaJobs.js
 *
 * Background jobs for product media, plus the upload-session purposes that
 * feed them. registerMediaJobs() is called once at boot (server.js).
 *
 *   product.video.upload    admin-uploaded video → OneDrive
 *                           development|website / products / {Product folder}
 *   supplier.video.upload   partner-uploaded video → OneDrive
 *                           development|website / supplier folder / {Company} / {Product}
 *                           (for a product that's already live, the video becomes
 *                           part of a change awaiting admin approval)
 *   media.images.import     "Find images online" → download selected results
 *                           → WebP → R2 → staged images the form can attach
 *
 * Every video job records its id on the target document (videoUpload.jobId)
 * before it is queued. When the job finishes it only swaps the video in if
 * that id still matches — if the user meanwhile pasted a YouTube link or
 * started another upload, the stale result is discarded and its file deleted.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const mongoose = require('mongoose');
const Product = require('../../models/Product');
const SupplierProduct = require('../../models/SupplierProduct');
const UploadSession = require('../../models/UploadSession');
const MediaAsset = require('../../models/MediaAsset');
const AppError = require('../../lib/errors/AppError');
const jobQueue = require('../../lib/jobs/jobQueue');
const { withRetry } = require('../../lib/resilience/retry');
const { uploadBuffer, FOLDER_MAP } = require('../r2Service');
const uploadSessions = require('./uploadSessionService');
const { uploadLargeFile, productFolderSegments, supplierFolderSegments, safeName, deleteItem } = require('./oneDriveMediaService');
const { releaseVideoItem } = require('./productMediaService');
const revisions = require('../catalog/supplierRevisionService');
const logger = require('../../utils/logger').child({ module: 'mediaJobs' });

const { PermanentJobError } = jobQueue;
const INTERNAL_ROLES = ['inventory', 'sales', 'accounts', 'admin'];
const isObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id));

// ── Shared: run an upload session's file through OneDrive ────────────────────
const uploadSessionToOneDrive = async (job, ctx, folderSegments, baseName) => {
  const session = await UploadSession.findById(job.payload.uploadId);
  if (!session || !session.tmpPath || !fs.existsSync(session.tmpPath)) {
    throw new PermanentJobError('The uploaded file is no longer on the server. Please upload the video again.', 'UPLOAD_FILE_MISSING');
  }
  const ext = path.extname(session.tmpPath) || '.mp4';
  const fileName = `${safeName(baseName, 'product')} - video${ext}`;

  // Progress text is shown to partners too — never mention where files are stored.
  await ctx.progress(2, 'uploading', 'Processing video…');
  const uploaded = await uploadLargeFile({
    folderSegments,
    fileName,
    filePath: session.tmpPath,
    mimeType: session.mimeType,
    signal: ctx.signal,
    onProgress: (sent, total) => ctx.progress(2 + (sent / total) * 93, 'uploading', `${Math.round(sent / 1048576)} / ${Math.round(total / 1048576)} MB`),
  });
  return { uploaded, session };
};

const videoFieldsFrom = (uploaded, session) => ({
  videoSource: 'upload',
  videoUrl: '',
  videoOneDriveItemId: uploaded.itemId,
  videoOneDrivePath: uploaded.path,
  videoFileName: session.fileName,
  videoUpload: { status: 'idle', jobId: '', fileName: '', error: '', updatedAt: new Date() },
});

const discard = async (itemId, why, job) => {
  logger.info('Video upload superseded — discarding result', { jobId: job._id, why });
  await deleteItem(itemId).catch(() => {});
  await uploadSessions.releaseFile(job.payload.uploadId);
  return { superseded: true };
};

// ── product.video.upload ─────────────────────────────────────────────────────
const productVideoUpload = async (job, ctx) => {
  const jobId = String(job._id);
  const product = await Product.findById(job.payload.productId).lean();
  if (!product) {
    await uploadSessions.releaseFile(job.payload.uploadId);
    throw new PermanentJobError('The product was deleted before its video finished uploading.', 'TARGET_DELETED');
  }
  if (product.videoUpload?.jobId !== jobId) {
    await uploadSessions.releaseFile(job.payload.uploadId);
    return { superseded: true };
  }

  const { uploaded, session } = await uploadSessionToOneDrive(job, ctx, productFolderSegments(product), product.name);

  await ctx.progress(97, 'saving', 'Finishing up…');
  const before = await Product.findOneAndUpdate(
    { _id: product._id, 'videoUpload.jobId': jobId },
    { $set: videoFieldsFrom(uploaded, session) },
    { new: false }
  ).lean();
  if (!before) return discard(uploaded.itemId, 'product video changed while uploading', job);

  if (before.videoOneDriveItemId && before.videoOneDriveItemId !== uploaded.itemId) releaseVideoItem(before.videoOneDriveItemId);
  await uploadSessions.releaseFile(job.payload.uploadId);
  return { productId: String(product._id), fileName: session.fileName, oneDrivePath: uploaded.path };
};

// ── supplier.video.upload ────────────────────────────────────────────────────
const supplierVideoUpload = async (job, ctx) => {
  const jobId = String(job._id);
  const row = await SupplierProduct.findById(job.payload.supplierProductId)
    .populate('supplier', 'name supplierCompanyName').lean();
  if (!row) {
    await uploadSessions.releaseFile(job.payload.uploadId);
    throw new PermanentJobError('The submission was deleted before its video finished uploading.', 'TARGET_DELETED');
  }
  if (row.videoUpload?.jobId !== jobId) {
    await uploadSessions.releaseFile(job.payload.uploadId);
    return { superseded: true };
  }

  const company = row.supplier?.supplierCompanyName || row.supplier?.name;
  const { uploaded, session } = await uploadSessionToOneDrive(job, ctx, supplierFolderSegments(company, row.name), row.name);

  await ctx.progress(97, 'saving', 'Finishing up…');
  const fields = videoFieldsFrom(uploaded, session);
  const { videoUpload, ...videoOnly } = fields;

  // Live product → the new video becomes part of a change that needs admin
  // approval; the live product keeps its current video until then.
  if (row.status === 'approved' && row.convertedProductId) {
    const live = await Product.findById(row.convertedProductId).lean();
    const claimed = await SupplierProduct.findOneAndUpdate(
      { _id: row._id, 'videoUpload.jobId': jobId },
      { $set: { videoUpload } },
      { new: false }
    ).lean();
    if (!claimed) return discard(uploaded.itemId, 'submission video changed while uploading', job);
    const before = revisions.editableVersion(claimed, live);
    await revisions.proposeRevision(claimed, live, videoOnly);
    if (before.videoOneDriveItemId && before.videoOneDriveItemId !== uploaded.itemId) releaseVideoItem(before.videoOneDriveItemId);
    await uploadSessions.releaseFile(job.payload.uploadId);
    return { supplierProductId: String(row._id), pendingApproval: true, fileName: session.fileName };
  }

  const before = await SupplierProduct.findOneAndUpdate(
    { _id: row._id, 'videoUpload.jobId': jobId },
    { $set: fields },
    { new: false }
  ).lean();
  if (!before) return discard(uploaded.itemId, 'submission video changed while uploading', job);

  if (before.videoOneDriveItemId && before.videoOneDriveItemId !== uploaded.itemId) releaseVideoItem(before.videoOneDriveItemId);
  await uploadSessions.releaseFile(job.payload.uploadId);
  return { supplierProductId: String(row._id), fileName: session.fileName };
};

// ── media.images.import ──────────────────────────────────────────────────────
const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;

const assertPublicImageUrl = (raw) => {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) images can be imported');
  if (PRIVATE_HOST.test(url.hostname)) throw new Error('Private network addresses are not allowed');
  return url.toString();
};

const importImages = async (job, ctx) => {
  const { urls = [], userId, role, folder = 'products' } = job.payload;
  const saved = [];
  const failed = [];

  for (let i = 0; i < urls.length; i += 1) {
    if (ctx.signal.aborted) throw new Error('Worker shutting down.');
    const raw = urls[i];
    try {
      const url = assertPublicImageUrl(raw);
      // eslint-disable-next-line no-await-in-loop
      const res = await withRetry(() => axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15_000,
        maxContentLength: 10 * 1024 * 1024,
        maxRedirects: 3,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProductGalleryBot/1.0)', Accept: 'image/*,*/*' },
      }), { label: 'image.download', retries: 2, maxMs: 4_000 });
      const contentType = res.headers['content-type'] || '';
      if (!contentType.startsWith('image/')) throw new Error(`Not an image (${contentType || 'unknown type'})`);

      // eslint-disable-next-line no-await-in-loop
      const { data, info } = await sharp(Buffer.from(res.data))
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 86 })
        .toBuffer({ resolveWithObject: true });
      // eslint-disable-next-line no-await-in-loop
      const { key, url: publicUrl } = await withRetry(
        () => uploadBuffer(data, FOLDER_MAP[folder] || FOLDER_MAP.products, '.webp', 'image/webp'),
        { label: 'r2.upload', retries: 3 }
      );
      // eslint-disable-next-line no-await-in-loop
      await MediaAsset.create({
        key, url: publicUrl, owner: { userId: String(userId), role },
        width: info.width, height: info.height, bytes: data.length,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      saved.push({ key, url: publicUrl, sourceUrl: raw });
    } catch (err) {
      failed.push({ url: raw, reason: err.message });
    }
    // eslint-disable-next-line no-await-in-loop
    await ctx.progress(((i + 1) / urls.length) * 100, 'importing', `${saved.length} of ${urls.length} images imported`);
  }

  if (!saved.length && urls.length) {
    // Nothing worked — let the queue retry later (the sites may be temporarily down).
    throw new Error(`None of the ${urls.length} images could be downloaded (${failed[0]?.reason || 'unknown error'}).`);
  }
  return { saved, failed };
};

// ── Upload-session purposes ─────────────────────────────────────────────────
const newJobId = () => new mongoose.Types.ObjectId();

const registerPurposes = () => {
  uploadSessions.registerPurpose('product-video', {
    authorize: async (user, targetId) => {
      if (!INTERNAL_ROLES.includes(user.role)) throw AppError.forbidden();
      if (!isObjectId(targetId) || !(await Product.exists({ _id: targetId }))) throw AppError.notFound('Product not found.');
    },
    onComplete: async (session, user, { idempotencyKey } = {}) => {
      const id = newJobId();
      const product = await Product.findByIdAndUpdate(session.targetId, {
        $set: { videoUpload: { status: 'processing', jobId: String(id), fileName: session.fileName, error: '', updatedAt: new Date() } },
      }, { new: true });
      if (!product) throw AppError.notFound('Product not found.');
      return jobQueue.enqueue({
        id,
        type: 'product.video.upload',
        title: `Uploading video · ${product.name}`,
        payload: { uploadId: String(session._id), productId: String(product._id) },
        owner: { userId: user.id, role: user.role },
        idempotencyKey: idempotencyKey ? `complete:${idempotencyKey}` : `upload:${session._id}`,
        pinToThisHost: true,
        resource: { kind: 'product', id: String(product._id) },
      });
    },
  });

  uploadSessions.registerPurpose('supplier-product-video', {
    authorize: async (user, targetId) => {
      if (user.role !== 'supplier') throw AppError.forbidden();
      if (!isObjectId(targetId) || !(await SupplierProduct.exists({ _id: targetId, supplier: user.id }))) {
        throw AppError.notFound('Submission not found.');
      }
    },
    onComplete: async (session, user, { idempotencyKey } = {}) => {
      const id = newJobId();
      const row = await SupplierProduct.findOneAndUpdate(
        { _id: session.targetId, supplier: user.id },
        { $set: { videoUpload: { status: 'processing', jobId: String(id), fileName: session.fileName, error: '', updatedAt: new Date() } } },
        { new: true }
      );
      if (!row) throw AppError.notFound('Submission not found.');
      return jobQueue.enqueue({
        id,
        type: 'supplier.video.upload',
        title: `Uploading video · ${row.name}`,
        payload: { uploadId: String(session._id), supplierProductId: String(row._id) },
        owner: { userId: user.id, role: user.role },
        idempotencyKey: idempotencyKey ? `complete:${idempotencyKey}` : `upload:${session._id}`,
        pinToThisHost: true,
        resource: { kind: 'supplierProduct', id: String(row._id) },
      });
    },
  });
};

// Surface final failures (and manual retries) on the product so the UI can show them.
const TARGETS = {
  'product.video.upload': { model: Product, idField: 'productId' },
  'supplier.video.upload': { model: SupplierProduct, idField: 'supplierProductId' },
};

const listenForJobOutcomes = () => {
  jobQueue.events.on('failed', (job) => {
    const target = TARGETS[job.type];
    if (!target) return;
    target.model.updateOne(
      { _id: job.payload[target.idField], 'videoUpload.jobId': String(job._id) },
      { $set: {
        'videoUpload.status': 'failed',
        // The submission row is shown to the partner — keep its message neutral.
        'videoUpload.error': job.type === 'supplier.video.upload' && !['UPLOAD_FILE_MISSING', 'TARGET_DELETED'].includes(job.error?.code)
          ? 'The video could not be processed. Please upload it again.'
          : (job.error?.message || 'Upload failed.'),
        'videoUpload.updatedAt': new Date(),
      } }
    ).catch((err) => logger.warn('Could not record video failure', { jobId: job._id, error: err.message }));
  });
  jobQueue.events.on('retried', (job) => {
    const target = TARGETS[job.type];
    if (!target) return;
    target.model.updateOne(
      { _id: job.payload[target.idField], 'videoUpload.jobId': String(job._id) },
      { $set: { 'videoUpload.status': 'processing', 'videoUpload.error': '', 'videoUpload.updatedAt': new Date() } }
    ).catch(() => {});
  });
};

const registerMediaJobs = () => {
  jobQueue.registerHandler('product.video.upload', productVideoUpload, { concurrency: 2, maxAttempts: 5 });
  jobQueue.registerHandler('supplier.video.upload', supplierVideoUpload, { concurrency: 2, maxAttempts: 5 });
  jobQueue.registerHandler('media.images.import', importImages, { concurrency: 2, maxAttempts: 3 });
  registerPurposes();
  listenForJobOutcomes();
};

module.exports = { registerMediaJobs, assertPublicImageUrl };
