'use strict';
/**
 * services/documentExtraction/ocrEngine.js
 *
 * Local, open-source OCR (Tesseract via tesseract.js) — no API key, no quota,
 * no document ever leaves the server.
 *
 *  • The English model ships with the app (@tesseract.js-data/eng), so the
 *    engine never downloads anything at runtime and works behind firewalls.
 *  • Workers are created lazily, reused across requests (spinning one up
 *    costs ~300 ms), and shut down after OCR_IDLE_MS of inactivity so an idle
 *    server doesn't hold ~100 MB per worker.
 *  • Tesseract runs in worker_threads, so OCR never blocks the event loop.
 *  • Every job has a hard timeout; a stuck or crashed worker is discarded and
 *    the next request transparently starts a fresh one.
 */
const path = require('path');
const sharp = require('sharp');
const AppError = require('../../lib/errors/AppError');
const logger = require('../../utils/logger').child({ module: 'ocrEngine' });

const POOL_SIZE = Math.max(1, Number(process.env.OCR_WORKERS) || 1);
const JOB_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS) || 60_000;
const IDLE_MS = Number(process.env.OCR_IDLE_MS) || 10 * 60_000;

// Resolved on first OCR use (not at startup), so a missing optional package
// can never stop the API from booting — only OCR requests report it.
let langPath = null;
const resolveLangPath = () => {
  if (langPath) return langPath;
  try {
    langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
    return langPath;
  } catch {
    throw AppError.upstream('Image reading is not installed on the server. Run "npm install" in the backend (needs tesseract.js and @tesseract.js-data/eng).');
  }
};

let schedulerPromise = null;
let idleTimer = null;

const createScheduler = async () => {
  const LANG_PATH = resolveLangPath();
  let tesseract;
  try { tesseract = require('tesseract.js'); }
  catch { throw AppError.upstream('Image reading is not installed on the server. Run "npm install" in the backend.'); }
  const { createScheduler: mkScheduler, createWorker } = tesseract;
  const scheduler = mkScheduler();
  const started = Date.now();
  for (let i = 0; i < POOL_SIZE; i++) {
    // cacheMethod 'none': the model is already on local disk, no need to copy it into a cache dir.
    const worker = await createWorker('eng', 1, { langPath: LANG_PATH, gzip: true, cacheMethod: 'none' });
    // tesseract.js defaults to PSM 6 ("one uniform block of text"), which drops
    // text sitting in the side boxes of Tally/Busy-style forms. PSM 3 runs full
    // automatic layout analysis; keep word spacing so columns stay separable.
    await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
    scheduler.addWorker(worker);
  }
  logger.info('OCR workers ready', { workers: POOL_SIZE, ms: Date.now() - started });
  return scheduler;
};

const shutdown = async () => {
  const pending = schedulerPromise;
  schedulerPromise = null;
  clearTimeout(idleTimer);
  if (!pending) return;
  try { await (await pending).terminate(); } catch { /* already dead */ }
};

const armIdleTimer = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { logger.debug('OCR idle — releasing workers'); shutdown(); }, IDLE_MS);
  idleTimer.unref?.();
};

const getScheduler = () => {
  if (!schedulerPromise) {
    schedulerPromise = createScheduler().catch((err) => { schedulerPromise = null; throw err; });
  }
  return schedulerPromise;
};

/**
 * Normalise an image for OCR: honour EXIF rotation, greyscale, stretch
 * contrast and bring it to a width Tesseract reads well (phone screenshots
 * are often too small, camera photos needlessly large).
 */
const prepareImage = async (buffer, { upscale = false } = {}) => {
  try {
    const img = sharp(buffer, { failOn: 'none' }).rotate();
    const { width = 0 } = await img.metadata();
    // Small phone photos (WhatsApp-compressed) are upscaled 2x; clean screenshots
    // read better at native size unless their text turns out to be tiny.
    const target = upscale || (width && width < 1000) ? Math.min(width * 2, 4000) : width > 2800 ? 2400 : null;
    // Greyscale + light sharpening only — contrast "normalise" washes out sparse
    // text on mostly-white pages.
    return await (target ? img.resize({ width: target, kernel: 'lanczos3' }) : img).grayscale().sharpen({ sigma: 1 }).png().toBuffer();
  } catch (err) {
    throw AppError.unprocessable('This image format could not be read. Please upload a JPG, PNG or PDF.', { reason: err.message });
  }
};

const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(AppError.timeout('Reading the document took too long.')), ms); }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * OCR an image buffer.
 * @returns {Promise<Array<{ text, x0, x1, y, h }>>} word fragments for layout.buildLayout
 */
const toWords = (data) => {
  // Words keep a reference to their Tesseract line: on tilted phone photos a
  // line's words drift vertically, and Tesseract's own line grouping is far
  // more reliable than regrouping by y-position (see layout.buildLayout).
  const words = [];
  let lineNo = 0;
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        lineNo += 1;
        const lb = line.bbox;
        for (const w of line.words || []) {
          if (!w.text?.trim() || w.confidence < 20) continue;
          const { x0, x1, y0, y1 } = w.bbox;
          words.push({ text: w.text, x0, x1, y: (y0 + y1) / 2, h: Math.max(1, y1 - y0), line: { id: lineNo, y0: lb.y0, y1: lb.y1 } });
        }
      }
    }
  }
  return words;
};

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] || 0; };
const SMALL_TEXT_PX = 15; // below this Tesseract starts dropping digits ("15/09" → "5/09")

const runJob = async (image) => {
  const scheduler = await getScheduler();
  const { data } = await withTimeout(scheduler.addJob('recognize', image, {}, { text: true, blocks: true }), JOB_TIMEOUT_MS);
  return toWords(data);
};

/**
 * OCR an image buffer once.
 * @param {{ upscale?: boolean }} [opts] — force a 2x read (used for small text)
 * @returns {Promise<Array<{ text, x0, x1, y, h, line }>>} words for layout.buildLayout
 */
const recognize = async (buffer, { upscale = false } = {}) => {
  clearTimeout(idleTimer);
  try {
    return await runJob(await prepareImage(buffer, { upscale }));
  } catch (err) {
    // A timed-out or crashed worker can't be trusted with the next job.
    logger.warn('OCR job failed — recycling workers', { error: err.message });
    await shutdown();
    throw err;
  } finally {
    armIdleTimer();
  }
};

/** True when a read's text is small enough that a 2x pass is worth it. */
const isSmallText = (words) => words.length > 0 && median(words.map((w) => w.h)) < SMALL_TEXT_PX;

module.exports = { recognize, isSmallText, shutdown };
