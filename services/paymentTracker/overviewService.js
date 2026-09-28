'use strict';
/**
 * services/paymentTracker/overviewService.js
 *
 * Everything the Payment Tracker screen needs in ONE request — PIs, payments,
 * vault invoices (with their paid/outstanding already computed) and the
 * vendor picker list. Replaces four separate page-load calls, and makes
 * filter changes free: the screen filters locally instead of re-fetching.
 */
const { Invoice, ProformaInvoice, Payment } = require('../../models/paymentTrackerModel');
const vendors = require('./vendorDirectory');

// Safety cap per collection. The flag in the response tells the UI when the
// ledger has outgrown a single payload (time to move a tab to paging).
const CAP = Number(process.env.PAYMENT_TRACKER_OVERVIEW_CAP) || 5000;

const round2 = (n) => Math.round(n * 100) / 100;

const getOverview = async () => {
  const [pis, payments, invoices, vendorList] = await Promise.all([
    ProformaInvoice.find({})
      .populate('vendor', 'companyName gstNumber')
      .populate('finalInvoice', 'invoice_number total_amount date vendor_name')
      .sort({ createdAt: -1 }).limit(CAP).lean(),
    Payment.find({})
      .populate('vendor', 'companyName')
      .populate('proformaInvoice', 'piNumber totalAmount amountPaid amountDue status')
      .populate('vendorInvoice', 'invoice_number total_amount vendor_name')
      .sort({ paymentDate: -1 }).limit(CAP).lean(),
    Invoice.find({}).select('-image -items').sort({ createdAt: -1 }).limit(CAP).lean(),
    vendors.listForPicker(),
  ]);

  // An invoice's paid amount = every payment tagged with it (direct payments,
  // plus the payments of the PI it settles — tagged when the PI is linked).
  const paid = new Map();
  for (const p of payments) {
    const id = p.vendorInvoice?._id || p.vendorInvoice;
    if (id) paid.set(String(id), (paid.get(String(id)) || 0) + p.amount);
  }
  for (const inv of invoices) {
    inv.amountPaid = round2(paid.get(String(inv._id)) || 0);
    inv.amountDue = Math.max(0, round2((inv.total_amount || 0) - inv.amountPaid));
  }

  return {
    pis,
    payments,
    invoices,
    vendors: vendorList,
    financialYears: [...new Set(invoices.map((i) => i.financialYear).filter(Boolean))].sort().reverse(),
    truncated: { pis: pis.length >= CAP, payments: payments.length >= CAP, invoices: invoices.length >= CAP },
    generatedAt: new Date().toISOString(),
  };
};

module.exports = { getOverview };
