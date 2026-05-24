'use strict';
/**
 * backend/models/public-site/Testimonial.js
 * Client testimonials shown on www.marqland.com
 */

const mongoose = require('mongoose');

const testimonialSchema = new mongoose.Schema({
  author:   { type: String, required: true },
  company:  { type: String, default: '' },
  role:     { type: String, default: '' },
  text:     { type: String, required: true },   // the testimonial body
  imageUrl: { type: String, default: '' },       // person photo — /uploads/publicApp/testimonials/filename
  imageKey: { type: String, default: '' }, 
  order:    { type: Number, default: 0 },
}, {
  timestamps: true,
});

module.exports = mongoose.model('Testimonial', testimonialSchema);