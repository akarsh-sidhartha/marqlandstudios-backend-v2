'use strict';
/**
 * services/catalog/supplierRevisionService.js
 *
 * Approval workflow for partner edits to products that are ALREADY LIVE.
 *
 *   partner saves an edit     → proposeRevision(): stored on the submission row
 *                               as pendingRevision, revisionStatus = 'pending'.
 *                               The live Product is NOT touched, so client
 *                               portals keep showing the approved version.
 *   admin approves the change → approveRevision(): the proposed text, price,
 *                               images and video are copied onto the live
 *                               Product (and the row); portals show it on
 *                               their next load.
 *   admin rejects the change  → rejectRevision(): revisionStatus = 'rejected'
 *                               with a reason; the partner can fix and resubmit.
 *
 * Price mapping is the same as first approval: the partner's price becomes
 * Marqland's purchase price; the selling price is purchase + markup (the
 * admin can adjust either when approving).
 */
const Product = require('../../models/Product');
const SupplierProduct = require('../../models/SupplierProduct');
const AppError = require('../../lib/errors/AppError');
const media = require('../media/productMediaService');
const logger = require('../../utils/logger').child({ module: 'supplierRevisionService' });

const CONTENT_FIELDS = ['brand', 'name', 'description', 'imageUrl', 'imageKey', 'additionalImages', 'additionalImageKeys',
  'videoSource', 'videoUrl', 'videoOneDriveItemId', 'videoOneDrivePath', 'videoFileName'];

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));

const calcSellingPrice = (purchasePrice, markupPercent) => {
  const price = Number(purchasePrice) || 0;
  return Math.round(price + (price * (Number(markupPercent) || 0)) / 100);
};

/** Starting point for a new revision: the version that is live right now. */
const revisionBase = (row, live) => ({
  ...pick(live || row, CONTENT_FIELDS),
  sellingPrice: live ? live.purchasePrice : row.sellingPrice,
});

/** The version the partner should be editing (their pending/rejected change, or what's live). */
const editableVersion = (row, live) => (row.pendingRevision ? row.pendingRevision : revisionBase(row, live));

/**
 * Record the partner's proposed change to a live product.
 * `changes` holds already-validated fields (text, sellingPrice, image and video fields).
 * Returns the updated row (lean).
 */
const proposeRevision = async (row, live, changes) => {
  const next = { ...editableVersion(row, live), ...changes };
  delete next.videoUpload;
  const updated = await SupplierProduct.findByIdAndUpdate(row._id, {
    $set: {
      pendingRevision: next,
      revisionStatus: 'pending',
      revisionRejectionReason: '',
      revisionSubmittedAt: new Date(),
    },
  }, { new: true, runValidators: true }).lean();
  logger.info('Partner change to live product submitted for review', { supplierProductId: row._id, productId: row.convertedProductId });
  return updated;
};

const loadForReview = async (id) => {
  const row = await SupplierProduct.findById(id).lean();
  if (!row) throw AppError.notFound('Submission not found.');
  if (row.revisionStatus !== 'pending' || !row.pendingRevision) throw AppError.conflict('There are no changes waiting for approval on this product.');
  const live = row.convertedProductId ? await Product.findById(row.convertedProductId).lean() : null;
  if (!live) throw AppError.conflict('The live product no longer exists.');
  return { row, live };
};

const approveRevision = async (id, { purchasePrice, markupPercent } = {}, admin) => {
  const { row, live } = await loadForReview(id);
  const rev = row.pendingRevision;
  const purchase = purchasePrice !== undefined && purchasePrice !== '' ? Number(purchasePrice) : rev.sellingPrice;
  const markup = markupPercent !== undefined && markupPercent !== '' ? Number(markupPercent) : live.markupPercent;
  if (!(purchase > 0)) throw AppError.badRequest('A valid purchase price is required.');

  const content = pick(rev, CONTENT_FIELDS);
  const updatedLive = await Product.findByIdAndUpdate(live._id, {
    $set: {
      ...content,
      purchasePrice: purchase,
      markupPercent: markup,
      sellingPrice: calcSellingPrice(purchase, markup),
      supplier: row.supplier,
      lastEditedBy: { userId: String(admin.id), role: admin.role, at: new Date() },
    },
  }, { new: true, runValidators: true }).lean();

  await SupplierProduct.updateOne({ _id: row._id }, {
    $set: {
      ...content,
      sellingPrice: rev.sellingPrice,
      pendingRevision: null,
      revisionStatus: 'none',
      revisionRejectionReason: '',
      reviewedBy: admin.id,
      reviewedAt: new Date(),
    },
  });

  // Old live media that the approved version no longer uses (reference-checked).
  const keep = new Set(media.currentImages(updatedLive).map((i) => i.key || i.url));
  media.releaseImages(media.currentImages(live).filter((i) => !keep.has(i.key || i.url)));
  if (live.videoOneDriveItemId && live.videoOneDriveItemId !== updatedLive.videoOneDriveItemId) media.releaseVideoItem(live.videoOneDriveItemId);

  logger.info('Partner change approved and published', { supplierProductId: row._id, productId: live._id, approvedBy: admin.id });
  return updatedLive;
};

const rejectRevision = async (id, reason, admin) => {
  const { row } = await loadForReview(id);
  if (!reason?.trim()) throw AppError.badRequest('A rejection reason is required.');
  await SupplierProduct.updateOne({ _id: row._id }, {
    $set: { revisionStatus: 'rejected', revisionRejectionReason: reason.trim(), reviewedBy: admin.id, reviewedAt: new Date() },
  });
  logger.info('Partner change rejected', { supplierProductId: row._id, rejectedBy: admin.id });
};

module.exports = { proposeRevision, approveRevision, rejectRevision, editableVersion, revisionBase, CONTENT_FIELDS };
