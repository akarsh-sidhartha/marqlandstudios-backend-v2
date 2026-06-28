'use strict';
/**
 * backend/services/comboService.js
 *
 * Core business logic for Dynamic Combo generation.
 *
 * Algorithm overview:
 *   1. Fetch products matching the requested categories / subCategories.
 *   2. Group by subCategory (each group must contribute exactly one product
 *      to any valid combo — this enforces the subcategory exclusion rule).
 *   3. Iterate the cartesian product of all groups.
 *   4. For each candidate combo, compute the total selling price and check
 *      whether it falls within the budget tolerance band.
 *   5. Persist up to maxResults valid combos and return them.
 *
 * Budget tolerance tiers (spec):
 *   B ≤  500  →  ±10%
 *   B ≤ 1000  →  −10% to 0%  (max = B, so never exceeds budget)
 *   B ≤ 5000  →  ±500
 *   B > 5000  →  ±1000
 */

const Product = require('../models/Product');
const Combo   = require('../models/Combo');

// ── Budget tolerance ──────────────────────────────────────────────────────────
function getBudgetRange(B) {
  if (B <= 500)  return { min: B * 0.9,  max: B * 1.1 };
  if (B <= 1000) return { min: B * 0.9,  max: B       };
  if (B <= 5000) return { min: B - 500,  max: B + 500 };
  return               { min: B - 1000, max: B + 1000 };
}

// ── Selling price ─────────────────────────────────────────────────────────────
// Mirrors the markup logic stored on each Product document.
function sellingPrice(product) {
  return product.purchasePrice * (1 + (product.markupPercent || 10) / 100);
}

// ── Cartesian product (generator) ────────────────────────────────────────────
// Yields one array per combination, consuming O(depth) stack space.
function* cartesian(arrays, index = 0, current = []) {
  if (index === arrays.length) { yield current.slice(); return; }
  for (const item of arrays[index]) {
    current.push(item);
    yield* cartesian(arrays, index + 1, current);
    current.pop();
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * generateCombos({ budget, categories?, subCategories?, maxResults? })
 *
 * Returns an array of saved Combo documents.
 */
async function generateCombos({ budget, categories, subCategories, maxResults = 20 }) {
  if (!budget || budget <= 0) throw new Error('budget must be a positive number');

  const { min, max } = getBudgetRange(budget);

  // ── Step 1: Fetch eligible products ────────────────────────────────────────
  const query = { hiddenFromList: { $ne: true } };
  if (categories?.length)    query.category    = { $in: categories };
  if (subCategories?.length) query.subCategory = { $in: subCategories };

  const products = await Product.find(query).lean();
  if (!products.length) return [];

  // Pre-compute selling prices to avoid repeated arithmetic in the hot loop.
  const withPrice = products.map(p => ({ ...p, _sellingPrice: sellingPrice(p) }));

  // ── Step 2: Group by subCategory ───────────────────────────────────────────
  const grouped = new Map();   // subCat → product[]
  for (const p of withPrice) {
    const sc = p.subCategory || '__none__';
    if (!grouped.has(sc)) grouped.set(sc, []);
    grouped.get(sc).push(p);
  }

  const groups      = Array.from(grouped.values());
  const subCatKeys  = Array.from(grouped.keys());

  // ── Step 3: Pre-filter: drop any product that alone already exceeds max ────
  // This prunes branches early and significantly cuts the search space for
  // large catalogs where individual items can be very expensive.
  const prunedGroups = groups.map(g => g.filter(p => p._sellingPrice <= max));
  if (prunedGroups.some(g => g.length === 0)) return []; // a required subCat has no valid products

  // ── Step 4: Walk combinations ───────────────────────────────────────────────
  const HARD_LIMIT = 100_000; // safety valve
  let checked = 0;
  const validCombos = [];

  for (const combo of cartesian(prunedGroups)) {
    if (checked++ > HARD_LIMIT) break;

    const total = combo.reduce((s, p) => s + p._sellingPrice, 0);
    if (total >= min && total <= max) {
      validCombos.push({ combo, total });
      if (validCombos.length >= maxResults) break;
    }
  }

  if (!validCombos.length) return [];

  // ── Step 5: Persist ─────────────────────────────────────────────────────────
  const docs = await Promise.all(validCombos.map(({ combo, total }) =>
    Combo.create({
      budget,
      totalPrice: Math.round(total),
      categories: [...new Set(combo.map(p => p.category).filter(Boolean))],
      subCategories: subCatKeys,
      items: combo.map((p, i) => ({
        productId:        p._id,
        name:             p.name,
        description:      p.description  || '',
        imageUrl:         p.imageUrl     || '',
        additionalImages: p.additionalImages || [],
        videoUrl:         p.videoUrl     || '',
        price:            Math.round(p._sellingPrice),
        category:         p.category     || '',
        subCategory:      p.subCategory  || '',
        order:            i,
      })),
      hiddenFromList: true,
      isCombo:        true,
    }),
  ));

  return docs;
}

module.exports = { generateCombos, getBudgetRange };