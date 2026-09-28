'use strict';
/**
 * paymentService money paths with the Mongoose models stubbed out:
 * PI balance moves atomically, failures are compensated, overpayments are
 * refused with the real outstanding balance, deletes reverse the balance.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { Invoice, ProformaInvoice, Payment } = require('../../models/paymentTrackerModel');
const Counter = require('../../models/Counter');
const paymentService = require('../../services/paymentTracker/paymentService');

/** Chainable stand-in for a Mongoose query that resolves to `value`. */
const q = (value) => {
  const chain = { select: () => chain, lean: () => chain, populate: () => chain, sort: () => chain, then: (res, rej) => Promise.resolve(value).then(res, rej) };
  return chain;
};

const PI = { _id: 'pi1', piNumber: 'PI-1', vendor: 'v1', finalInvoice: 'inv9', status: 'partial', totalAmount: 1000, amountPaid: 400 };
const originals = {};
const stub = (obj, key, fn) => { originals[`${obj.modelName}.${key}`] = [obj, key, obj[key]]; obj[key] = fn; };

let applied;
test.beforeEach(() => {
  applied = [];
  stub(Counter, 'updateOne', async () => ({}));
  stub(Counter, 'findOneAndUpdate', async () => ({ seq: 42 }));
  stub(Payment, 'findOne', () => q(null));
  stub(ProformaInvoice, 'findById', () => q(PI));
  stub(ProformaInvoice, 'applyPayment', async (id, delta, opts) => { applied.push([id, delta, !!opts?.guard]); return PI.amountPaid + delta <= PI.totalAmount + 1 ? { ...PI } : null; });
  stub(Payment, 'findById', () => q({ _id: 'pay1', paymentRef: 'PAY-00042' }));
});
test.afterEach(() => { Object.values(originals).forEach(([obj, key, fn]) => { obj[key] = fn; }); });

const input = (over = {}) => ({ amount: 600, paymentDate: new Date('2026-09-26'), paymentMode: 'neft', mappedTo: 'proforma_invoice', proformaInvoice: 'pi1', ...over });

test('payment against a PI moves the balance atomically and tags the linked invoice', async () => {
  let saved;
  stub(Payment, 'create', async (doc) => { saved = doc; return { _id: 'pay1' }; });
  await paymentService.create(input(), null, { id: 'u1' });
  assert.deepEqual(applied, [['pi1', 600, true]]);
  assert.equal(saved.paymentRef, 'PAY-00042');
  assert.equal(saved.vendorInvoice, 'inv9');
  assert.equal(saved.vendor, 'v1');
});

test('a failed save gives the money back to the PI', async () => {
  stub(Payment, 'create', async () => { throw new Error('db down'); });
  await assert.rejects(() => paymentService.create(input(), null, {}), /db down/);
  assert.deepEqual(applied, [['pi1', 600, true], ['pi1', -600, false]]);
});

test('overpaying a PI is refused with the real outstanding balance', async () => {
  stub(Payment, 'create', async () => assert.fail('must not save'));
  await assert.rejects(() => paymentService.create(input({ amount: 700 }), null, {}), (err) => {
    assert.equal(err.statusCode, 422);
    assert.match(err.message, /₹600/);
    return true;
  });
});

test('payment against an unlinked invoice is capped at the invoice balance', async () => {
  stub(Invoice, 'findById', () => q({ _id: 'inv1', invoice_number: 'A-1', vendor_name: 'Acme', total_amount: 1000 }));
  stub(ProformaInvoice, 'findOne', () => q(null));
  stub(Payment, 'aggregate', async () => [{ paid: 900 }]);
  await assert.rejects(() => paymentService.create(input({ mappedTo: 'vendor_invoice', vendorInvoice: 'inv1', amount: 200 }), null, {}), /₹100/);
  assert.deepEqual(applied, []);
});

test('deleting a PI payment reverses the PI balance', async () => {
  stub(Payment, 'findById', () => q({ _id: 'pay1', proformaInvoice: 'pi1', amount: 250, paymentRef: 'PAY-1' }));
  stub(Payment, 'deleteOne', async () => ({}));
  await paymentService.remove('pay1', {});
  assert.deepEqual(applied, [['pi1', -250, false]]);
});

test('only advances can be re-mapped', async () => {
  stub(Payment, 'findById', () => ({ ...q(null), then: (r) => Promise.resolve({ mappedTo: 'proforma_invoice' }).then(r) }));
  await assert.rejects(() => paymentService.remap('pay1', { mappedTo: 'proforma_invoice', proformaInvoice: 'pi1' }, {}), /Only advances/);
});
