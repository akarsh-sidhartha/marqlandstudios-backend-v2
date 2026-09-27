'use strict';
/**
 * services/media/productMediaService.js
 *
 * Image + video bookkeeping shared by the admin product API and the
 * partner (supplier) product API.
 *
 * Images
 *   stageImage()     picked image → WebP → R2, recorded as a staged MediaAsset
 *   resolveImages()  turns the ordered list the form sends ({ key, url }[])
 *                    into { imageUrl, imageKey, additionalImages, additionalImageKeys },
 *                    accepting only images the record already has or ones the
 *                    same user staged
 *   releaseImages()  deletes R2 objects no longer referenced by any product
 *
 * Video
 *   applyVideoLink() switch a record to a YouTube / brand link
 *   clearVideo()     remove the video entirely
 *   (uploaded files go through upload sessions + the jobs in productVideoJobs.js)
 */
const sharp = require('sharp');
const Product = require('../../models/Product');
const SupplierProduct = require('../../models/SupplierProduct');
const MediaAsset = require('../../models/MediaAsset');
const AppError = require('../../lib/errors/AppError');
const { uploadBuffer, deleteFromR2, FOLDER_MAP } = require('../r2Service');
const { withRetry } = require('../../lib/resilience/retry');
const { isSafeUrl, normalizeUrl } = require('../../utils/inputValidation');
const { deleteItem } = require('./oneDriveMediaService');
const logger = require('../../utils/logger').child({ module: 'productMediaService' });

const MAX_IMAGES = 20;
const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

// ── Images ───────────────────────────────────────────────────────────────────
const stageImage = async (file, user, { folder = 'products' } = {}) => {
  if (!file) throw AppError.badRequest('No image uploaded.');
  if (!IMAGE_TYPES.has(file.mimetype)) throw AppError.badRequest('Only JPG, PNG, WEBP, GIF or HEIC images are allowed.');

  let webp;
  let info;
  try {
    ({ data: webp, info } = await sharp(file.buffer)
      .rotate()
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 86 })
      .toBuffer({ resolveWithObject: true }));
  } catch {
    throw AppError.badRequest('That image could not be read. Please try a different file.');
  }

  const { key, url } = await withRetry(
    () => uploadBuffer(webp, FOLDER_MAP[folder] || FOLDER_MAP.products, '.webp', 'image/webp'),
    { label: 'r2.upload', retries: 3, maxMs: 4_000 }
  );

  const asset = await MediaAsset.create({
    key, url,
    owner: { userId: String(user.id), role: user.role },
    width: info.width, height: info.height, bytes: webp.length,
    expiresAt: new Date(Date.now() + STAGED_TTL_MS),
  });
  logger.info('Image staged', { key, userId: user.id, bytes: webp.length });
  return { key: asset.key, url: asset.url, width: asset.width, height: asset.height };
};

const currentImages = (record) => {
  const list = [];
  if (record?.imageUrl) list.push({ url: record.imageUrl, key: record.imageKey || '' });
  (record?.additionalImages || []).forEach((url, i) => {
    if (url) list.push({ url, key: record.additionalImageKeys?.[i] || '' });
  });
  return list;
};

/**
 * @param {Array<{key?:string,url?:string}>} images  ordered — first is primary
 * @param {object} user
 * @param {object|null} existing  current Product / SupplierProduct (null on create)
 * @returns {{ fields, stagedKeys, removed }}
 */
const resolveImages = async (images, user, existing = null) => {
  if (!Array.isArray(images)) throw AppError.badRequest('images must be an array.');
  if (images.length === 0) throw AppError.badRequest('At least one product image is required.');
  if (images.length > MAX_IMAGES) throw AppError.badRequest(`A product can have at most ${MAX_IMAGES} images.`);

  const have = currentImages(existing);
  const byKey = new Map(have.filter((i) => i.key).map((i) => [i.key, i]));
  const byUrl = new Map(have.map((i) => [i.url, i]));

  const unknownKeys = images
    .map((img) => String(img?.key || ''))
    .filter((key) => key && !byKey.has(key));
  const staged = unknownKeys.length
    ? await MediaAsset.find({ key: { $in: unknownKeys }, 'owner.userId': String(user.id) }).lean()
    : [];
  const stagedByKey = new Map(staged.map((a) => [a.key, a]));

  const resolved = [];
  const seen = new Set();
  for (const img of images) {
    const key = String(img?.key || '');
    const url = String(img?.url || '');
    const match = (key && (byKey.get(key) || stagedByKey.get(key))) || (!key && url && byUrl.get(url));
    if (!match) throw AppError.badRequest('One of the images is not recognised. Please upload it again.');
    const id = match.key || match.url;
    if (seen.has(id)) continue;
    seen.add(id);
    resolved.push({ url: match.url, key: match.key || '' });
  }

  const [primary, ...rest] = resolved;
  const keep = new Set(resolved.map((i) => i.key || i.url));
  return {
    fields: {
      imageUrl: primary.url,
      imageKey: primary.key,
      additionalImages: rest.map((i) => i.url),
      additionalImageKeys: rest.map((i) => i.key),
    },
    stagedKeys: resolved.filter((i) => stagedByKey.has(i.key)).map((i) => i.key),
    removed: have.filter((i) => !keep.has(i.key || i.url)),
  };
};

const markAttached = async (keys, kind, id) => {
  if (!keys.length) return;
  await MediaAsset.updateMany(
    { key: { $in: keys } },
    { $set: { status: 'attached', attachedTo: { kind, id: String(id) }, expiresAt: null } }
  );
};

const isImageReferenced = async (key) => {
  const q = { $or: [{ imageKey: key }, { additionalImageKeys: key }] };
  // Images proposed in a pending partner edit are in use too.
  const rq = { $or: [{ imageKey: key }, { additionalImageKeys: key }, { 'pendingRevision.imageKey': key }, { 'pendingRevision.additionalImageKeys': key }] };
  const [p, s] = await Promise.all([Product.exists(q), SupplierProduct.exists(rq)]);
  return Boolean(p || s);
};

/** Fire-and-forget cleanup for images a save dropped. Never blocks the response. */
const releaseImages = (removed) => {
  const keys = removed.map((i) => i.key).filter(Boolean);
  if (!keys.length) return;
  setImmediate(async () => {
    for (const key of keys) {
      try {
        // Approved partner products share keys with their submission row.
        // eslint-disable-next-line no-await-in-loop
        if (await isImageReferenced(key)) continue;
        // eslint-disable-next-line no-await-in-loop
        await deleteFromR2(key);
        // eslint-disable-next-line no-await-in-loop
        await MediaAsset.deleteOne({ key });
      } catch (err) {
        logger.warn('Image cleanup failed (non-fatal)', { key, error: err.message });
      }
    }
  });
};

const cleanupStagedImages = async () => {
  const expired = await MediaAsset.find({ status: 'staged', expiresAt: { $lt: new Date() } }).limit(200).lean();
  for (const asset of expired) {
    // eslint-disable-next-line no-await-in-loop
    await deleteFromR2(asset.key);
    // eslint-disable-next-line no-await-in-loop
    await MediaAsset.deleteOne({ _id: asset._id });
  }
  if (expired.length) logger.info('Removed abandoned staged images', { count: expired.length });
};

// ── Video ───────────────────────────────────────────────────────────────────
const YT_PATTERNS = [
  /youtu\.be\/([\w-]{6,})/, /youtube\.com\/watch\?[^#]*v=([\w-]{6,})/,
  /youtube\.com\/embed\/([\w-]{6,})/, /youtube\.com\/shorts\/([\w-]{6,})/,
];
const youTubeId = (url) => {
  for (const re of YT_PATTERNS) {
    const m = String(url || '').match(re);
    if (m) return m[1];
  }
  return null;
};

/**
 * Validates a video link. `requireYouTube` is used by the partner form's
 * YouTube option; the admin "link" option also accepts direct brand URLs.
 */
const normaliseVideoLink = (raw, { requireYouTube = false } = {}) => {
  const value = String(raw || '').trim();
  if (!value) throw AppError.badRequest('Please paste a video link.');
  if (!isSafeUrl(value)) throw AppError.badRequest('Video link must be a valid http(s) URL.');
  const url = normalizeUrl(value);
  if (requireYouTube && !youTubeId(url)) throw AppError.badRequest('Please paste a valid YouTube link.');
  return url;
};

const isVideoItemReferenced = async (itemId) => {
  const [p, s] = await Promise.all([
    Product.exists({ videoOneDriveItemId: itemId }),
    SupplierProduct.exists({ $or: [{ videoOneDriveItemId: itemId }, { 'pendingRevision.videoOneDriveItemId': itemId }] }),
  ]);
  return Boolean(p || s);
};

/** Delete a OneDrive video once nothing points at it any more (background, best effort). */
const releaseVideoItem = (itemId) => {
  if (!itemId) return;
  setImmediate(async () => {
    try {
      if (await isVideoItemReferenced(itemId)) return;
      await deleteItem(itemId);
      logger.info('Replaced OneDrive video deleted', { itemId });
    } catch (err) {
      logger.warn('OneDrive video cleanup failed (non-fatal)', { itemId, error: err.message });
    }
  });
};

/** Effective video for API consumers (legacy rows have no videoSource). */
const videoView = (record) => {
  const source = record.videoSource || (record.videoUrl ? 'link' : (record.videoOneDriveItemId || record.videoOneDrivePath ? 'upload' : ''));
  return {
    source,
    url: source === 'link' ? record.videoUrl : '',
    fileName: source === 'upload' ? (record.videoFileName || (record.videoOneDrivePath || '').split('/').pop()) : '',
    hasVideo: Boolean(source),
    upload: {
      status: record.videoUpload?.status || 'idle',
      jobId: record.videoUpload?.jobId || '',
      fileName: record.videoUpload?.fileName || '',
      error: record.videoUpload?.error || '',
    },
  };
};

/**
 * Fields for a link/none video change. Returns the $set patch plus the
 * OneDrive item that is no longer needed (if any). A pending upload is
 * superseded: its job will notice and discard its result.
 */
const videoPatch = (existing, video, { requireYouTube = false } = {}) => {
  if (!video || video.source === undefined || video.source === 'keep') return { patch: {}, releasedItemId: '' };
  const oldItem = existing?.videoOneDriveItemId || '';
  const idle = { status: 'idle', jobId: '', fileName: '', error: '', updatedAt: new Date() };

  if (video.source === 'link' || video.source === 'youtube') {
    return {
      patch: {
        videoSource: 'link',
        videoUrl: normaliseVideoLink(video.url, { requireYouTube: requireYouTube || video.source === 'youtube' }),
        videoOneDriveItemId: '', videoOneDrivePath: '', videoFileName: '',
        videoUpload: idle,
      },
      releasedItemId: oldItem,
    };
  }
  if (video.source === 'none') {
    return {
      patch: { videoSource: '', videoUrl: '', videoOneDriveItemId: '', videoOneDrivePath: '', videoFileName: '', videoUpload: idle },
      releasedItemId: oldItem,
    };
  }
  // 'upload' is not set here — the upload session + job swap the file in.
  if (video.source === 'upload') return { patch: {}, releasedItemId: '' };
  throw AppError.badRequest('Unknown video option.');
};

module.exports = {
  stageImage, resolveImages, markAttached, releaseImages, cleanupStagedImages, currentImages,
  normaliseVideoLink, videoPatch, videoView, releaseVideoItem, youTubeId, MAX_IMAGES,
};
