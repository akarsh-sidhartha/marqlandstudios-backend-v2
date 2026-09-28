'use strict';
/**
 * services/documentExtraction/pdfExtractor.js
 *
 * Reads PDFs with Mozilla's pdf.js (Apache-2.0):
 *   • Digital PDFs (Zoho, Tally, Busy, Excel exports…) — the embedded text
 *     layer is read directly with exact positions. Fast (~50 ms) and 100%
 *     accurate; no OCR involved.
 *   • Scanned PDFs (no text layer) — the first pages are rendered to an
 *     image and handed to the local OCR engine.
 *
 * pdf.js runs with eval disabled and without font loading — we only ever
 * need text positions, and this closes off the font-program attack surface.
 */
const ocrEngine = require('./ocrEngine');
const logger = require('../../utils/logger').child({ module: 'pdfExtractor' });

const MAX_TEXT_PAGES = 5;
const MAX_OCR_PAGES = 2;
const MIN_TEXT_CHARS = 25; // below this a PDF is treated as scanned
const PAGE_GAP = 40;       // vertical gap inserted between stacked pages

let pdfjsPromise = null;
const loadPdfJs = () => {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
};

/** Returns the loading task — its destroy() cleans up in both pdf.js v5 and v6. */
const openDocument = async (buffer) => {
  const pdfjs = await loadPdfJs();
  return pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
};

const textFragments = async (doc) => {
  const fragments = [];
  let yOffset = 0;
  const pages = Math.min(doc.numPages, MAX_TEXT_PAGES);
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const { height } = page.getViewport({ scale: 1 });
    const { items } = await page.getTextContent();
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const [, , , , x, baseline] = it.transform;
      const h = Math.abs(it.height || it.transform[3]) || 8;
      fragments.push({ text: it.str, x0: x, x1: x + (it.width || it.str.length * h * 0.5), y: yOffset + (height - baseline) - h / 2, h });
    }
    yOffset += height + PAGE_GAP;
    page.cleanup();
  }
  return fragments;
};

const ocrFragments = async (doc) => {
  const fragments = [];
  let yOffset = 0;
  const pages = Math.min(doc.numPages, MAX_OCR_PAGES);
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 3 }); // ~216 dpi — small form text (GSTINs, invoice no.) needs it
    const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: context, viewport }).promise;
    const png = canvas.toBuffer('image/png');
    const words = await ocrEngine.recognize(png);
    words.forEach((w) => fragments.push({ ...w, y: w.y + yOffset, line: w.line && { ...w.line, id: `${p}:${w.line.id}` } }));
    yOffset += viewport.height + PAGE_GAP;
    page.cleanup();
  }
  return fragments;
};

/**
 * @returns {Promise<{ fragments: Array, source: 'pdf-text'|'pdf-ocr' }>}
 */
const extractPdf = async (buffer) => {
  const task = await openDocument(buffer);
  try {
    const doc = await task.promise;
    const fragments = await textFragments(doc);
    const chars = fragments.reduce((n, f) => n + f.text.trim().length, 0);
    if (chars >= MIN_TEXT_CHARS) return { fragments, source: 'pdf-text' };

    logger.debug('PDF has no text layer — falling back to OCR', { pages: doc.numPages });
    return { fragments: await ocrFragments(doc), source: 'pdf-ocr' };
  } finally {
    // Cleanup must never mask the real error (pdf.js v6 removed doc.destroy()).
    try { await task.destroy(); } catch { /* already torn down */ }
  }
};

module.exports = { extractPdf };
