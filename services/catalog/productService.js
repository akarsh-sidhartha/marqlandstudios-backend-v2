'use strict';
/**
 * services/catalog/productService.js
 *
 * Catalogue product business logic for /api/v2/products (admin app).
 * Express-free: takes plain inputs + the acting user, returns plain data,
 * throws AppError. Controllers stay thin (controllers/v2/productController.js).
 *
 * Performance:
 *   - The admin screen loads the category summary first (one aggregation),
 *     then pages of products per category as each category is opened, so
 *     the page cost no longer grows with the size of the whole catalogue.
 *   - List queries use a card projection (no long descriptions / key arrays)
 *     backed by the { category, updatedAt } index.
 */
const mongoose = require('mongoose');
const Product = require('../../models/Product');
const SupplierProduct = require('../../models/SupplierProduct');
const ImagePrompt = require('../../models/ImagePrompt');
const AppError = require('../../lib/errors/AppError');
const jobQueue = require('../../lib/jobs/jobQueue');
const media = require('../media/productMediaService');
const { removeProductsFromPortals } = require('./portalCleanupService');
const { getStreamUrl, itemIdForPath } = require('../media/oneDriveMediaService');
const logger = require('../../utils/logger').child({ module: 'productService' });

const CARD_FIELDS = 'brand category subCategory name description purchasePrice markupPercent sellingPrice imageUrl additionalImages videoSource videoUrl videoOneDriveItemId videoOneDrivePath videoFileName videoUpload supplier updatedAt createdAt';

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SORTS = {
  recent: { updatedAt: -1, _id: -1 },
  'name-asc': { name: 1, _id: 1 },
  'name-desc': { name: -1, _id: -1 },
  'price-asc': { sellingPrice: 1, _id: 1 },
  'price-desc': { sellingPrice: -1, _id: -1 },
};

const calcSellingPrice = (purchasePrice, markupPercent) => {
  const price = Number(purchasePrice) || 0;
  const markup = Number(markupPercent) || 0;
  return Math.round(price + (price * markup) / 100);
};

/** Shape sent to the front ends — raw OneDrive ids never leave the server. */
const toView = (p) => {
  if (!p) return p;
  const { videoOneDriveItemId, videoOneDrivePath, supplier, ...rest } = p;
  // fromPartner drives the "Partner" badge / filter and whether deleting
  // asks for a reason (only partner products notify someone). `supplier` may
  // arrive populated ({ _id, supplierCompanyName, name }) — the view always
  // exposes the id plus a display name.
  const populated = supplier && typeof supplier === 'object' && !(supplier instanceof mongoose.Types.ObjectId) && supplier._id;
  return {
    ...rest,
    supplier: populated ? supplier._id : (supplier || null),
    fromPartner: Boolean(supplier),
    partnerName: populated ? (supplier.supplierCompanyName || supplier.name || '') : '',
    video: media.videoView(p),
  };
};

// ── Queries ──────────────────────────────────────────────────────────────────
const categorySummary = async () => {
  // One flat $group (category × subCategory) and the nesting done here —
  // cheaper than a two-stage $group/$push and portable across Mongo versions.
  const [rows, brands] = await Promise.all([
    Product.aggregate([
      { $group: { _id: { category: '$category', subCategory: '$subCategory' }, count: { $sum: 1 } } },
    ]),
    Product.distinct('brand'),
  ]);

  const byCategory = new Map();
  for (const { _id, count } of rows) {
    const name = _id.category || 'Uncategorized';
    const entry = byCategory.get(name) || { category: name, count: 0, subCategories: [] };
    entry.count += count;
    if (_id.subCategory) entry.subCategories.push({ name: _id.subCategory, count });
    byCategory.set(name, entry);
  }
  const categories = [...byCategory.values()]
    .map((c) => ({ ...c, subCategories: c.subCategories.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.category.localeCompare(b.category));

  return {
    categories,
    brands: brands.filter(Boolean).sort((a, b) => a.localeCompare(b)),
    total: categories.reduce((n, c) => n + c.count, 0),
  };
};

const buildFilter = ({ category, subCategory, brand, search, minPrice, maxPrice, source }) => {
  const filter = {};
  if (source === 'partner') filter.supplier = { $ne: null };
  if (source === 'marqland') filter.supplier = null;
  if (category) filter.category = category === 'Uncategorized' ? { $in: [null, '', 'Uncategorized'] } : category;
  if (subCategory) filter.subCategory = subCategory;
  if (brand) filter.brand = brand;
  if (search) {
    const re = new RegExp(escapeRegex(search.trim()), 'i');
    filter.$or = [{ name: re }, { brand: re }, { category: re }, { subCategory: re }];
  }
  if (minPrice !== undefined || maxPrice !== undefined) {
    filter.sellingPrice = {};
    if (minPrice !== undefined) filter.sellingPrice.$gte = minPrice;
    if (maxPrice !== undefined) filter.sellingPrice.$lte = maxPrice;
  }
  return filter;
};

const listProducts = async (query, { page, limit, skip }) => {
  const filter = buildFilter(query);
  const sort = SORTS[query.sort] || SORTS.recent;
  const [items, total] = await Promise.all([
    Product.find(filter).select(CARD_FIELDS).sort(sort).skip(skip).limit(limit)
      .populate('supplier', 'supplierCompanyName name').lean(),
    Product.countDocuments(filter),
  ]);
  return { items: items.map(toView), total };
};

/** Name-similarity check for the "similar product already exists" warning. */
const findDuplicates = async ({ name, brand, category, subCategory, excludeId }) => {
  const trimmed = String(name || '').trim();
  if (trimmed.length < 2) return [];
  const filter = { name: new RegExp(escapeRegex(trimmed), 'i') };
  if (brand) filter.brand = new RegExp(`^${escapeRegex(brand)}$`, 'i');
  if (category) filter.category = new RegExp(`^${escapeRegex(category)}$`, 'i');
  if (subCategory) filter.$or = [{ subCategory: new RegExp(`^${escapeRegex(subCategory)}$`, 'i') }, { subCategory: { $in: [null, ''] } }];
  if (excludeId) filter._id = { $ne: excludeId };
  return Product.find(filter).select('brand name category subCategory').limit(5).lean();
};

const getProduct = async (id) => {
  const product = await Product.findById(id).populate('supplier', 'supplierCompanyName name').lean();
  if (!product) throw AppError.notFound('Product not found.');
  return toView(product);
};

// ── AI studio processing (background) ────────────────────────────────────────
const resolvePrompt = async ({ promptText, promptId, category }) => {
  if (promptText?.trim()) return promptText.trim();
  if (promptId) {
    const saved = await ImagePrompt.findById(promptId).lean().catch(() => null);
    if (saved) return saved.prompt;
  }
  if (category) {
    const def = await ImagePrompt.findOne({ category, isDefault: true }).lean();
    if (def) return def.prompt;
  }
  return null;
};

const queueStudioProcessing = async (product, user, { promptText, promptId }) => {
  const prompt = await resolvePrompt({ promptText, promptId, category: product.category });
  return jobQueue.enqueue({
    type: 'product.image.process',
    title: `Studio AI image · ${product.name}`,
    payload: { productId: String(product._id), imageKey: product.imageKey, imageUrl: product.imageUrl, prompt, category: product.category },
    owner: { userId: user.id, role: user.role },
    resource: { kind: 'product', id: String(product._id) },
  });
};

// ── Mutations ────────────────────────────────────────────────────────────────
const editedBy = (user) => ({ userId: String(user.id), role: user.role, at: new Date() });

const createProduct = async (input, user) => {
  const { fields: imageFields, stagedKeys } = await media.resolveImages(input.images, user, null);
  const { patch: videoFields } = media.videoPatch(null, input.video);

  const product = await Product.create({
    brand: input.brand,
    category: input.category,
    subCategory: input.subCategory || '',
    name: input.name,
    description: input.description || '',
    purchasePrice: input.purchasePrice,
    markupPercent: input.markupPercent,
    sellingPrice: calcSellingPrice(input.purchasePrice, input.markupPercent),
    ...imageFields,
    ...videoFields,
    lastEditedBy: editedBy(user),
  });
  await media.markAttached(stagedKeys, 'product', product._id);

  let job = null;
  if (input.processImage) job = await queueStudioProcessing(product, user, input);

  logger.info('Product created', { productId: product._id, name: product.name, userId: user.id, images: stagedKeys.length });
  return { product: toView(product.toObject()), jobs: job ? [job.toClient()] : [] };
};

const updateProduct = async (id, input, user) => {
  const existing = await Product.findById(id).lean();
  if (!existing) throw AppError.notFound('Product not found.');

  const set = { lastEditedBy: editedBy(user) };
  for (const field of ['brand', 'category', 'subCategory', 'name', 'description', 'purchasePrice', 'markupPercent']) {
    if (input[field] !== undefined) set[field] = input[field];
  }
  if (input.purchasePrice !== undefined || input.markupPercent !== undefined) {
    set.sellingPrice = calcSellingPrice(set.purchasePrice ?? existing.purchasePrice, set.markupPercent ?? existing.markupPercent);
  }

  let removedImages = [];
  let stagedKeys = [];
  if (input.images !== undefined) {
    const resolved = await media.resolveImages(input.images, user, existing);
    Object.assign(set, resolved.fields);
    removedImages = resolved.removed;
    stagedKeys = resolved.stagedKeys;
  }
  const { patch: videoFields, releasedItemId } = media.videoPatch(existing, input.video);
  Object.assign(set, videoFields);

  const updated = await Product.findByIdAndUpdate(id, { $set: set }, { new: true, runValidators: true })
    .populate('supplier', 'supplierCompanyName name').lean();
  await media.markAttached(stagedKeys, 'product', id);
  media.releaseImages(removedImages);
  if (releasedItemId) media.releaseVideoItem(releasedItemId);

  let job = null;
  const primaryChanged = set.imageKey !== undefined && set.imageKey !== existing.imageKey;
  if (input.processImage && (primaryChanged || input.reprocessImage)) job = await queueStudioProcessing(updated, user, input);

  logger.info('Product updated', { productId: id, fields: Object.keys(set), userId: user.id });
  return { product: toView(updated), jobs: job ? [job.toClient()] : [] };
};

const deleteProduct = async (id, reason, user) => {
  const product = await Product.findById(id).lean();
  if (!product) throw AppError.notFound('Product not found.');
  const origin = await SupplierProduct.exists({ convertedProductId: product._id });
  if ((product.supplier || origin) && !(reason || '').trim()) {
    throw AppError.badRequest('Please give a reason — it is shown to the partner who supplied this product.');
  }

  // Keep the partner's submission record, flipped to 'deleted' with the
  // admin's reason, so the partner sees why it left the catalogue.
  await SupplierProduct.updateOne(
    { convertedProductId: product._id },
    { $set: { status: 'deleted', deletionReason: (reason || '').trim() || 'Removed by Marqland Studios.' } }
  );
  await Product.deleteOne({ _id: id });
  // Take it out of every client portal / combo it was added to.
  await removeProductsFromPortals([id]);

  media.releaseImages(media.currentImages(product));
  if (product.videoOneDriveItemId) media.releaseVideoItem(product.videoOneDriveItemId);
  logger.info('Product deleted', { productId: id, name: product.name, userId: user.id });
};

// ── Video playback ──────────────────────────────────────────────────────────
/**
 * Playable URL for a product's video. Uploaded files get a fresh short-lived
 * OneDrive URL (they expire, so they're never stored); links are returned as-is.
 */
const videoStreamFor = async (product) => {
  const view = media.videoView(product);
  if (view.source === 'link') return { source: 'link', url: product.videoUrl, expiresInSeconds: null };
  if (view.source !== 'upload') throw AppError.notFound('This product has no video.');

  let itemId = product.videoOneDriveItemId;
  if (!itemId && product.videoOneDrivePath) {
    itemId = await itemIdForPath(product.videoOneDrivePath);
    // Cache the resolved id — only for a real catalogue product (never an empty filter).
    if (product._id) await Product.updateOne({ _id: product._id }, { $set: { videoOneDriveItemId: itemId } }).catch(() => {});
  }
  try {
    const { url, expiresInSeconds } = await getStreamUrl(itemId);
    return { source: 'upload', url, expiresInSeconds, fileName: view.fileName };
  } catch (err) {
    logger.warn('Could not resolve video stream URL', { productId: product._id, error: err.message, status: err.response?.status });
    if (err.response?.status === 404) throw AppError.notFound('The video file could not be found.');
    throw AppError.upstream('The video is temporarily unavailable. Please try again shortly.');
  }
};

const getVideoStream = async (id) => {
  const product = await Product.findById(id).select('videoSource videoUrl videoOneDriveItemId videoOneDrivePath videoFileName').lean();
  if (!product) throw AppError.notFound('Product not found.');
  return videoStreamFor(product);
};

/**
 * One-off, idempotent: link products approved before Product.supplier existed
 * to their partner, so the Partner filter/badge covers them too. Runs at boot.
 */
const backfillPartnerLinks = async () => {
  const rows = await SupplierProduct.find({ convertedProductId: { $ne: null } }, 'supplier convertedProductId').lean();
  if (!rows.length) return 0;
  const res = await Product.bulkWrite(rows.map((r) => ({
    updateOne: { filter: { _id: r.convertedProductId, supplier: null }, update: { $set: { supplier: r.supplier } } },
  })), { ordered: false });
  if (res.modifiedCount) logger.info('Linked existing partner products to their partner', { count: res.modifiedCount });
  return res.modifiedCount;
};

module.exports = {
  backfillPartnerLinks,
  categorySummary, listProducts, findDuplicates, getProduct, createProduct, updateProduct, deleteProduct,
  getVideoStream, videoStreamFor, calcSellingPrice, toView, resolvePrompt,
};
