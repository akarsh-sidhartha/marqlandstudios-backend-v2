'use strict';
/**
 * services/documentExtraction/parsers/primitives.js
 *
 * Small, dependency-free building blocks shared by every document parser:
 * money, dates, GSTINs, Indian "amount in words", and a layout-aware
 * label → value lookup. Kept pure (string in → value out) so each one is
 * trivially unit-testable and reusable by future document types.
 */

// ── Text normalisation ────────────────────────────────────────────────────────
// OCR routinely reads the rupee sign as "¥", "%" or "=" — fold the common ones
// back to ₹ so the amount matchers only have to know one symbol.
const normalizeText = (s = '') =>
  String(s)
    .replace(/[¥₹]/g, '₹')
    .replace(/\bRs\.?\s*/gi, '₹')
    .replace(/\bINR\s*/g, '₹')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/ /g, ' ');

const collapse = (s = '') => String(s).replace(/\s+/g, ' ').trim();

// ── Money ─────────────────────────────────────────────────────────────────────
// A "money-like" token: comma grouping (1,23,456 or 123,456), a decimal part,
// or an explicit ₹ prefix. Bare integers are ignored on purpose — HSN codes,
// quantities, pin codes and phone numbers would otherwise look like totals.
const MONEY_RE = /(₹\s*)?(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|(?<=₹\s*)\d+)(?!\d|%|,\d)/g;

const parseAmount = (raw) => {
  if (raw === null || raw === undefined) return null;
  const n = Number(String(raw).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/** All money-like values in a string, in reading order. */
const findAmounts = (text = '') => {
  const out = [];
  const s = normalizeText(text);
  for (const m of s.matchAll(MONEY_RE)) {
    const value = parseAmount(m[2]);
    if (value === null) continue;
    out.push({ value, hasCurrency: !!m[1], index: m.index });
  }
  return out;
};

// ── Dates ─────────────────────────────────────────────────────────────────────
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const DATE_PATTERNS = [
  // 2026-09-26
  { re: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g, pick: (m) => [m[1], m[2], m[3]] },
  // 26/09/2026, 26-09-26, 26.09.2026 — Indian documents are day-first
  { re: /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/g, pick: (m) => [m[3], m[2], m[1]] },
  // 26 Sept 2026, 26-Sep-2026, 26th September, 2026
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-/.,]*${MON}[\\s\\-/.,']*(\\d{4}|\\d{2})\\b`, 'gi'), pick: (m) => [m[3], m[2], m[1]] },
  // Sep 26, 2026
  { re: new RegExp(`\\b${MON}[\\s.\\-]*(\\d{1,2})(?:st|nd|rd|th)?[\\s,]+(\\d{4})\\b`, 'gi'), pick: (m) => [m[3], m[1], m[2]] },
];

const pad2 = (n) => String(n).padStart(2, '0');

const toISODate = (y, m, d) => {
  let year = Number(y);
  if (year < 100) year += 2000;
  const month = /^\d+$/.test(String(m)) ? Number(m) : MONTHS[String(m).toLowerCase().slice(0, 4)] || MONTHS[String(m).toLowerCase().slice(0, 3)];
  const day = Number(d);
  if (!month || month > 12 || !day || day > 31 || year < 2000 || year > 2100) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null; // 31 Feb etc.
  return `${year}-${pad2(month)}-${pad2(day)}`;
};

/** All dates in a string (ISO yyyy-mm-dd), in reading order. */
const findDates = (text = '') => {
  const hits = [];
  for (const { re, pick } of DATE_PATTERNS) {
    for (const m of String(text).matchAll(re)) {
      const iso = toISODate(...pick(m));
      if (iso) hits.push({ iso, index: m.index });
    }
  }
  return hits.sort((a, b) => a.index - b.index).map((h) => h.iso);
};

const parseDate = (text) => findDates(text)[0] || null;

/** Indian financial year + month name for an ISO date. */
const fiscalPeriod = (iso) => {
  if (!iso) return { financialYear: null, month: null };
  const [y, m] = iso.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return { financialYear: `${start}-${String(start + 1).slice(-2)}`, month: MONTH_NAMES[m - 1] };
};

// ── GSTIN ─────────────────────────────────────────────────────────────────────
// Layout: 2-digit state · 10-char PAN (5 letters, 4 digits, 1 letter) · entity
// digit · 'Z' · check character (mod-36 checksum over the first 14).
const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;
const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const gstinCheckChar = (first14) => {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const prod = B36.indexOf(first14[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  return B36[(36 - (sum % 36)) % 36];
};
const isValidGstin = (g) => /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g) && gstinCheckChar(g) === g[14];

// Characters OCR commonly swaps, by the kind of character a position expects.
const TO_DIGIT = { O: '0', D: '0', Q: '0', I: '1', L: '1', T: '1', Z: '2', S: '5', B: '8', G: '6' };
const TO_LETTER = { 0: 'O', 1: 'I', 2: 'Z', 5: 'S', 8: 'B', 6: 'G', 4: 'A' };
const DIGIT_POS = new Set([0, 1, 7, 8, 9, 10]);
const LETTER_POS = new Set([2, 3, 4, 5, 6, 11]);
const LOOKALIKES = ['0ODQ96', '1IL7T', '2Z', '5S', '8B3', '6G', '4A'];

// Valid GST state codes (01–38, 97 other territory, 99 centre jurisdiction).
const STATE_CODES = new Set([...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, '0')), '97', '99']);
// PAN 4th character = holder type (Company, Person, Firm, HUF, AOP, Trust, BOI, Local body, Juridical, Govt).
const PAN_TYPES = 'CPFHATBLJG';
const STATE_NAMES = [
  [/karnataka|bengaluru|bangalore|mysuru|mysore|hubli|mangalore/i, '29'], [/tamil\s*nadu|chennai|coimbatore/i, '33'],
  [/maharashtra|mumbai|pune|nagpur|thane/i, '27'], [/telangana|hyderabad|secunderabad/i, '36'], [/andhra\s*pradesh|vijayawada|visakhapatnam/i, '37'],
  [/kerala|kochi|cochin|thiruvananthapuram/i, '32'], [/delhi/i, '07'], [/gujarat|ahmedabad|surat|vadodara/i, '24'],
  [/haryana|gurugram|gurgaon|faridabad/i, '06'], [/uttar\s*pradesh|noida|lucknow|ghaziabad/i, '09'], [/west\s*bengal|kolkata/i, '19'],
  [/odisha|bhubaneswar/i, '21'], [/rajasthan|jaipur/i, '08'], [/goa\b/i, '30'], [/punjab|ludhiana|mohali/i, '03'],
];

/** State codes the document itself mentions ("State Code : 29", "Karnataka"). */
const statesInText = (text = '') => {
  const found = new Set();
  for (const m of String(text).matchAll(/\b(?:state\s*)?code\s*[:\-]?\s*(\d{2})\b/gi)) found.add(m[1]);
  for (const [re, code] of STATE_NAMES) if (re.test(text)) found.add(code);
  return found;
};

/**
 * Repair a 15-character OCR reading of a GSTIN. First fix characters that
 * can't be right for their position; if the check character still fails,
 * try one or two look-alike swaps (never letter-for-letter inside the PAN)
 * and rank the valid results by: fewest swaps, a real state code, a real
 * PAN holder type, and agreement with a state named on the document.
 * Returns null when the best candidates tie — better empty than wrong.
 */
const repairGstin = (raw, { states = new Set() } = {}) => {
  const chars = raw.toUpperCase().split('');
  if (chars.length !== 15) return null;
  chars.forEach((c, i) => {
    if (DIGIT_POS.has(i) && TO_DIGIT[c]) chars[i] = TO_DIGIT[c];
    if (LETTER_POS.has(i) && TO_LETTER[c]) chars[i] = TO_LETTER[c];
  });
  chars[13] = 'Z';
  const fixed = chars.join('');
  if (isValidGstin(fixed)) return fixed;

  const alts = (i, c) => (LETTER_POS.has(i) ? '' : (LOOKALIKES.find((g) => g.includes(c)) || '')).replace(c, '');
  const positions = [...Array(15).keys()].filter((i) => i !== 13 && alts(i, fixed[i]));
  const scored = [];
  const consider = (cand, swaps) => {
    if (!isValidGstin(cand)) return;
    const state = cand.slice(0, 2);
    const score = swaps * 10
      + (STATE_CODES.has(state) ? 0 : 100)
      + (PAN_TYPES.includes(cand[5]) ? 0 : 20)
      + (states.size ? (states.has(state) ? -12 : 8) : 0); // the document names its state(s)
    scored.push({ cand, score });
  };
  for (const i of positions) {
    for (const a of alts(i, fixed[i])) {
      const one = fixed.slice(0, i) + a + fixed.slice(i + 1);
      consider(one, 1);
      for (const j of positions) {
        if (j <= i) continue;
        for (const b of alts(j, fixed[j])) consider(one.slice(0, j) + b + one.slice(j + 1), 2);
      }
    }
  }
  if (!scored.length) return null;
  scored.sort((x, y) => x.score - y.score);
  // Accept only a clear winner that needed at most two plausible swaps.
  const [first, second] = scored;
  if (first.score > 20) return null;
  if (second && second.score - first.score < 5) return null;
  return first.cand;
};

/** All GSTINs in reading order — checksum-valid, repairing OCR misreads where unambiguous. */
const findGstins = (text = '') => {
  const s = String(text).toUpperCase();
  const states = statesInText(text);
  const out = [];
  const add = (g) => { if (g && !out.includes(g)) out.push(g); };
  // 15-char alphanumeric tokens, also across a stray space ("29ACGFM 9082Q1Z5").
  const words = s.split(/[^0-9A-Z]+/).filter(Boolean);
  const tokens = [];
  words.forEach((w, i) => {
    if (w.length === 15) tokens.push(w);
    else if (words[i + 1] && w.length + words[i + 1].length === 15) tokens.push(w + words[i + 1]);
  });
  for (const t of tokens) {
    // Only consider tokens that already look like a GSTIN (state digits + mostly-right shape).
    if (!/^[0-9OISZ]{2}[A-Z0-9]{5}[0-9A-Z]{4}[A-Z0-9]{4}$/.test(t) || !/[A-Z]{3}/.test(t.slice(2, 7))) continue;
    // Unrepairable but correctly shaped → keep it (the form shows it for review).
    add(isValidGstin(t) ? t : repairGstin(t, { states }) || (new RegExp(`^${GSTIN_RE.source}$`).test(t) ? t : null));
  }
  return out;
};

// ── Amount in words (Indian numbering) ────────────────────────────────────────
const SMALL = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALE = { hundred: 100, thousand: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, million: 1e6, crore: 1e7, crores: 1e7 };

const wordsToInt = (tokens) => {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const t of tokens) {
    if (t in SMALL) { current += SMALL[t]; seen = true; }
    else if (t === 'hundred') { current = (current || 1) * 100; seen = true; }
    else if (t in SCALE) { total += (current || 1) * SCALE[t]; current = 0; seen = true; }
  }
  return seen ? total + current : null;
};

/**
 * "Indian Rupee Thirty-Five Thousand Eight Hundred Thirteen Only" → 35813
 * "Rupees Eight Thousand Twenty Four and Fifty Paise Only"        → 8024.5
 */
const wordsToAmount = (text = '') => {
  const tokens = String(text).toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
  const paiseAt = tokens.indexOf('paise');
  const andAt = paiseAt > 0 ? tokens.lastIndexOf('and', paiseAt) : -1;
  const rupeeTokens = andAt > 0 ? tokens.slice(0, andAt) : tokens.filter((t) => t !== 'paise');
  const rupees = wordsToInt(rupeeTokens);
  if (rupees === null) return null;
  const paise = andAt > 0 ? wordsToInt(tokens.slice(andAt + 1, paiseAt)) || 0 : 0;
  return Math.round((rupees + paise / 100) * 100) / 100;
};

// ── Layout-aware label lookup ─────────────────────────────────────────────────
const stripLabelPunct = (s = '') => s.replace(/^[\s:#.\-–|]+/, '').trim();

/**
 * Finds the value that belongs to a label, the way a person reads a form:
 *   1. the rest of the same segment      "Invoice#: INV-001"
 *   2. the next segment on the same line "Invoice Date    21/08/2026"
 *   3. the segment directly below it      "Transfer Date" ⏎ "26 Sept 2026"
 *      (column-aligned, so two-column layouts don't bleed into each other)
 *
 * @param {object}   layout     — { lines: [{ segments: [{ text, x0, x1 }] }] }
 * @param {RegExp[]} labels     — label patterns, tried in priority order
 * @param {object}   [opts]
 * @param {(v:string)=>any} [opts.accept] — returns a parsed value, or null to keep looking
 * @param {number}   [opts.below=2]       — how many lines below the label to inspect
 * @returns {{ value:any, raw:string, lineIndex:number } | null}
 */
const findLabelValue = (layout, labels, { accept = (v) => v || null, below = 2 } = {}) => {
  const lines = layout?.lines || [];
  for (const label of labels) {
    for (let li = 0; li < lines.length; li++) {
      const segs = lines[li].segments;
      for (let si = 0; si < segs.length; si++) {
        const seg = segs[si];
        const m = seg.text.match(label);
        if (!m) continue;

        const candidates = [stripLabelPunct(seg.text.slice(m.index + m[0].length))];
        for (let k = si + 1; k < segs.length; k++) candidates.push(stripLabelPunct(segs[k].text));

        const mid = (seg.x0 + seg.x1) / 2;
        for (let d = 1; d <= below && li + d < lines.length; d++) {
          const next = lines[li + d].segments;
          // Nearest segment whose horizontal span overlaps the label's column.
          const aligned = next
            .map((s) => ({ s, dist: s.x1 < seg.x0 ? seg.x0 - s.x1 : s.x0 > seg.x1 ? s.x0 - seg.x1 : 0, mid: Math.abs((s.x0 + s.x1) / 2 - mid) }))
            .sort((a, b) => a.dist - b.dist || a.mid - b.mid);
          if (aligned.length && aligned[0].dist <= Math.max(40, (seg.x1 - seg.x0))) candidates.push(stripLabelPunct(aligned[0].s.text));
        }

        for (const raw of candidates) {
          if (!raw) continue;
          const value = accept(raw);
          if (value !== null && value !== undefined && value !== '') return { value, raw, lineIndex: li };
        }
      }
    }
  }
  return null;
};

/** Index of the first line whose text matches any pattern (or -1). */
const findLineIndex = (layout, patterns, from = 0) => {
  const lines = layout?.lines || [];
  for (let i = from; i < lines.length; i++) {
    if (patterns.some((p) => p.test(lines[i].text))) return i;
  }
  return -1;
};

module.exports = {
  normalizeText,
  collapse,
  parseAmount,
  findAmounts,
  findDates,
  parseDate,
  toISODate,
  fiscalPeriod,
  findGstins,
  isValidGstin,
  repairGstin,
  wordsToAmount,
  findLabelValue,
  findLineIndex,
  MONTH_NAMES,
};
