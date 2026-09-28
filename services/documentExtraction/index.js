'use strict';
/**
 * services/documentExtraction/index.js
 *
 * Open-source document reader for the Payment Tracker — replaces the paid
 * Gemini / Mistral vision APIs for invoices, proforma invoices and payment
 * screenshots.
 *
 *   PDF with text layer ─► pdf.js positions ─┐
 *   Scanned PDF ─► render ─► Tesseract OCR ──┼─► layout ─► rule-based parser
 *   JPG / PNG / WEBP ───► Tesseract OCR ─────┘
 *
 * Everything runs locally: no API keys, no per-call cost, no quota, and the
 * documents never leave the server.
 *
 * USAGE
 *   const { extractDocument } = require('./services/documentExtraction');
 *   const result = await extractDocument(buffer, 'application/pdf', 'invoice');
 *   // invoice/pi → { vendor_name, vendor_gst, invoice_number, date, due_date,
 *   //                total_amount, taxable_amount, cgst, sgst, igst,
 *   //                financialYear, month, subject, bank_details, _meta }
 *   // payment    → { amount, payment_date, payment_mode, bank_ref,
 *   //                payee_name, remarks, _meta }
 */
const { extractPdf } = require('./pdfExtractor');
const ocrEngine = require('./ocrEngine');
const { buildLayout } = require('./layout');
const { parseInvoice } = require('./parsers/invoiceParser');
const { parsePayment } = require('./parsers/paymentParser');
const sharp = require('sharp');
const { detectMime } = require('../../utils/fileType');
const { fiscalPeriod } = require('./parsers/primitives');
const AppError = require('../../lib/errors/AppError');
const logger = require('../../utils/logger').child({ module: 'documentExtraction' });

const DOC_TYPES = ['invoice', 'pi', 'payment'];

const listEnv = (name, fallback) =>
  (process.env[name] || fallback).split(',').map((s) => s.trim()).filter(Boolean);

// Our own identity — used to tell the seller from the buyer on invoices and
// the payer from the payee on bank screenshots.
const context = () => ({
  ownGstins: listEnv('OWN_GSTINS', '29ACGFM9082Q1Z5').map((g) => g.toUpperCase()),
  ownNames: listEnv('OWN_COMPANY_NAMES', 'marqland').map((n) => n.toLowerCase()),
});

// Images under 1000px are already upscaled 2x on the first read.
const imageIsSmall = async (buffer) => ((await sharp(buffer).metadata()).width || 0) < 1000;

/**
 * Merge two parses of the same document. Per field: a value one read backs
 * with a printed label or checksum (`_strong`) wins; otherwise the first
 * read's value (the 2x read, better at small digits) is used, then the other.
 * Amount fields are taken together from one read so totals and taxes stay
 * consistent with each other.
 */
const MONEY_KEYS = ['total_amount', 'taxable_amount', 'cgst', 'sgst', 'igst'];
const mergeReads = (a, b) => {
  const out = { _strong: [] };
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => k !== '_strong' && !MONEY_KEYS.includes(k)));
  for (const k of keys) {
    const pick = a._strong.includes(k) ? a : b._strong.includes(k) ? b : (a[k] ?? null) !== null ? a : b;
    out[k] = pick[k] ?? null;
    if (pick._strong.includes(k)) out._strong.push(k);
  }
  const moneyFrom = (r) => MONEY_KEYS.filter((k) => r[k] != null).length + (r._strong.includes('total_amount') ? 5 : 0);
  const money = moneyFrom(b) > moneyFrom(a) ? b : a;
  MONEY_KEYS.forEach((k) => { if (k in money) out[k] = money[k] ?? null; });
  // Dependent period fields follow the chosen date.
  if ('date' in out) Object.assign(out, fiscalPeriod(out.date));
  return out;
};

const countFound = (obj) =>
  Object.entries(obj).filter(([k, v]) => !k.startsWith('_') && v !== null && v !== undefined && v !== '').length;

/**
 * @param {Buffer} buffer
 * @param {string} [declaredMime] — client-declared type; the real type is sniffed from the bytes
 * @param {'invoice'|'pi'|'payment'} [docType='invoice']
 */
const extractDocument = async (buffer, declaredMime, docType = 'invoice') => {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw AppError.badRequest('No document received.');
  if (!DOC_TYPES.includes(docType)) throw AppError.badRequest(`Unknown document type "${docType}".`);

  // The bytes decide, not the client's claim.
  const mime = detectMime(buffer);
  if (declaredMime && mime && declaredMime !== mime) logger.debug('Declared mime differs from content', { declaredMime, mime });
  const started = Date.now();

  let fragments;
  let source;
  let secondRead = null;
  if (mime === 'application/pdf') {
    try {
      ({ fragments, source } = await extractPdf(buffer));
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw AppError.unprocessable('This PDF could not be read — it may be damaged or password-protected.', { reason: err.message });
    }
  } else if (mime?.startsWith('image/')) {
    fragments = await ocrEngine.recognize(buffer);
    source = 'ocr';
    // Small text: Tesseract drops different characters at 1x and 2x, so read
    // both and merge field by field (see mergeReads).
    if (!(await imageIsSmall(buffer)) && ocrEngine.isSmallText(fragments)) {
      secondRead = await ocrEngine.recognize(buffer, { upscale: true });
      source = 'ocr-2pass';
    }
  } else {
    throw AppError.unprocessable('Unsupported file type. Upload a PDF, JPG, PNG or WEBP.');
  }

  const ctx = context();
  const parse = (frags) => {
    const layout = buildLayout(frags);
    return docType === 'payment' ? parsePayment(layout, ctx) : parseInvoice(layout, docType, ctx);
  };
  const { _strong, ...fields } = secondRead ? mergeReads(parse(secondRead), parse(fragments)) : parse(fragments);

  const meta = { source, docType, mimeType: mime, fieldsFound: countFound(fields), ms: Date.now() - started };
  logger.info('Document extracted', meta);

  // Legacy aliases: older callers (WhatsApp intake, cached front-ends) read the
  // invoice-shaped keys even for payment screenshots.
  const legacy = docType === 'payment'
    ? { vendor_name: fields.payee_name, total_amount: fields.amount, date: fields.payment_date }
    : {};

  return { ...legacy, ...fields, _provider: `open-source:${source}`, _meta: meta };
};

const status = () => ({ available: true, provider: 'open-source', engines: ['pdf.js', 'tesseract'], reason: 'ok' });

module.exports = { extractDocument, status, DOC_TYPES };
