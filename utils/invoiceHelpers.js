'use strict';
/**
 * backend/utils/invoiceHelpers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * CHANGES FROM ORIGINAL:
 *
 * 1. Invoice model import: require('../models/Invoice')
 *                        → require('../models/paymentTrackerModel').Invoice
 *    (Invoice.js is now a shim — this import works either way, but direct is cleaner)
 *
 * 2. OneDrive folder path: ['Invoices', fy, month]
 *                        → ['website', 'Invoices', fy, month]
 *
 * 3. Upload method: uploadSingleFile(folderPath, filename, base64, mimeType)  [base64]
 *                 → uploadSingleFileBuffer(folderPath, filename, buffer, mimeType) [Buffer]
 *    base64Data is still received as a string (WhatsApp/Outlook pass it that way),
 *    so we convert to Buffer here before uploading — cleaner than base64 in transit.
 *
 * 4. DEV / PROD ISOLATION:
 *    saveExtractedInvoice now uses odvPath('Invoices', fy, month) so automated
 *    invoice saves (WhatsApp, Outlook) land in the right sandbox folder:
 *      production  →  ['website',     'Invoices', fy, month]
 *      development →  ['development', 'Invoices', fy, month]
 *    Consistent with the manual upload path in paymentTrackerRoutes.js.
 *
 * Everything else — normalizeFY, fyFromDate, checkIfDuplicate, buildInvoiceFilename — unchanged.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { Invoice } = require('../models/paymentTrackerModel');
const { uploadSingleFileBuffer } = require('../services/msGraphService');
const { odvPath } = require('./oneDrivePaths');  // ← env-aware path helper

/** Pause for ms milliseconds */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Normalise FY to short 2-digit format.
 * "2025-2026" → "2025-26" | "2025-26" → unchanged
 */
const normalizeFY = (fy) => {
  if (!fy) return fy;
  return fy.replace(/^(\d{4})-(\d{2,4})$/, (_, y, s) => `${y}-${String(s).slice(-2).padStart(2, '0')}`);
};

/**
 * Derive { fy, month } from a Date object.
 */
const fyFromDate = (d) => {
  const sh = (n) => String(n).slice(-2).padStart(2, '0');
  const y  = d.getFullYear();
  return {
    fy:    d.getMonth() < 3 ? `${y - 1}-${sh(y)}` : `${y}-${sh(y + 1)}`,
    month: d.toLocaleString('default', { month: 'long' }),
  };
};

/**
 * Get { fy, month } from a date string.
 */
const getFinancialDetails = (dateString) => {
  const d = dateString ? new Date(dateString) : new Date();
  if (isNaN(d.getTime())) return { fy: 'Unknown', month: 'Unknown' };
  return fyFromDate(d);
};

/**
 * Check whether an invoice already exists (vendor GSTIN + invoice number).
 */
const checkIfDuplicate = async (vendor_gst, invoice_number) => {
  if (!vendor_gst || !invoice_number) return false;
  return !!(await Invoice.findOne({ vendor_gst, invoice_number }).lean());
};

/**
 * Generate a safe filename for OneDrive upload.
 * e.g. "Acme Corp" + "INV-001" + "image/jpeg" → "AcmeCorp_INV-001_1234567890.jpg"
 */
const buildInvoiceFilename = (vendorName, invoiceNumber, mimeType) => {
  const ext    = mimeType?.includes('pdf') ? '.pdf' : '.jpg';
  const vendor = (vendorName    || 'unknown').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
  const inv    = (invoiceNumber || 'noinv'  ).replace(/[^a-zA-Z0-9\-]/g, '').slice(0, 20);
  return `${vendor}_${inv}_${Date.now()}${ext}`;
};

/**
 * Save an AI-extracted invoice to the database.
 * Uploads file to OneDrive/{root}/Invoices/{FY}/{Month}/ first,
 * then saves only metadata + URL to MongoDB — no base64 in the DB.
 *
 * Root switches automatically based on NODE_ENV:
 *   production  →  website/Invoices/{FY}/{Month}/
 *   development →  development/Invoices/{FY}/{Month}/
 *
 * @param {object} extraction  - AI result from extractFromDocument()
 * @param {string} base64Data  - raw base64 string (no data URI prefix) — from WhatsApp/Outlook
 * @param {string} mimeType
 * @param {string} source      - 'whatsapp' | 'outlook' | 'manual'
 * @param {object} metadata    - { notes }
 */
const saveExtractedInvoice = async (extraction, base64Data, mimeType, source, metadata = {}) => {
  const isDup = await checkIfDuplicate(extraction.vendor_gst, extraction.invoice_number);
  if (isDup) return { success: false, reason: 'Duplicate', data: extraction };

  const { fy: autoFY, month: autoMonth } = getFinancialDetails(extraction.date);
  const fy    = normalizeFY(extraction.financialYear) || autoFY;
  const month = extraction.month || autoMonth;

  // ── Upload to OneDrive/{root}/Invoices/{FY}/{Month}/ ───────────────────────
  // odvPath('Invoices', fy, month) resolves the root from NODE_ENV:
  //   production  → ['website',     'Invoices', fy, month]
  //   development → ['development', 'Invoices', fy, month]
  let oneDriveFileId = '';
  let oneDriveUrl    = '';
  let fileName       = '';

  try {
    fileName = buildInvoiceFilename(extraction.vendor_name, extraction.invoice_number, mimeType);

    // Convert base64 → Buffer (avoids base64 going over the wire to Graph API)
    const pure   = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
    const buffer = Buffer.from(pure, 'base64');

    const result = await uploadSingleFileBuffer(
      odvPath('Invoices', fy, month),   // ← env-aware (was hardcoded ['website', 'Invoices', fy, month])
      fileName,
      buffer,
      mimeType
    );
    oneDriveFileId = result.fileId;
    oneDriveUrl    = result.webUrl;
  } catch (uploadErr) {
    // OneDrive upload failed — log but don't block the DB save
    console.error('[invoiceHelpers] OneDrive upload failed:', uploadErr.message);
  }

  // ── Save to MongoDB (no base64) ─────────────────────────────────────────────
  const inv = new Invoice({
    ...extraction,
    total_amount:  Number(extraction.total_amount || 0),
    cgst:          Number(extraction.cgst         || 0),
    sgst:          Number(extraction.sgst         || 0),
    igst:          Number(extraction.igst         || 0),
    mimeType,
    receivedVia:   source,
    financialYear: fy,
    month,
    notes:         metadata.notes || `Auto-processed via ${source}`,
    oneDriveFileId,
    oneDriveUrl,
    fileName,
    createdAt:     new Date(),
    // image intentionally NOT set — file is in OneDrive
  });

  await inv.save();
  return { success: true, data: inv };
};

module.exports = {
  sleep,
  normalizeFY,
  fyFromDate,
  getFinancialDetails,
  checkIfDuplicate,
  buildInvoiceFilename,
  saveExtractedInvoice,
};