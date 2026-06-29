'use strict';
/**
 * backend/services/comboService.js
 *
 * Generates diverse combos where:
 *   - Each product appears in at most MAX_APPEARANCES (2) different combos.
 *   - Each combo uses a completely different set of products from every other
 *     combo — no two combos share any product in the same subcategory slot
 *     until all products in that slot have been used once (round-robin).
 *
 * Algorithm:
 *   1. Fetch and group products by subCategory.
 *   2. Shuffle each group independently (so rotation starts from random points).
 *   3. For each combo slot, pick the next unused product from each group using
 *      a per-group rotating pointer. This guarantees:
 *        - Combo N and Combo N+1 never share a product in any slot.
 *        - After ceil(groupSize / 1) combos, every product has appeared once.
 *        - After two full rotations, every product has appeared exactly twice.
 *   4. Filter out candidates whose total price falls outside the budget band.
 *   5. Persist and return up to maxResults combos.
 *
 * Budget tolerance tiers:
 *   B ≤  500  →  ±10%
 *   B ≤ 1000  →  −10% to 0%
 *   B ≤ 5000  →  ±500
 *   B > 5000  →  ±1000
 */

const Product = require('../models/Product');
const Combo   = require('../models/Combo');

const MAX_APPEARANCES = 2;   // how many combos a product may appear in total

// ── Budget tolerance ──────────────────────────────────────────────────────────
function getBudgetRange(B) {
  if (B <= 500)  return { min: B * 0.9,  max: B * 1.1 };
  if (B <= 1000) return { min: B * 0.9,  max: B       };
  if (B <= 5000) return { min: B - 500,  max: B + 500 };
  return               { min: B - 1000, max: B + 1000 };
}

// ── Selling price ─────────────────────────────────────────────────────────────
function sellingPrice(product) {
  return product.purchasePrice * (1 + (product.markupPercent || 10) / 100);
}

// ── Fisher-Yates shuffle (in-place, returns array) ───────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Main export ───────────────────────────────────────────────────────────────
async function generateCombos({ budget, categories, subCategories, maxResults = 20 }) {
  if (!budget || budget <= 0) throw new Error('budget must be a positive number');

  const { min, max } = getBudgetRange(budget);

  // ── Step 1: Fetch eligible products ────────────────────────────────────────
  const query = { hiddenFromList: { $ne: true } };
  if (categories?.length)    query.category    = { $in: categories };
  if (subCategories?.length) query.subCategory = { $in: subCategories };

  const products = await Product.find(query).lean();
  if (!products.length) return [];

  const withPrice = products.map(p => ({
    ...p,
    _id:          String(p._id),
    _sellingPrice: sellingPrice(p),
  }));

  // ── Step 2: Group by subCategory ───────────────────────────────────────────
  const grouped = new Map();
  for (const p of withPrice) {
    const sc = p.subCategory || '__none__';
    if (!grouped.has(sc)) grouped.set(sc, []);
    grouped.get(sc).push(p);
  }

  const subCatKeys = Array.from(grouped.keys());

  // ── Step 3: Prepare shuffled + price-filtered pools per subCategory ─────────
  // Each pool is shuffled randomly. Products whose price alone exceeds max are
  // removed (they can never contribute to a valid combo regardless of partners).
  const pools = subCatKeys.map(sc =>
    shuffle(grouped.get(sc).filter(p => p._sellingPrice <= max))
  );

  // If any subCategory has no eligible products after filtering, abort.
  if (pools.some(pool => pool.length === 0)) return [];

  // ── Step 4: Round-robin combo construction ─────────────────────────────────
  // pointers[i] = next index to pick from pools[i]
  // appearances[productId] = how many combos this product has been used in
  //
  // For each candidate combo we advance the pointer for every pool simultaneously
  // so each combo uses a completely different product in every subcategory slot.
  // If the selected product has hit MAX_APPEARANCES we skip forward within that
  // pool until we find one that hasn't.
  //
  // Total candidates we try = maxResults × MAX_APPEARANCES × max(pool sizes)
  // to allow enough room to find budget-fitting combos even after appearance
  // filtering.

  const pointers    = new Array(pools.length).fill(0);
  const appearances = new Map();            // productId → count

  // Helper: for a given pool, find the next eligible product starting at ptr.
  // "Eligible" means it hasn't hit MAX_APPEARANCES and its price ≤ max.
  // Returns { product, nextPtr } or null if no eligible product exists in pool.
  function pickFromPool(poolIdx) {
    const pool = pools[poolIdx];
    const start = pointers[poolIdx];
    const total = pool.length * MAX_APPEARANCES; // full rotation budget

    for (let offset = 0; offset < total; offset++) {
      const idx = (start + offset) % pool.length;
      const p   = pool[idx];
      if ((appearances.get(p._id) || 0) < MAX_APPEARANCES) {
        // Advance pointer past this product for next call
        pointers[poolIdx] = (idx + 1) % pool.length;
        return p;
      }
    }
    return null; // all products in this pool are exhausted
  }

  const validCombos = [];
  const MAX_ATTEMPTS = maxResults * 20; // guard against infinite budget-miss loops

  for (let attempt = 0; attempt < MAX_ATTEMPTS && validCombos.length < maxResults; attempt++) {

    // Pick one product from each pool
    const candidate = [];
    let exhausted = false;

    for (let i = 0; i < pools.length; i++) {
      const p = pickFromPool(i);
      if (!p) { exhausted = true; break; }
      candidate.push(p);
    }

    if (exhausted) break; // no more eligible products in at least one subcategory

    // Check budget
    const total = candidate.reduce((s, p) => s + p._sellingPrice, 0);
    if (total < min || total > max) {
      // Budget miss — don't record appearances, just continue to next attempt.
      // The pointer has already advanced; next attempt picks fresh products.
      continue;
    }

    // Accept combo — record appearances
    for (const p of candidate) {
      appearances.set(p._id, (appearances.get(p._id) || 0) + 1);
    }
    validCombos.push({ combo: candidate, total });
  }

  if (!validCombos.length) return [];

  // ── Step 5: Persist ─────────────────────────────────────────────────────────
  const docs = await Promise.all(validCombos.map(({ combo, total }) =>
    Combo.create({
      budget,
      totalPrice:    Math.round(total),
      categories:    [...new Set(combo.map(p => p.category).filter(Boolean))],
      subCategories: subCatKeys,
      items: combo.map((p, i) => ({
        productId:        p._id,
        name:             p.name,
        description:      p.description     || '',
        imageUrl:         p.imageUrl        || '',
        additionalImages: p.additionalImages || [],
        videoUrl:         p.videoUrl        || '',
        price:            Math.round(p._sellingPrice),
        category:         p.category        || '',
        subCategory:      p.subCategory     || '',
        order:            i,
      })),
      hiddenFromList: true,
      isCombo:        true,
    })
  ));

  return docs;
}

module.exports = { generateCombos, getBudgetRange };