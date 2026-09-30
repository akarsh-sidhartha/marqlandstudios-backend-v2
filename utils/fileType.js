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
const IMAGE_MIMES = new Set([...DOCUMENT_MIMES].filter((m) => m.startsWith('image/')));

// Office formats have no signature of their own: OOXML is a ZIP, legacy
// Office is an OLE compound file. The container is sniffed from the bytes and
// the extension only picks which Office type it is — a renamed .exe still fails.
const ZIP = (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const OLE = (b) => b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
const OFFICE_BY_EXT = {
  xlsx: [ZIP, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  docx: [ZIP, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  pptx: [ZIP, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  xls: [OLE, 'application/vnd.ms-excel'],
  doc: [OLE, 'application/msword'],
  ppt: [OLE, 'application/vnd.ms-powerpoint'],
};
const TEXT_BY_EXT = { csv: 'text/csv', txt: 'text/plain' };
const looksLikeText = (b) => !b.subarray(0, 4096).includes(0);

/**
 * Type of a general order attachment: any document/image, Office file, or
 * plain CSV/TXT. Returns null for anything else (executables, HTML, …).
 */
const detectAttachmentMime = (buffer, filename = '') => {
  const known = detectMime(buffer);
  if (known) return known;
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  const ext = String(filename).toLowerCase().split('.').pop();
  const office = OFFICE_BY_EXT[ext];
  if (office && office[0](buffer)) return office[1];
  if (TEXT_BY_EXT[ext] && looksLikeText(buffer)) return TEXT_BY_EXT[ext];
  return null;
};

module.exports = { detectMime, detectAttachmentMime, DOCUMENT_MIMES, IMAGE_MIMES };
