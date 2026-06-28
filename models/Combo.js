'use strict';
/**
 * backend/models/Combo.js
 *
 * Stores auto-generated product bundles ("combos").
 *
 * Key invariants enforced at generation time (see comboService.js):
 *   - items[] contains exactly one product per subCategory.
 *   - hiddenFromList: true  →  never returned by GET /api/products.
 *   - isCombo: true         →  filterable sentinel for admin queries.
 *
 * collageImageUrl is populated asynchronously by collageService.js after
 * the document is created; it may be empty until the job completes.
 */

const mongoose = require('mongoose');

const comboItemSchema = new mongoose.Schema(
  {
    productId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    name:             { type: String, required: true },
    description:      { type: String, default: '' },
    imageUrl:         { type: String, default: '' },
    additionalImages: { type: [String], default: [] },
    videoUrl:         { type: String, default: '' },
    price:            { type: Number, required: true },   // pre-computed selling price
    category:         { type: String, default: '' },
    subCategory:      { type: String, default: '' },
  },
  { _id: true },
);

const comboSchema = new mongoose.Schema(
  {
    label:           { type: String, default: '' },        // e.g. "₹1,000 Casual Bundle"
    budget:          { type: Number, required: true },     // target budget used for generation
    totalPrice:      { type: Number, required: true },     // actual sum of item selling prices

    categories:      { type: [String], default: [] },     // unique categories covered
    subCategories:   { type: [String], default: [] },     // one entry per subCat slot

    items:           [comboItemSchema],                    // ordered; one per subCategory

    // Hero collage image — stitched by collageService.js after creation.
    // Falls back to a 2×2 mosaic in the client portal if empty.
    collageImageUrl: { type: String, default: '' },

    // Visibility flags
    isCombo:         { type: Boolean, default: true, index: true },
    hiddenFromList:  { type: Boolean, default: true },    // excluded from /api/products

    createdBy:       { type: String, default: 'admin' },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Combo', comboSchema);