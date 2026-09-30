'use strict';
/**
 * HTTP contract tests for /api/v2/orders that need no database: routing,
 * validation, upload type-sniffing, quote parsing and the role guard.
 * Every request here is rejected (or answered) before any model is touched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const v2Routes = require('../../routes/v2');
const errorHandler = require('../../middleware/errorHandler');
const { routeGuard } = require('../../middleware/authMiddleware');
const { shutdown } = require('../../services/documentExtraction/ocrEngine');
const { safeName, folderNameFor } = require('../../services/orders/orderStorage');
const { zohoMultiItemQuotePdf } = require('../documentExtraction/fixtures');

const ID = '0123456789abcdef01234567';
let server;
let base;

const token = (role) => jwt.sign({ id: `u-${role}`, role }, process.env.JWT_SECRET);
const auth = (role = 'sales') => ({ Authorization: `Bearer ${token(role)}` });

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', routeGuard);
  app.use('/api/v2', v2Routes);
  app.use(errorHandler);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/v2/orders`;
});

test.after(async () => {
  server.close();
  await shutdown();
});

const form = (files = [], fields = {}) => {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
  files.forEach((f) => fd.append(f.field, new Blob([f.bytes], { type: f.type }), f.name));
  return fd;
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

test('meta lists the procurement stages in order', async () => {
  const res = await fetch(`${base}/meta`, { headers: auth() });
  assert.equal(res.status, 200);
  const { success, data } = await res.json();
  assert.equal(success, true);
  assert.equal(data.procurementStatuses[0].value, 'pending');
  assert.ok(data.procurementStatuses.some((s) => s.value === 'in_branding'));
});

test('roles outside sales/accounts/admin are refused; no token is 401', async () => {
  assert.equal((await fetch(`${base}/meta`, { headers: auth('supplier') })).status, 403);
  assert.equal((await fetch(`${base}/meta`)).status, 401);
});

test('quote parse returns the line items without storing anything', async () => {
  const res = await fetch(`${base}/${ID}/quote/parse`, {
    method: 'POST', headers: auth(),
    body: form([{ field: 'quote', bytes: await zohoMultiItemQuotePdf(), type: 'application/pdf', name: 'q.pdf' }]),
  });
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.quoteNumber, 'QT-26-27/000099');
  assert.deepEqual(data.items.map((i) => i.name), ['Stand Mixer Deluxe', 'Travel Backpack 20L - Black', 'Transportation Services']);
});

test('quote parse rejects a file whose bytes are not a PDF/image', async () => {
  const res = await fetch(`${base}/${ID}/quote/parse`, {
    method: 'POST', headers: auth(),
    body: form([{ field: 'quote', bytes: Buffer.from('<html><script>x</script></html>'.repeat(3)), type: 'application/pdf', name: 'q.pdf' }]),
  });
  assert.equal(res.status, 422);
});

test('screenshots must really be images', async () => {
  const bad = await fetch(`${base}/${ID}/files?category=screenshot`, {
    method: 'POST', headers: auth(),
    body: form([{ field: 'files', bytes: await zohoMultiItemQuotePdf(), type: 'image/png', name: 'image.png' }]),
  });
  assert.equal(bad.status, 422);
  const body = await bad.json();
  assert.equal(body.success, false);
  assert.match(body.error.message, /not an image/);
});

test('file uploads need at least one file and a known category', async () => {
  const none = await fetch(`${base}/${ID}/files?category=screenshot`, { method: 'POST', headers: auth(), body: form([], { x: '1' }) });
  assert.equal(none.status, 400);
  const badCat = await fetch(`${base}/${ID}/files?category=invoice`, {
    method: 'POST', headers: auth(), body: form([{ field: 'files', bytes: PNG, type: 'image/png', name: 'a.png' }]),
  });
  assert.equal(badCat.status, 400);
});

test('start project requires a quote number', async () => {
  const res = await fetch(`${base}/${ID}/start`, { method: 'POST', headers: auth(), body: form([], { items: '[]' }) });
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.ok(error.details.some((d) => d.field === 'quoteNumber'));
});

test('start project rejects malformed line items', async () => {
  const res = await fetch(`${base}/${ID}/start`, {
    method: 'POST', headers: auth(),
    body: form([], { quoteNumber: 'QT-26-27/0001', items: JSON.stringify([{ name: '', quantity: -1 }]) }),
  });
  assert.equal(res.status, 400);
});

test('generic update cannot change status or reference numbers (mass assignment)', async () => {
  const res = await fetch(`${base}/${ID}`, {
    method: 'PATCH', headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x', status: 'completed', refNumber: 'INQ-1' }),
  });
  assert.equal(res.status, 400);
});

test('procurement item updates only accept known stages', async () => {
  const res = await fetch(`${base}/${ID}/items/${ID}`, {
    method: 'PATCH', headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'teleported' }),
  });
  assert.equal(res.status, 400);
});

test('vendor pickers only accept a vendor id (name is resolved server-side) or null', async () => {
  const patch = (body) => fetch(`${base}/${ID}/items/${ID}`, {
    method: 'PATCH', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await patch({ productSupplier: { vendorId: 'nope' } })).status, 400);
  assert.equal((await patch({ brandingPartner: { vendorId: ID, name: 'Spoofed Ltd' } })).status, 400);
  assert.equal((await patch({ productSupplier: 'Acme' })).status, 400);
});

test('vendor-options is open to order roles only', async () => {
  assert.equal((await fetch(`${base}/vendor-options`, { headers: auth('supplier') })).status, 403);
  assert.equal((await fetch(`${base}/vendor-options`)).status, 401);
});

test('invalid ids are rejected before any lookup', async () => {
  assert.equal((await fetch(`${base}/not-an-id`, { headers: auth() })).status, 400);
  assert.equal((await fetch(`${base}/${ID}/files/..%2F..%2Fsecret/content`, { headers: auth() })).status, 400);
});

test('OneDrive names are made safe and follow the current identifier', () => {
  assert.equal(safeName('a/b\\c:d*?.png'), 'a-b-c-d--.png');
  assert.equal(folderNameFor({ refNumber: 'INQ-26-27-001' }), 'INQ-26-27-001');
  assert.equal(folderNameFor({ refNumber: 'INQ-26-27-001', quoteNumber: 'QT-26-27/000031' }), 'QT-26-27-000031');
  assert.equal(folderNameFor({ refNumber: 'INQ-1', quoteNumber: 'QT-1', invoiceNumber: 'INV-26-27/9' }), 'INV-26-27-9');
});
