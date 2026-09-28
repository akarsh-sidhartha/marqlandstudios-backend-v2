'use strict';
/**
 * validation/schemas/paymentTracker.schema.js
 *
 * Request schemas for /api/payment-tracker. Most write endpoints receive
 * multipart/form-data (a document + fields), where every value arrives as a
 * string — the field builders below coerce and treat "" as "not provided".
 *
 * Unknown keys are stripped (zod's default), so a client can never
 * mass-assign server-owned fields such as amountPaid, status or file IDs.
 */
const { z } = require('zod');

const blank = (v) => (v === '' || v === null || v === 'null' || v === 'undefined' ? undefined : v);
const opt = (schema) => z.preprocess(blank, schema.optional());

const mongoId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id.');
const text = (max) => z.string().trim().max(max, `Must be under ${max} characters.`);
const money = z.coerce.number({ message: 'Must be a number.' }).finite().min(0, 'Cannot be negative.').max(1e10);
const positiveMoney = money.refine((n) => n > 0, 'Must be greater than zero.');
const isoDay = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const date = z.coerce.date({ message: 'Invalid date.' });
const gstin = z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'GSTIN must be 15 characters, e.g. 29ABCDE1234F1Z5.');
const fy = z.string().trim()
  .regex(/^\d{4}-(\d{2}|\d{4})$/, 'Use a financial year like 2025-26.')
  .transform((v) => v.replace(/^(\d{4})-(\d{2,4})$/, (_, y, s) => `${y}-${s.slice(-2)}`));
const docNumber = text(60).min(1, 'Required.');

const paging = (maxLimit = 200, defaultLimit = 50) => ({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
});

// ── Params ────────────────────────────────────────────────────────────────────
const idParam = z.object({ id: mongoId });
const vendorIdParam = z.object({ vendorId: mongoId });

// ── Extraction ────────────────────────────────────────────────────────────────
const extractBody = z.object({ docType: z.enum(['invoice', 'pi', 'payment']).default('invoice') });

// Deprecated JSON/base64 variant kept for older clients.
const legacyExtractBody = z.object({
  image: z.string().min(16).max(40 * 1024 * 1024),
  mimeType: z.string().max(100).optional(),
  docType: z.enum(['invoice', 'pi', 'payment']).default('invoice'),
});

// ── Invoices ──────────────────────────────────────────────────────────────────
const invoiceListQuery = z.object({ fy: opt(fy), month: opt(text(20)), ...paging(500) });

const createInvoiceBody = z.object({
  vendorId: opt(mongoId),
  vendor_name: opt(text(200)),
  vendor_gst: opt(gstin),
  invoice_number: docNumber,
  date: isoDay,
  total_amount: positiveMoney,
  cgst: opt(money),
  sgst: opt(money),
  igst: opt(money),
  currency: opt(text(3)),
  financialYear: opt(fy),
  month: opt(text(20)),
  notes: opt(text(1000)),
  linkedPi: opt(mongoId),
}).refine((b) => b.vendorId || b.vendor_name, { message: 'Select or type a vendor.', path: ['vendor_name'] });

// ── Proforma invoices ─────────────────────────────────────────────────────────
const piItems = z.preprocess(
  (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return undefined; } },
  z.array(z.object({
    description: opt(text(500)),
    quantity: opt(money),
    unitPrice: opt(money),
    amount: opt(money),
  })).max(200).optional(),
);

const piFields = {
  piNumber: docNumber,
  vendor: mongoId,
  piDate: date,
  dueDate: opt(date),
  totalAmount: positiveMoney,
  currency: opt(text(3)),
  bankDetails: opt(text(2000)),
  notes: opt(text(2000)),
  items: piItems,
};
const createPiBody = z.object(piFields);
const updatePiBody = z.object({
  ...Object.fromEntries(Object.entries(piFields).map(([k, s]) => [k, opt(s)])),
  status: opt(z.enum(['cancelled', 'pending'])),
});
const piListQuery = z.object({
  vendorId: opt(mongoId),
  status: opt(z.enum(['pending', 'partial', 'fully_paid', 'invoiced', 'cancelled'])),
  ...paging(),
});

// ── Payments ──────────────────────────────────────────────────────────────────
const mapping = {
  mappedTo: z.preprocess(blank, z.enum(['advance', 'proforma_invoice', 'vendor_invoice']).default('advance')),
  proformaInvoice: opt(mongoId),
  vendorInvoice: opt(mongoId),
};
const requireTarget = (b, ctx) => {
  if (b.mappedTo === 'proforma_invoice' && !b.proformaInvoice) ctx.addIssue({ code: 'custom', path: ['proformaInvoice'], message: 'Select a PI.' });
  if (b.mappedTo === 'vendor_invoice' && !b.vendorInvoice) ctx.addIssue({ code: 'custom', path: ['vendorInvoice'], message: 'Select an invoice.' });
};

const createPaymentBody = z.object({
  vendor: opt(mongoId),
  paymentDate: date,
  amount: positiveMoney,
  currency: opt(text(3)),
  paymentMode: z.preprocess(blank, z.enum(['neft', 'rtgs', 'imps', 'upi', 'cheque', 'cash', 'other']).default('other')),
  bankRef: opt(text(60)),
  remarks: opt(text(1000)),
  ...mapping,
}).superRefine(requireTarget);

const mapPaymentBody = z.object({
  ...mapping,
  mappedTo: z.enum(['proforma_invoice', 'vendor_invoice']),
}).superRefine(requireTarget);

const linkBody = z.object({ piId: mongoId, invoiceId: mongoId });

const paymentListQuery = z.object({
  vendorId: opt(mongoId),
  mappedTo: opt(z.enum(['advance', 'proforma_invoice', 'vendor_invoice'])),
  status: opt(z.enum(['recorded', 'verified', 'reconciled'])),
  ...paging(),
});

// ── Vendors ───────────────────────────────────────────────────────────────────
const vendorGstBody = z.object({ gstNumber: gstin });

const summaryQuery = z.object({ vendorId: opt(mongoId) });

module.exports = {
  idParam, vendorIdParam,
  extractBody, legacyExtractBody,
  invoiceListQuery, createInvoiceBody,
  createPiBody, updatePiBody, piListQuery,
  createPaymentBody, mapPaymentBody, linkBody, paymentListQuery,
  vendorGstBody, summaryQuery,
};
