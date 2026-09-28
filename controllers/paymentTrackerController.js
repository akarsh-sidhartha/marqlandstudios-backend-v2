'use strict';
/**
 * controllers/paymentTrackerController.js
 *
 * Thin HTTP layer for /api/payment-tracker: validated input in, service call,
 * JSON out. No try/catch (asyncHandler forwards to the central errorHandler)
 * and no business rules (those live in services/paymentTracker/*).
 *
 * Response bodies keep the shapes the admin UI has always consumed, so the
 * API can be deployed before or after the front-end.
 */
const mongoose = require('mongoose');
const { ProformaInvoice, Payment } = require('../models/paymentTrackerModel');
const Vendor = require('../models/Vendor');
const AppError = require('../lib/errors/AppError');
const documentExtraction = require('../services/documentExtraction');
const overviewService = require('../services/paymentTracker/overviewService');
const invoiceService = require('../services/paymentTracker/invoiceService');
const proformaService = require('../services/paymentTracker/proformaService');
const paymentService = require('../services/paymentTracker/paymentService');
const logger = require('../utils/logger').child({ module: 'paymentTrackerController' });

const body = (req) => req.validated?.body || {};
const query = (req) => req.validated?.query || {};

// ── Overview & extraction ─────────────────────────────────────────────────────
const overview = async (req, res) => res.json(await overviewService.getOverview());

const extract = async (req, res) => {
  if (!req.file) throw AppError.badRequest('Please attach a document to read.');
  const result = await documentExtraction.extractDocument(req.file.buffer, req.file.mimetype, body(req).docType);
  res.json(result);
};

/** @deprecated base64 JSON variant — use POST /extract (multipart). */
const extractLegacy = async (req, res) => {
  const { image, mimeType, docType } = body(req);
  const buffer = Buffer.from(image.includes(',') ? image.split(',')[1] : image, 'base64');
  res.json(await documentExtraction.extractDocument(buffer, mimeType, docType));
};

const extractionStatus = (req, res) => res.json(documentExtraction.status());

// ── Invoices ──────────────────────────────────────────────────────────────────
const listInvoices = async (req, res) => res.json(await invoiceService.list(query(req)));
const getInvoice = async (req, res) => res.json(await invoiceService.get(req.params.id));
const invoiceFile = (req, res) => invoiceService.streamFile(res, req.params.id);
const createInvoice = async (req, res) =>
  res.status(201).json(await invoiceService.create(body(req), req.file, { user: req.user }));
const deleteInvoice = async (req, res) => res.json(await invoiceService.remove(req.params.id, req.user));

// ── Proforma invoices ─────────────────────────────────────────────────────────
const listPis = async (req, res) => res.json(await proformaService.list(query(req)));
const getPi = async (req, res) => res.json(await proformaService.get(req.params.id));
const piAttachment = (req, res) => proformaService.streamAttachment(res, req.params.id);
const createPi = async (req, res) => res.status(201).json(await proformaService.create(body(req), req.file, req.user));
const updatePi = async (req, res) => res.json(await proformaService.update(req.params.id, body(req), req.file, req.user));
const deletePi = async (req, res) => res.json(await proformaService.remove(req.params.id, req.user));

// ── Payments ──────────────────────────────────────────────────────────────────
const listPayments = async (req, res) => res.json(await paymentService.list(query(req)));
const paymentScreenshot = (req, res) => paymentService.streamScreenshot(res, req.params.id);
const createPayment = async (req, res) => res.status(201).json(await paymentService.create(body(req), req.file, req.user));
const mapPayment = async (req, res) => res.json(await paymentService.remap(req.params.id, body(req), req.user));
const deletePayment = async (req, res) => res.json(await paymentService.remove(req.params.id, req.user));

const linkPiToInvoice = async (req, res) => {
  const { piId, invoiceId } = body(req);
  const { paymentsUpdated } = await proformaService.linkInvoice(piId, invoiceId);
  logger.info('PI linked to invoice', { piId, invoiceId, paymentsUpdated, userId: req.user?.id });
  res.json({ success: true, pi: await proformaService.byIdPopulated(piId), paymentsUpdated });
};

// ── Vendor GSTIN ──────────────────────────────────────────────────────────────
const getVendorGst = async (req, res) => {
  const vendor = await Vendor.findById(req.params.vendorId).select('companyName gstNumber').lean();
  if (!vendor) throw AppError.notFound('Vendor not found.');
  res.json({ companyName: vendor.companyName, gstNumber: vendor.gstNumber || null });
};

const setVendorGst = async (req, res) => {
  const vendor = await Vendor.findByIdAndUpdate(req.params.vendorId, { gstNumber: body(req).gstNumber }, { returnDocument: 'after' })
    .select('companyName gstNumber').lean();
  if (!vendor) throw AppError.notFound('Vendor not found.');
  logger.info('Vendor GSTIN updated', { vendorId: req.params.vendorId, userId: req.user?.id });
  res.json(vendor);
};

// ── Summary ───────────────────────────────────────────────────────────────────
const summary = async (req, res) => {
  const { vendorId } = query(req);
  const match = vendorId ? { vendor: new mongoose.Types.ObjectId(vendorId) } : {};
  const [piStats, paymentStats] = await Promise.all([
    ProformaInvoice.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 }, totalAmount: { $sum: '$totalAmount' }, amountPaid: { $sum: '$amountPaid' }, amountDue: { $sum: '$amountDue' } } }]),
    Payment.aggregate([{ $match: match }, { $group: { _id: '$mappedTo', count: { $sum: 1 }, totalPaid: { $sum: '$amount' } } }]),
  ]);
  res.json({ piStats, paymentStats });
};

// ── Outlook sync (disabled) ───────────────────────────────────────────────────
const syncOutlookInvoices = async () => ({
  success: false, disabled: true,
  message: 'Outlook email scanning is temporarily disabled. Upload invoices manually via the Invoice Vault tab.',
});
const outlookSync = async (req, res) => {
  logger.info('Manual Outlook sync requested (disabled)', { userId: req.user?.id });
  res.status(503).json(await syncOutlookInvoices());
};

module.exports = {
  overview, extract, extractLegacy, extractionStatus,
  listInvoices, getInvoice, invoiceFile, createInvoice, deleteInvoice,
  listPis, getPi, piAttachment, createPi, updatePi, deletePi,
  listPayments, paymentScreenshot, createPayment, mapPayment, deletePayment, linkPiToInvoice,
  getVendorGst, setVendorGst, summary, outlookSync, syncOutlookInvoices,
};
