'use strict';
/**
 * routes/paymentTrackerRoutes.js — mounted at /api/payment-tracker
 * ─────────────────────────────────────────────────────────────────────────────
 * Request pipeline (same as the reference routes/exampleRoutes.js):
 *
 *   routeGuard (server.js: accounts/admin only)
 *     → rate limit → multipart intake + byte-level file check
 *     → zod validation → idempotency (creates) → controller → service
 *     → centralized errorHandler
 *
 * Layout:
 *   controllers/paymentTrackerController.js      HTTP in/out
 *   services/paymentTracker/*                    business rules
 *   services/documentExtraction/*                open-source PDF/OCR reader
 *   validation/schemas/paymentTracker.schema.js  request contracts
 * ─────────────────────────────────────────────────────────────────────────────
 */
const express = require('express');
const router = express.Router();

const asyncHandler = require('../middleware/asyncHandler');
const validate = require('../validation/validate');
const idempotency = require('../middleware/idempotency');
const documentUpload = require('../middleware/documentUpload');
const { createRateLimiter } = require('../middleware/security/rateLimiter');
const c = require('../controllers/paymentTrackerController');
const s = require('../validation/schemas/paymentTracker.schema');
const { handleWebhook } = require('../services/paymentTracker/whatsappIntake');
const logger = require('../utils/logger').child({ module: 'paymentTrackerRoutes' });

const perUser = (req) => String(req.user?.id || req.ip);
// OCR is CPU-heavy: ~12 reads/min sustained per user, bursts of 20.
const extractLimiter = createRateLimiter({ capacity: 20, refillPerSec: 0.2, keyGenerator: perUser, message: 'Too many documents read in a short time. Please wait a minute.' });
const writeLimiter = createRateLimiter({ capacity: 40, refillPerSec: 0.5, keyGenerator: perUser });
const once = idempotency();
const byId = validate({ params: s.idParam });

// ── Screen bootstrap ──────────────────────────────────────────────────────────
router.get('/overview', asyncHandler(c.overview));

// ── Document reading (open source — no paid AI) ───────────────────────────────
router.post('/extract', extractLimiter, documentUpload('file', { required: true }), validate({ body: s.extractBody }), asyncHandler(c.extract));
router.get('/extract/status', c.extractionStatus);
router.post('/invoices/process', extractLimiter, validate({ body: s.legacyExtractBody }), asyncHandler(c.extractLegacy)); // @deprecated
router.get('/gemini-status', c.extractionStatus); // @deprecated alias of /extract/status

// ── Invoice vault ─────────────────────────────────────────────────────────────
router.get('/invoices', validate({ query: s.invoiceListQuery }), asyncHandler(c.listInvoices));
router.get('/invoices/:id', byId, asyncHandler(c.getInvoice));
router.get('/invoices/:id/file', byId, asyncHandler(c.invoiceFile));
router.post('/invoices', writeLimiter, documentUpload('file'), validate({ body: s.createInvoiceBody }), once, asyncHandler(c.createInvoice));
router.delete('/invoices/:id', writeLimiter, byId, asyncHandler(c.deleteInvoice));

// ── Proforma invoices ─────────────────────────────────────────────────────────
router.get('/pi', validate({ query: s.piListQuery }), asyncHandler(c.listPis));
router.get('/pi/:id', byId, asyncHandler(c.getPi));
router.get('/pi/:id/attachment', byId, asyncHandler(c.piAttachment));
router.post('/pi', writeLimiter, documentUpload('attachment'), validate({ body: s.createPiBody }), once, asyncHandler(c.createPi));
router.patch('/pi/:id', writeLimiter, documentUpload('attachment'), validate({ params: s.idParam, body: s.updatePiBody }), asyncHandler(c.updatePi));
router.delete('/pi/:id', writeLimiter, byId, asyncHandler(c.deletePi));

// ── Payments ──────────────────────────────────────────────────────────────────
router.get('/payments', validate({ query: s.paymentListQuery }), asyncHandler(c.listPayments));
router.get('/payments/:id/screenshot', byId, asyncHandler(c.paymentScreenshot));
router.post('/payments', writeLimiter, documentUpload('screenshot'), validate({ body: s.createPaymentBody }), once, asyncHandler(c.createPayment));
router.post('/payments/link-to-invoice', writeLimiter, validate({ body: s.linkBody }), asyncHandler(c.linkPiToInvoice));
router.patch('/payments/:id/map', writeLimiter, validate({ params: s.idParam, body: s.mapPaymentBody }), asyncHandler(c.mapPayment));
router.delete('/payments/:id', writeLimiter, byId, asyncHandler(c.deletePayment));

// ── Vendor GSTIN & summary ────────────────────────────────────────────────────
router.get('/vendor-gst/:vendorId', validate({ params: s.vendorIdParam }), asyncHandler(c.getVendorGst));
router.patch('/vendor-gst/:vendorId', writeLimiter, validate({ params: s.vendorIdParam, body: s.vendorGstBody }), asyncHandler(c.setVendorGst));
router.get('/summary', validate({ query: s.summaryQuery }), asyncHandler(c.summary));

// ── Integrations ──────────────────────────────────────────────────────────────
router.post('/outlook-sync', asyncHandler(c.outlookSync));

router.get('/whatsapp-webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(String(challenge));
  logger.warn('WhatsApp webhook verification failed', { mode });
  res.sendStatus(403);
});

router.post('/whatsapp-webhook', (req, res) => {
  res.sendStatus(200); // acknowledge immediately; Meta retries slow webhooks
  handleWebhook(req.body).catch((err) => logger.error('WhatsApp invoice intake failed', { error: err.message, stack: err.stack }));
});

module.exports = { router, syncOutlookInvoices: c.syncOutlookInvoices };
