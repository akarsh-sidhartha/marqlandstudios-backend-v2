'use strict';
/**
 * backend/services/trendingProductService.js
 *
 * STORAGE CHANGE FROM ORIGINAL:
 * ─────────────────────────────────────────────────────────────────────────────
 * downloadImage() — was: sharp → fs.writeFileSync → return local /uploads/ path
 *                   now: sharp → uploadBuffer to R2 → return R2 https:// URL
 *
 * R2 path: website/internalApp/trending/{filename}.jpg
 *
 * Two references updated as a result:
 *   - SAVE_DIR mkdir removed (no local dir needed)
 *   - TrendingProduct.imageUrl now stores full R2 URL instead of local path
 *
 * Everything else — SerpApi search, supplier extraction, Gemini analysis,
 * runDiscovery loop, searchByImage, cron scheduler — is UNCHANGED.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const axios        = require('axios');
const sharp        = require('sharp');
const logger       = require('../utils/logger').child({ module: 'trendingProductService' });
const path         = require('path');
const cron         = require('node-cron');
const TrendingProduct = require('../models/TrendingProduct');
const { uploadBuffer } = require('./r2Service'); // ← NEW

// ── Industry search queries (UNCHANGED) ───────────────────────────────────────
const INDUSTRY_QUERIES = {
  'IT': [
    'trending corporate gifts IT professionals India 2025',
    'tech gadget corporate gifts software companies India bulk order',
    'best corporate gifts IT sector trending Pinterest 2025',
    'premium desk accessories gifting technology companies',
  ],
  'Pharma': [
    'corporate gifting pharmaceutical companies India 2025',
    'wellness gifts pharma sales team doctors India supplier',
    'trending corporate gifts pharma healthcare Pinterest',
    'premium gifts pharmaceutical industry bulk India',
  ],
  'Cement': [
    'corporate gifts cement construction companies India',
    'branded merchandise infrastructure companies India bulk',
    'trending gifts construction real estate sector India',
    'premium corporate gifts cement industry suppliers India',
  ],
  'Paints': [
    'corporate gifting paint coating companies India 2025',
    'branded gifts home improvement industry India supplier',
    'trending corporate merchandise paints sector India',
    'premium gifts decorative paints companies India bulk',
  ],
  'FMCG': [
    'corporate gifting FMCG companies India 2025 trending',
    'branded gifts fast moving consumer goods India bulk',
    'trending corporate gifts retail FMCG sector India',
    'premium merchandise FMCG companies India supplier',
  ],
  'Finance': [
    'corporate gifts banking finance companies India 2025',
    'luxury gifts financial services insurance India bulk',
    'trending corporate gifts banking professionals India',
    'premium branded merchandise finance sector India',
  ],
  'Manufacturing': [
    'corporate gifts manufacturing companies India 2025',
    'branded merchandise industrial sector India bulk order',
    'trending gifts factory plant managers India supplier',
    'premium corporate gifting manufacturing India',
  ],
  'Healthcare': [
    'corporate gifts hospital healthcare companies India 2025',
    'wellness gifting medical professionals India bulk',
    'trending corporate gifts healthcare sector India',
    'premium gifts hospital doctors nurses India supplier',
  ],
  'Education': [
    'corporate gifting educational institutions India 2025',
    'branded merchandise schools colleges universities India',
    'trending gifts education sector teachers India bulk',
    'premium corporate gifts education companies India',
  ],
  'Real Estate': [
    'corporate gifts real estate builders developers India 2025',
    'luxury branded gifts property companies India bulk',
    'trending gifting real estate construction India',
    'premium corporate merchandise builders India supplier',
  ],
};

// ── Source engines (UNCHANGED) ────────────────────────────────────────────────
const SEARCH_SOURCES = [
  { id: 'google_images_in',     engine: 'google_images',    label: 'Google Images (India)',    params: { gl: 'in', hl: 'en' } },
  { id: 'google_images_global', engine: 'google_images',    label: 'Google Images (Global)',   params: { gl: 'us', hl: 'en' } },
  { id: 'pinterest',            engine: 'pinterest',         label: 'Pinterest',                params: {} },
  { id: 'google_shopping_in',   engine: 'google_shopping',  label: 'Google Shopping (India)',  params: { gl: 'in', hl: 'en' } },
];

// ── Helpers (UNCHANGED) ───────────────────────────────────────────────────────
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const domain = url => { try { return new URL(url).hostname.replace('www.', ''); } catch { return ''; } };

/**
 * Download an image URL, normalise via sharp, upload to R2.
 *
 * CHANGED:
 *   BEFORE: sharp → fs.writeFileSync(SAVE_DIR) → return '/uploads/internalApp/trending/...'
 *   AFTER:  sharp → uploadBuffer(R2)            → return 'https://<R2_PUBLIC_URL>/website/internalApp/trending/...'
 *
 * @returns {Promise<string|null>} R2 https:// URL, or null on failure
 */
async function downloadImage(imageUrl, filename) {
  try {
    const res = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout:      12000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarqlandBot/1.0)' },
      maxContentLength: 8 * 1024 * 1024,
    });

    const contentType = res.headers['content-type'] || '';
    if (!contentType.startsWith('image/')) {
      logger.warn('Image download — not an image', { contentType, url: imageUrl.slice(0, 60) });
      return null;
    }

    // Normalise to JPEG via sharp — handles webp, png, avif, heic, etc.
    const jpegBuffer = await sharp(Buffer.from(res.data))
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Upload to R2 — path: website/internalApp/trending/{filename}
    const r2Key = `website/internalApp/trending/${filename}`;
    const { url } = await uploadBuffer(jpegBuffer, 'website/internalApp/trending', '.jpg', 'image/jpeg', r2Key);

    return url; // full R2 https:// URL
  } catch (err) {
    logger.warn('Image download/upload failed', { error: err.message.slice(0, 80), url: imageUrl.slice(0, 60) });
    return null;
  }
}

// ── SerpApi search (UNCHANGED) ────────────────────────────────────────────────
async function searchSerpApi(query, engine = 'google_images', extraParams = {}, num = 10) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) { logger.warn('SERPAPI_KEY not set — skipping search'); return []; }

  try {
    const params = { api_key: apiKey, engine, q: query, safe: 'active', ...extraParams };
    if (engine === 'google_images')   params.ijn  = 0;
    if (engine === 'google_shopping') params.num  = Math.min(num, 20);
    if (engine === 'pinterest')       params.page = 1;

    const res = await axios.get('https://serpapi.com/search', { params, timeout: 20000 });

    if (engine === 'google_images') {
      return (res.data.images_results || []).slice(0, num).map(item => ({
        title:        item.title    || '',
        snippet:      item.source   || '',
        link:         item.link     || item.original || '',
        imageUrl:     item.original || item.thumbnail || '',
        displayLink:  item.source   || domain(item.link || ''),
        sourceEngine: 'google_images',
      }));
    }
    if (engine === 'pinterest') {
      return (res.data.pins_results || []).slice(0, num).map(item => ({
        title:        item.title       || item.description?.slice(0, 100) || '',
        snippet:      item.description || '',
        link:         item.link        || `https://pinterest.com/pin/${item.id}` || '',
        imageUrl:     item.image_url   || item.images?.orig?.url || '',
        displayLink:  'pinterest.com',
        sourceEngine: 'pinterest',
      }));
    }
    if (engine === 'google_shopping') {
      return (res.data.shopping_results || []).slice(0, num).map(item => ({
        title:        item.title    || '',
        snippet:      item.source   || '',
        link:         item.link     || item.product_link || '',
        imageUrl:     item.thumbnail || '',
        displayLink:  item.source   || domain(item.link || ''),
        sourceEngine: 'google_shopping',
      }));
    }
    return [];
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.error || err.message;
    if (status === 429) logger.warn('SerpApi quota exceeded', { engine });
    else logger.warn('SerpApi error', { engine, status, error: String(msg).slice(0, 100) });
    return [];
  }
}

// Kept for backward compat — used by searchByImage (UNCHANGED)
async function searchGoogle(query, num = 10) {
  return searchSerpApi(query, 'google_images', { gl: 'in', hl: 'en' }, num);
}

// ── Supplier info extraction (UNCHANGED) ──────────────────────────────────────
async function extractSupplierInfo(pageUrl, displayLink) {
  const supplier = { name: '', website: displayLink || '', email: '', phone: '', country: '' };

  const knownDirs = {
    'indiamart.com':      'IndiaMart Supplier',
    'alibaba.com':        'Alibaba Supplier',
    'amazon.in':          'Amazon India Seller',
    'amazon.com':         'Amazon Seller',
    'flipkart.com':       'Flipkart Seller',
    'tradeindia.com':     'TradeIndia Supplier',
    'exportersindia.com': 'ExportersIndia Supplier',
    'justdial.com':       'JustDial Listing',
  };

  for (const [d, label] of Object.entries(knownDirs)) {
    if (displayLink?.includes(d)) { supplier.name = label; supplier.country = d.endsWith('.in') ? 'India' : ''; break; }
  }

  const safeDomains = ['indiamart.com', 'tradeindia.com', 'exportersindia.com'];
  if (safeDomains.some(d => displayLink?.includes(d))) {
    try {
      const res  = await axios.get(pageUrl, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarqlandBot/1.0)' }, maxContentLength: 500 * 1024 });
      const html = res.data || '';
      const emailMatch = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (emailMatch) supplier.email = emailMatch[0];
      const phoneMatch = html.match(/(\+91[\s-]?)?[6-9]\d{9}/);
      if (phoneMatch) supplier.phone = phoneMatch[0];
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch && !supplier.name) supplier.name = titleMatch[1].split(/[-|]/)[0].trim().slice(0, 80);
    } catch { /* silent — best-effort */ }
  }

  return supplier;
}

// ── Core discovery function (UNCHANGED — downloadImage now returns R2 URL) ────
async function runDiscovery(industries = Object.keys(INDUSTRY_QUERIES), onProgress) {
  const runDate = new Date();
  const results = { started: runDate, industries: {}, totalSaved: 0, totalSkipped: 0, errors: [] };

  logger.info('Trending product discovery started', { industries: industries.length });

  const dayOfYear    = Math.floor((runDate - new Date(runDate.getFullYear(), 0, 0)) / 86400000);
  const primarySrc   = SEARCH_SOURCES[dayOfYear % SEARCH_SOURCES.length];
  const secondarySrc = SEARCH_SOURCES[0];

  for (const industry of industries) {
    const queries       = INDUSTRY_QUERIES[industry] || [];
    const industryResult = { saved: 0, skipped: 0, queries: queries.length };
    results.industries[industry] = industryResult;
    const query = queries[dayOfYear % queries.length];

    logger.debug('Discovery industry sources', { industry, primary: primarySrc.label, secondary: secondarySrc.label });
    logger.debug('Discovery query', { industry, query });

    const [primaryResults, secondaryResults] = await Promise.all([
      searchSerpApi(query, primarySrc.engine, primarySrc.params, 8),
      primarySrc.id !== secondarySrc.id
        ? searchSerpApi(query, secondarySrc.engine, secondarySrc.params, 8)
        : Promise.resolve([]),
    ]);

    const seen = new Set();
    const searchResults = [...primaryResults, ...secondaryResults].filter(r => {
      const key = r.imageUrl || r.link;
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    });

    logger.debug('Discovery results fetched', { industry, primary: primaryResults.length, secondary: secondaryResults.length, unique: searchResults.length });
    onProgress?.({ industry, done: 0, total: searchResults.length, saved: 0 });

    for (let i = 0; i < searchResults.length; i++) {
      const result = searchResults[i];
      try {
        const exists = await TrendingProduct.findOne({ sourceUrl: result.link });
        if (exists) { industryResult.skipped++; results.totalSkipped++; continue; }

        const imgFilename = `trending_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`;
        const r2ImgUrl    = await downloadImage(result.imageUrl, imgFilename); // now returns R2 URL

        let supplier = { name: '', website: result.displayLink, email: '', phone: '', country: '' };
        try { supplier = await extractSupplierInfo(result.link, result.displayLink); } catch {}

        await TrendingProduct.findOneAndUpdate(
          { sourceUrl: result.link },
          {
            $set: {
              name:         result.title.slice(0, 200),
              description:  result.snippet.slice(0, 500),
              industry,
              imageUrl:     r2ImgUrl || '',   // R2 https:// URL (was local /uploads/ path)
              imageSrcUrl:  result.imageUrl,
              sourceUrl:    result.link,
              sourceDomain: result.displayLink || domain(result.link),
              sourceEngine: result.sourceEngine || primarySrc.id,
              supplier,
              searchQuery:  query,
              runDate,
            },
            $setOnInsert: { status: 'new' },
          },
          { upsert: true, new: true }
        );

        industryResult.saved++;
        results.totalSaved++;
        logger.debug('Trending product saved', { industry, engine: result.sourceEngine, title: result.title.slice(0, 55) });

      } catch (err) {
        logger.warn('Trending product item failed', { industry, item: i + 1, error: err.message.slice(0, 80) });
        results.errors.push({ industry, item: i, error: err.message });
      }

      onProgress?.({ industry, done: i + 1, total: searchResults.length, saved: industryResult.saved });
      await sleep(1000);
    }

    await sleep(2000);
  }

  results.finished   = new Date();
  results.durationMs = results.finished - results.started;
  logger.info('Trending product discovery complete', { totalSaved: results.totalSaved, totalSkipped: results.totalSkipped, durationSeconds: Math.round(results.durationMs / 1000) });
  return results;
}

// ── Daily cron (UNCHANGED) ────────────────────────────────────────────────────
let cronJob = null;

function startScheduler() {
  if (cronJob) return;
  cronJob = cron.schedule('0 2 * * *', async () => {
    logger.info('Trending product daily cron triggered');
    try { await runDiscovery(); }
    catch (err) { logger.error('Trending product cron run failed', { error: err.message, stack: err.stack }); }
  }, { timezone: 'Asia/Kolkata' });
  logger.info('Trending product daily scheduler started', { schedule: '02:00 IST' });
}

function stopScheduler() { cronJob?.stop(); cronJob = null; }

// ── Gemini image analysis (UNCHANGED) ────────────────────────────────────────
async function analyseImageWithGemini(imageBuffer) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  let processedBuffer;
  try {
    processedBuffer = await sharp(imageBuffer)
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    logger.debug('Image resized for Gemini analysis', { sizeKB: Math.round(processedBuffer.length / 1024) });
  } catch (sharpErr) {
    logger.warn('Sharp resize failed — using original buffer', { error: sharpErr.message });
    processedBuffer = imageBuffer;
  }

  const base64 = processedBuffer.toString('base64');
  const prompt = `You are a corporate gifting product specialist.

Analyse the product shown in this image and respond with ONLY valid JSON — no markdown, no explanation, nothing else.

{
  "productName": "concise product name (e.g. 'Stainless Steel Insulated Tumbler')",
  "description": "1-2 sentence description of the product",
  "industry": "best matching industry from: IT, Pharma, Cement, Paints, FMCG, Finance, Manufacturing, Healthcare, Education, Real Estate, General",
  "queries": [
    "search query 1 — exact product name for corporate gifting",
    "search query 2 — similar products or alternatives",
    "search query 3 — supplier / wholesale angle",
    "search query 4 — branded version of this product",
    "search query 5 — trending gifting angle"
  ]
}

Make queries specific and actionable for finding real product listings and suppliers online.`;

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: base64 } }, { text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    },
    { timeout: 60000 }
  );

  const raw   = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const clean = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); }
  catch { throw new Error(`Gemini returned unparseable response: ${raw.slice(0, 120)}`); }
}

// ── searchByImage (UNCHANGED — downloadImage returns R2 URL automatically) ────
async function searchByImage(imageBuffer, onProgress) {
  onProgress?.({ stage: 'analysing', message: 'Gemini is identifying the product…' });
  const analysis = await analyseImageWithGemini(imageBuffer);
  logger.info('Image search product identified', { productName: analysis.productName, queries: analysis.queries.length, industry: analysis.industry });

  const industry = analysis.industry || 'General';
  const savedIds = [];
  let   skipped  = 0;
  let   queryIndex = 0;

  for (const query of analysis.queries) {
    queryIndex++;
    onProgress?.({ stage: 'searching', message: `Searching (${queryIndex}/${analysis.queries.length}): ${query}`, query });
    logger.debug('Image search query', { queryIndex, query });

    const results = await searchGoogle(query, 10);
    logger.debug('Image search results', { queryIndex, count: results.length });

    for (const result of results) {
      try {
        const exists = await TrendingProduct.findOne({ sourceUrl: result.link });
        if (exists) { skipped++; continue; }

        const imgFilename = `trending_img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`;
        const r2ImgUrl    = await downloadImage(result.imageUrl, imgFilename); // R2 URL

        let supplier = { name: '', website: result.displayLink, email: '', phone: '', country: '' };
        try { supplier = await extractSupplierInfo(result.link, result.displayLink); } catch {}

        const doc = await TrendingProduct.findOneAndUpdate(
          { sourceUrl: result.link },
          {
            $set: {
              name:         result.title.slice(0, 200),
              description:  result.snippet.slice(0, 500),
              industry,
              imageUrl:     r2ImgUrl || '',   // R2 https:// URL
              imageSrcUrl:  result.imageUrl,
              sourceUrl:    result.link,
              sourceDomain: result.displayLink || domain(result.link),
              supplier,
              searchQuery:  query,
              runDate:      new Date(),
            },
            $setOnInsert: { status: 'new' },
          },
          { upsert: true, new: true }
        );

        savedIds.push(doc._id);
        logger.debug('Image search product saved', { title: result.title.slice(0, 60) });
      } catch (err) {
        logger.warn('Image search item failed', { error: err.message.slice(0, 80) });
      }
      await sleep(1000);
    }
    await sleep(2000);
  }

  onProgress?.({ stage: 'done', message: `Done — ${savedIds.length} products saved` });
  logger.info('Image search complete', { saved: savedIds.length, skipped });
  return { analysis, saved: savedIds.length, skipped, productIds: savedIds };
}

module.exports = { runDiscovery, startScheduler, stopScheduler, INDUSTRY_QUERIES, searchByImage, analyseImageWithGemini };