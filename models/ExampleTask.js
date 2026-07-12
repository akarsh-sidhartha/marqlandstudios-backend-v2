'use strict';
/**
 * models/ExampleTask.js
 * Backing model for the reference /api/examples/tasks endpoint — see
 * routes/exampleRoutes.js for the full request pipeline this demonstrates.
 */
const mongoose = require('mongoose');

const exampleTaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    status: { type: String, enum: ['pending', 'in_progress', 'done'], default: 'pending' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ExampleTask', exampleTaskSchema);
