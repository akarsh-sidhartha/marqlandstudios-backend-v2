'use strict';
/**
 * services/documentExtraction/parsers/quoteParser.js
 *
 * Reads a sales quote (Zoho Books, Tally, Excel exports…) into its header
 * fields and item table:
 *
 *   { quoteNumber, quoteDate, subject, subTotal, total,
 *     items: [{ lineNo, name, details, hsn, quantity, unit, rate, amount, total }],
 *     warnings: [] }
 *
 * The item table is read by COLUMN, not by guessing which number is which:
 * the header row ("# | Item & Description | HSN/SAC | Qty | Rate | Amount…")
 * fixes each column's x-range, and every value below is assigned to the
 * column it sits under. A row starts at a serial number (or, without a "#"
 * column, at a quantity); the lines below it until the next row are its
 * description ("Agaro Royal Stand Mixer", "- Black") and unit ("pcs").
 *
 * Pure: layout in → object out. No I/O, so it is unit-tested directly.
 */
const { collapse, parseAmount, parseDate, findLabelValue } = require('./primitives');

// Header cell → column key. First match wins, so "Taxable Amount" is an
// amount and "Unit Price" is a rate, not a unit.
const COLUMN_PATTERNS = [
  ['index', /^(#|s\.?\s*no\.?|sl\.?\s*(no\.?)?|sr\.?\s*(no\.?)?)$/i],
  ['hsn', /\b(hsn|sac)\b/i],
  ['rate', /\b(rate|price|mrp)\b/i],
  ['qty', /\b(qty|quantity|nos)\b/i],
  ['unit', /^(unit|uom)$/i],
  ['tax', /\b(cgst|sgst|igst|gst|tax\s*%?|vat)\b(?!.*amount)/i],
  ['amount', /\b(amount|taxable|value)\b/i],
  ['total', /\btotal\b/i],
  ['item', /\b(item|description|particulars|product|goods|services?)\b/i],
];

const END_OF_TABLE = /^(sub\s*-?\s*total|total\b|grand\s+total|total\s+in\s+words|amount\s+in\s+words|notes?\b|terms\b|balance\s+due|rounding)/i;
const SERIAL = /^\d{1,3}\.?$/;
const SERIAL_PREFIX = /^(\d{1,3})[.)]?\s+(\S.*)$/;
const INLINE_HSN = /\b(?:hsn|sac)\s*(?:code)?\s*[:\-]?\s*(\d{4,8})\b/i;
const NUMBER = /-?\d[\d,]*(?:\.\d+)?/;
const UNIT_WORD = /^(pcs?|nos?|units?|sets?|kgs?|boxes|box|pairs?|pax|mtrs?|ltrs?|dozens?|packs?|each|ea)\.?$/i;

// Item titles that only name a category ("Goodies") — the real product name
// is then the description line under it.
const GENERIC_TITLES = /^(goodies|gifts?|gifting|items?|products?|merchandise|merch|hampers?|kits?|misc(ellaneous)?)$/i;

const round2 = (n) => Math.round(n * 100) / 100;

const classifyHeader = (text) => COLUMN_PATTERNS.find(([, re]) => re.test(text.trim()))?.[0] || null;

const NUMERIC_COLUMNS = new Set(['qty', 'rate', 'amount', 'total', 'tax', 'hsn', 'unit', 'extra']);

/**
 * Splits a segment into words with x-positions estimated from character
 * offsets. Tightly set tables (and OCR) merge neighbouring cells into one
 * segment — "HSN/SAC Qty", "21 pcs 1,100.00" — and this pulls them apart.
 */
const splitWords = (seg) => {
  const perChar = (seg.x1 - seg.x0) / Math.max(1, seg.text.length);
  const words = [];
  for (const m of seg.text.matchAll(/\S+/g)) {
    words.push({ text: m[0], x0: seg.x0 + m.index * perChar, x1: seg.x0 + (m.index + m[0].length) * perChar });
  }
  return words;
};

/**
 * The header row: one line that names both an item column and a quantity
 * column. Each header word is classified on its own and neighbours with the
 * same meaning are merged back ("Item & Description", "Taxable Amount").
 */
const findHeader = (lines, from = 0) => {
  for (let i = from; i < lines.length; i++) {
    const columns = [];
    for (const word of lines[i].segments.flatMap(splitWords)) {
      const key = classifyHeader(word.text);
      const prev = columns[columns.length - 1];
      if (prev && (!key || key === prev.key) && word.x0 - prev.x1 < 12) prev.x1 = word.x1;
      else if (key) columns.push({ key, x0: word.x0, x1: word.x1 });
    }
    const keys = new Set(columns.map((c) => c.key));
    if (keys.has('item') && keys.has('qty') && columns.length >= 3) {
      // Several amount/total columns can exist (Taxable Amount, CGST amount…);
      // only the first of each is read, later ones are kept as 'extra' so their
      // values still land somewhere instead of bleeding into a neighbour.
      const seen = new Set();
      return {
        index: i,
        columns: columns.map((c) => {
          const key = c.key !== 'tax' && seen.has(c.key) ? 'extra' : c.key;
          seen.add(c.key);
          return { ...c, key };
        }),
      };
    }
  }
  return null;
};

/** Column whose x-range the segment's centre falls in, else the nearest one. */
const columnFor = (seg, columns) => {
  const mid = (seg.x0 + seg.x1) / 2;
  let best = null;
  for (const col of columns) {
    const dist = mid < col.x0 ? col.x0 - mid : mid > col.x1 ? mid - col.x1 : 0;
    if (!best || dist < best.dist) best = { col, dist };
  }
  return best?.col.key || null;
};

const cellsOf = (line, columns) => {
  const cells = {};
  const put = (key, text) => { if (key) cells[key] = cells[key] ? `${cells[key]} ${text}` : text; };
  const hasIndex = columns.some((c) => c.key === 'index');
  for (const seg of line.segments) {
    const key = columnFor(seg, columns);
    if (NUMERIC_COLUMNS.has(key) && /\s/.test(seg.text)) {
      // "21 pcs 1,100.00" — every word goes to the column it sits under.
      splitWords(seg).forEach((w) => put(columnFor(w, columns), w.text));
    } else if (key === 'item' && hasIndex && !cells.index && SERIAL_PREFIX.test(seg.text)) {
      // "1 Goodies Hydro Boil…" — the serial number merged into the item text.
      const [, serial, rest] = seg.text.match(SERIAL_PREFIX);
      put('index', serial);
      put('item', rest);
    } else {
      put(key, seg.text);
    }
  }
  return cells;
};

/** "21 pcs" → { quantity: 21, unit: 'pcs' }; "pcs" → { unit: 'pcs' } */
const parseQty = (raw = '') => {
  const text = collapse(raw);
  const num = text.match(NUMBER);
  const quantity = num ? parseAmount(num[0]) : null;
  const rest = collapse(num ? text.replace(num[0], '') : text);
  return { quantity, unit: UNIT_WORD.test(rest) ? rest.toLowerCase().replace(/\.$/, '') : null };
};

const money = (raw) => {
  const m = collapse(raw || '').replace(/[₹\s]/g, '').match(NUMBER);
  return m ? parseAmount(m[0]) : null;
};

const isRowStart = (cells, hasIndex) => {
  if (hasIndex) return SERIAL.test(collapse(cells.index || ''));
  return parseQty(cells.qty).quantity !== null && (money(cells.amount) !== null || money(cells.rate) !== null);
};

const readItems = (layout) => {
  const { lines } = layout;
  const header = findHeader(lines);
  if (!header) return { items: [], tableFound: false };

  const hasIndex = header.columns.some((c) => c.key === 'index');
  const rows = [];
  let current = null;

  for (let i = header.index + 1; i < lines.length; i++) {
    const line = lines[i];
    if (END_OF_TABLE.test(line.segments[0]?.text || '') || line.segments.some((s) => /^sub\s*-?\s*total$/i.test(s.text.trim()))) break;
    // Multi-page quotes repeat the header on every page.
    if (findHeader([line])) continue;

    const cells = cellsOf(line, header.columns);
    if (isRowStart(cells, hasIndex)) {
      current = { cells, extra: [] };
      rows.push(current);
    } else if (current) {
      current.extra.push(cells);
    }
  }

  const items = rows.map((row, idx) => {
    const { quantity, unit } = parseQty(row.cells.qty);
    let descLines = row.extra.map((c) => collapse(c.item || '')).filter(Boolean);
    // "HSN: 84231000" printed under the item instead of in its own column.
    const inlineHsn = descLines.map((d) => d.match(INLINE_HSN)?.[1]).find(Boolean) || null;
    descLines = descLines.map((d) => collapse(d.replace(INLINE_HSN, ''))).filter(Boolean);
    const extraUnit = row.extra.map((c) => parseQty(c.qty || c.unit).unit).find(Boolean);
    const rate = money(row.cells.rate);
    const amount = money(row.cells.amount) ?? (rate !== null && quantity !== null ? round2(rate * quantity) : null);
    return {
      lineNo: hasIndex ? parseInt(row.cells.index, 10) || idx + 1 : idx + 1,
      title: collapse(row.cells.item || ''),
      description: collapse(descLines.join(' ')),
      hsn: collapse(row.cells.hsn || '').match(/\d{4,8}/)?.[0] || inlineHsn,
      quantity: quantity ?? 1,
      unit: unit || parseQty(row.cells.unit).unit || extraUnit || null,
      rate,
      amount,
      total: money(row.cells.total),
    };
  });

  // Name each item by what gets procured: "Goodies / Agaro Royal Stand Mixer"
  // → "Agaro Royal Stand Mixer". A title repeated on several rows is a
  // category label, not a product name.
  const titleCount = items.reduce((m, it) => m.set(it.title.toLowerCase(), (m.get(it.title.toLowerCase()) || 0) + 1), new Map());
  return {
    tableFound: true,
    items: items
      .map(({ title, description, ...rest }) => {
        const generic = GENERIC_TITLES.test(title) || titleCount.get(title.toLowerCase()) > 1;
        const useDescription = description && (generic || !title);
        return {
          ...rest,
          name: (useDescription ? description : title || description).slice(0, 300),
          details: (useDescription ? title : description).slice(0, 1000),
        };
      })
      .filter((it) => it.name),
  };
};

const QUOTE_NUMBER_LABELS = [/\b(?:quote|quotation|estimate|proposal)\s*(?:#|no\.?|number)\s*:?/i];
const QUOTE_DATE_LABELS = [/\b(?:quote|quotation|estimate)\s*date\s*:?/i, /^\s*date\s*:?/i];
const DOC_NUMBER = /^[A-Z]{1,6}[-/]?[A-Z0-9][A-Z0-9/\-]{2,30}$/i;

const acceptNumber = (v) => {
  const token = collapse(v).replace(/^[:#\s]+/, '').split(' ')[0];
  return token && DOC_NUMBER.test(token) && /\d/.test(token) ? token.toUpperCase() : null;
};

/** Last amount on the last line (below the item table) that a pattern labels. */
const labelledAmount = (lines, pattern) => {
  const line = [...lines].reverse().find((l) => l.segments.some((s) => pattern.test(s.text.trim())));
  if (!line) return null;
  const values = line.segments.map((s) => money(s.text)).filter((v) => v !== null);
  return values.length ? values : null;
};

/**
 * @param {{ lines: Array, text: string }} layout — see ../layout.js
 */
const parseQuote = (layout) => {
  const warnings = [];
  const { items, tableFound } = readItems(layout);
  if (!tableFound) warnings.push('No item table was found — add the line items manually.');
  else if (!items.length) warnings.push('The item table was found but no rows could be read.');

  const quoteNumber = findLabelValue(layout, QUOTE_NUMBER_LABELS, { accept: acceptNumber, below: 1 })?.value || null;
  const quoteDate = findLabelValue(layout, QUOTE_DATE_LABELS, { accept: (v) => parseDate(v), below: 1 })?.value || null;
  const subject = findLabelValue(layout, [/^\s*subject\s*:?/i], {
    accept: (v) => (/[a-z]{3}/i.test(v) ? collapse(v).slice(0, 200) : null), below: 1,
  })?.value || null;

  // Totals live below the item table — never read them off the header row.
  const header = findHeader(layout.lines);
  const below = header ? layout.lines.slice(header.index + 1) : layout.lines;
  const subTotal = labelledAmount(below, /^sub\s*-?\s*total$/i)?.[0] ?? null;               // taxable value
  const totals = labelledAmount(below, /^(grand\s+)?total(\s+amount)?$/i) || labelledAmount(below, /^balance\s+due$/i);
  const total = totals ? totals[totals.length - 1] : null;
  return { quoteNumber, quoteDate, subject, subTotal, total, items, warnings };
};

module.exports = { parseQuote };
