'use strict';
/**
 * services/paymentTracker/proformaService.js — Proforma Invoices (PIs).
 *
 * Balances (amountPaid / amountDue / status) are never written directly by
 * callers: payments move them through ProformaInvoice.applyPayment (atomic),
 * and linking an invoice flips status via the model's derivation rule.
 */
const mongoose = require('mongoose');
const { ProformaInvoice, Payment } = require('../../models/paymentTrackerModel');
const Vendor = require('../../models/Vendor');
const AppError = require('../../lib/errors/AppError');
const fileStore = require('./fileStore');
const logger = require('../../utils/logger').child({ module: 'paymentTracker.pi' });

const VENDOR_FIELDS = 'companyName gstNumber';
const FINAL_INVOICE_FIELDS = 'invoice_number total_amount date vendor_name';

const byIdPopulated = (id) =>
  ProformaInvoice.findById(id).populate('vendor', VENDOR_FIELDS).populate('finalInvoice', FINAL_INVOICE_FIELDS).lean();

const list = async ({ vendorId, status, page, limit }) => {
  const filter = {};
  if (vendorId) filter.vendor = vendorId;
  if (status) filter.status = status;
  const skip = (page - 1) * limit;

  const [pis, total] = await Promise.all([
    ProformaInvoice.find(filter).populate('vendor', VENDOR_FIELDS).populate('finalInvoice', FINAL_INVOICE_FIELDS)
      .sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ProformaInvoice.countDocuments(filter),
  ]);

  const payments = await Payment.find({ proformaInvoice: { $in: pis.map((p) => p._id) } })
    .select('proformaInvoice amount paymentDate paymentMode bankRef status paymentRef screenshotFileId screenshotMime')
    .sort({ paymentDate: 1 }).lean();
  const byPi = new Map();
  for (const p of payments) {
    const k = String(p.proformaInvoice);
    if (!byPi.has(k)) byPi.set(k, []);
    byPi.get(k).push(p);
  }
  return { data: pis.map((pi) => ({ ...pi, payments: byPi.get(String(pi._id)) || [] })), total, page, limit };
};

const get = async (id) => {
  const pi = await byIdPopulated(id);
  if (!pi) throw AppError.notFound('PI not found.');
  const payments = await Payment.find({ proformaInvoice: id }).sort({ paymentDate: 1 }).lean();
  return { ...pi, payments };
};

const streamAttachment = async (res, id) => {
  const pi = await ProformaInvoice.findById(id).select('attachmentFileId attachmentName attachmentMime piNumber').lean();
  if (!pi) throw AppError.notFound('PI not found.');
  await fileStore.stream(res, { fileId: pi.attachmentFileId, mime: pi.attachmentMime, fileName: pi.attachmentName || pi.piNumber });
};

const assertUniqueNumber = async (piNumber, exceptId) => {
  const clash = await ProformaInvoice.exists({ piNumber, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
  if (clash) throw AppError.conflict(`PI number "${piNumber}" already exists.`, { duplicate: true, piNumber });
};

const storeAttachment = async (piNumber, vendorName, file) => {
  if (!file) return {};
  const stored = await fileStore.save({
    folder: fileStore.folders.pi(piNumber),
    fileName: fileStore.buildName([piNumber, vendorName], file.mimetype),
    buffer: file.buffer,
    mime: file.mimetype,
  });
  if (stored.warning) return { warning: stored.warning };
  return {
    fields: { attachmentFileId: stored.fileId, attachmentUrl: stored.webUrl, attachmentName: stored.fileName, attachmentMime: stored.mime },
  };
};

const create = async (input, file, user) => {
  await assertUniqueNumber(input.piNumber);
  const vendor = await Vendor.findById(input.vendor).select('companyName').lean();
  if (!vendor) throw AppError.badRequest('Selected vendor does not exist.');

  const { fields = {}, warning } = await storeAttachment(input.piNumber, vendor.companyName, file);
  let pi;
  try {
    pi = await ProformaInvoice.create({ ...input, ...fields, amountPaid: 0 });
  } catch (err) {
    if (fields.attachmentFileId) fileStore.remove(fields.attachmentFileId);
    if (err.code === 11000) throw AppError.conflict(`PI number "${input.piNumber}" already exists.`, { duplicate: true, piNumber: input.piNumber });
    throw err;
  }
  logger.info('PI created', { piId: pi._id, piNumber: pi.piNumber, hasAttachment: !!fields.attachmentFileId, userId: user?.id });
  return { ...(await byIdPopulated(pi._id)), ...(warning ? { _warning: warning } : {}) };
};

const update = async (id, input, file, user) => {
  const pi = await ProformaInvoice.findById(id);
  if (!pi) throw AppError.notFound('PI not found.');
  if (input.piNumber && input.piNumber !== pi.piNumber) await assertUniqueNumber(input.piNumber, id);
  if (input.totalAmount != null && input.totalAmount + 1 < pi.amountPaid) {
    throw AppError.unprocessable(`Total cannot be less than the ₹${pi.amountPaid} already paid.`);
  }
  if (input.vendor && !(await Vendor.exists({ _id: input.vendor }))) throw AppError.badRequest('Selected vendor does not exist.');

  const { status, ...rest } = input;
  Object.assign(pi, rest);
  // Only cancel / re-open are manual; every other status is derived on save.
  if (status === 'cancelled') pi.status = 'cancelled';
  if (status === 'pending' && pi.status === 'cancelled') pi.status = 'pending';

  const previousFileId = pi.attachmentFileId;
  let warning;
  if (file) {
    const vendor = await Vendor.findById(pi.vendor).select('companyName').lean();
    const stored = await storeAttachment(pi.piNumber, vendor?.companyName, file);
    warning = stored.warning;
    if (stored.fields) Object.assign(pi, stored.fields);
  }
  await pi.save();
  if (file && previousFileId && previousFileId !== pi.attachmentFileId) fileStore.remove(previousFileId);

  logger.info('PI updated', { piId: id, fields: Object.keys(input), userId: user?.id });
  return { ...(await byIdPopulated(id)), ...(warning ? { _warning: warning } : {}) };
};

/** Deleting a PI also deletes its payments (the UI confirms this explicitly). */
const remove = async (id, user) => {
  const pi = await ProformaInvoice.findById(id).lean();
  if (!pi) throw AppError.notFound('PI not found.');
  const payments = await Payment.find({ proformaInvoice: id }).select('screenshotFileId paymentRef').lean();

  await Payment.deleteMany({ proformaInvoice: id });
  await ProformaInvoice.deleteOne({ _id: id });

  // Storage clean-up is best-effort and doesn't hold up the response.
  Promise.allSettled([
    ...payments.map((p) => fileStore.remove(p.screenshotFileId)),
    fileStore.removeFolder(fileStore.folders.pi(pi.piNumber)),
  ]);
  logger.info('PI deleted with its payments', { piId: id, payments: payments.length, userId: user?.id });
  return { message: 'PI deleted.', paymentsDeleted: payments.length };
};

/**
 * Link a PI to the vendor's final tax invoice. Marks the PI invoiced and tags
 * its payments with the invoice so the vault can show what was paid.
 */
const linkInvoice = async (piId, invoiceId) => {
  const pi = await ProformaInvoice.findById(piId);
  if (!pi) throw AppError.notFound('PI not found.');
  if (pi.status === 'cancelled') throw AppError.badRequest('A cancelled PI cannot be linked to an invoice.');
  if (pi.finalInvoice && String(pi.finalInvoice) !== String(invoiceId)) {
    throw AppError.conflict(`PI ${pi.piNumber} is already linked to another invoice.`);
  }
  pi.finalInvoice = new mongoose.Types.ObjectId(String(invoiceId));
  await pi.save();
  const { modifiedCount } = await Payment.updateMany({ proformaInvoice: pi._id }, { $set: { vendorInvoice: pi.finalInvoice } });
  return { pi, paymentsUpdated: modifiedCount };
};

/** Detach an invoice from every PI pointing at it (used when an invoice is deleted). */
const unlinkInvoice = async (invoiceId) => {
  const pis = await ProformaInvoice.find({ finalInvoice: invoiceId });
  for (const pi of pis) {
    pi.finalInvoice = null;
    if (pi.status === 'invoiced') pi.status = 'pending'; // re-derived from payments on save
    await pi.save();
  }
  await Payment.updateMany({ vendorInvoice: invoiceId, mappedTo: 'proforma_invoice' }, { $set: { vendorInvoice: null } });
  return pis.length;
};

module.exports = { list, get, create, update, remove, streamAttachment, linkInvoice, unlinkInvoice, byIdPopulated };
