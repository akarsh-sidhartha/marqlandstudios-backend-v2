'use strict';
/**
 * services/documentExtraction/parsers/paymentParser.js
 *
 * Reads bank / UPI payment confirmations — net-banking "Payment Initiated"
 * screens (HDFC, ICICI, SBI, Axis, IDFC…), UPI receipts (GPay, PhonePe,
 * Paytm, BHIM) and emailed payment advices.
 *
 * Extracts: amount, payment date, mode (NEFT/RTGS/IMPS/UPI/cheque/cash),
 * bank reference / UTR, payee name, and the note/remark.
 */
const {
  collapse, findAmounts, findDates, parseDate, wordsToAmount, findLabelValue, findLineIndex,
} = require('./primitives');

const LABEL_WORD = /^(?:to|from|amount|invoice|bill|gstin?|date|time|status|mode|note|remarks?|reference|ref|utr|paid|sent|debited|credited|transfer\s*mode|transfer\s*date|current\s*a\/c|savings\s*a\/c|a\/c|account)\b/i;

const MODES = [
  ['rtgs', /\bRTGS\b/i],
  ['neft', /\bNEFT\b/i],
  ['imps', /\bIMPS\b/i],
  ['upi', /\bUPI\b|@(?:ok\w+|ybl|paytm|ibl|axl|upi)\b|google\s*pay|phonepe|paytm|bhim/i],
  ['cheque', /\bcheque\b|\bchq\b/i],
  ['cash', /\bcash\b/i],
];

const acceptMoney = (raw) => {
  const vals = findAmounts(raw).map((a) => a.value).filter((v) => v > 0);
  return vals.length ? vals[0] : null;
};

const acceptRef = (raw) => {
  const token = collapse(raw).split(/\s+/).find((t) => /^[A-Z0-9]{8,30}$/i.test(t) && /\d{4,}/.test(t));
  return token ? token.toUpperCase() : null;
};

const acceptName = (ownNames) => (raw) => {
  const v = collapse(raw).replace(/[^\w&.,()' -]/g, '').trim();
  if (!v || !/[a-z]{3}/i.test(v) || LABEL_WORD.test(v) || /\d{4,}/.test(v)) return null;
  if (ownNames.some((n) => v.toLowerCase().includes(n))) return null;
  return v.slice(0, 80);
};

/**
 * @param {object} layout
 * @param {{ ownNames: string[] }} ctx — lower-case names of our own company (the payer)
 */
const parsePayment = (layout, ctx = { ownNames: [] }) => {
  const text = layout.text;

  // Amount: labelled → headline ("Payment of ₹…", "Paid ₹…") → words → largest ₹ figure.
  const labelled = findLabelValue(layout, [
    /\b(?:amount|amt)\s*(?:paid|transferred|debited|sent)?\b/i,
    /\b(?:paid|debited|transferred|sent)\b/i,
    /\bpayment\s*(?:initiated|successful|of|for|done)\b/i,
  ], { accept: acceptMoney, below: 1 });
  let amount = labelled?.value ?? null;
  if (amount == null) {
    const wAt = findLineIndex(layout, [/\brupees?\b.*\bonly\b/i]);
    if (wAt >= 0) amount = wordsToAmount(layout.lines[wAt].text);
  }
  if (amount == null) {
    const rupee = findAmounts(text).filter((a) => a.hasCurrency).map((a) => a.value);
    if (rupee.length) amount = Math.max(...rupee);
  }

  const dated = findLabelValue(layout, [
    /\b(?:transfer|transaction|txn|payment|value|debit|paid\s*on)\s*(?:date|on)\b/i,
    /\bdate\s*(?:&|and)\s*time\b/i,
    /\bdate\b/i,
  ], { accept: parseDate, below: 1 });
  const payment_date = dated?.value || findDates(text)[0] || null;

  const payment_mode = MODES.find(([, re]) => re.test(text))?.[0] || null;

  const ref = findLabelValue(layout, [
    /\butr\s*(?:no\.?|number)?\b/i,
    /\b(?:upi\s*)?(?:ref(?:erence)?|transaction|txn)\s*(?:id|no\.?|number)\b/i,
    /\brrn\b/i,
    /\bcheque\s*(?:no\.?|number)\b/i,
  ], { accept: acceptRef, below: 1 });
  const bank_ref = ref?.value
    || text.match(/\b[A-Z]{4}[A-Z0-9]\d{6,}[A-Z0-9]*\b/)?.[0] // NEFT/RTGS UTR: IFSC bank code + digits
    || text.match(/(?<!\d)\d{12}(?!\d)/)?.[0]                 // UPI RRN
    || null;

  const payee = findLabelValue(layout, [
    /\b(?:paid|sent)\s*to\b/i,
    /\b(?:beneficiary|payee|recipient)\s*(?:name)?\b/i,
    /\bcredited\s*to\b/i,
    /^to\b/i,
  ], { accept: acceptName(ctx.ownNames), below: 1 });

  const note = findLabelValue(layout, [/\b(?:note|remarks?|narration|purpose|message|description)\b/i], {
    accept: (v) => (collapse(v) && !LABEL_WORD.test(v) ? collapse(v).slice(0, 200) : null), below: 1,
  });

  const _strong = [labelled && 'amount', dated && 'payment_date', ref && 'bank_ref', payee && 'payee_name'].filter(Boolean);

  return {
    _strong,
    amount,
    payment_date,
    payment_mode,
    bank_ref,
    payee_name: payee?.value || null,
    remarks: note?.value || null,
  };
};

module.exports = { parsePayment };
