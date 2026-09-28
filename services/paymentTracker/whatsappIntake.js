'use strict';
/**
 * services/paymentTracker/whatsappIntake.js
 *
 * Invoices sent to the business WhatsApp number: read them with the
 * open-source extractor and file them through the same invoiceService.create
 * path as a manual upload (duplicate check, OneDrive, PI link).
 */
const { extractDocument } = require('../documentExtraction');
const invoiceService = require('./invoiceService');
const logger = require('../../utils/logger').child({ module: 'paymentTracker.whatsapp' });

let whatsapp = null;
try { whatsapp = require('../whatsappService'); } catch { /* optional integration */ }

const reply = (phoneId, to, message) =>
  whatsapp?.sendReply(phoneId, to, message).catch((e) => logger.warn('WhatsApp reply failed', { error: e.message }));

const handleWebhook = async (payload) => {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];
  if (!msg || !whatsapp) return;

  const phoneId = value.metadata?.phone_number_id;
  const display = value.metadata?.display_phone_number;
  const from = msg.from;
  const media = msg.document || msg.image;
  if (!media) return reply(phoneId, from, '👋 Please send an image or PDF of the tax invoice.');

  await reply(phoneId, from, '⏳ Reading invoice…');
  const downloaded = await whatsapp.downloadWhatsAppMedia(media.id);
  if (!downloaded) { logger.warn('WhatsApp media download returned nothing', { mediaId: media.id }); return; }

  const buffer = Buffer.from(downloaded.base64, 'base64');
  const ex = await extractDocument(buffer, downloaded.mimeType, 'invoice');
  if (!ex.invoice_number || !ex.total_amount || !ex.date) {
    return reply(phoneId, from, '⚠️ Could not read the invoice number, date or total clearly. Please upload it from the Payment Tracker.');
  }

  try {
    const inv = await invoiceService.create({
      vendor_name: ex.vendor_name, vendor_gst: ex.vendor_gst, invoice_number: ex.invoice_number, date: ex.date,
      total_amount: ex.total_amount, cgst: ex.cgst, sgst: ex.sgst, igst: ex.igst,
      notes: `WhatsApp Receiver: ${display} | From: ${from}`,
    }, { buffer, mimetype: ex._meta.mimeType }, { source: 'whatsapp' });
    await reply(phoneId, from, `✅ Invoice saved!\n*Vendor:* ${inv.vendor_name}\n*Inv:* ${inv.invoice_number}\n*Amount:* ₹${inv.total_amount}`);
  } catch (err) {
    if (err.details?.duplicate) return reply(phoneId, from, `⚠️ Duplicate: invoice #${ex.invoice_number} is already in the vault.`);
    throw err;
  }
};

module.exports = { handleWebhook };
