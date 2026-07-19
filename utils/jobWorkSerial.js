'use strict';
/**
 * utils/jobWorkSerial.js
 *
 * Generates the human-readable serial ID for a job-work row, e.g.
 * "JW/25-26/0001" — financial year (via services/msGraphService.getFinancialYear,
 * the same "24-25" short format already used for invoice/PI OneDrive paths)
 * plus a 4-digit atomic sequence scoped per financial year (models/Counter.js).
 *
 * This serial is also used as the OneDrive folder name suffix
 * ("job work folder JW-25-26-0001") — see services/jobWorkOneDriveService.js.
 */
const Counter = require('../models/Counter');
const { getFinancialYear } = require('../services/msGraphService');

const generateJobWorkSerialId = async () => {
  const fy = getFinancialYear(); // e.g. "25-26"
  const scope = `jobwork-${fy}`;
  const counter = await Counter.findOneAndUpdate(
    { scope },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  const seq = String(counter.seq).padStart(4, '0');
  return `JW/${fy}/${seq}`;
};

module.exports = { generateJobWorkSerialId };
