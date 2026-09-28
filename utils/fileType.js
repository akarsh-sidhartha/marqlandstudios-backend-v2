'use strict';
/**
 * utils/fileType.js
 *
 * Detects a file's real type from its leading bytes ("magic numbers").
 * The Content-Type / mimetype a client sends is just a claim — anything that
 * is stored, parsed or streamed back is checked against the bytes first.
 */

const SIGNATURES = [
  { mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'image/heic', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)$/.test(b.subarray(8, 12).toString('latin1')) },
];

/** @returns {string|null} the detected MIME type, or null when unrecognised */
const detectMime = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  return SIGNATURES.find((s) => s.test(buffer))?.mime || null;
};

const DOCUMENT_MIMES = new Set(SIGNATURES.map((s) => s.mime));

module.exports = { detectMime, DOCUMENT_MIMES };
