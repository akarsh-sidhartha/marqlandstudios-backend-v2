'use strict';
/**
 * backend/services/comboEngine.js
 *
 * Stateless price-matching for the Combo Creator. Reads Product only —
 * never writes anything, never touches a ClientPortal. Nothing here is
 * persisted; persistence happens in clientPortalRoutes.js's POST
 * /:slug/combos route when an admin explicitly publishes a candidate.
 *
 * Mode: "mixed" subset only (no "one per category" mode) — any combination
 * of 2+ products across the selected categories/sub-categories whose summed
 * selling price falls within getComboPriceBand(targetPrice)'s [lower, upper]
 * window, with one hard rule on top: a combo never contains two products
 * from the same sub-category (two hooded jackets from different brands, two
 * speakers, etc.) — see the subCatKey/usedSubCats handling in generateCombos.
 *
 * The tiered absolute tolerance band is mirrored in ClientPortalEditor.js so
 * the frontend can pre-validate without a round trip — keep the two in sync
 * if this changes.
 */

const Product = require('../models/Product');

const effectivePrice = (p) =>
  Math.round(p.purchasePrice * (1 + (p.markupPercent ?? 10) / 100));

// Empty/missing subCategory is treated as "no constraint" rather than as a
// shared bucket — several products with no subCategory set can still appear
// together in the same combo, since a blank value isn't a real category that
// should be deduplicated against.
const subCatKey = (p) => (p.subCategory && p.subCategory.trim()) ? p.subCategory.trim().toLowerCase() : null;

/**
 * getComboPriceBand
 * Tiered absolute tolerance around targetPrice:
 *   ≤  500  → ± 50
 *   ≤ 1000  → ± 100
 *   ≤ 5000  → ± 500
 *   > 5000  → ± 1000 (flat — does not keep scaling up)
 */
function getComboPriceBand(targetPrice) {
  const t = Number(targetPrice) || 0;
  let tolerance;
  if (t <= 500) tolerance = 50;
  else if (t <= 1000) tolerance = 100;
  else if (t <= 5000) tolerance = 500;
  else tolerance = 1000;

  return {
    tolerance,
    lower: Math.max(0, t - tolerance),
    upper: t + tolerance,
  };
}

/**
 * Pulls candidate products for each selected category, cheapest-first,
 * capped per category so the subset search below stays bounded.
 * subCategories (optional) further narrows the pool — when provided, only
 * products whose subCategory is in that list are considered at all.
 */
async function fetchCandidates(categories, subCategories, maxPerCategory = 10) {
  const query = { category: { $in: categories } };
  if (Array.isArray(subCategories) && subCategories.length > 0) {
    query.subCategory = { $in: subCategories };
  }
  const products = await Product.find(query).lean();
  const byCategory = categories.map((cat) =>
    products
      .filter((p) => p.category === cat)
      .map((p) => ({ ...p, price: effectivePrice(p) }))
      .sort((a, b) => a.price - b.price)
      .slice(0, maxPerCategory)
  );
  return byCategory.filter((list) => list.length > 0);
}

/**
 * generateCombos
 * Mixed-subset search: any 2..maxItems products (not constrained to one per
 * category) whose summed price lands within getComboPriceBand(targetPrice),
 * with at most one product per sub-category in any given combo. Subset-sum
 * is NP-hard in general, so this is bounded three ways:
 *   - maxPerCategory caps how many candidates per category enter the pool
 *   - maxItems caps how large a single combo can be
 *   - VISIT_CAP is a hard backstop regardless of how the above two interact
 */
async function generateCombos({
  categories,
  subCategories,
  targetPrice,
  maxItems = 5,
  maxResults = 12,
  maxPerCategory = 10,
}) {
  if (!Array.isArray(categories) || categories.length === 0) return [];
  if (!targetPrice || targetPrice <= 0) return [];

  const byCategory = await fetchCandidates(categories, subCategories, maxPerCategory);
  const pool = byCategory.flat();
  if (pool.length === 0) return [];

  const { lower, upper } = getComboPriceBand(targetPrice);

  const results = [];
  let visited = 0;
  const VISIT_CAP = 300_000; // hard safety valve regardless of input size

  function dfs(startIdx, chosen, sum, usedSubCats) {
    if (visited++ > VISIT_CAP) return;
    if (sum >= lower && sum <= upper && chosen.length >= 2) {
      results.push({
        products: [...chosen],
        total: sum,
        delta: Math.abs(sum - targetPrice),
      });
    }
    if (chosen.length >= maxItems || sum > upper) return;

    for (let i = startIdx; i < pool.length; i++) {
      const key = subCatKey(pool[i]);
      // Already have one item from this sub-category in the combo being
      // built — skip it rather than ever letting two through (two hooded
      // jackets, two speakers, etc., even from different brands/products).
      if (key && usedSubCats.has(key)) continue;
      const nextUsed = key ? new Set(usedSubCats).add(key) : usedSubCats;
      dfs(i + 1, [...chosen, pool[i]], sum + pool[i].price, nextUsed);
    }
  }

  dfs(0, [], 0, new Set());
  results.sort((a, b) => a.delta - b.delta);

  // De-dupe identical product sets across the result list itself
  // (the same subset can be reached via different DFS orderings).
  const seen = new Set();
  return results
    .filter((r) => {
      const sig = r.products.map((p) => p._id.toString()).sort().join('|');
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    })
    .slice(0, maxResults);
}

module.exports = { generateCombos, effectivePrice, fetchCandidates, getComboPriceBand };