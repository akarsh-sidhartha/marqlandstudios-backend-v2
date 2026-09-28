'use strict';
/**
 * services/paymentTracker/paymentService.js — outgoing vendor payments.
 *
 * A payment is either an advance (map later), against a PI, or against a
 * vault invoice. Recording and re-mapping share one resolver, so both apply
 * money to PI balances the same way:
 *
 *   against PI       → PI balance += amount (atomic, never above the PI total)
 *   against invoice  → if a PI is linked to that invoice, its balance moves
 *                      too; otherwise the invoice's own outstanding is checked
 *
 * Every balance change goes through ProformaInvoice.applyPayment, and any
 * failure after it is compensated, so a half-recorded payment can't leave a
 * PI showing money that was never saved.
 */
const { Invoice, ProformaInvoice, Payment } = require('../../models/paymentTrackerModel');
const Vendor = require('../../models/Vendor');
const Counter = require('../../models/Counter');
const AppError = require('../../lib/errors/AppError');
const fileStore = require('./fileStore');
const vendors = require('./vendorDirectory');
const { fiscalPeriod } = require('../documentExtraction/parsers/primitives');
const logger = require('../../utils/logger').child({ module: 'paymentTracker.payments' });

const POPULATE = [
  ['vendor', 'companyName'],
  ['proformaInvoice', 'piNumber totalAmount amountPaid amountDue status'],
  ['vendorInvoice', 'invoice_number total_amount vendor_name'],
];
const populated = (query) => POPULATE.reduce((q, [path, fields]) => q.populate(path, fields), query);
const getPopulated = (id) => populated(Payment.findById(id)).lean();

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const round2 = (n) => Math.round(n * 100) / 100;

// ── PAY-00001 references ──────────────────────────────────────────────────────
// Atomic counter: concurrent requests can never mint the same reference.
// The first call per process seeds it past the highest existing PAY- number,
// so it continues the legacy sequence.
const REF_SCOPE = 'payment-tracker:paymentRef';
let seeded = null;
const seedCounter = async () => {
  const last = await Payment.findOne({ paymentRef: /^PAY-\d+$/ }).sort({ paymentRef: -1 }).select('paymentRef').lean();
  const max = last ? parseInt(last.paymentRef.slice(4), 10) : 0;
  await Counter.updateOne({ scope: REF_SCOPE }, { $max: { seq: max } }, { upsert: true });
};
const nextPaymentRef = async () => {
  if (!seeded) seeded = seedCounter().catch((err) => { seeded = null; throw err; });
  await seeded;
  const { seq } = await Counter.findOneAndUpdate({ scope: REF_SCOPE }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return `PAY-${String(seq).padStart(5, '0')}`;
};

// ── Target resolution ─────────────────────────────────────────────────────────
/**
 * Works out which PI (if any) absorbs the money and which vendor/invoice the
 * payment belongs to. Pure lookups — nothing is written here.
 */
const resolveTarget = async ({ mappedTo, proformaInvoice, vendorInvoice, vendor, amount }) => {
  if (mappedTo === 'proforma_invoice') {
    const pi = await ProformaInvoice.findById(proformaInvoice).select('_id piNumber vendor finalInvoice status totalAmount amountPaid').lean();
    if (!pi) throw AppError.notFound('PI not found.');
    if (pi.status === 'cancelled') throw AppError.unprocessable(`PI ${pi.piNumber} is cancelled.`);
    return { mappedTo, pi, vendorId: pi.vendor, vendorInvoiceId: pi.finalInvoice || null, docNumber: pi.piNumber };
  }

  if (mappedTo === 'vendor_invoice') {
    const inv = await Invoice.findById(vendorInvoice).select('_id invoice_number vendor_name total_amount').lean();
    if (!inv) throw AppError.notFound('Invoice not found in the vault.');
    const pi = await ProformaInvoice.findOne({ finalInvoice: inv._id, status: { $ne: 'cancelled' } })
      .select('_id piNumber vendor totalAmount amountPaid').lean();
    if (!pi) {
      const [{ paid = 0 } = {}] = await Payment.aggregate([
        { $match: { vendorInvoice: inv._id } },
        { $group: { _id: null, paid: { $sum: '$amount' } } },
      ]);
      const due = round2(inv.total_amount - paid);
      if (amount > due + 1) throw AppError.unprocessable(`Payment exceeds the invoice balance of ${inr(due)}.`);
    }
    const vendorId = vendor || pi?.vendor || (await vendors.findByName(inv.vendor_name))?._id || null;
    return { mappedTo, pi, vendorId, vendorInvoiceId: inv._id, docNumber: inv.invoice_number };
  }

  return { mappedTo: 'advance', pi: null, vendorId: vendor || null, vendorInvoiceId: null, docNumber: null };
};

/** Move money onto a PI, or explain why it doesn't fit. */
const applyToPi = async (pi, amount) => {
  const updated = await ProformaInvoice.applyPayment(pi._id, amount, { guard: true });
  if (updated) return updated;
  const fresh = await ProformaInvoice.findById(pi._id).select('totalAmount amountPaid status piNumber').lean();
  if (fresh?.status === 'cancelled') throw AppError.unprocessable(`PI ${fresh.piNumber} is cancelled.`);
  throw AppError.unprocessable(`Payment exceeds the PI balance of ${inr((fresh?.totalAmount || 0) - (fresh?.amountPaid || 0))}.`);
};

const reverseFromPi = (piId, amount) => (piId ? ProformaInvoice.applyPayment(piId, -amount) : null);

// ── Queries ───────────────────────────────────────────────────────────────────
const list = async ({ vendorId, mappedTo, status, page, limit }) => {
  const filter = {};
  if (vendorId) filter.vendor = vendorId;
  if (mappedTo) filter.mappedTo = mappedTo;
  if (status) filter.status = status;
  const [data, total] = await Promise.all([
    populated(Payment.find(filter)).sort({ paymentDate: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Payment.countDocuments(filter),
  ]);
  return { data, total, page, limit };
};

const streamScreenshot = async (res, id) => {
  const pay = await Payment.findById(id).select('screenshotFileId screenshotName screenshotMime paymentRef').lean();
  if (!pay) throw AppError.notFound('Payment not found.');
  await fileStore.stream(res, { fileId: pay.screenshotFileId, mime: pay.screenshotMime, fileName: pay.screenshotName || pay.paymentRef });
};

// ── Commands ──────────────────────────────────────────────────────────────────
const create = async (input, file, user) => {
  const target = await resolveTarget(input);
  const paymentRef = await nextPaymentRef();

  if (target.pi) await applyToPi(target.pi, input.amount);

  try {
    let stored = {};
    if (file) {
      const vendorName = target.vendorId ? (await Vendor.findById(target.vendorId).select('companyName').lean())?.companyName : '';
      const { financialYear, month } = fiscalPeriod(input.paymentDate.toISOString().slice(0, 10));
      stored = await fileStore.save({
        folder: fileStore.folders.payment(financialYear, month),
        fileName: fileStore.buildName([vendorName || 'UnknownVendor', target.docNumber, paymentRef], file.mimetype),
        buffer: file.buffer,
        mime: file.mimetype,
      });
    }

    const payment = await Payment.create({
      paymentRef,
      vendor: target.vendorId,
      paymentDate: input.paymentDate,
      amount: input.amount,
      currency: input.currency,
      paymentMode: input.paymentMode,
      bankRef: input.bankRef,
      remarks: input.remarks,
      mappedTo: target.mappedTo,
      proformaInvoice: target.pi?._id || null,
      vendorInvoice: target.vendorInvoiceId,
      screenshotFileId: stored.fileId || '',
      screenshotUrl: stored.webUrl || '',
      screenshotName: stored.fileName || '',
      screenshotMime: stored.mime || '',
    });

    logger.info('Payment recorded', { paymentRef, amount: input.amount, mappedTo: target.mappedTo, userId: user?.id });
    return { ...(await getPopulated(payment._id)), ...(stored.warning ? { _warning: stored.warning } : {}) };
  } catch (err) {
    if (target.pi) await reverseFromPi(target.pi._id, input.amount).catch((e) => logger.error('PI balance compensation failed', { piId: target.pi._id, error: e.message }));
    throw err;
  }
};

/** Map an advance to a PI or invoice (the only re-mapping allowed). */
const remap = async (id, input, user) => {
  const payment = await Payment.findById(id);
  if (!payment) throw AppError.notFound('Payment not found.');
  if (payment.mappedTo !== 'advance') throw AppError.badRequest('Only advances can be re-mapped.');

  const target = await resolveTarget({ ...input, vendor: payment.vendor, amount: payment.amount });
  if (target.pi) await applyToPi(target.pi, payment.amount);
  try {
    payment.mappedTo = target.mappedTo;
    payment.proformaInvoice = target.pi?._id || null;
    payment.vendorInvoice = target.vendorInvoiceId;
    if (target.vendorId) payment.vendor = target.vendorId;
    await payment.save();
  } catch (err) {
    if (target.pi) await reverseFromPi(target.pi._id, payment.amount).catch(() => {});
    throw err;
  }
  logger.info('Advance mapped', { paymentId: id, mappedTo: target.mappedTo, userId: user?.id });
  return getPopulated(id);
};

const remove = async (id, user) => {
  const payment = await Payment.findById(id).lean();
  if (!payment) throw AppError.notFound('Payment not found.');
  await Payment.deleteOne({ _id: id });
  await reverseFromPi(payment.proformaInvoice, payment.amount);
  fileStore.remove(payment.screenshotFileId);
  logger.info('Payment deleted', { paymentId: id, paymentRef: payment.paymentRef, userId: user?.id });
  return { message: 'Payment deleted.' };
};

module.exports = { list, create, remap, remove, streamScreenshot, nextPaymentRef };
