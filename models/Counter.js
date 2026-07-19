'use strict';
/**
 * models/Counter.js
 *
 * Generic atomic sequence counter, scoped by an arbitrary string key.
 * Used by utils/jobWorkSerial.js to mint "JW/25-26/0001"-style serial IDs —
 * one counter document per financial year (scope: "jobwork-25-26").
 *
 * Usage:
 *   const Counter = require('../models/Counter');
 *   const { seq } = await Counter.findOneAndUpdate(
 *     { scope }, { $inc: { seq: 1 } }, { upsert: true, new: true }
 *   );
 */
const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema({
  scope: { type: String, required: true, unique: true },
  seq:   { type: Number, default: 0 },
});

module.exports = mongoose.model('Counter', counterSchema);

