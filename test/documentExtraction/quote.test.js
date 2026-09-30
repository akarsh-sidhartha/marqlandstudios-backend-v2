'use strict';
/**
 * Quote line-item extraction (services/documentExtraction/parsers/quoteParser.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { extractQuote } = require('../../services/documentExtraction');
const { parseQuote } = require('../../services/documentExtraction/parsers/quoteParser');
const { layoutFromPlainText } = require('../../services/documentExtraction/layout');
const { shutdown } = require('../../services/documentExtraction/ocrEngine');
const { zohoQuotePdf, zohoMultiItemQuotePdf, zohoInvoicePdf } = require('./fixtures');

test.after(() => shutdown());

test('multi-item Zoho quote: every row, product names from the description line', async () => {
  const q = await extractQuote(await zohoMultiItemQuotePdf());
  assert.equal(q.quoteNumber, 'QT-26-27/000099');
  assert.equal(q.quoteDate, '2026-09-07');
  assert.equal(q.subject, 'Goodies - Team Offsite');
  assert.equal(q.subTotal, 16810);
  assert.equal(q.total, 19836);
  assert.deepEqual(q.warnings, []);
  assert.deepEqual(q.items.map((i) => [i.lineNo, i.name, i.details, i.hsn, i.quantity, i.unit, i.rate, i.amount]), [
    [1, 'Stand Mixer Deluxe', 'Goodies', '8308', 1, 'pcs', 5278, 5278],
    [2, 'Travel Backpack 20L - Black', 'Goodies', '8308', 2, 'pcs', 4716, 9432],
    [3, 'Transportation Services', 'For all units of goodies shipments', '996511', 1, null, 2100, 2100],
  ]);
});

test('tightly set quote: merged header and value cells are split by column', async () => {
  const q = await extractQuote(await zohoQuotePdf());
  assert.equal(q.quoteNumber, 'QT-26-27/000053');
  assert.equal(q.items.length, 1);
  const [item] = q.items;
  assert.equal(item.name, 'Goodies Hydro Boil Mini with branding');
  assert.equal(item.quantity, 21);
  assert.equal(item.unit, 'pcs');
  assert.equal(item.rate, 1100);
  assert.equal(item.amount, 23100);
});

test('HSN printed under the item is lifted out of the description', async () => {
  const q = await extractQuote(await zohoInvoicePdf());
  assert.equal(q.items[0].name, 'WEIGHING SCALE');
  assert.equal(q.items[0].hsn, '84231000');
  assert.equal(q.items[0].quantity, 62);
});

test('no item table → empty items with a warning, never a throw', () => {
  const q = parseQuote(layoutFromPlainText('Quote# : QT-1/0001\nThank you for your business'));
  assert.deepEqual(q.items, []);
  assert.equal(q.warnings.length, 1);
});
