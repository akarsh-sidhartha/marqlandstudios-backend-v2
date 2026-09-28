'use strict';
/**
 * Run: npm test
 * Uses Node's built-in test runner — no extra dev dependencies.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { extractDocument } = require('../../services/documentExtraction');
const { layoutFromPlainText } = require('../../services/documentExtraction/layout');
const { parseInvoice } = require('../../services/documentExtraction/parsers/invoiceParser');
const { parsePayment } = require('../../services/documentExtraction/parsers/paymentParser');
const P = require('../../services/documentExtraction/parsers/primitives');
const { zohoInvoicePdf, zohoQuotePdf } = require('./fixtures');

const ctx = { ownGstins: ['29ACGFM9082Q1Z5'], ownNames: ['marqland'] };

test('primitives: amounts, dates, words, GSTIN', () => {
  assert.deepEqual(P.findAmounts('Rs.35,813.00 and 18% of 1,23,456.5 HSN 84231000').map((a) => a.value), [35813, 123456.5]);
  assert.equal(P.parseDate('Invoice Date: 21/08/2026'), '2026-08-21');
  assert.equal(P.parseDate('26 Sept 2026'), '2026-09-26');
  assert.equal(P.parseDate('Sep 26, 2026'), '2026-09-26');
  assert.equal(P.parseDate('2026-09-26'), '2026-09-26');
  assert.equal(P.parseDate('12-Sep-26'), '2026-09-12');
  assert.equal(P.parseDate('31/02/2026'), null);
  assert.equal(P.wordsToAmount('Indian Rupee Thirty-Five Thousand Eight Hundred Thirteen Only'), 35813);
  assert.equal(P.wordsToAmount('Rupees Two Lakh Five Thousand and Fifty Paise Only'), 205000.5);
  assert.equal(P.wordsToAmount('Eight Thousand Twenty Four Rupees Only'), 8024);
  assert.deepEqual(P.findGstins('GSTIN: 29ACGFM9082Q1Z5 / 21AACCO5117B1Z8'), ['29ACGFM9082Q1Z5', '21AACCO5117B1Z8']);
  assert.deepEqual(P.fiscalPeriod('2026-02-10'), { financialYear: '2025-26', month: 'February' });
});

test('GSTIN checksum and OCR repair', () => {
  assert.equal(P.isValidGstin('29AAUFK7236J1ZJ'), true);
  assert.equal(P.isValidGstin('20AAUFK7236J1ZJ'), false);
  assert.equal(P.repairGstin('29AAUFK7236J12J'), '29AAUFK7236J1ZJ'); // Z read as 2
  assert.equal(P.repairGstin('20AAUFK7236J1ZJ'), '29AAUFK7236J1ZJ'); // 9 read as 0
  assert.equal(P.repairGstin('29AAUFK7236JIZJ'), '29AAUFK7236J1ZJ'); // 1 read as I
  assert.equal(P.repairGstin('29ABCDE1234F1Z5'), null);              // never invents a PAN
  assert.deepEqual(P.findGstins('GSTIN/UIN: 29AAUFK7236J12J  Bill to 29ACGFM 9082Q1Z5'), ['29AAUFK7236J1ZJ', '29ACGFM9082Q1Z5']);
});

test('merged SGST/Total cells, wrapped amount-in-words, CGST = SGST', () => {
  // INV-26-27/000029: the SGST cell and the grand total touch, and the words wrap.
  const layout = layoutFromPlainText([
    'Marqland Studios',
    'GSTIN: 29ACGFM9082Q1Z5',
    'Invoice#       : INV-26-27/000029',
    'Bill To',
    'GSTIN 29AABCW1354K4Z0',
    '#   Item          Amount        Taxable Amount   CGST        SGST                        Total',
    '1   Goodies       1,31,500.00   1,31,500.00      9%          9%                          1,55,170.00',
    '    Sub Total     3,11,500.00   ₹3,11,500.00     26,410.00   26,410.00 ₹3,64,320.00',
    'Balance Due                                                                              ₹3,64,320.00',
    'Total In Words',
    'Indian Rupee Three Lakh Sixty-Four Thousand Three Hundred',
    'Twenty Only',
  ].join('\n'));
  const r = parseInvoice(layout, 'invoice', ctx);
  assert.equal(r.total_amount, 364320);
  assert.equal(r.taxable_amount, 311500);
  assert.equal(r.cgst, 26410);
  assert.equal(r.sgst, 26410);
});

test('GSTIN repair uses the state named on the document and refuses ties', () => {
  assert.deepEqual(P.findGstins('GSTIN: 20ACGFM9082Q175  State Name : Karnataka, Code : 29'), ['29ACGFM9082Q1Z5']);
  assert.deepEqual(P.findGstins('GSTIN: 20AEUFS2458A1Z0  Bengaluru'), ['29AEUFS2458A1ZO']); // two misreads
});

test('Tally-style boxed header: labels above values', () => {
  const layout = layoutFromPlainText([
    'KASA ENTERPRISES.                      Invoice No.        Dated',
    'NO 119, 1ST FLOOR J P ARCADE           KASA/TOR/2026      25-Sep-26',
    'GSTIN/UIN: 29AAUFK7236J12J             Reference No. & Date.',
    'Buyer (Bill to)',
    'MARQLAND STUDIOS LLP',
    'OUTPUT CGST@9%                                              501.75',
    'OUTPUT SGST@9%                                              501.75',
    'Total                                                   ₹ 6,579.00',
    'Amount Chargeable (in words)',
    '₹ Six Thousand Five Hundred Seventy Nine Only',
  ].join('\n'));
  const r = parseInvoice(layout, 'invoice', ctx);
  assert.equal(r.vendor_name, 'KASA ENTERPRISES.');
  assert.equal(r.vendor_gst, '29AAUFK7236J1ZJ');
  assert.equal(r.invoice_number, 'KASA/TOR/2026');
  assert.equal(r.date, '2026-09-25');
  assert.equal(r.total_amount, 6579);
  assert.equal(r.cgst, 501.75);
  assert.equal(r.sgst, 501.75);
});

test('Zoho tax invoice PDF (inter-state, IGST column)', async () => {
  const r = await extractDocument(await zohoInvoicePdf(), 'application/pdf', 'invoice');
  assert.equal(r._meta.source, 'pdf-text');
  assert.equal(r.vendor_name, 'Marqland Studios');
  assert.equal(r.vendor_gst, '29ACGFM9082Q1Z5');
  assert.equal(r.invoice_number, 'INV-26-27/000016');
  assert.equal(r.date, '2026-08-21');
  assert.equal(r.total_amount, 35813);
  assert.equal(r.taxable_amount, 30350);
  assert.equal(r.igst, 5463);
  assert.equal(r.cgst, null);
  assert.equal(r.financialYear, '2026-27');
  assert.equal(r.month, 'August');
  assert.match(r.bank_details, /45188854942/);
});

test('Zoho quote PDF read as a PI (intra-state, CGST + SGST columns)', async () => {
  const r = await extractDocument(await zohoQuotePdf(), 'application/pdf', 'pi');
  assert.equal(r.invoice_number, 'QT-26-27/000053');
  assert.equal(r.date, '2026-09-23');
  assert.equal(r.total_amount, 27258);
  assert.equal(r.taxable_amount, 23100);
  assert.equal(r.cgst, 2079);
  assert.equal(r.sgst, 2079);
  assert.equal(r.igst, null);
  assert.equal(r.subject, 'Hydro Boil Mini order by Tejaswini');
});

test('vendor invoice billed to us: seller comes from the header, not Bill To', () => {
  const layout = layoutFromPlainText([
    'STERLING BOXES',
    'No 12, Industrial Area, Peenya, Bangalore 560058',
    'GSTIN: 29ABCDE1234F1Z5',
    'TAX INVOICE',
    'Invoice No: SB/1068          Dated: 12-Sep-2026',
    'Bill To:',
    'Marqland Studios LLP',
    'GSTIN: 29ACGFM9082Q1Z5',
    'Corrugated boxes 3 ply        500 pcs      20.00      10,000.00',
    'Taxable Value                                          10,000.00',
    'CGST @ 9%                                                 900.00',
    'SGST @ 9%                                                 900.00',
    'Grand Total                                         Rs. 11,800.00',
    'Amount in words: Rupees Eleven Thousand Eight Hundred Only',
  ].join('\n'));
  const r = parseInvoice(layout, 'invoice', ctx);
  assert.equal(r.vendor_name, 'STERLING BOXES');
  assert.equal(r.vendor_gst, '29ABCDE1234F1Z5');
  assert.equal(r.invoice_number, 'SB/1068');
  assert.equal(r.date, '2026-09-12');
  assert.equal(r.total_amount, 11800);
  assert.equal(r.taxable_amount, 10000);
  assert.equal(r.cgst, 900);
  assert.equal(r.sgst, 900);
});

test('net-banking payment screenshot (two-column OCR layout)', () => {
  // Mirrors Tesseract output for an HDFC "Payment Initiated" screen — note the
  // rupee sign misread as ¥, and label/value pairs split across two columns.
  const layout = layoutFromPlainText([
    'Payment Initiated for ¥8,024.00',
    'Copy & Share        Download',
    'To                                  From',
    'sterling boxes shankar              MARQLAND',
    'Current A/C » ***1 303              Current A/C « **30 46',
    'IDFC FIRST BANK LTD',
    'Amount                              Transfer Mode',
    '¥8,024.00                           NEFT',
    'Eight Thousand Twenty Four Rupees Only',
    'Transfer Date                       Reference ID',
    '26 Sept 2026                        HDFCH01284688508',
    'Note',
    'SBP 1068',
  ].join('\n'));
  const r = parsePayment(layout, ctx);
  assert.equal(r.amount, 8024);
  assert.equal(r.payment_date, '2026-09-26');
  assert.equal(r.payment_mode, 'neft');
  assert.equal(r.bank_ref, 'HDFCH01284688508');
  assert.equal(r.payee_name, 'sterling boxes shankar');
  assert.equal(r.remarks, 'SBP 1068');
});

test('UPI receipt', () => {
  const layout = layoutFromPlainText([
    'Paid to',
    'Shree Ganesh Traders',
    '₹ 2,450',
    'Completed',
    '15 Sep 2026, 4:12 pm',
    'UPI transaction ID',
    '426012345678',
    'Paid from HDFC Bank 4521',
  ].join('\n'));
  const r = parsePayment(layout, ctx);
  assert.equal(r.amount, 2450);
  assert.equal(r.payment_date, '2026-09-15');
  assert.equal(r.payment_mode, 'upi');
  assert.equal(r.bank_ref, '426012345678');
  assert.equal(r.payee_name, 'Shree Ganesh Traders');
});

test('rejects unsupported bytes regardless of declared mime', async () => {
  await assert.rejects(() => extractDocument(Buffer.from('hello world, not a document'), 'application/pdf'), /Unsupported file type/);
  await assert.rejects(() => extractDocument(Buffer.from('%PDF-1.7 truncated garbage'), 'application/pdf'), /could not be read/);
});
