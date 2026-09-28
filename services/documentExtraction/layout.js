'use strict';
/**
 * services/documentExtraction/layout.js
 *
 * Turns positioned text fragments — pdf.js text items or Tesseract words —
 * into one shared layout model the parsers read:
 *
 *   { text, lines: [{ text, y, segments: [{ text, x0, x1 }] }] }
 *
 * Lines are rebuilt from coordinates (top-to-bottom, left-to-right), so the
 * parsers never depend on the order a PDF generator happened to write its
 * content stream in. Each line is further split into "segments" wherever a
 * wide horizontal gap appears — that is what keeps the two columns of a
 * "To | From" or "Amount | Transfer Mode" block from merging into one string.
 */
const { normalizeText } = require('./parsers/primitives');

// Group into lines: a fragment joins the current line when its centre sits
// within half a glyph height of the line's running centre. Used for PDF text,
// where the page is perfectly straight.
const rowsByPosition = (items) => {
  const rows = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    const tol = Math.max(2, Math.min(it.h, row?.h ?? it.h) * 0.5);
    if (row && Math.abs(row.y - it.y) <= tol) {
      row.items.push(it);
      row.y = (row.y * (row.items.length - 1) + it.y) / row.items.length;
    } else {
      rows.push({ y: it.y, h: it.h, items: [it] });
    }
  }
  return rows;
};

// OCR output: keep Tesseract's lines intact (they survive tilt), and only merge
// lines from different columns that share the same band of the page.
const rowsFromOcrLines = (items) => {
  const byLine = new Map();
  for (const it of items) {
    if (!byLine.has(it.line.id)) byLine.set(it.line.id, { y0: it.line.y0, y1: it.line.y1, items: [] });
    byLine.get(it.line.id).items.push(it);
  }
  const lines = [...byLine.values()].map((l) => {
    // A tilted line's bounding box is tall; its word-height median is the real text height.
    const hs = l.items.map((i) => i.h).sort((a, b) => a - b);
    const h = hs[Math.floor(hs.length / 2)];
    const y = l.items.reduce((s, i) => s + i.y, 0) / l.items.length;
    return { y, h, items: l.items };
  }).sort((a, b) => a.y - b.y);

  const rows = [];
  for (const l of lines) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.y - l.y) <= Math.min(row.h, l.h) * 0.6) {
      row.items.push(...l.items);
      row.h = Math.max(row.h, l.h);
    } else {
      rows.push({ y: l.y, h: l.h, items: [...l.items] });
    }
  }
  return rows;
};

/**
 * @param {Array<{ text:string, x0:number, x1:number, y:number, h:number, line?:object }>} fragments
 *        y is the vertical centre in top-down coordinates; h the glyph height.
 */
const buildLayout = (fragments) => {
  const items = fragments
    .map((f) => ({ ...f, text: normalizeText(f.text).replace(/\s+/g, ' ') }))
    .filter((f) => f.text.trim())
    .sort((a, b) => a.y - b.y || a.x0 - b.x0);

  const rows = items.every((f) => f.line) ? rowsFromOcrLines(items) : rowsByPosition(items);

  const lines = rows.map((row) => {
    const sorted = row.items.sort((a, b) => a.x0 - b.x0);
    const segments = [];
    for (const it of sorted) {
      const seg = segments[segments.length - 1];
      const charW = Math.max(1, (it.x1 - it.x0) / Math.max(1, it.text.length));
      const gap = seg ? it.x0 - seg.x1 : Infinity;
      // A gap wider than ~2.5 glyphs (or 1.5× the line height) starts a new column.
      if (seg && gap <= Math.max(charW * 2.5, row.h * 1.5)) {
        seg.text += (gap > charW * 0.25 && !seg.text.endsWith(' ') && !it.text.startsWith(' ') ? ' ' : '') + it.text;
        seg.x1 = Math.max(seg.x1, it.x1);
      } else {
        segments.push({ text: it.text, x0: it.x0, x1: it.x1 });
      }
    }
    segments.forEach((s) => { s.text = s.text.trim(); });
    return { y: row.y, segments: segments.filter((s) => s.text), text: segments.map((s) => s.text).join('   ').trim() };
  }).filter((l) => l.text);

  return { lines, text: lines.map((l) => l.text).join('\n') };
};

/** Layout for plain text with no coordinates (used by tests and as a last resort). */
const layoutFromPlainText = (text = '') => {
  const lines = String(text).split(/\r?\n/).map((raw, i) => {
    const segments = [];
    let x = 0;
    for (const part of normalizeText(raw).split(/(\s{3,}|\t+)/)) {
      if (/^\s+$/.test(part) || !part) { x += part.length; continue; }
      segments.push({ text: part.trim(), x0: x * 6, x1: (x + part.length) * 6 });
      x += part.length;
    }
    return { y: i * 10, segments, text: segments.map((s) => s.text).join('   ') };
  }).filter((l) => l.text);
  return { lines, text: lines.map((l) => l.text).join('\n') };
};

module.exports = { buildLayout, layoutFromPlainText };
