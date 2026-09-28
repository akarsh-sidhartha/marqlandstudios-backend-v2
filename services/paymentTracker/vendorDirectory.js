'use strict';
/**
 * services/paymentTracker/vendorDirectory.js
 *
 * Vendor lookups used across invoices, PIs and payments. Replaces the old
 * `new RegExp(req.body.vendor_name, 'i')` calls, which let any user-supplied
 * name run as a regular expression (ReDoS / wildcard matching the wrong
 * vendor). Names are escaped and matched exactly first, loosely second.
 */
const Vendor = require('../../models/Vendor');
const logger = require('../../utils/logger').child({ module: 'paymentTracker.vendors' });

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Exact (case-insensitive) name match, then "starts with" as a fallback. */
const findByName = async (name, projection = '_id companyName gstNumber') => {
  const clean = String(name || '').trim();
  if (clean.length < 2) return null;
  const esc = escapeRegex(clean.slice(0, 120));
  return (await Vendor.findOne({ companyName: new RegExp(`^${esc}$`, 'i') }).select(projection).lean())
    || Vendor.findOne({ companyName: new RegExp(`^${esc}`, 'i') }).select(projection).lean();
};

/**
 * Remember a vendor's GSTIN the first time we see it on a document.
 * Never overwrites an existing GSTIN, and never fails the caller.
 */
const rememberGstin = async ({ vendorId, vendorName, gstin }) => {
  if (!gstin) return;
  try {
    const id = vendorId || (await findByName(vendorName))?._id;
    if (!id) return;
    await Vendor.updateOne(
      { _id: id, $or: [{ gstNumber: { $exists: false } }, { gstNumber: null }, { gstNumber: '' }] },
      { $set: { gstNumber: gstin } },
    );
  } catch (err) {
    logger.warn('Could not store vendor GSTIN', { error: err.message });
  }
};

const listForPicker = () =>
  Vendor.find({}).select('_id companyName gstNumber').sort({ companyName: 1 }).collation({ locale: 'en' }).lean();

module.exports = { findByName, rememberGstin, listForPicker, escapeRegex };
