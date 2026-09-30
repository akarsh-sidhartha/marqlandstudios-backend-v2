'use strict';
/**
 * validation/schemas/order.schema.js
 *
 * zod request schemas for /api/v2/orders. Vocabularies come from
 * lib/orders/orderConstants.js so the model, the API and the UI agree.
 * Every object schema is .strict(): a client can never set status,
 * refNumber, attachments, timeline… through a generic update.
 */
const { z } = require('zod');
const {
  ORDER_STATUSES, ORDER_TYPES, FILE_CATEGORIES, PROCUREMENT_STATUS_VALUES,
} = require('../../lib/orders/orderConstants');

const mongoId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id.');
const text = (max, label) => z.string().trim().max(max, `${label} must be under ${max} characters.`);
const requiredText = (max, label) => text(max, label).min(1, `${label} is required.`);
const docNumber = (label) => requiredText(40, label)
  .transform((v) => v.toUpperCase())
  .refine((v) => /^[A-Z0-9][A-Z0-9/\-_. ]*$/.test(v), `${label} may only contain letters, digits, / and -.`);
const amount = z.coerce.number().min(0).max(1_000_000_000);

// Descriptions are plain text (see the "no pasted images" hotfix); the
// global sanitizer strips markup, this just bounds the size.
const description = text(20_000, 'Description');

const idParam = z.object({ id: mongoId });
const itemParam = z.object({ id: mongoId, itemId: mongoId });
// Graph drive-item ids: base32-ish, with "!" on personal drives.
const fileParam = z.object({ id: mongoId, itemId: z.string().regex(/^[A-Za-z0-9!_-]{8,80}$/, 'Invalid file id.') });

const listQuery = z.object({ status: z.enum(ORDER_STATUSES).optional() }).strict();

const createOrder = z.object({
  title: text(200, 'Title').optional().default(''),
  clientName: requiredText(200, 'Client name'),
  orderPlacedBy: requiredText(200, 'Contact person'),
  description: description.optional().default(''),
  orderType: z.enum(ORDER_TYPES).default('product'),
}).strict();

const updateOrder = z.object({
  title: text(200, 'Title').optional(),
  clientName: requiredText(200, 'Client name').optional(),
  orderPlacedBy: requiredText(200, 'Contact person').optional(),
  description: description.optional(),
  orderType: z.enum(ORDER_TYPES).optional(),
}).strict().refine((d) => Object.keys(d).length > 0, 'Nothing to update.');

const itemFields = {
  lineNo: z.coerce.number().int().min(0).max(10_000).optional(),
  name: requiredText(300, 'Item name'),
  details: text(1000, 'Details').optional().default(''),
  hsn: text(12, 'HSN').optional(),
  quantity: z.coerce.number().min(0).max(1_000_000).default(1),
  unit: text(20, 'Unit').optional(),
  rate: amount.nullable().optional(),
  amount: amount.nullable().optional(),
  status: z.enum(PROCUREMENT_STATUS_VALUES).optional(),
  notes: text(2000, 'Notes').optional().default(''),
};
const stripNulls = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
const item = z.object(itemFields).strict().transform(stripNulls);

const addItems = z.object({ items: z.array(item).min(1).max(200) }).strict();

// The client sends only the vendor id (or null to clear); the server looks up
// the name, so a vendor name can never be spoofed from the browser.
const vendorRef = z.object({ vendorId: mongoId }).strict().nullable();

const updateItem = z.object({
  name: itemFields.name.optional(),
  details: text(1000, 'Details').optional(),
  quantity: z.coerce.number().min(0).max(1_000_000).optional(),
  unit: text(20, 'Unit').optional(),
  status: z.enum(PROCUREMENT_STATUS_VALUES).optional(),
  notes: text(2000, 'Notes').optional(),
  productSupplier: vendorRef.optional(),
  brandingPartner: vendorRef.optional(),
}).strict().refine((d) => Object.keys(d).length > 0, 'Nothing to update.');

// Multipart: scalar fields arrive as strings, the confirmed items as JSON.
const jsonField = (schema) => z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return Symbol.for('invalid-json'); }
}, schema);

const quoteDocument = z.object({
  quoteDate: z.string().max(20).nullable().optional(),
  subject: z.string().max(200).nullable().optional(),
  subTotal: amount.nullable().optional(),
  total: amount.nullable().optional(),
}).strip().transform(stripNulls);

const startProject = z.object({
  quoteNumber: docNumber('Quote number'),
  items: jsonField(z.array(item).max(200)).optional().default([]),
  quoteDocument: jsonField(quoteDocument).optional(),
}).strict();

const completeOrder = z.object({ invoiceNumber: docNumber('Invoice number') }).strict();

const timeline = z.object({
  status: z.enum([...ORDER_STATUSES, 'update']).default('update'),
  message: requiredText(4000, 'Update message'),
}).strict();

const fileQuery = z.object({ category: z.enum(FILE_CATEGORIES).default('attachment') }).strict();
const contentQuery = z.object({ download: z.enum(['0', '1']).optional() }).strict();

module.exports = {
  idParam, itemParam, fileParam, listQuery, createOrder, updateOrder, addItems, updateItem,
  startProject, completeOrder, timeline, fileQuery, contentQuery,
};
