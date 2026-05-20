'use strict';
/**
 * backend/routes/invoiceRoute.js
 * Mounted at /api/payment-tracker  (see server.js)
 *
 * Automated ingestion (webhook — no user auth, verified by token/signature):
 *   GET  /whatsapp-webhook   — Meta webhook verification challenge
 *   POST /whatsapp-webhook   — incoming WhatsApp invoice media
 *   POST /outlook-sync       — trigger Outlook mailbox scan (admin only)
 *
 * AI processing (authenticated):
 *   POST /process            — AI extraction only, no save (accounts + admin)
 *
 * CRUD (authenticated):
 *   GET    /                 — list all invoices
 *   POST   /                 — manually save an invoice
 *   DELETE /:id              — delete an invoice
 */

const express         = require('express');
const router          = express.Router();
const Invoice         = require('../models/Invoice');
const whatsappService = require('../services/whatsappService');
const { authenticate, authorize }            = require('../middleware/authMiddleware');
const { extractFromDocument }                = require('../services/aiService');
const { scanMailboxesForAttachments }        = require('../services/msGraphService');
const { checkIfDuplicate, saveExtractedInvoice } = require('../utils/invoiceHelpers');
const logger          = require('../utils/logger').child({ module: 'invoiceRoute' });

// ─── Shared: extract → dedup → save ──────────────────────────────────────────
const handleAutomatedInvoice = async (base64Data, mimeType, source, metadata = {}) => {
  const extraction = await extractFromDocument(base64Data, mimeType);
  return saveExtractedInvoice(extraction, base64Data, mimeType, source, metadata);
};


// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK ROUTES — no user auth (verified by token / Meta signature)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /whatsapp-webhook
 * Meta sends this to verify the webhook URL.
 */
router.get('/whatsapp-webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }
  logger.warn('WhatsApp webhook verification failed', { mode, tokenMatch: token === process.env.WHATSAPP_VERIFY_TOKEN });
  res.sendStatus(403);
});

/**
 * POST /whatsapp-webhook
 * Receives incoming WhatsApp messages from Meta.
 * ALWAYS returns 200 — if we return anything else Meta will retry endlessly.
 */
router.post('/whatsapp-webhook', async (req, res) => {
  // Acknowledge immediately — Meta requires a fast response
  res.sendStatus(200);

  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return; // ping / status update — nothing to process

    const msg     = value.messages[0];
    const phoneId = value.metadata?.phone_number_id;
    const display = value.metadata?.display_phone_number;
    const from    = msg.from;
    const media   = msg.document || msg.image || null;

    logger.debug('WhatsApp webhook message received', { from, hasMedia: !!media, phoneId });

    if (!media) {
      await whatsappService.sendReply(phoneId, from,
        '👋 Please send an *Image* or *PDF* of the tax invoice.'
      ).catch(e => logger.warn('WhatsApp reply failed', { error: e.message }));
      return;
    }

    await whatsappService.sendReply(phoneId, from, '⏳ Reading your invoice...')
      .catch(e => logger.warn('WhatsApp ack reply failed', { error: e.message }));

    const mediaData = await whatsappService.downloadWhatsAppMedia(media.id);
    if (!mediaData) {
      logger.warn('WhatsApp media download returned empty', { mediaId: media.id, from });
      return;
    }

    const result = await handleAutomatedInvoice(
      mediaData.base64,
      mediaData.mimeType,
      'whatsapp',
      { notes: `WhatsApp Receiver: ${display} | From: ${from}` }
    );

    if (result.success) {
      logger.info('WhatsApp invoice saved', {
        invoiceId:     result.data._id,
        vendor:        result.data.vendor_name,
        invoiceNumber: result.data.invoice_number,
        from,
      });
      await whatsappService.sendReply(phoneId, from,
        `✅ Invoice Saved!\n\n*Vendor:* ${result.data.vendor_name}\n*Inv No:* ${result.data.invoice_number}\n*Amount:* ₹${result.data.total_amount}`
      ).catch(e => logger.warn('WhatsApp success reply failed', { error: e.message }));

    } else if (result.reason === 'Duplicate') {
      logger.info('WhatsApp invoice duplicate skipped', {
        invoiceNumber: result.data.invoice_number,
        vendor:        result.data.vendor_name,
        from,
      });
      await whatsappService.sendReply(phoneId, from,
        `⚠️ Duplicate: Invoice #${result.data.invoice_number} from ${result.data.vendor_name} is already in the vault.`
      ).catch(e => logger.warn('WhatsApp duplicate reply failed', { error: e.message }));

    } else {
      logger.warn('WhatsApp invoice processing returned unknown result', { result, from });
    }

  } catch (err) {
    // Log but never let an exception bubble — res.sendStatus(200) was already sent above
    logger.error('WhatsApp webhook processing error', { error: err.message, stack: err.stack });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// OUTLOOK SYNC — admin only
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Scans Outlook mailboxes for the last 24 h of attachments, extracts and saves invoices.
 * Exported so server.js cron job can call it directly.
 */
const syncOutlookInvoices = async () => {
  logger.info('Outlook sync started');
  try {
    const since       = new Date(Date.now() - 86_400_000).toISOString(); // last 24 h
    const attachments = await scanMailboxesForAttachments(since);
    logger.debug('Outlook attachments fetched', { count: attachments.length });

    let saved    = 0;
    let skipped  = 0;
    let failures = 0;

    for (const att of attachments) {
      try {
        const r = await handleAutomatedInvoice(
          att.contentBytes,
          att.contentType,
          'outlook',
          { notes: `User: ${att.userEmail} | From: ${att.fromEmail} | Subject: ${att.subject}` }
        );
        if (r.success)              saved++;
        else if (r.reason === 'Duplicate') skipped++;
        else                        failures++;
      } catch (attErr) {
        failures++;
        logger.warn('Outlook attachment processing failed', {
          subject:   att.subject,
          fromEmail: att.fromEmail,
          error:     attErr.message,
        });
      }
    }

    logger.info('Outlook sync complete', { saved, skipped, failures, total: attachments.length });
    return { success: true, processed: saved };
  } catch (err) {
    logger.error('Outlook sync failed', { error: err.message, stack: err.stack });
    return { success: false, error: err.message };
  }
};

/**
 * POST /outlook-sync
 * Manually trigger an Outlook sync. Admin only.
 */
router.post('/outlook-sync', authenticate, authorize(['admin']), async (req, res) => {
  logger.info('Manual Outlook sync triggered', { userId: req.user.id });
  const result = await syncOutlookInvoices();
  res.json(result);
});


// ═══════════════════════════════════════════════════════════════════════════════
// AI PROCESSING (authenticated — accounts + admin)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /process
 * Runs AI extraction on a base64 document and returns the result without saving.
 * Used by the Invoice.js frontend page for manual review before save.
 */
router.post('/process', authenticate, authorize(['accounts', 'admin']), async (req, res) => {
  try {
    const { image, mimeType } = req.body;
    if (!image || !mimeType)
      return res.status(400).json({ error: 'image and mimeType are required.' });

    const base64 = image.includes(',') ? image.split(',')[1] : image;
    logger.debug('Invoice AI extraction started', { mimeType, userId: req.user.id });

    const result = await extractFromDocument(base64, mimeType);
    logger.info('Invoice AI extraction complete', {
      vendor:        result.vendor_name,
      invoiceNumber: result.invoice_number,
      userId:        req.user.id,
    });
    res.json(result);
  } catch (err) {
    logger.error('Invoice AI extraction failed', { error: err.message, stack: err.stack, userId: req.user?.id });
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// CRUD (authenticated via routeGuard — accounts + admin)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /
 * List all invoices, newest first.
 */
router.get('/', async (req, res) => {
  try {
    const invoices = await Invoice.find().sort({ createdAt: -1 }).lean();
    logger.debug('Invoices listed', { count: invoices.length, userId: req.user?.id });
    res.json(invoices);
  } catch (err) {
    logger.error('Failed to list invoices', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /
 * Manually save a reviewed invoice.
 */
router.post('/', async (req, res) => {
  try {
    const isDup = await checkIfDuplicate(req.body.vendor_gst, req.body.invoice_number);
    if (isDup) {
      logger.warn('Manual invoice save blocked — duplicate', {
        invoiceNumber: req.body.invoice_number,
        vendorGst:     req.body.vendor_gst,
        userId:        req.user?.id,
      });
      return res.status(400).json({ error: 'Invoice already exists in vault.' });
    }

    const inv = new Invoice({
      ...req.body,
      total_amount: Number(req.body.total_amount || 0),
      createdAt:    new Date(),
    });
    await inv.save();

    logger.info('Invoice manually saved', {
      invoiceId:     inv._id,
      vendor:        inv.vendor_name,
      invoiceNumber: inv.invoice_number,
      amount:        inv.total_amount,
      userId:        req.user?.id,
    });
    res.status(201).json(inv);
  } catch (err) {
    logger.error('Invoice manual save failed', { error: err.message, stack: err.stack, userId: req.user?.id });
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const inv = await Invoice.findByIdAndDelete(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    logger.info('Invoice deleted', { invoiceId: req.params.id, userId: req.user?.id });
    res.json({ message: 'Invoice deleted.' });
  } catch (err) {
    logger.error('Invoice delete failed', { invoiceId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, syncOutlookInvoices };