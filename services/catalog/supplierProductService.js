'use strict';
/**
 * services/catalog/supplierProductService.js
 *
 * Partner (supplier) product logic for /api/v2/supplier/products.
 *
 * A partner can edit a product at every stage, and every edit is reviewed:
 *   pending / rejected → the submission is updated and (re)queued for review
 *   approved           → the edit is stored as a pending revision (see
 *                        supplierRevisionService.js) and goes into the admin
 *                        approval queue. The live product — and every client
 *                        portal showing it — keeps the approved version until
 *                        an admin approves the change.
 *   deleted            → read-only (removed from the catalogue by Marqland)
 *
 * Price mapping: the partner's price is Marqland's purchase price; the
 * selling price is set (with markup) by the admin at approval time.
 */
const mongoose = require('mongoose');
const Product = require('../../models/Product');
const SupplierProduct = require('../../models/SupplierProduct');
const AppError = require('../../lib/errors/AppError');
const media = require('../media/productMediaService');
const revisions = require('./supplierRevisionService');
const { isValidName, isValidMessage } = require('../../utils/inputValidation');
const logger = require('../../utils/logger').child({ module: 'supplierProductService' });

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const validateText = ({ brand, name, description }) => {
  if (brand !== undefined && !isValidName(brand)) throw AppError.badRequest('Brand can only contain letters, numbers and spaces.');
  if (name !== undefined && !isValidName(name)) throw AppError.badRequest('Product name can only contain letters, numbers and spaces.');
  if (description !== undefined && (!String(description).trim() || !isValidMessage(description))) {
    throw AppError.badRequest('Description is required and can only contain letters, numbers, spaces and line breaks.');
  }
};

// Pending partner video uploads are tracked on the submission row
// (videoUpload), so that field is never taken from the live product.
const MEDIA_FIELDS = ['imageUrl', 'imageKey', 'additionalImages', 'additionalImageKeys',
  'videoSource', 'videoUrl', 'videoOneDriveItemId', 'videoOneDrivePath', 'videoFileName'];

/**
 * What the partner sees. For an approved product the top-level fields are
 * the LIVE version (an admin may have refined it after approval);
 * `pendingChanges` carries the partner's proposed edit while it's being
 * reviewed (or after it was rejected), and is what the edit form starts from.
 */
const toView = (row, live) => {
  const source = row.status === 'approved' && live ? { ...row, ...pick(live, ['brand', 'name', 'description', ...MEDIA_FIELDS]) } : row;
  const { videoOneDriveItemId, videoOneDrivePath, imageKey, additionalImageKeys, pendingRevision, ...rest } = source;
  const rev = row.revisionStatus !== 'none' && row.pendingRevision ? row.pendingRevision : null;
  return {
    ...rest,
    sellingPrice: row.status === 'approved' && live ? live.purchasePrice : row.sellingPrice,
    images: media.currentImages(source),
    video: media.videoView({ ...source, videoUpload: row.videoUpload }),
    isLive: Boolean(row.status === 'approved' && live),
    liveProductId: live ? String(live._id) : null,
    pendingChanges: rev ? {
      status: row.revisionStatus,
      reason: row.revisionRejectionReason || '',
      submittedAt: row.revisionSubmittedAt,
      brand: rev.brand,
      name: rev.name,
      description: rev.description,
      sellingPrice: rev.sellingPrice,
      images: media.currentImages(rev),
      video: media.videoView({ ...rev, videoUpload: row.videoUpload }),
    } : null,
  };
};

function pick(obj, keys) {
  const out = {};
  keys.forEach((k) => { if (obj[k] !== undefined) out[k] = obj[k]; });
  return out;
}

const loadLive = async (rows) => {
  const ids = rows.filter((r) => r.status === 'approved' && r.convertedProductId).map((r) => r.convertedProductId);
  if (!ids.length) return new Map();
  const lives = await Product.find({ _id: { $in: ids } }).lean();
  return new Map(lives.map((p) => [String(p._id), p]));
};

const findOwned = async (id, user) => {
  const row = await SupplierProduct.findOne({ _id: id, supplier: user.id }).lean();
  if (!row) throw AppError.notFound('Product not found.');
  return row;
};

// ── Queries ──────────────────────────────────────────────────────────────────
const list = async (user, { status, search }, { skip, limit }) => {
  const filter = { supplier: user.id };
  // 'changes' = live products with an edit waiting for (or rejected at) review.
  if (status === 'changes') filter.revisionStatus = { $in: ['pending', 'rejected'] };
  else if (status) filter.status = status;
  if (search) {
    const re = new RegExp(escapeRegex(search.trim()), 'i');
    filter.$or = [{ name: re }, { brand: re }];
  }
  const supplierId = new mongoose.Types.ObjectId(String(user.id));
  const [rows, total, counts, changes] = await Promise.all([
    SupplierProduct.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    SupplierProduct.countDocuments(filter),
    SupplierProduct.aggregate([{ $match: { supplier: supplierId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    SupplierProduct.countDocuments({ supplier: supplierId, revisionStatus: { $in: ['pending', 'rejected'] } }),
  ]);
  const live = await loadLive(rows);
  return {
    items: rows.map((r) => toView(r, live.get(String(r.convertedProductId)))),
    total,
    statusCounts: { ...Object.fromEntries(counts.map((c) => [c._id, c.n])), changes },
  };
};

const get = async (id, user) => {
  const row = await findOwned(id, user);
  const live = await loadLive([row]);
  return toView(row, live.get(String(row.convertedProductId)));
};

// ── Mutations ────────────────────────────────────────────────────────────────
const create = async (input, user) => {
  validateText(input);
  const { fields: imageFields, stagedKeys } = await media.resolveImages(input.images, user, null);
  const { patch: videoFields } = media.videoPatch(null, input.video);

  const row = await SupplierProduct.create({
    supplier: user.id,
    brand: input.brand.trim(),
    name: input.name.trim(),
    description: input.description,
    sellingPrice: input.sellingPrice,
    ...imageFields,
    ...videoFields,
    status: 'pending',
  });
  await media.markAttached(stagedKeys, 'supplierProduct', row._id);
  logger.info('Partner product submitted', { supplierProductId: row._id, supplierId: user.id });
  return toView(row.toObject(), null);
};

const update = async (id, input, user) => {
  validateText(input);
  const row = await findOwned(id, user);
  if (row.status === 'deleted') throw AppError.conflict('This product was removed from the catalogue and can no longer be edited.');

  const live = row.status === 'approved' && row.convertedProductId
    ? await Product.findById(row.convertedProductId).lean()
    : null;
  // The version being edited: the pending/rejected proposal, what's live, or the submission itself.
  const base = live ? revisions.editableVersion(row, live) : row;
  // Images/video may be picked from either the proposal or the live version.
  const known = live ? {
    ...base,
    additionalImages: [...(base.additionalImages || []), live.imageUrl, ...(live.additionalImages || [])].filter(Boolean),
    additionalImageKeys: [...(base.additionalImageKeys || []), live.imageKey || '', ...(live.additionalImageKeys || [])],
  } : base;

  const text = {};
  for (const field of ['brand', 'name', 'description']) {
    if (input[field] !== undefined) text[field] = typeof input[field] === 'string' ? input[field].trim() : input[field];
  }

  let imageFields = {};
  let removed = [];
  let stagedKeys = [];
  if (input.images !== undefined) {
    const resolved = await media.resolveImages(input.images, user, known);
    imageFields = resolved.fields;
    removed = resolved.removed;
    stagedKeys = resolved.stagedKeys;
  }
  const { patch: videoPatchFields, releasedItemId } = media.videoPatch(base, input.video);
  const { videoUpload, ...videoFields } = videoPatchFields;

  const changes = { ...text, ...imageFields, ...videoFields };
  if (input.sellingPrice !== undefined) changes.sellingPrice = input.sellingPrice;

  let updated;
  if (live) {
    // Live product: propose the change for admin approval — nothing goes live yet.
    updated = await revisions.proposeRevision(row, live, changes);
    if (videoUpload) await SupplierProduct.updateOne({ _id: row._id }, { $set: { videoUpload } });
  } else {
    // Any edit to an unapproved submission goes (back) into the review queue.
    updated = await SupplierProduct.findByIdAndUpdate(row._id, {
      $set: { ...changes, ...(videoUpload ? { videoUpload } : {}), status: 'pending', rejectionReason: '' },
    }, { new: true, runValidators: true }).lean();
  }

  await media.markAttached(stagedKeys, 'supplierProduct', row._id);
  media.releaseImages(removed);           // reference-checked: live images are never deleted
  if (releasedItemId) media.releaseVideoItem(releasedItemId);

  logger.info('Partner product updated', {
    supplierProductId: row._id, supplierId: user.id, status: updated.status, revisionStatus: updated.revisionStatus,
  });
  return toView(updated, live);
};

// Partners can delete pending, rejected and REMOVED (status 'deleted') rows —
// the last clears a product Marqland took out of the catalogue from their
// list. Live products can't be deleted from the partner portal.
const remove = async (id, user) => {
  const row = await findOwned(id, user);
  if (row.status === 'approved') throw AppError.conflict('Live products cannot be deleted here — please contact Marqland Studios.');
  await SupplierProduct.deleteOne({ _id: row._id });
  media.releaseImages([...media.currentImages(row), ...(row.pendingRevision ? media.currentImages(row.pendingRevision) : [])]);
  if (row.pendingRevision?.videoOneDriveItemId) media.releaseVideoItem(row.pendingRevision.videoOneDriveItemId);
  if (row.videoOneDriveItemId) media.releaseVideoItem(row.videoOneDriveItemId);
  logger.info('Partner product deleted', { supplierProductId: row._id, supplierId: user.id });
};

module.exports = { list, get, create, update, remove, toView };
