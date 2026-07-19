'use strict';
/**
 * backend/services/aiService.js
 *
 * Central AI extraction service used by paymentTrackerRoutes, invoiceRoute,
 * vendorRoutes (business card scan), and any future views.
 *
 * PROVIDER WATERFALL (tries free providers first, escalates only if needed):
 *   1. Tesseract — Fully free, runs locally (no API key, no quota). Tried first —
 *                  these documents are simple tax invoices, so plain OCR + regex
 *                  is usually enough to find company name, invoice #, GSTIN, tax split.
 *   2. Mistral   — Good OCR, generous free tier. Uses MISTRAL_API_KEY.
 *   3. Gemini    — Best accuracy but the most limited/paid quota. Uses GEMINI_API_KEY.
 *                  Only reached if the free providers didn't extract enough fields.
 *
 * A result only "passes" a provider and skips the rest of the waterfall once it
 * has enough of the fields we actually care about (see isInvoiceSufficient /
 * isCardSufficient). Otherwise the best partial result seen so far is kept as a
 * fallback and the next provider is tried.
 *
 * USAGE:
 *   const { extractFromDocument, extractFromBusinessCard, checkAIStatus } = require('./aiService');
 *   const result = await extractFromDocument(base64Data, mimeType);
 *   // result: { vendor_name, vendor_gst, invoice_number, date, total_amount,
 *   //           cgst, sgst, igst, financialYear, month, _provider }
 */

const axios  = require('axios');
const logger = require('../utils/logger').child({ module: 'aiService' });

// ── Utilities ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const parseAIJson = (text) => {
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
};

// ── Gemini model list cache ───────────────────────────────────────────────────
// Cached at module level — fetched once per process, not on every extraction call.
// The original code called getGeminiModels inside the retry loop, making up to
// 3 extra HTTP round-trips per document. Now fetched once and reused.
let _cachedGeminiModels = null;

const getGeminiModels = async (apiKey) => {
  if (_cachedGeminiModels) return _cachedGeminiModels;
  try {
    const res = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { timeout: 8_000 }
    );
    _cachedGeminiModels = res.data.models
      .map(m => m.name.replace('models/', ''))
      .filter(n => (n.includes('flash') || n.includes('pro')) && !n.includes('gemini-1.0'));
    logger.debug('Gemini models cached', { models: _cachedGeminiModels });
    return _cachedGeminiModels;
  } catch (err) {
    logger.warn('Failed to fetch Gemini model list — using fallback', { error: err.message });
    return ['gemini-1.5-flash'];
  }
};

// ── Provider 1: GEMINI ────────────────────────────────────────────────────────
// extraImages: [{ base64, mimeType }] — for multi-image calls (e.g. card front + back)
const callGemini = async (base64Data, mimeType, prompt, extraImages = []) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const imageParts = [
    { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64Data } },
    ...extraImages.map(img => ({ inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.base64 } })),
  ];

  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        ...imageParts,
      ],
    }],
  };

  // Resolve model list once before the retry loop — avoids extra HTTP calls per attempt
  const models = await getGeminiModels(apiKey);
  const model  = Array.isArray(models) ? models[0] : models;
  const url    = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  let attempts = 0;
  while (attempts < 3) {
    try {
      const res  = await axios.post(url, payload, { timeout: 30_000 });
      const text = res.data.candidates[0].content.parts[0].text;
      return parseAIJson(text);
    } catch (err) {
      attempts++;
      const status = err.response?.status;
      if (status === 429) throw Object.assign(err, { isQuotaError: true });
      if (attempts >= 3) throw err;
      const delay = Math.pow(2, attempts) * 1_000;
      logger.warn('Gemini attempt failed — retrying', { attempt: attempts, status, delay });
      await sleep(delay);
    }
  }
};

// ── Provider 2: MISTRAL (pixtral-12b — vision model) ─────────────────────────
// extraImages: [{ base64, mimeType }] — for multi-image calls (e.g. card front + back)
const callMistral = async (base64Data, mimeType, prompt, extraImages = []) => {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY not set');

  const toDataUrl = (b64, mime) =>
    b64.startsWith('data:') ? b64 : `data:${mime || 'image/jpeg'};base64,${b64}`;

  const imageBlocks = [
    { type: 'image_url', image_url: { url: toDataUrl(base64Data, mimeType) } },
    ...extraImages.map(img => ({ type: 'image_url', image_url: { url: toDataUrl(img.base64, img.mimeType) } })),
  ];

  const res = await axios.post(
    'https://api.mistral.ai/v1/chat/completions',
    {
      model:       'pixtral-12b-2409',
      messages: [{
        role:    'user',
        content: [
          { type: 'text', text: prompt },
          ...imageBlocks,
        ],
      }],
      max_tokens:  800,
      temperature: 0.1,
    },
    {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 40_000,
    }
  );

  return parseAIJson(res.data.choices[0].message.content);
};

// ── Provider 3: TESSERACT (local OCR — no API key needed) ─────────────────────
const callTesseract = async (base64Data, mimeType) => {
  // tesseract.js's recognize() only handles raster images. Handed a PDF, it
  // doesn't reject its promise — it throws inside a worker thread as an
  // unhandled 'error' event, which Node treats as an uncaught exception and
  // crashes the whole process. Fail fast here (a normal, catchable rejection)
  // instead of ever handing it a non-image buffer.
  if (mimeType && !mimeType.startsWith('image/')) {
    throw new Error(`Tesseract cannot OCR mimeType "${mimeType}" — image input required`);
  }

  let Tesseract;
  try {
    Tesseract = require('tesseract.js');
  } catch {
    throw new Error('tesseract.js not installed. Run: npm install tesseract.js');
  }

  const pureBase64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
  const buffer     = Buffer.from(pureBase64, 'base64');
  const { data: { text } } = await Tesseract.recognize(buffer, 'eng', { logger: () => {} });
  return extractFieldsFromRawText(text);
};

// ── Heuristic extraction from raw OCR text ────────────────────────────────────
const extractFieldsFromRawText = (text) => {
  const result = {
    vendor_name:    null,
    vendor_gst:     null,
    invoice_number: null,
    date:           null,
    total_amount:   null,
    cgst:           null,
    sgst:           null,
    igst:           null,
    financialYear:  null,
    month:          null,
    _provider:      'tesseract',
    _raw_text:      text,
  };

  const gstMatch = text.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}\b/);
  if (gstMatch) result.vendor_gst = gstMatch[0];

  const invMatch = text.match(/(?:invoice\s*(?:no|number|#)[:\s]+)([A-Z0-9\-\/]+)/i);
  if (invMatch) result.invoice_number = invMatch[1].trim();

  const dateMatch = text.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  if (dateMatch) {
    const [, d, m, y] = dateMatch;
    result.date  = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const mo     = parseInt(m);
    result.month = new Date(`${y}-${m}-${d}`).toLocaleString('default', { month: 'long' });
    result.financialYear = mo >= 4
      ? `${y}-${String(parseInt(y) + 1).slice(-2)}`
      : `${parseInt(y) - 1}-${String(y).slice(-2)}`;
  }

  const totalMatch = text.match(/(?:grand\s*total|total\s*amount|total)[:\s\u20B9Rs.]*([0-9,]+(?:\.\d{2})?)/i);
  if (totalMatch) result.total_amount = parseFloat(totalMatch[1].replace(/,/g, ''));

  const cgstMatch = text.match(/CGST[:\s\u20B9Rs.]*([0-9,]+(?:\.\d{2})?)/i);
  const sgstMatch = text.match(/SGST[:\s\u20B9Rs.]*([0-9,]+(?:\.\d{2})?)/i);
  const igstMatch = text.match(/IGST[:\s\u20B9Rs.]*([0-9,]+(?:\.\d{2})?)/i);
  if (cgstMatch) result.cgst = parseFloat(cgstMatch[1].replace(/,/g, ''));
  if (sgstMatch) result.sgst = parseFloat(sgstMatch[1].replace(/,/g, ''));
  if (igstMatch) result.igst = parseFloat(igstMatch[1].replace(/,/g, ''));

  const lines       = text.split('\n').map(l => l.trim()).filter(l => l.length > 3);
  const companyLine = lines.find(l =>
    /pvt|ltd|llp|inc|corp|industries|enterprise|trading|solutions|services/i.test(l)
  );
  if (companyLine) result.vendor_name = companyLine.replace(/[^a-zA-Z0-9\s&.,()-]/g, '').trim();

  return result;
};

// ── Business card heuristics ──────────────────────────────────────────────────
const extractCardFieldsFromText = (text) => {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 1);

  // Phone: Indian mobile or international format
  const phone = text.match(/(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?)?[6-9]\d{9}/)?.[0]
             || text.match(/\+?[\d\s()\-]{10,}/)?.[0]?.trim()
             || null;

  // Email
  const email = text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i)?.[0] || null;

  // Company: line containing business keywords
  const companyLine = lines.find(l =>
    /pvt|ltd|llp|inc|corp|industries|enterprise|trading|solutions|services|group|associates/i.test(l)
  );
  const company_name = companyLine ? companyLine.replace(/[^a-zA-Z0-9\s&.,()\-]/g, '').trim() : null;

  // Name: first short line (2–4 words, no digits, not a company keyword, not already picked)
  const nameLine = lines.find(l =>
    l !== companyLine &&
    /^[A-Z][a-z]+(\s[A-Z][a-z.]+){1,3}$/.test(l) &&
    !/pvt|ltd|llp|inc|corp|@|\d/i.test(l)
  );
  const name = nameLine || null;

  return { company_name, name, phone, email, _provider: 'tesseract', _raw_text: text };
};

// ── Prompts ───────────────────────────────────────────────────────────────────
const INVOICE_PROMPT = `Extract Indian Tax Invoice details from this document.
Return ONLY a valid JSON object with these exact fields (use null for missing):
{
  "vendor_name": "string",
  "vendor_gst": "15-char GSTIN string",
  "invoice_number": "string",
  "date": "YYYY-MM-DD",
  "total_amount": number,
  "cgst": number,
  "sgst": number,
  "igst": number,
  "financialYear": "e.g. 2024-25",
  "month": "full month name e.g. March"
}
No explanation. No markdown. Just the JSON object.`;

const BUSINESS_CARD_PROMPT = `Extract contact details from this business card image (or images — front and back may both be provided).
Scan ALL text visible across every image and return ONLY a valid JSON object with these exact fields (null if not found):
{
  "company_name": "full company or organisation name",
  "name": "person's full name",
  "phone": "phone number including country code if present",
  "email": "email address"
}
Rules:
- If multiple phone numbers exist, prefer the mobile number.
- If multiple emails exist, prefer the direct/personal one over generic ones (info@, hello@).
- "name" is the individual person's name, not the company name.
- No explanation. No markdown. Just the JSON object.`;


// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Runs a list of providers in priority order, stopping at the first one whose
 * result passes `isSufficient`. If none pass, the best partial result seen is
 * returned (still more useful to the caller than nothing) — the waterfall
 * only throws if every provider errored outright with no usable result at all.
 *
 * Replaces three near-identical try/catch/fallback chains (invoice extraction,
 * business card extraction, and previously duplicated per-provider blocks)
 * with one place that encodes "try free providers, escalate if needed".
 *
 * @param {Array<{name: string, available: () => boolean, run: () => Promise<object>}>} providers
 * @param {(result: object) => boolean} isSufficient
 */
const runProviderWaterfall = async (providers, isSufficient) => {
  const errors = [];
  let bestResult   = null;
  let bestProvider = null;

  for (const { name, available, run } of providers) {
    if (!available()) { errors.push({ provider: name, reason: 'no_key' }); continue; }
    try {
      const result = await run();
      if (isSufficient(result)) return { result, provider: name };
      if (!bestResult) { bestResult = result; bestProvider = name; }
      errors.push({ provider: name, reason: 'insufficient_fields' });
      logger.warn(`${name} extraction didn't meet the quality bar — trying next provider`, { name });
    } catch (err) {
      const reason = err.isQuotaError ? 'quota_exceeded' : err.message;
      errors.push({ provider: name, reason });
      logger.warn(`${name} extraction failed — trying next provider`, { reason });
    }
  }

  if (bestResult) return { result: bestResult, provider: bestProvider, partial: true };

  const summary = errors.map(e => `${e.provider}:${e.reason}`).join(', ');
  logger.error('All AI providers failed', { errors });
  throw new Error(`All AI providers failed. Errors: ${summary}`);
};

/** Enough of the fields we actually need — company, invoice #, GSTIN, and at least one amount. */
const REQUIRED_INVOICE_FIELDS = ['vendor_name', 'invoice_number', 'vendor_gst'];
const isInvoiceSufficient = (result) => {
  if (!result) return false;
  const fieldsHit = REQUIRED_INVOICE_FIELDS.filter((k) => result[k]).length;
  const hasAmount = [result.total_amount, result.cgst, result.sgst, result.igst].some((v) => v != null && v !== '');
  return fieldsHit >= 2 && hasAmount;
};

const isCardSufficient = (result) =>
  !!(result && (result.company_name || result.name) && (result.phone || result.email));

const extractFromDocument = async (base64Data, mimeType) => {
  const pureBase64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
  const mistralPrompt = mimeType === 'application/pdf'
    ? INVOICE_PROMPT + '\nNote: This may be a PDF rendered as image.'
    : INVOICE_PROMPT;

  const providers = [
    { name: 'tesseract', available: () => mimeType?.startsWith('image/') ?? false, run: () => callTesseract(pureBase64, mimeType) },
    { name: 'mistral',   available: () => !!process.env.MISTRAL_API_KEY,   run: () => callMistral(pureBase64, mimeType, mistralPrompt) },
    { name: 'gemini',    available: () => !!process.env.GEMINI_API_KEY,    run: () => callGemini(pureBase64, mimeType, INVOICE_PROMPT) },
  ];

  const { result, provider, partial } = await runProviderWaterfall(providers, isInvoiceSufficient);
  if (partial) logger.warn('No provider met the quality bar for this document — returning best-effort result', { provider });
  else logger.debug(`Document extracted via ${provider}`);
  return { ...result, _provider: provider };
};

/**
 * extractFromBusinessCard
 *
 * @param {string} base64Data   — base64 (with or without data-URI prefix) of the FRONT image
 * @param {string} [backImageData] — optional base64 of the BACK image
 *
 * All providers receive front + back together (or OCR both, for Tesseract) so
 * information can be merged from both sides (e.g. company on front, email on back).
 */
const extractFromBusinessCard = async (base64Data, backImageData = null) => {
  const stripPrefix = (b64) => (b64 && b64.includes(',') ? b64.split(',')[1] : b64);

  const frontBase64 = stripPrefix(base64Data);
  const backBase64  = backImageData ? stripPrefix(backImageData) : null;
  const mimeType    = 'image/jpeg';
  const extraImages = backBase64 ? [{ base64: backBase64, mimeType }] : [];

  const recogniseTesseract = async () => {
    const Tesseract = require('tesseract.js');
    const recognise = async (b64) => {
      const { data: { text } } = await Tesseract.recognize(Buffer.from(b64, 'base64'), 'eng', { logger: () => {} });
      return text;
    };
    const frontText = await recognise(frontBase64);
    const backText  = backBase64 ? await recognise(backBase64) : '';
    return extractCardFieldsFromText([frontText, backText].filter(Boolean).join('\n'));
  };

  const providers = [
    { name: 'tesseract', available: () => true,                          run: recogniseTesseract },
    { name: 'mistral',   available: () => !!process.env.MISTRAL_API_KEY, run: () => callMistral(frontBase64, mimeType, BUSINESS_CARD_PROMPT, extraImages) },
    { name: 'gemini',    available: () => !!process.env.GEMINI_API_KEY,  run: () => callGemini(frontBase64, mimeType, BUSINESS_CARD_PROMPT, extraImages) },
  ];

  const { result, provider } = await runProviderWaterfall(providers, isCardSufficient);
  return { ...result, _provider: provider };
};

const checkAIStatus = async () => {
  try {
    require('tesseract.js');
    return { available: true, provider: 'tesseract', reason: 'ok' };
  } catch {
    // tesseract.js not installed — fall through to the paid providers below
  }

  if (process.env.MISTRAL_API_KEY) {
    return { available: true, provider: 'mistral', reason: 'ok' };
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const models = await getGeminiModels(process.env.GEMINI_API_KEY);
      const model  = Array.isArray(models) ? models[0] : models;
      await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text: 'hi' }] }] },
        { timeout: 5_000 }
      );
      return { available: true, provider: 'gemini', reason: 'ok' };
    } catch (err) {
      if (err.response?.status === 429) {
        logger.info('Gemini quota exceeded and no free provider configured');
        return { available: false, provider: 'gemini', reason: 'gemini_quota_exceeded' };
      }
    }
  }

  return { available: false, provider: 'none', reason: 'no_providers_available' };
};

module.exports = { extractFromDocument, extractFromBusinessCard, checkAIStatus };