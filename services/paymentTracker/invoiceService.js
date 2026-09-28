'use strict';
/**
 * services/paymentTracker/invoiceService.js — the Invoice Vault.
 *
 * One create path for every intake channel (manual upload, mobile, WhatsApp):
 * duplicate check → vendor resolution → OneDrive → save → PI link.
 */
const { Invoice, ProformaInvoice, Payment } = require('../../models/paymentTrackerModel');
const Vendor = require('../../models/Vendor');
const AppError = require('../../lib/errors/AppError');
const fileStore = require('./fileStore');
const vendors = require('./vendorDirectory');
const proformaService = require('./proformaService');
const { fiscalPeriod } = require('../documentExtraction/parsers/primitives');
const logger = require('../../utils/logger').child({ module: 'paymentTracker.invoices' });

const LIST_FIELDS = '-image -items';

const list = async ({ fy, month, page, limit }) => {
  const filter = {};
  if (fy) filter.financialYear = fy;
  if (month) filter.month = month;
  const [invoices, total, financialYears] = await Promise.all([
    Invoice.find(filter).select(LIST_FIELDS).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Invoice.countDocuments(filter),
    Invoice.distinct('financialYear'),
  ]);
  return { invoices, total, page, limit, financialYears };
};

const get = async (id) => {
  const inv = await Invoice.findById(id).select('-image').lean();
  if (!inv) throw AppError.notFound('Invoice not found.');
  return inv;
};

const streamFile = async (res, id) => {
  const inv = await Invoice.findById(id).select('oneDriveFileId fileName mimeType invoice_number').lean();
  if (!inv) throw AppError.notFound('Invoice not found.');
  await fileStore.stream(res, { fileId: inv.oneDriveFileId, mime: inv.mimeType, fileName: inv.fileName || inv.invoice_number });
};

/** Same GSTIN + number, or (no GSTIN) same vendor name + number. */
const findDuplicate = ({ vendor_gst, vendor_name, invoice_number }) => {
  if (!invoice_number) return null;
  if (vendor_gst) return Invoice.findOne({ vendor_gst, invoice_number }).select('_id vendor_name invoice_number').lean();
  if (!vendor_name) return null;
  return Invoice.findOne({ invoice_number, vendor_name: new RegExp(`^${vendors.escapeRegex(vendor_name.trim())}$`, 'i') })
    .select('_id vendor_name invoice_number').lean();
};

/**
 * Pick the PI this invoice settles: the explicitly chosen one, or — only when
 * it is unambiguous — the vendor's single open, unlinked PI whose total
 * matches the invoice (±1%). Never guesses between several candidates.
 */
const choosePiToLink = async ({ linkedPi, vendorId, total }) => {
  if (linkedPi) return linkedPi;
  if (!vendorId || !total) return null;
  const open = await ProformaInvoice.find({ vendor: vendorId, finalInvoice: null, status: { $ne: 'cancelled' } })
    .select('_id totalAmount').lean();
  const matches = open.filter((pi) => Math.abs(pi.totalAmount - total) <= Math.max(1, total * 0.01));
  return matches.length === 1 ? matches[0]._id : null;
};

/**
 * @param {object} input  — validated invoice fields (see validation schema)
 * @param {{ buffer: Buffer, mimetype: string }} [file]
 * @param {{ user?: object, source?: string }} [opts]
 */
const create = async (input, file, { user, source = 'manual_upload' } = {}) => {
  // Resolve the vendor record (for GSTIN memory + PI matching).
  const vendorDoc = input.vendorId
    ? await Vendor.findById(input.vendorId).select('_id companyName gstNumber').lean()
    : await vendors.findByName(input.vendor_name);
  const vendor_name = (input.vendor_name || vendorDoc?.companyName || '').trim() || 'Unknown Vendor';
  const vendor_gst = (input.vendor_gst || vendorDoc?.gstNumber || '').toUpperCase();

  const dup = await findDuplicate({ vendor_gst, vendor_name, invoice_number: input.invoice_number });
  if (dup) {
    throw AppError.conflict(`Invoice #${input.invoice_number} from ${dup.vendor_name} is already in the vault.`, {
      duplicate: true, invoice_number: input.invoice_number, vendor_name: dup.vendor_name, existingId: dup._id,
    });
  }
  if (vendorDoc && vendor_gst) vendors.rememberGstin({ vendorId: vendorDoc._id, gstin: vendor_gst });

  const period = fiscalPeriod(input.date);
  const financialYear = input.financialYear || period.financialYear;
  const month = input.month || period.month;

  let stored = {};
  if (file) {
    stored = await fileStore.save({
      folder: fileStore.folders.invoice(financialYear, month),
      fileName: fileStore.buildName([input.invoice_number, vendor_name], file.mimetype),
      buffer: file.buffer,
      mime: file.mimetype,
    });
  }

  const inv = await Invoice.create({
    vendor_name,
    vendor_gst,
    invoice_number: input.invoice_number,
    date: input.date,
    currency: input.currency || 'INR',
    total_amount: input.total_amount,
    cgst: input.cgst || 0,
    sgst: input.sgst || 0,
    igst: input.igst || 0,
    tax_amount: (input.cgst || 0) + (input.sgst || 0) + (input.igst || 0),
    financialYear,
    month,
    notes: input.notes || '',
    receivedVia: source,
    mimeType: file?.mimetype || '',
    oneDriveFileId: stored.fileId || '',
    oneDriveUrl: stored.webUrl || '',
    fileName: stored.fileName || '',
  });
  logger.info('Invoice saved', { invoiceId: inv._id, invoiceNumber: inv.invoice_number, amount: inv.total_amount, source, userId: user?.id });

  let linkedPi = null;
  let linkWarning;
  try {
    const piId = await choosePiToLink({ linkedPi: input.linkedPi, vendorId: vendorDoc?._id, total: input.total_amount });
    if (piId) linkedPi = (await proformaService.linkInvoice(piId, inv._id)).pi._id;
  } catch (err) {
    // The invoice is saved either way; tell the user why the link didn't happen.
    linkWarning = `Invoice saved, but it could not be linked to the PI: ${err.message}`;
    logger.warn('PI link failed after invoice save', { invoiceId: inv._id, error: err.message });
  }

  const _warning = [stored.warning, linkWarning].filter(Boolean).join(' ') || undefined;
  return { ...inv.toObject(), image: undefined, _linkedPi: linkedPi, ...(_warning ? { _warning } : {}) };
};

/**
 * Delete an invoice. Refuses while payments are mapped directly to it (they
 * would be orphaned); PI links are undone so those PIs re-open correctly.
 */
const remove = async (id, user) => {
  const inv = await Invoice.findById(id).select('oneDriveFileId invoice_number').lean();
  if (!inv) throw AppError.notFound('Invoice not found.');
  const direct = await Payment.countDocuments({ vendorInvoice: id, mappedTo: 'vendor_invoice' });
  if (direct) {
    throw AppError.conflict(`This invoice has ${direct} payment${direct > 1 ? 's' : ''} mapped to it. Delete or re-map those payments first.`);
  }
  const unlinked = await proformaService.unlinkInvoice(id);
  await Invoice.deleteOne({ _id: id });
  fileStore.remove(inv.oneDriveFileId);
  logger.info('Invoice deleted', { invoiceId: id, unlinkedPis: unlinked, userId: user?.id });
  return { message: 'Invoice deleted.' };
};

module.exports = { list, get, create, remove, streamFile };
