'use strict';
/**
 * validation/schemas/v2.schema.js
 *
 * zod request schemas for the /api/v2 product, supplier, media, upload and
 * job endpoints. Primitives are defined once and composed.
 */
const { z } = require('zod');

const mongoId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id.');
const idParam = z.object({ id: mongoId });

const text = (max, label) => z.string().trim().max(max, `${label} must be under ${max} characters.`);
const requiredText = (max, label) => text(max, label).min(1, `${label} is required.`);
const money = z.coerce.number().min(0, 'Price cannot be negative.').max(10_000_000);

const image = z.object({
  key: z.string().max(300).optional().default(''),
  url: z.string().max(2000).optional().default(''),
}).refine((i) => i.key || i.url, 'Each image needs a key or url.');

const video = z.object({
  source: z.enum(['keep', 'none', 'link', 'youtube', 'upload']),
  url: z.string().trim().max(500).optional(),
});

const pagingQuery = {
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
};

// ── Admin catalogue products ────────────────────────────────────────────────
const productBase = {
  brand: requiredText(120, 'Brand'),
  category: requiredText(120, 'Category'),
  subCategory: text(120, 'Sub category').optional().default(''),
  name: requiredText(200, 'Name'),
  description: text(5000, 'Description').optional().default(''),
  purchasePrice: money,
  markupPercent: z.coerce.number().min(0).max(1000).default(30),
  images: z.array(image).min(1, 'Add at least one image.').max(20),
  video: video.optional(),
  processImage: z.boolean().optional().default(false),
  reprocessImage: z.boolean().optional(),
  promptId: z.string().max(40).optional(),
  promptText: text(4000, 'Prompt').optional(),
};

const createProduct = z.object(productBase).strict();

const updateProduct = z.object({
  brand: productBase.brand.optional(),
  category: productBase.category.optional(),
  subCategory: text(120, 'Sub category').optional(),
  name: productBase.name.optional(),
  description: text(5000, 'Description').optional(),
  purchasePrice: money.optional(),
  markupPercent: z.coerce.number().min(0).max(1000).optional(),
  images: z.array(image).min(1, 'Add at least one image.').max(20).optional(),
  video: video.optional(),
  processImage: z.boolean().optional(),
  reprocessImage: z.boolean().optional(),
  promptId: z.string().max(40).optional(),
  promptText: text(4000, 'Prompt').optional(),
}).strict();

const listProducts = z.object({
  category: text(120, 'Category').optional(),
  subCategory: text(120, 'Sub category').optional(),
  brand: text(120, 'Brand').optional(),
  search: text(120, 'Search').optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  sort: z.enum(['recent', 'name-asc', 'name-desc', 'price-asc', 'price-desc']).optional(),
  source: z.enum(['partner', 'marqland']).optional(),   // who added the product
  ...pagingQuery,
});

const duplicateQuery = z.object({
  name: text(200, 'Name').optional().default(''),
  brand: text(120, 'Brand').optional(),
  category: text(120, 'Category').optional(),
  subCategory: text(120, 'Sub category').optional(),
  excludeId: mongoId.optional(),
});

// Reason is only asked for (and only shown to anyone) for partner products.
const deleteProduct = z.object({ reason: text(500, 'Reason').optional().default('') }).optional().default({});

// ── Partner products ─────────────────────────────────────────────────────────
const supplierBase = {
  brand: requiredText(120, 'Brand'),
  name: requiredText(120, 'Product name'),
  description: requiredText(2000, 'Description'),
  sellingPrice: z.coerce.number().positive('Selling price is required.').max(10_000_000),
  images: z.array(image).min(1, 'Add at least one image.').max(20),
  video: video.optional(),
};
const createSupplierProduct = z.object(supplierBase).strict();
const updateSupplierProduct = z.object({
  brand: supplierBase.brand.optional(),
  name: supplierBase.name.optional(),
  description: supplierBase.description.optional(),
  sellingPrice: supplierBase.sellingPrice.optional(),
  images: supplierBase.images.optional(),
  video: video.optional(),
}).strict();
const listSupplierProducts = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'deleted', 'changes']).optional(),
  search: text(120, 'Search').optional(),
  ...pagingQuery,
});

// ── Media / uploads / jobs ──────────────────────────────────────────────────
const imageSearch = z.object({ query: requiredText(200, 'Search') });
const imageImport = z.object({ urls: z.array(z.string().url().max(2000)).min(1).max(20) });

const createUpload = z.object({
  purpose: z.enum(['product-video', 'supplier-product-video']),
  targetId: mongoId,
  fileName: requiredText(200, 'File name'),
  mimeType: requiredText(100, 'File type'),
  totalBytes: z.coerce.number().int().positive(),
}).strict();
const chunkQuery = z.object({ offset: z.coerce.number().int().min(0) });

const jobList = z.object({
  ids: z.string().max(2000).optional(),
  resourceKind: z.enum(['product', 'supplierProduct']).optional(),
  resourceId: mongoId.optional(),
  active: z.enum(['true', 'false']).optional(),
});

module.exports = {
  idParam, createProduct, updateProduct, listProducts, duplicateQuery, deleteProduct,
  createSupplierProduct, updateSupplierProduct, listSupplierProducts,
  imageSearch, imageImport, createUpload, chunkQuery, jobList,
};
