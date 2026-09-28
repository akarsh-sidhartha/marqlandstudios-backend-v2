'use strict';
/**
 * HTTP contract tests for /api/payment-tracker that need no database:
 * validation, upload type-sniffing, and the open-source /extract endpoint.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { router } = require('../../routes/paymentTrackerRoutes');
const errorHandler = require('../../middleware/errorHandler');
const { shutdown } = require('../../services/documentExtraction/ocrEngine');
const { zohoInvoicePdf } = require('../documentExtraction/fixtures');

let server;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'test-user', role: 'accounts' }; next(); });
  app.use('/api/payment-tracker', router);
  app.use(errorHandler);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/payment-tracker`;
});

test.after(async () => {
  server.close();
  await shutdown();
});

const form = (fields, file) => {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
  if (file) fd.append(file.field, new Blob([file.bytes], { type: file.type }), file.name);
  return fd;
};

test('POST /extract reads a PDF invoice with no paid API', async () => {
  const res = await fetch(`${base}/extract`, {
    method: 'POST',
    body: form({ docType: 'invoice' }, { field: 'file', bytes: await zohoInvoicePdf(), type: 'application/pdf', name: 'inv.pdf' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.invoice_number, 'INV-26-27/000016');
  assert.equal(body.total_amount, 35813);
  assert.equal(body._provider, 'open-source:pdf-text');
});

test('POST /extract rejects a file whose bytes are not a document', async () => {
  const res = await fetch(`${base}/extract`, {
    method: 'POST',
    body: form({ docType: 'invoice' }, { field: 'file', bytes: Buffer.from('<script>alert(1)</script>'.repeat(4)), type: 'image/png', name: 'x.png' }),
  });
  assert.equal(res.status, 422);
});

test('POST /extract requires a file and a known docType', async () => {
  let res = await fetch(`${base}/extract`, { method: 'POST', body: form({ docType: 'invoice' }) });
  assert.equal(res.status, 400);
  res = await fetch(`${base}/extract`, {
    method: 'POST',
    body: form({ docType: 'receipt' }, { field: 'file', bytes: await zohoInvoicePdf(), type: 'application/pdf', name: 'a.pdf' }),
  });
  assert.equal(res.status, 400);
});

test('POST /payments validates the mapping target before touching data', async () => {
  const res = await fetch(`${base}/payments`, {
    method: 'POST',
    body: form({ amount: '500', paymentDate: '2026-09-26', mappedTo: 'proforma_invoice' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.details.some((d) => d.field === 'proformaInvoice'));
});

test('POST /invoices rejects a malformed GSTIN and a non-positive total', async () => {
  const res = await fetch(`${base}/invoices`, {
    method: 'POST',
    body: form({ vendor_name: 'Acme', vendor_gst: 'NOT-A-GSTIN', invoice_number: 'A1', date: '2026-09-01', total_amount: '0' }),
  });
  assert.equal(res.status, 400);
  const fields = (await res.json()).details.map((d) => d.field);
  assert.ok(fields.includes('vendor_gst'));
  assert.ok(fields.includes('total_amount'));
});

test('ids are validated on every :id route', async () => {
  const res = await fetch(`${base}/pi/not-an-id`);
  assert.equal(res.status, 400);
});
