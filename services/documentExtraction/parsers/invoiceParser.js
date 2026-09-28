'use strict';
/**
 * services/documentExtraction/parsers/invoiceParser.js
 *
 * Rule-based reader for Indian GST tax invoices and proforma invoices /
 * quotations. Works on the positioned layout (see ../layout.js), so it copes
 * with the common generators (Zoho, Tally, Busy, Vyapar, Excel/Word exports)
 * and with OCR output from photos.
 *
 * Field strategy, strongest signal first:
 *   number / dates   → labelled value ("Invoice#", "Invoice Date", "Due Date")
 *   seller (vendor)  → the header block above "Bill To"/"Buyer" — its company
 *                      line and its GSTIN; the buyer's GSTIN is never used
 *   total            → "Total in words" cross-checked against labelled totals
 *   taxable + taxes  → summary lines ("CGST 9% … 2,079.00"), else the tax
 *                      columns of the Sub Total row, else derived from
 *                      total − taxable and the intra/inter-state rule
 */
const {
  collapse, findAmounts, findDates, parseDate, fiscalPeriod, findGstins, isValidGstin,
  wordsToAmount, findLabelValue, findLineIndex,
} = require('./primitives');

// ── Vocabulary ────────────────────────────────────────────────────────────────
const BUYER_SECTION = [/\b(?:bill(?:ed)?\s*to|buyer|customer\s*(?:name|details)?|invoice\s*to|details\s*of\s*(?:receiver|recipient)|ship(?:ped)?\s*to|consignee|to\s*,?\s*$)\b/i];

const COMPANY_SUFFIX = /\b(?:pvt|private|ltd|limited|llp|inc|co\.|company|enterprises?|traders?|trading|industries|studios?|solutions|services|agenc(?:y|ies)|associates|corporation|corp|exports?|imports?|packag(?:ing|ers)|print(?:s|ers|ing)?|creations?|international|group|mart|store|boxes|gifts?|&\s*co)\b/i;

const NOT_A_NAME = /\b(?:tax\s*invoice|proforma|pro\s*forma|invoice|quotation|quote|estimate|original|duplicate|triplicate|recipient|gstin|gst\s*no|pan|cin|phone|mobile|tel|email|e-mail|www\.|http|state\s*code|place\s*of\s*supply|page\s*\d|powered\s*by|authori[sz]ed|signature|balance\s*due|bill\s*to|ship\s*to)\b/i;

const NUMBER_LABELS = {
  invoice: [
    /\b(?:tax\s*)?invoice\s*(?:no\.?|number|num\.?|#)/i,
    /\binv\.?\s*(?:no\.?|#)/i,
    /\bbill\s*(?:no\.?|number|#)/i,
    /\binvoice\s*:/i,
  ],
  pi: [
    /\bpro\s*-?\s*forma\s*(?:invoice)?\s*(?:no\.?|number|#)/i,
    /\bp\.?\s*i\.?\s*(?:no\.?|number|#)/i,
    /\b(?:quote|quotation|estimate|offer)\s*(?:no\.?|number|ref\.?|#)/i,
    /\b(?:tax\s*)?invoice\s*(?:no\.?|number|#)/i,
    /\border\s*(?:no\.?|number|#)/i,
  ],
};
const NUMBER_FALLBACK = /\b(?:INV|PI|PINV|PRO|PF|QT|QTN|QUO|EST|SO|BILL)[-/]?[A-Z0-9]*[-/]?[A-Z0-9\-/]*\d[A-Z0-9\-/]*\b/i;

const DATE_LABELS = {
  invoice: [/\b(?:invoice|inv|bill)\.?\s*date\b/i, /\bdated?\b/i],
  pi: [/\b(?:pi|pro\s*-?\s*forma|quote|quotation|estimate|order)\s*date\b/i, /\b(?:invoice|inv)\s*date\b/i, /\bdated?\b/i],
};
const DUE_LABELS = [/\bdue\s*date\b/i, /\b(?:expiry|valid(?:ity)?\s*(?:till|until|upto|up\s*to)?)\s*(?:date)?\b/i, /\bpayment\s*due\b/i];

const TOTAL_LABELS = [
  /\bgrand\s*total\b/i,
  /\btotal\s*(?:invoice\s*)?(?:amount|value)\b/i,
  /\binvoice\s*(?:total|value)\b/i,
  /\bnet\s*(?:amount|payable|total)\b/i,
  /\bamount\s*payable\b/i,
  /(?:^|\s)total\b(?!\s*in\s*words)/i,
  /\bbalance\s*due\b/i,
];
const TAXABLE_LABELS = [/\bsub\s*-?\s*total\b/i, /\btotal\s*taxable\s*(?:value|amount)\b/i, /\btaxable\s*(?:value|amount)\b/i];
const WORDS_LINE = [/\b(?:total|amount)\b.*\bin\s*words\b/i, /\b(?:rupees?|indian\s*rupee)\b.*\bonly\b/i];
const BANK_LINE = /\b(?:a\/c|account|acc\.?\s*no|ifsc|bank|branch|upi\s*id|swift)\b/i;

// ── Helpers ───────────────────────────────────────────────────────────────────
const acceptDocNumber = (raw) => {
  const token = collapse(raw).split(/\s+/)[0]?.replace(/^[:#.\-]+|[:,.]+$/g, '');
  if (!token || token.length < 2 || token.length > 40) return null;
  if (!/\d/.test(token) || !/^[A-Z0-9][A-Z0-9\-/_.]*$/i.test(token)) return null;
  if (findDates(token).length) return null;
  return token;
};

const acceptDate = (raw) => parseDate(raw);

/** Money on a line, ignoring percentages; largest last. */
const lineAmounts = (line) => findAmounts(line?.text || '').map((a) => a.value);

const alignedValue = (header, row) => {
  // Segment of `row` whose span overlaps the header segment's column.
  const mid = (header.x0 + header.x1) / 2;
  const hit = row.segments
    .map((s) => ({ s, d: Math.abs((s.x0 + s.x1) / 2 - mid), overlaps: s.x1 >= header.x0 - 15 && s.x0 <= header.x1 + 15 }))
    .filter((c) => c.overlaps)
    .sort((a, b) => a.d - b.d)[0];
  if (!hit) return null;
  const money = findAmounts(hit.s.text);
  if (money.length <= 1) return money[0]?.value ?? null;
  // Adjacent cells can merge into one segment ("26,410.00 ₹3,64,320.00"):
  // estimate each amount's x from its character offset and take the nearest.
  const { x0, x1, text } = hit.s;
  const perChar = (x1 - x0) / Math.max(1, text.length);
  return money
    .map((m) => ({ v: m.value, d: Math.abs(x0 + (m.index + 4) * perChar - mid) }))
    .sort((a, b) => a.d - b.d)[0].v;
};

const round2 = (n) => Math.round(n * 100) / 100;
const near = (a, b) => a != null && b != null && Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.001);

// ── Seller block ──────────────────────────────────────────────────────────────
const detectSeller = (layout, { ownGstins }) => {
  const lines = layout.lines;
  const buyerAt = findLineIndex(layout, BUYER_SECTION);
  const headerEnd = buyerAt > 0 ? buyerAt : Math.max(6, Math.ceil(lines.length * 0.35));
  const header = lines.slice(0, headerEnd);
  const headerText = header.map((l) => l.text).join('\n');

  const allGst = findGstins(layout.text);
  const headerGst = findGstins(headerText);
  const isOwn = (g) => ownGstins.includes(g);
  const vendor_gst = headerGst[0] || allGst.find((g) => !isOwn(g)) || allGst[0] || null;

  // Explicit "Seller/Supplier/From:" label wins.
  const labelled = findLabelValue(layout, [/\b(?:seller|supplier|vendor|from)\s*(?:name)?\s*:/i], {
    accept: (v) => (/[a-z]{3}/i.test(v) && !NOT_A_NAME.test(v) ? collapse(v) : null), below: 1,
  });
  const gstFromHeader = !!headerGst[0];
  if (labelled) return { vendor_name: labelled.value, vendor_gst, buyerAt, gstFromHeader };

  const segs = header.flatMap((l, i) => l.segments.map((s) => ({ text: collapse(s.text), line: i })));
  // Strip OCR debris: stray leading marks ("q:"), and document titles that
  // share the line with the name ("… PRINTERS TAX INVOICE").
  const clean = (t) => t
    .replace(/[^\w&.,()'\-/ ]/g, ' ')
    .replace(/^(?:\s*(?:[a-z]|\W+)\b[:.]?)+\s+/, '')
    .replace(/(?:\s+(?:tax|invoice|original|duplicate|triplicate|proforma|quotation|estimate|bill))+\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const nameLike = (t) => t.length >= 3 && t.length <= 70 && /[a-z]{3}/i.test(t) && !NOT_A_NAME.test(t)
    && !/@|\d{5,}|^\d/.test(t) && (t.match(/\d/g) || []).length <= 3;

  const withSuffix = segs.find((s) => nameLike(s.text) && COMPANY_SUFFIX.test(s.text));
  const firstClean = segs.find((s) => s.line < 6 && nameLike(s.text) && s.text.split(' ').length <= 8);
  const pick = withSuffix && (!firstClean || withSuffix.line <= firstClean.line + 3) ? withSuffix : firstClean || withSuffix;

  return { vendor_name: pick ? clean(pick.text) : null, vendor_gst, buyerAt, gstFromHeader };
};

// ── Totals & taxes ────────────────────────────────────────────────────────────
const detectTotals = (layout, { ownGstins, vendor_gst }) => {
  const lines = layout.lines;
  const text = layout.text;

  // Amount in words — the most reliable total on a GST invoice.
  let wordsTotal = null;
  const wAt = findLineIndex(layout, WORDS_LINE);
  if (wAt >= 0) {
    // The words can wrap over several lines ("…Three Hundred" ⏎ "Twenty Only").
    const parts = [];
    for (let i = wAt; i < Math.min(lines.length, wAt + 4); i++) {
      parts.push(lines[i].text);
      if (/\bonly\b/i.test(lines[i].text)) break;
    }
    const chunk = parts.join(' ').replace(/^.*?in\s*words\s*:?/i, '');
    wordsTotal = wordsToAmount(chunk);
    if (!wordsTotal || wordsTotal < 1) wordsTotal = null;
  }

  // Labelled totals. A label on a line of its own ("Grand Total" ⏎ "₹ 11,800")
  // may take its value from the next line; a table header row that merely
  // contains a "Total" column may not.
  const labelled = [];
  for (const re of TOTAL_LABELS) {
    lines.forEach((l, i) => {
      if (!re.test(l.text) || /in\s*words/i.test(l.text)) return;
      const own = lineAmounts(l);
      const vals = own.length ? own : l.segments.length <= 2 ? lineAmounts(lines[i + 1]) : [];
      if (vals.length) labelled.push(Math.max(...vals));
    });
  }

  // The document total is the largest labelled total ("Balance Due" can be
  // lower after an advance; a "Total" column cell is only one line item).
  let total_amount = null;
  // Words confirm which printed total is right; the printed figure itself is
  // exact (words can be cut off or OCR'd imperfectly).
  const confirmed = wordsTotal ? labelled.filter((v) => near(v, wordsTotal)) : [];
  if (confirmed.length) total_amount = Math.max(...confirmed);
  else if (labelled.length) total_amount = Math.max(...labelled);
  else if (wordsTotal) total_amount = wordsTotal;
  else {
    const rupee = findAmounts(text).filter((a) => a.hasCurrency).map((a) => a.value);
    if (rupee.length) total_amount = Math.max(...rupee);
  }

  // Taxable value — first amount on the "Sub Total" / "Taxable value" row.
  let taxable_amount = null;
  let subtotalRow = null;
  for (const re of TAXABLE_LABELS) {
    const i = lines.findIndex((l) => re.test(l.text) && lineAmounts(l).length);
    if (i >= 0) {
      subtotalRow = lines[i];
      const vals = lineAmounts(lines[i]).filter((v) => !total_amount || v < total_amount || lineAmounts(lines[i]).length === 1);
      taxable_amount = vals.length ? vals[0] : null;
      break;
    }
  }

  // Explicit tax amounts.
  const taxes = { cgst: null, sgst: null, igst: null };
  for (const key of Object.keys(taxes)) {
    const label = new RegExp(`\\b${key}\\b`, 'i');
    // 1. Summary line: "CGST @ 9%   2,079.00" / "IGST18 (18%)  5,463.00"
    const summary = lines.find((l) => label.test(l.text) && lineAmounts(l).length && !TAXABLE_LABELS.some((r) => r.test(l.text)));
    if (summary) {
      const vals = lineAmounts(summary);
      taxes[key] = vals[vals.length - 1];
      continue;
    }
    // 2. Tax column of the Sub Total row.
    if (subtotalRow) {
      const headerLine = lines.find((l) => l.segments.some((s) => label.test(s.text)));
      const headerSeg = headerLine?.segments.find((s) => label.test(s.text));
      if (headerSeg) {
        const v = alignedValue(headerSeg, subtotalRow);
        if (v != null && v !== taxable_amount && v !== total_amount) taxes[key] = v;
      }
    }
  }
  // CGST and SGST are always equal halves. If the two readings disagree, keep
  // the one that isn't really the taxable value or the grand total.
  if (taxes.cgst != null && taxes.sgst != null && taxes.cgst !== taxes.sgst) {
    const plausible = [taxes.cgst, taxes.sgst].filter((v) => v !== total_amount && v !== taxable_amount && (!total_amount || v < total_amount * 0.5));
    if (plausible.length === 1) taxes.cgst = taxes.sgst = plausible[0];
    else if (plausible.length === 2) taxes.cgst = taxes.sgst = Math.min(...plausible);
  }
  if (taxes.cgst != null && taxes.sgst == null) taxes.sgst = taxes.cgst;
  if (taxes.sgst != null && taxes.cgst == null) taxes.cgst = taxes.sgst;

  // 3. Derive from total − taxable when the document only shows rates.
  const explicitTax = (taxes.cgst || 0) + (taxes.sgst || 0) + (taxes.igst || 0);
  if (!explicitTax && total_amount && taxable_amount && total_amount > taxable_amount) {
    const tax = round2(total_amount - taxable_amount);
    const mentionsIgst = /\bIGST\b/i.test(text);
    const mentionsCgst = /\b[CS]GST\b/i.test(text);
    const buyerGst = findGstins(text).find((g) => g !== vendor_gst) || ownGstins[0];
    const sameState = vendor_gst && buyerGst ? vendor_gst.slice(0, 2) === buyerGst.slice(0, 2) : null;
    const intra = mentionsCgst && !mentionsIgst ? true : mentionsIgst && !mentionsCgst ? false : sameState;
    if (intra === true) { taxes.cgst = round2(tax / 2); taxes.sgst = round2(tax - taxes.cgst); }
    else if (intra === false) taxes.igst = tax;
  }

  return { total_amount, taxable_amount, ...taxes, _wordsTotal: wordsTotal };
};

// ── Public ────────────────────────────────────────────────────────────────────
/**
 * @param {object} layout
 * @param {'invoice'|'pi'} docType
 * @param {{ ownGstins: string[] }} ctx
 */
const parseInvoice = (layout, docType = 'invoice', ctx = { ownGstins: [] }) => {
  const type = docType === 'pi' ? 'pi' : 'invoice';

  const seller = detectSeller(layout, ctx);

  const num = findLabelValue(layout, NUMBER_LABELS[type], { accept: acceptDocNumber, below: 1 });
  const invoice_number = num?.value || acceptDocNumber(layout.text.match(NUMBER_FALLBACK)?.[0] || '') || null;

  const due = findLabelValue(layout, DUE_LABELS, { accept: acceptDate, below: 1 });
  const dated = findLabelValue(layout, DATE_LABELS[type], { accept: acceptDate, below: 1 });
  const date = dated?.value || findDates(layout.text).find((d) => d !== due?.value) || null;

  const totals = detectTotals(layout, { ownGstins: ctx.ownGstins, vendor_gst: seller.vendor_gst });

  const subject = findLabelValue(layout, [/^\s*subject\s*:?/i, /^\s*(?:kind\s*attn|ref(?:erence)?)\s*:/i], {
    accept: (v) => (/[a-z]{3}/i.test(v) ? collapse(v).slice(0, 200) : null), below: 1,
  })?.value || null;

  // Bank details: the short "label : value" segments (A/c No, IFSC, Bank Name…),
  // not whole lines — terms & conditions often sit in the next column.
  // A label segment without its value ("A/c No.") is joined with the segment
  // beside it (": 10104891303").
  const bankLines = [...new Set(layout.lines.flatMap((l) => {
    const segs = l.segments.map((seg) => collapse(seg.text));
    return segs.map((t, i) => (!/:\s*\S/.test(t) && segs[i + 1] && /^[:\-]/.test(segs[i + 1]) ? `${t} ${segs[i + 1]}` : t));
  }).filter((t) => BANK_LINE.test(t) && !/^[:\-]/.test(t) && t.length <= 90 && !/\b(?:bill|ship)\s*to\b|details$/i.test(t)))]
    .slice(0, 6);

  const { financialYear, month } = fiscalPeriod(date);

  // Which values came from a printed label or a checksum (vs. a fallback guess);
  // used to merge two OCR passes of the same image.
  const _strong = [
    num && 'invoice_number', dated && 'date', due && 'due_date',
    seller.gstFromHeader && isValidGstin(seller.vendor_gst || '') && 'vendor_gst', // a Bill-To fallback is never "strong"
    totals._wordsTotal && totals.total_amount === totals._wordsTotal && 'total_amount',
  ].filter(Boolean);

  return {
    _strong,
    vendor_name: seller.vendor_name,
    vendor_gst: seller.vendor_gst,
    invoice_number,
    date,
    due_date: due?.value || null,
    total_amount: totals.total_amount,
    taxable_amount: totals.taxable_amount,
    cgst: totals.cgst,
    sgst: totals.sgst,
    igst: totals.igst,
    financialYear,
    month,
    subject,
    bank_details: bankLines.length ? bankLines.join('\n') : null,
  };
};

module.exports = { parseInvoice };
