"use strict";
/**
 * backend/services/comboService.js
 *
 * Core business logic for Dynamic Combo generation.
 *
 * Algorithm overview:
 *   1. Fetch products matching the requested categories / subCategories.
 *   2. Group by subCategory (each group must contribute exactly one product
 *      to any valid combo — subcategory exclusion rule).
 *   3. Shuffle each group so iteration starts from a different product each
 *      time, distributing coverage across the catalogue.
 *   4. Iterate the cartesian product of all groups.
 *   5. For each candidate combo, skip it if any product in it has already
 *      appeared in MAX_APPEARANCES combos (default 2). This ensures broad
 *      coverage — every product appears in at most 2 combos, so with 15
 *      products in a subcategory and maxResults=20 we'll see ~10 products.
 *   6. Check total selling price against budget tolerance band.
 *   7. Persist up to maxResults valid combos and return them.
 *
 * Budget tolerance tiers (spec):
 *   B ≤  500  →  ±10%
 *   B ≤ 1000  →  −10% to 0%  (max = B, so never exceeds budget)
 *   B ≤ 5000  →  ±500
 *   B > 5000  →  ±1000
 */

const Product = require("../models/Product");
const Combo = require("../models/Combo");

// ── Max times a single product may appear across all generated combos ─────────
const MAX_APPEARANCES = 2;

// ── Budget tolerance ──────────────────────────────────────────────────────────
function getBudgetRange(B) {
  if (B <= 500) return { min: B * 0.9, max: B * 1.1 };
  if (B <= 1000) return { min: B * 0.9, max: B };
  if (B <= 5000) return { min: B - 500, max: B + 500 };
  return { min: B - 1000, max: B + 1000 };
}

// ── Selling price ─────────────────────────────────────────────────────────────
function sellingPrice(product) {
  return product.purchasePrice * (1 + (product.markupPercent || 10) / 100);
}

// ── Fisher-Yates shuffle (in-place) ──────────────────────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Cartesian product (generator) ────────────────────────────────────────────
// Yields one array per combination, O(depth) stack space.
function* cartesian(arrays, index = 0, current = []) {
  if (index === arrays.length) {
    yield current.slice();
    return;
  }
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
 * Each product appears in at most MAX_APPEARANCES (2) combos so that
 * large subcategories contribute many different products rather than
 * repeating the same 1-2 products across all results.
 */
async function generateCombos({
  budget,
  categories,
  subCategories,
  maxResults = 20,
}) {
  if (!budget || budget <= 0)
    throw new Error("budget must be a positive number");

  const { min, max } = getBudgetRange(budget);

  // ── Step 1: Fetch eligible products ────────────────────────────────────────
  const query = { hiddenFromList: { $ne: true } };
  if (categories?.length) query.category = { $in: categories };
  if (subCategories?.length) query.subCategory = { $in: subCategories };

  const products = await Product.find(query).lean();
  if (!products.length) return [];

  // Pre-compute selling prices to avoid repeated arithmetic in the hot loop.
  const withPrice = products.map((p) => ({
    ...p,
    _id: String(p._id), // normalise to string for Map keys
    _sellingPrice: sellingPrice(p),
  }));

  // ── Step 2: Group by subCategory ───────────────────────────────────────────
  const grouped = new Map(); // subCat → product[]
  for (const p of withPrice) {
    const sc = p.subCategory || "__none__";
    if (!grouped.has(sc)) grouped.set(sc, []);
    grouped.get(sc).push(p);
  }

  const subCatKeys = Array.from(grouped.keys());
  const groups = Array.from(grouped.values());

  // ── Step 3: Pre-filter — drop products whose price alone exceeds max ────────
  // Also shuffle each group so we start iterating from random products,
  // preventing the same first product from dominating every combo.
  const prunedGroups = groups.map((g) =>
    shuffle(g.filter((p) => p._sellingPrice <= max)),
  );
  if (prunedGroups.some((g) => g.length === 0)) return [];

  // ── Step 4: Walk combinations with per-product appearance cap ───────────────
  // appearanceCount tracks how many already-accepted combos include each product.
  // If a candidate would push any product above MAX_APPEARANCES, skip it and
  // keep looking — this spreads selection across the full catalogue.
  const HARD_LIMIT = 500_000; // raised because we now skip many candidates
  const appearanceCount = new Map(); // productId → number of combos it's in
  let checked = 0;
  const validCombos = [];

  for (const combo of cartesian(prunedGroups)) {
    if (checked++ > HARD_LIMIT) break;

    // Reject if any product in this candidate has hit the appearance cap
    const hitCap = combo.some(
      (p) => (appearanceCount.get(p._id) || 0) >= MAX_APPEARANCES,
    );
    if (hitCap) continue;

    // Check budget
    const total = combo.reduce((s, p) => s + p._sellingPrice, 0);
    if (total < min || total > max) continue;

    // Accept — record appearances
    for (const p of combo) {
      appearanceCount.set(p._id, (appearanceCount.get(p._id) || 0) + 1);
    }
    validCombos.push({ combo, total });
    if (validCombos.length >= maxResults) break;
  }

  if (!validCombos.length) return [];

  // ── Step 5: Persist ─────────────────────────────────────────────────────────
  const docs = await Promise.all(
    validCombos.map(({ combo, total }) =>
      Combo.create({
        budget,
        totalPrice: Math.round(total),
        categories: [...new Set(combo.map((p) => p.category).filter(Boolean))],
        subCategories: subCatKeys,
        items: combo.map((p, i) => ({
          productId: p._id,
          name: p.name,
          description: p.description || "",
          imageUrl: p.imageUrl || "",
          additionalImages: p.additionalImages || [],
          videoUrl: p.videoUrl || "",
          price: Math.round(p._sellingPrice),
          category: p.category || "",
          subCategory: p.subCategory || "",
          order: i,
        })),
        hiddenFromList: true,
        isCombo: true,
      }),
    ),
  );

  return docs;
}

module.exports = { generateCombos, getBudgetRange };
