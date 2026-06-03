'use strict';
/**
 * backend/routes/paymentTrackerRoutes.js
 * Mounted at /api/payment-tracker
 * ─────────────────────────────────────────────────────────────────────────────
 * MERGED: absorbs routes/invoiceRoute.js (the old route file).
 *
 * STORAGE CHANGES:
 * 1. Invoice vault uploads: folder path  ['Invoices', fy, month]
 *                                     →  ['website', 'Invoices', fy, month]
 *    Uses uploadSingleFileBuffer() (Buffer, not base64) for cleaner flow.
 *
 * 2. PI attachments: were stored as raw base64 in MongoDB.
 *    Now uploaded to OneDrive/website/PI-Attachments/{piNumber}/ via multer upload.
 *    Returns attachmentUrl (webUrl) + attachmentDownloadUrl (for inline display proxy).
 *
 * 3. Payment screenshots: were stored as raw base64 in MongoDB.
 *    Now uploaded to OneDrive/website/Payments/{paymentRef}/ via multer upload.
 *    Returns screenshotUrl + screenshotDownloadUrl (for inline display proxy).
 *
 * 4. NEW PROXY ROUTES for inline display (avoids expiring OneDrive download URLs):
 *    GET /invoices/:id/file           — stream invoice file inline
 *    GET /pi/:id/attachment           — stream PI attachment inline
 *    GET /payments/:id/screenshot     — stream payment screenshot inline
 *
 * DEV / PROD ISOLATION:
 * ─────────────────────────────────────────────────────────────────────────────
 * When NODE_ENV !== 'production', all OneDrive uploads are rooted under
 * 'development' instead of 'website':
 *   production  →  website/Invoices/...   website/PI-Attachments/...   website/Payments/...
 *   development →  development/Invoices/... development/PI-Attachments/... development/Payments/...
 *
 * This is handled centrally by utils/oneDrivePaths.js via odvPath().
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ROUTES ADDED FROM invoiceRoute.js (de-duplicated — newer versions kept):
 *    GET/POST /whatsapp-webhook    — already in paymentTrackerRoutes ✓
 *    POST     /outlook-sync        — already in paymentTrackerRoutes ✓ (disabled)
 *    POST     /process             — merged as POST /invoices/process ✓ (already existed)
 *    GET      /                    — merged as GET /invoices ✓
 *    POST     /                    — merged as POST /invoices ✓
 *    DELETE   /:id                 — merged as DELETE /invoices/:id ✓
 *
 * server.js change:
 *   BEFORE: const { router: paymentTracker, syncOutlookInvoices } = require('./routes/paymentTrackerRoutes');
 *   AFTER:  same — export shape unchanged.
 *   DELETE: require('./routes/invoiceRoute') line from server.js
 *           app.use('/api/payment-tracker', ...) remains; remove duplicate mount if any.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const multer = require('multer');
const axios = require('axios');
const path = require('path');

const { Invoice, ProformaInvoice, Payment, VendorInvoice } = require('../models/paymentTrackerModel');
const Vendor = require('../models/Vendor');
const { authenticate, authorize } = require('../middleware/authMiddleware');
const { extractFromDocument, checkAIStatus } = require('../services/aiService');
const { scanMailboxesForAttachments, uploadSingleFileBuffer, deleteFile: deleteOneDriveFile, deleteFolderByPath, getFinancialYear, getMonthName } = require('../services/msGraphService');
const { normalizeFY, fyFromDate, checkIfDuplicate, saveExtractedInvoice } = require('../utils/invoiceHelpers');
const logger = require('../utils/logger').child({ module: 'paymentTrackerRoutes' });

// ── OneDrive path helper — env-aware ──────────────────────────────────────────
// odvPath('Invoices', '25-26', 'April') returns:
//   production  → ['website', 'Invoices', '25-26', 'April']
//   development → ['development', 'Invoices', '25-26', 'April']
const { odvPath } = require('../utils/oneDrivePaths');

// ── WhatsApp service (optional — gracefully absent in test/CI) ─────────────────
let whatsappService = null;
try { whatsappService = require('../services/whatsappService'); } catch { /* not available */ }

// ── multer: memory only — for PI attachments and payment screenshots ──────────
const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    const allowed = new Set([
      'image/jpeg', 'image/png', 'image/webp', 'image/heic',
      'application/pdf',
    ]);
    if (allowed.has(file.mimetype)) cb(null, true);
    else cb(new Error(`File type not supported: ${file.mimetype}`));
  },
});

// ── OneDrive upload wrapper ───────────────────────────────────────────────────

/**
 * Upload a buffer to OneDrive and return { fileId, webUrl }.
 * Wraps uploadSingleFileBuffer.
 * NOTE: downloadUrl expires ~1h — use the proxy routes for inline display.
 */
const uploadToOneDrive = async (folderPath, filename, buffer, mimeType) => {
  const result = await uploadSingleFileBuffer(folderPath, filename, buffer, mimeType);
  return {
    fileId: result.fileId,
    webUrl: result.webUrl,
    // downloadUrl may not be returned by uploadSingleFileBuffer — that's fine,
    // the proxy endpoint fetches it fresh each time it's needed.
  };
};

/**
 * Build a safe filename: {ref}_{vendorName?}.{ext}
 */
const buildFilename = (ref, vendorName, mimeType) => {
  const ext = mimeType === 'application/pdf' ? 'pdf'
    : mimeType?.startsWith('image/') ? mimeType.split('/')[1].replace('jpeg', 'jpg')
      : 'bin';
  const safeRef = (ref || 'FILE').replace(/[^a-z0-9_\-]/gi, '_');
  const safeVend = (vendorName || '').replace(/[^a-z0-9_\-]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return safeVend ? `${safeRef}_${safeVend}.${ext}` : `${safeRef}.${ext}`;
};

// ── Shared: AI extract → dedup → save + auto-update vendor GST ────────────────
const handleAutomatedInvoice = async (base64Data, mimeType, source, metadata = {}) => {
  const extraction = await extractFromDocument(base64Data, mimeType);

  if (extraction.vendor_gst && extraction.vendor_name) {
    try {
      const vendor = await Vendor.findOne({ companyName: new RegExp(extraction.vendor_name, 'i') });
      if (vendor && !vendor.gstNumber) {
        vendor.gstNumber = extraction.vendor_gst;
        await vendor.save();
        logger.debug('Vendor GST auto-updated from invoice', { vendorId: vendor._id, gst: extraction.vendor_gst });
      }
    } catch (e) {
      logger.warn('Vendor GST auto-update failed', { error: e.message });
    }
  }

  return saveExtractedInvoice(extraction, base64Data, mimeType, source, metadata);
};


// ═══════════════════════════════════════════════════════════════════════════════
// INVOICE VAULT
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/gemini-status', async (req, res) => {
  try { res.json(await checkAIStatus()); }
  catch (err) { res.json({ available: false, reason: err.message }); }
});

/** POST /invoices/process — AI extraction only, no save */
router.post('/invoices/process', authenticate, authorize(['accounts', 'admin']), async (req, res) => {
  try {
    const { image, mimeType } = req.body;
    if (!image || !mimeType)
      return res.status(400).json({ error: 'image and mimeType are required.' });
    const base64 = image.includes(',') ? image.split(',')[1] : image;
    logger.debug('Invoice AI extraction started', { mimeType, userId: req.user.id });
    const result = await extractFromDocument(base64, mimeType);
    logger.info('Invoice AI extraction complete', { vendor: result.vendor_name, invoiceNumber: result.invoice_number, userId: req.user.id });
    res.json(result);
  } catch (err) {
    logger.error('Invoice AI extraction failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

/** GET /invoices — paginated list */
router.get('/invoices', async (req, res) => {
  try {
    const { fy, month, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (fy) filter.financialYear = fy;
    if (month) filter.month = month;

    const [invoices, total, financialYears] = await Promise.all([
      Invoice.find(filter)
        .select('-image')
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .lean(),
      Invoice.countDocuments(filter),
      Invoice.distinct('financialYear'),
    ]);

    res.json({ invoices, total, page: Number(page), limit: Number(limit), financialYears });
  } catch (err) {
    logger.error('Failed to list invoices', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

/** GET /invoices/:id — single invoice */
router.get('/invoices/:id', async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id).select('-image').lean();
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    res.json(inv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /invoices/:id/file
 * PROXY ROUTE — streams the invoice file from OneDrive inline.
 * Avoids expiring @microsoft.graph.downloadUrl by fetching a fresh one
 * via the Graph API each time, then proxying the bytes to the browser.
 * Frontend: <iframe src="/api/payment-tracker/invoices/:id/file" />
 *        or <img    src="/api/payment-tracker/invoices/:id/file" />
 */
router.get('/invoices/:id/file', async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id).select('oneDriveFileId fileName mimeType').lean();
    if (!inv?.oneDriveFileId) return res.status(404).json({ error: 'No file attached to this invoice.' });

    const { getAccessToken } = require('../services/msGraphService');
    const token = await getAccessToken();
    const uid = process.env.MICROSOFT_USER_ID;

    // Fetch fresh item metadata to get a non-expired download URL
    const meta = await axios.get(
      `https://graph.microsoft.com/v1.0/users/${uid}/drive/items/${inv.oneDriveFileId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const dlUrl = meta.data['@microsoft.graph.downloadUrl'];
    if (!dlUrl) return res.status(502).json({ error: 'Could not get download URL from OneDrive.' });

    const fileStream = await axios.get(dlUrl, { responseType: 'stream' });
    const mime = inv.mimeType || 'application/octet-stream';

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${inv.fileName || 'invoice'}"`);
    res.setHeader('Cache-Control', 'private, max-age=300'); // 5 min browser cache
    fileStream.data.pipe(res);
  } catch (err) {
    logger.error('Invoice file proxy failed', { invoiceId: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /invoices
 * Manually save invoice to vault. Accepts multipart (file upload) OR JSON (base64).
 *
 * STORAGE:
 *   prod  → OneDrive: website/Invoices/{FY}/{Month}/
 *   dev   → OneDrive: development/Invoices/{FY}/{Month}/
 *   odvPath() handles the switch automatically.
 */
router.post('/invoices',
  uploadMem.single('file'),   // optional multipart file — falls through if JSON body
  async (req, res) => {
    try {
      const isDup = await checkIfDuplicate(req.body.vendor_gst, req.body.invoice_number);
      if (isDup) {
        logger.warn('Invoice save blocked — duplicate', { invoiceNumber: req.body.invoice_number, userId: req.user?.id });
        return res.status(409).json({
          duplicate: true, error: 'Invoice already exists in vault.',
          invoice_number: req.body.invoice_number, vendor_name: req.body.vendor_name,
        });
      }

      // Auto-update vendor GST
      if (req.body.vendor_gst && req.body.vendor_name) {
        try {
          const vendor = await Vendor.findOne({ companyName: new RegExp(req.body.vendor_name.trim(), 'i') });
          if (vendor && !vendor.gstNumber) { vendor.gstNumber = req.body.vendor_gst; await vendor.save(); }
        } catch (e) { logger.warn('Vendor GST auto-update failed on manual save', { error: e.message }); }
      }

      const d = req.body.date ? new Date(req.body.date) : new Date();
      const { fy, month } = fyFromDate(d);

      // ── Upload to OneDrive/{root}/Invoices/{FY}/{Month}/ ──────────────────────
      // odvPath('Invoices', fyFolder, month) resolves root based on NODE_ENV.
      let oneDriveFileId = '', oneDriveUrl = '', fileName = '';
      try {
        let fileBuffer = null;
        let fileMime = req.body.mimeType || 'image/jpeg';

        if (req.file) {
          // Multipart upload — prefer this path
          fileBuffer = req.file.buffer;
          fileMime = req.file.mimetype;
        } else if (req.body.image) {
          // Legacy base64 JSON path
          const pure = req.body.image.includes(',') ? req.body.image.split(',')[1] : req.body.image;
          fileBuffer = Buffer.from(pure, 'base64');
        }

        if (fileBuffer) {
          fileName = buildFilename(req.body.invoice_number, req.body.vendor_name, fileMime);
          const fyFolder = normalizeFY(req.body.financialYear) || fy;
          const upload = await uploadToOneDrive(
            odvPath('Invoices', fyFolder, req.body.month || month),  // ← env-aware
            fileName, fileBuffer, fileMime
          );
          oneDriveFileId = upload.fileId;
          oneDriveUrl = upload.webUrl;
          logger.debug('Invoice uploaded to OneDrive', { fileName, oneDriveUrl });
        }
      } catch (e) {
        logger.warn('Invoice OneDrive upload failed — saving to vault without file link', { error: e.message });
      }

      const inv = new Invoice({
        ...req.body,
        total_amount: Number(req.body.total_amount || 0),
        financialYear: normalizeFY(req.body.financialYear) || fy,
        month: req.body.month || month,
        oneDriveFileId,
        oneDriveUrl,
        fileName,
        createdAt: new Date(),
        image: undefined, // never store base64
      });
      await inv.save();

      logger.info('Invoice saved to vault', {
        invoiceId: inv._id, vendor: inv.vendor_name,
        invoiceNumber: inv.invoice_number, amount: inv.total_amount, userId: req.user?.id,
      });

      // Auto-link to open PI for this vendor
      let piToLink = null;
      try {
        const linkedPiId = req.body.linkedPi || null;
        if (linkedPiId) {
          piToLink = await ProformaInvoice.findById(linkedPiId);
        } else if (req.body.vendor_name) {
          const vendor = await Vendor.findOne({ companyName: new RegExp(req.body.vendor_name.trim(), 'i') });
          if (vendor) {
            piToLink = await ProformaInvoice.findOne({
              vendor: vendor._id, status: { $in: ['pending', 'partial', 'fully_paid'] }, finalInvoice: null,
            }).sort({ createdAt: -1 });
          }
        }
        if (piToLink) {
          piToLink.finalInvoice = inv._id;
          if (piToLink.status === 'fully_paid') piToLink.status = 'invoiced';
          await piToLink.save();
          await Payment.updateMany({ proformaInvoice: piToLink._id }, { $set: { vendorInvoice: inv._id } });
          logger.debug('Invoice auto-linked to PI', { invoiceId: inv._id, piId: piToLink._id });
        }
      } catch (linkErr) {
        logger.warn('PI auto-link failed — invoice still saved', { invoiceId: inv._id, error: linkErr.message });
      }

      res.status(201).json({ ...inv.toObject(), _linkedPi: piToLink?._id || null });
    } catch (err) {
      logger.error('Invoice save failed', { error: err.message, stack: err.stack, userId: req.user?.id });
      res.status(400).json({ error: err.message });
    }
  }
);

/** DELETE /invoices/:id */
router.delete('/invoices/:id', async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });

    if (inv.oneDriveFileId) {
      try { await deleteOneDriveFile(inv.oneDriveFileId); }
      catch (e) { logger.warn('Could not delete invoice file from OneDrive', { fileId: inv.oneDriveFileId, error: e.message }); }
    }

    await Invoice.findByIdAndDelete(req.params.id);
    logger.info('Invoice deleted', { invoiceId: req.params.id, userId: req.user?.id });
    res.json({ message: 'Invoice deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// WHATSAPP WEBHOOK (no user auth — verified by token)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/whatsapp-webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }
  logger.warn('WhatsApp webhook verification failed', { mode });
  res.sendStatus(403);
});

router.post('/whatsapp-webhook', async (req, res) => {
  res.sendStatus(200); // always acknowledge immediately

  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return;

    const msg = value.messages[0];
    const phoneId = value.metadata?.phone_number_id;
    const display = value.metadata?.display_phone_number;
    const from = msg.from;
    const media = msg.document || msg.image || null;

    logger.debug('WhatsApp webhook message received', { from, hasMedia: !!media });

    if (!media || !whatsappService) {
      if (whatsappService) {
        await whatsappService.sendReply(phoneId, from, '👋 Please send an Image or PDF of the tax invoice.')
          .catch(e => logger.warn('WhatsApp reply failed', { error: e.message }));
      }
      return;
    }

    await whatsappService.sendReply(phoneId, from, '⏳ Reading invoice...')
      .catch(e => logger.warn('WhatsApp ack reply failed', { error: e.message }));

    const mediaData = await whatsappService.downloadWhatsAppMedia(media.id);
    if (!mediaData) { logger.warn('WhatsApp media download returned empty', { mediaId: media.id, from }); return; }

    const result = await handleAutomatedInvoice(
      mediaData.base64, mediaData.mimeType, 'whatsapp',
      { notes: `WhatsApp Receiver: ${display} | From: ${from}` }
    );

    const reply = result.success
      ? `✅ Invoice Saved!\n*Vendor:* ${result.data.vendor_name}\n*Inv:* ${result.data.invoice_number}\n*Amount:* ₹${result.data.total_amount}`
      : `⚠️ Duplicate: Invoice #${result.data.invoice_number} already in vault.`;

    if (result.success) logger.info('WhatsApp invoice saved', { invoiceId: result.data._id, from });
    else logger.info('WhatsApp invoice duplicate skipped', { invoiceNumber: result.data.invoice_number, from });

    await whatsappService.sendReply(phoneId, from, reply)
      .catch(e => logger.warn('WhatsApp result reply failed', { error: e.message }));

  } catch (err) {
    logger.error('WhatsApp webhook processing error', { error: err.message, stack: err.stack });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// OUTLOOK SYNC (admin only — currently disabled)
// ═══════════════════════════════════════════════════════════════════════════════

const syncOutlookInvoices = async () => {
  logger.warn('Outlook sync is currently disabled to prevent zero-value invoice creation');
  return {
    success: false, disabled: true,
    message: 'Outlook email scanning is temporarily disabled. Upload invoices manually via the Invoice Vault tab.',
  };
};

router.post('/outlook-sync', authenticate, authorize(['admin']), async (req, res) => {
  logger.info('Manual Outlook sync triggered (currently disabled)', { userId: req.user.id });
  const result = await syncOutlookInvoices();
  res.status(result.disabled ? 503 : 200).json(result);
});


// ═══════════════════════════════════════════════════════════════════════════════
// PROFORMA INVOICES (PI)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/pi', async (req, res) => {
  try {
    const { vendorId, status, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (vendorId) filter.vendor = vendorId;
    if (status) filter.status = status;

    const [pis, total] = await Promise.all([
      ProformaInvoice.find(filter)
        .populate('vendor', 'companyName gstNumber')
        .populate('finalInvoice', 'invoiceNumber status amountPaid amountDue')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit)),
      ProformaInvoice.countDocuments(filter),
    ]);

    const piIds = pis.map(p => p._id);
    const pays = await Payment.find({ proformaInvoice: { $in: piIds } })
      .select('proformaInvoice amount paymentDate paymentMode bankRef status paymentRef')
      .sort({ paymentDate: 1 });

    const byPI = {};
    pays.forEach(p => { const k = p.proformaInvoice?.toString(); if (!byPI[k]) byPI[k] = []; byPI[k].push(p); });

    res.json({
      data: pis.map(pi => ({ ...pi.toObject(), payments: byPI[pi._id.toString()] || [] })),
      total, page: Number(page), limit: Number(limit),
    });
  } catch (err) {
    logger.error('Failed to list PIs', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

router.get('/pi/:id', async (req, res) => {
  try {
    const pi = await ProformaInvoice.findById(req.params.id)
      .populate('vendor', 'companyName gstNumber')
      .populate('finalInvoice');
    if (!pi) return res.status(404).json({ error: 'PI not found.' });
    const payments = await Payment.find({ proformaInvoice: pi._id }).sort({ paymentDate: 1 });
    res.json({ ...pi.toObject(), payments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /pi/:id/attachment
 * PROXY ROUTE — streams PI attachment inline from OneDrive.
 * Frontend: <iframe src="/api/payment-tracker/pi/:id/attachment" />
 *        or <img    src="/api/payment-tracker/pi/:id/attachment" />
 */
router.get('/pi/:id/attachment', async (req, res) => {
  try {
    const pi = await ProformaInvoice.findById(req.params.id)
      .select('attachmentFileId attachmentName attachmentMime').lean();
    if (!pi?.attachmentFileId) return res.status(404).json({ error: 'No attachment on this PI.' });

    const { getAccessToken } = require('../services/msGraphService');
    const token = await getAccessToken();
    const uid = process.env.MICROSOFT_USER_ID;

    const meta = await axios.get(
      `https://graph.microsoft.com/v1.0/users/${uid}/drive/items/${pi.attachmentFileId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const dlUrl = meta.data['@microsoft.graph.downloadUrl'];
    if (!dlUrl) return res.status(502).json({ error: 'Could not get download URL from OneDrive.' });

    const fileStream = await axios.get(dlUrl, { responseType: 'stream' });
    res.setHeader('Content-Type', pi.attachmentMime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${pi.attachmentName || 'attachment'}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    fileStream.data.pipe(res);
  } catch (err) {
    logger.error('PI attachment proxy failed', { piId: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /pi
 * STORAGE:
 *   prod  → OneDrive: website/PI-Attachments/{piNumber}/
 *   dev   → OneDrive: development/PI-Attachments/{piNumber}/
 *   odvPath() handles the switch automatically.
 */
router.post('/pi',
  uploadMem.single('attachment'),
  async (req, res) => {
    try {
      const existing = await ProformaInvoice.findOne({ piNumber: req.body.piNumber });
      if (existing) {
        return res.status(409).json({
          duplicate: true, error: `PI number "${req.body.piNumber}" already exists.`, piNumber: req.body.piNumber,
        });
      }

      // ── Upload PI attachment to OneDrive/{root}/PI-Attachments/{piNumber}/ ────
      // Sanitise piNumber for use as an OneDrive folder name:
      // slashes (e.g. PI-267/2026-27) would be interpreted as path separators by
      // the Graph API and create unexpected nested folders or throw a 404.
      const safePiFolder = (req.body.piNumber || 'PI')
        .replace(/\//g, '-')           // PI-267/2026-27 → PI-267-2026-27
        .replace(/[\\:*?"<>|]/g, '_'); // strip any other chars illegal in folder names

      let attachmentFileId = '', attachmentUrl = '', attachmentName = '', attachmentMime = '';
      let oneDriveWarning = null;
      if (req.file) {
        try {
          attachmentName = req.file.originalname || buildFilename(req.body.piNumber, '', req.file.mimetype);
          attachmentMime = req.file.mimetype;
          const upload = await uploadToOneDrive(
            odvPath('PI-Attachments', safePiFolder),   // ← sanitised folder name
            attachmentName, req.file.buffer, req.file.mimetype
          );
          attachmentFileId = upload.fileId;
          attachmentUrl    = upload.webUrl;
          logger.info('PI attachment uploaded to OneDrive', { piNumber: req.body.piNumber, safePiFolder, attachmentUrl });
        } catch (e) {
          // Keep name/mime blank so the record doesn't appear to have an attachment
          attachmentName   = '';
          attachmentMime   = '';
          oneDriveWarning  = e.message;
          logger.error('PI OneDrive upload failed', { error: e.message, stack: e.stack, piNumber: req.body.piNumber, safePiFolder });
        }
      }
      // ── Parse any JSON-stringified fields sent via FormData ───────────────────
      const body = { ...req.body };
      if (typeof body.items === 'string') {
        try { body.items = JSON.parse(body.items); } catch { body.items = []; }
      }
      const pi = new ProformaInvoice({
        ...body,
        attachmentFileId,
        attachmentUrl,
        attachmentName,
        attachmentMime,
        attachment: undefined, // never store base64
        attachmentMime_legacy: undefined,
      });
      pi.amountPaid = 0;
      pi.amountDue = pi.totalAmount;
      await pi.save();

      logger.info('PI created', { piId: pi._id, piNumber: pi.piNumber, hasAttachment: !!attachmentFileId, userId: req.user?.id });
      const doc = await ProformaInvoice.findById(pi._id).populate('vendor', 'companyName gstNumber');
      const payload = doc.toObject();
      if (oneDriveWarning) payload._oneDriveWarning = `Attachment not saved — OneDrive error: ${oneDriveWarning}`;
      res.status(201).json(payload);
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({
          duplicate: true, error: `PI number "${req.body.piNumber}" already exists.`, piNumber: req.body.piNumber,
        });
      }
      logger.error('PI creation failed', { error: err.message, stack: err.stack, userId: req.user?.id });
      res.status(400).json({ error: err.message });
    }
  }
);

/**
 * PATCH /pi/:id
 * STORAGE:
 *   prod  → OneDrive: website/PI-Attachments/{piNumber}/
 *   dev   → OneDrive: development/PI-Attachments/{piNumber}/
 */
router.patch('/pi/:id',
  uploadMem.single('attachment'),
  async (req, res) => {
    try {
      const pi = await ProformaInvoice.findById(req.params.id);
      if (!pi) return res.status(404).json({ error: 'PI not found.' });

      Object.assign(pi, req.body);

      if (req.file) {
        try {
          const attachmentName = req.file.originalname || buildFilename(pi.piNumber, '', req.file.mimetype);
          const upload = await uploadToOneDrive(
            odvPath('PI-Attachments', pi.piNumber),  // ← env-aware
            attachmentName, req.file.buffer, req.file.mimetype
          );
          pi.attachmentFileId = upload.fileId;
          pi.attachmentUrl = upload.webUrl;
          pi.attachmentName = attachmentName;
          pi.attachmentMime = req.file.mimetype;
        } catch (e) {
          logger.warn('PI attachment update upload failed', { piId: req.params.id, error: e.message });
        }
      }

      await pi.save();
      logger.info('PI updated', { piId: req.params.id, userId: req.user?.id });
      res.json(pi);
    } catch (err) {
      logger.error('PI update failed', { piId: req.params.id, error: err.message, stack: err.stack });
      res.status(400).json({ error: err.message });
    }
  }
);

router.delete('/pi/:id', async (req, res) => {
  try {
    const pi = await ProformaInvoice.findById(req.params.id);
    if (!pi) return res.status(404).json({ error: 'PI not found.' });

    // Delete linked payment screenshots + their OneDrive folders
    const linkedPayments = await Payment.find({ proformaInvoice: pi._id });
    for (const pay of linkedPayments) {
      if (pay.screenshotFileId) {
        try { await deleteOneDriveFile(pay.screenshotFileId); }
        catch (e) { logger.warn('Could not delete payment screenshot from OneDrive', { fileId: pay.screenshotFileId, error: e.message }); }
      }
      if (pay.paymentRef) {
        try { await deleteFolderByPath(odvPath('Payments', pay.paymentRef)); }
        catch (e) { /* folder may not exist */ }
      }
    }
    await Payment.deleteMany({ proformaInvoice: pi._id });

    // Delete PI attachment folder from OneDrive (same sanitisation as POST /pi)
    if (pi.piNumber) {
      const safePiFolder = pi.piNumber.replace(/\//g, '-').replace(/[\\:*?"<>|]/g, '_');
      try { await deleteFolderByPath(odvPath('PI-Attachments', safePiFolder)); }
      catch (e) { logger.warn('Could not delete PI folder from OneDrive', { piNumber: pi.piNumber, error: e.message }); }
    }

    await ProformaInvoice.findByIdAndDelete(req.params.id);
    logger.info('PI deleted (cascade payments + OneDrive cleanup)', { piId: req.params.id, userId: req.user?.id });
    res.json({ message: 'PI deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/payments', async (req, res) => {
  try {
    const { vendorId, mappedTo, status, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (vendorId) filter.vendor = vendorId;
    if (mappedTo) filter.mappedTo = mappedTo;
    if (status) filter.status = status;

    const [payments, total] = await Promise.all([
      Payment.find(filter)
        .populate('vendor', 'companyName')
        .populate('proformaInvoice', 'piNumber totalAmount amountPaid status')
        .populate('vendorInvoice', 'invoice_number total_amount vendor_name')
        .sort({ paymentDate: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit)),
      Payment.countDocuments(filter),
    ]);

    res.json({ data: payments, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /payments/:id/screenshot
 * PROXY ROUTE — streams payment screenshot inline from OneDrive.
 * Frontend: <img src="/api/payment-tracker/payments/:id/screenshot" />
 */
router.get('/payments/:id/screenshot', async (req, res) => {
  try {
    const pay = await Payment.findById(req.params.id)
      .select('screenshotFileId screenshotName screenshotMime').lean();
    if (!pay?.screenshotFileId) return res.status(404).json({ error: 'No screenshot on this payment.' });

    const { getAccessToken } = require('../services/msGraphService');
    const token = await getAccessToken();
    const uid = process.env.MICROSOFT_USER_ID;

    const meta = await axios.get(
      `https://graph.microsoft.com/v1.0/users/${uid}/drive/items/${pay.screenshotFileId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const dlUrl = meta.data['@microsoft.graph.downloadUrl'];
    if (!dlUrl) return res.status(502).json({ error: 'Could not get download URL from OneDrive.' });

    const fileStream = await axios.get(dlUrl, { responseType: 'stream' });
    res.setHeader('Content-Type', pay.screenshotMime || 'image/jpeg');
    res.setHeader('Content-Disposition', `inline; filename="${pay.screenshotName || 'screenshot'}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    fileStream.data.pipe(res);
  } catch (err) {
    logger.error('Payment screenshot proxy failed', { paymentId: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /payments
 * STORAGE:
 *   prod  → OneDrive: website/Payments/{paymentRef}/
 *   dev   → OneDrive: development/Payments/{paymentRef}/
 *   odvPath() handles the switch automatically.
 */
router.post('/payments',
  uploadMem.single('screenshot'),
  async (req, res) => {
    try {
      const {
        vendor, paymentDate, amount, currency, paymentMode, bankRef,
        remarks, mappedTo, proformaInvoice: piId, vendorInvoice: viId,
      } = req.body;

      // Collision-proof paymentRef
      const last = await Payment.findOne({}, { paymentRef: 1 }).sort({ paymentRef: -1 });
      let nextNum = 1;
      if (last?.paymentRef) { const m = last.paymentRef.match(/PAY-(\d+)/); if (m) nextNum = parseInt(m[1], 10) + 1; }
      let paymentRef = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = `PAY-${String(nextNum).padStart(5, '0')}`;
        if (!await Payment.exists({ paymentRef: candidate })) { paymentRef = candidate; break; }
        nextNum++;
      }
      if (!paymentRef) throw new Error('Could not generate a unique payment reference — please retry.');

      // ── Upload screenshot to OneDrive/{root}/Invoices/{FY}/{Month}/Payments/{paymentRef}/ ──
      let screenshotFileId = '', screenshotUrl = '', screenshotName = '', screenshotMime = '';
      if (req.file) {
        try {
          screenshotName = req.file.originalname || buildFilename(paymentRef, '', req.file.mimetype);
          screenshotMime = req.file.mimetype;
          // Derive FY and month from paymentDate so the file lands alongside invoices for that period
          const pd = paymentDate ? new Date(paymentDate) : new Date();
          const { fy: payFy, month: payMonth } = fyFromDate(pd);
          const upload = await uploadToOneDrive(
            odvPath('Invoices', payFy, payMonth, 'Payments'),  // ← nested under Invoices/{FY}/{Month}/Payments/
            screenshotName, req.file.buffer, req.file.mimetype
          );
          screenshotFileId = upload.fileId;
          screenshotUrl = upload.webUrl;
          logger.debug('Payment screenshot uploaded to OneDrive', { paymentRef, screenshotUrl, path: `Invoices/${payFy}/${payMonth}/Payments` });
        } catch (e) {
          logger.warn('Payment screenshot OneDrive upload failed — recording payment without screenshot', { error: e.message });
        }
      } else if (req.body.screenshot) {
        // Legacy base64 path — still works but not stored in MongoDB
        logger.warn('Payment received base64 screenshot — ignoring. Send as multipart instead.');
      }

      const payment = new Payment({
        paymentRef,
        vendor: vendor || null,
        paymentDate, amount: Number(amount), currency, paymentMode, bankRef, remarks,
        mappedTo: mappedTo || 'advance',
        proformaInvoice: piId || null,
        vendorInvoice: viId || null,
        screenshotFileId,
        screenshotUrl,
        screenshotName,
        screenshotMime,
        screenshot: undefined, // never store base64
      });
      await payment.save();

      // Update PI balance
      if (piId) {
        const pi = await ProformaInvoice.findById(piId);
        if (!pi) { await Payment.findByIdAndDelete(payment._id); throw new Error('PI not found.'); }
        if (pi.amountPaid + Number(amount) > pi.totalAmount) {
          await Payment.findByIdAndDelete(payment._id);
          throw new Error(`Payment exceeds PI balance of ₹${pi.totalAmount - pi.amountPaid}`);
        }
        pi.amountPaid += Number(amount);
        if (pi.amountPaid >= pi.totalAmount && pi.finalInvoice) pi.status = 'invoiced';
        await pi.save();
      }

      // Update balance via vendor invoice → linked PI
      if (viId) {
        const vi = await Invoice.findById(viId);
        if (!vi) { await Payment.findByIdAndDelete(payment._id); throw new Error('Invoice not found in vault.'); }
        const linkedPi = await ProformaInvoice.findOne({ finalInvoice: viId });
        if (linkedPi) {
          if (linkedPi.amountPaid + Number(amount) > linkedPi.totalAmount) {
            await Payment.findByIdAndDelete(payment._id);
            throw new Error(`Payment exceeds PI balance of ₹${linkedPi.totalAmount - linkedPi.amountPaid}`);
          }
          linkedPi.amountPaid += Number(amount);
          payment.proformaInvoice = linkedPi._id;
          if (linkedPi.amountPaid >= linkedPi.totalAmount) linkedPi.status = 'invoiced';
          await linkedPi.save();
        }
        if (vi.vendor_name && !vendor) {
          const vendorDoc = await Vendor.findOne({ companyName: new RegExp(vi.vendor_name, 'i') });
          if (vendorDoc) payment.vendor = vendorDoc._id;
        }
        await payment.save();
      }

      logger.info('Payment recorded', { paymentRef, amount: Number(amount), mappedTo: mappedTo || 'advance', userId: req.user?.id });

      const populated = await Payment.findById(payment._id)
        .populate('vendor', 'companyName')
        .populate('proformaInvoice', 'piNumber totalAmount amountPaid amountDue status')
        .populate('vendorInvoice', 'invoice_number total_amount vendor_name');

      res.status(201).json(populated);
    } catch (err) {
      logger.error('Payment creation failed', { error: err.message, stack: err.stack, userId: req.user?.id });
      res.status(400).json({ error: err.message });
    }
  }
);

router.patch('/payments/:id/map', async (req, res) => {
  try {
    const { mappedTo, proformaInvoice: piId, vendorInvoice: viId } = req.body;
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Payment not found.' });
    if (payment.mappedTo !== 'advance') return res.status(400).json({ error: 'Only advances can be re-mapped.' });

    if (mappedTo === 'proforma_invoice' && piId) {
      const pi = await ProformaInvoice.findById(piId);
      if (!pi) throw new Error('PI not found.');
      if (pi.amountPaid + payment.amount > pi.totalAmount)
        throw new Error(`Payment exceeds PI balance of ₹${pi.totalAmount - pi.amountPaid}`);
      pi.amountPaid += payment.amount;
      if (pi.amountPaid >= pi.totalAmount && pi.finalInvoice) pi.status = 'invoiced';
      await pi.save();
      payment.mappedTo = 'proforma_invoice';
      payment.proformaInvoice = piId;
      if (pi.vendor) payment.vendor = pi.vendor;

    } else if (mappedTo === 'vendor_invoice' && viId) {
      const vi = await Invoice.findById(viId);
      if (!vi) throw new Error('Invoice not found in vault.');
      payment.mappedTo = 'vendor_invoice';
      payment.vendorInvoice = viId;
      if (vi.vendor_name) {
        const vendorDoc = await Vendor.findOne({ companyName: new RegExp(vi.vendor_name, 'i') });
        if (vendorDoc) payment.vendor = vendorDoc._id;
      }
    } else {
      return res.status(400).json({ error: 'Invalid mapping target.' });
    }

    await payment.save();
    logger.info('Payment remapped', { paymentId: req.params.id, mappedTo, userId: req.user?.id });

    const populated = await Payment.findById(payment._id)
      .populate('vendor', 'companyName')
      .populate('proformaInvoice', 'piNumber totalAmount amountPaid amountDue status')
      .populate('vendorInvoice', 'invoice_number total_amount vendor_name');
    res.json(populated);
  } catch (err) {
    logger.error('Payment remap failed', { paymentId: req.params.id, error: err.message });
    res.status(400).json({ error: err.message });
  }
});

router.post('/payments/link-to-invoice', async (req, res) => {
  try {
    const { piId, invoiceId } = req.body;
    if (!piId || !invoiceId) return res.status(400).json({ error: 'piId and invoiceId are required.' });

    const [pi, invoice] = await Promise.all([ProformaInvoice.findById(piId), Invoice.findById(invoiceId)]);
    if (!pi) return res.status(404).json({ error: 'PI not found.' });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found in vault.' });

    pi.finalInvoice = new mongoose.Types.ObjectId(invoiceId);
    pi.status = 'invoiced';
    await pi.save();

    const updated = await Payment.updateMany(
      { proformaInvoice: new mongoose.Types.ObjectId(piId) },
      { $set: { vendorInvoice: new mongoose.Types.ObjectId(invoiceId) } }
    );

    logger.info('PI linked to invoice', { piId, invoiceId, paymentsUpdated: updated.modifiedCount, userId: req.user?.id });
    res.json({
      success: true,
      pi: await ProformaInvoice.findById(pi._id).populate('vendor', 'companyName'),
      paymentsUpdated: updated.modifiedCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/payments/:id', async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Payment not found.' });

    if (payment.proformaInvoice) {
      const pi = await ProformaInvoice.findById(payment.proformaInvoice);
      if (pi) { pi.amountPaid = Math.max(0, pi.amountPaid - payment.amount); await pi.save(); }
    }
    if (payment.vendorInvoice) {
      const vi = await VendorInvoice.findById(payment.vendorInvoice);
      if (vi) { vi.amountPaid = Math.max(0, vi.amountPaid - payment.amount); vi.payments = vi.payments.filter(p => p.toString() !== payment._id.toString()); await vi.save(); }
    }

    await Payment.findByIdAndDelete(req.params.id);

    // Delete payment screenshot file and OneDrive folder
    if (payment.screenshotFileId) {
      try { await deleteOneDriveFile(payment.screenshotFileId); }
      catch (e) { logger.warn('Could not delete payment screenshot from OneDrive', { fileId: payment.screenshotFileId, error: e.message }); }
    }
    if (payment.paymentRef) {
      try { await deleteFolderByPath(odvPath('Payments', payment.paymentRef)); }
      catch (e) { /* folder may not exist */ }
    }

    logger.info('Payment deleted', { paymentId: req.params.id, paymentRef: payment.paymentRef, userId: req.user?.id });
    res.json({ message: 'Payment deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// VENDOR GST
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/vendor-gst/:vendorId', async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.vendorId).select('companyName gstNumber').lean();
    if (!vendor) return res.status(404).json({ error: 'Vendor not found.' });
    res.json({ companyName: vendor.companyName, gstNumber: vendor.gstNumber || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/vendor-gst/:vendorId', async (req, res) => {
  try {
    const vendor = await Vendor.findByIdAndUpdate(
      req.params.vendorId, { gstNumber: req.body.gstNumber }, { new: true }
    ).select('companyName gstNumber');
    if (!vendor) return res.status(404).json({ error: 'Vendor not found.' });
    logger.info('Vendor GST updated', { vendorId: req.params.vendorId, userId: req.user?.id });
    res.json(vendor);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
  try {
    const match = req.query.vendorId ? { vendor: new mongoose.Types.ObjectId(req.query.vendorId) } : {};

    const [piStats, paymentStats] = await Promise.all([
      ProformaInvoice.aggregate([
        { $match: match },
        { $group: { _id: '$status', count: { $sum: 1 }, totalAmount: { $sum: '$totalAmount' }, amountPaid: { $sum: '$amountPaid' }, amountDue: { $sum: '$amountDue' } } },
      ]),
      Payment.aggregate([
        { $match: match },
        { $group: { _id: '$mappedTo', count: { $sum: 1 }, totalPaid: { $sum: '$amount' } } },
      ]),
    ]);

    res.json({ piStats, paymentStats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, syncOutlookInvoices };