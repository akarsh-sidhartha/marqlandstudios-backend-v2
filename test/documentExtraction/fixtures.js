'use strict';
/**
 * Builds realistic test PDFs in memory (no binaries in git). Layouts mirror
 * Zoho Books' tax-invoice and quote templates: header block, Bill To / Ship
 * To columns, an item table with tax columns and a Sub Total row, and the
 * "Total In Words" line.
 */
const { PDFDocument, StandardFonts } = require('pdf-lib');

// Helvetica (WinAnsi) can't encode "₹", so amounts use "Rs." — the extractor
// normalises both to the same symbol, exactly as it does for real PDFs.
const draw = async (rows) => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const [x, y, text, size = 8] of rows) page.drawText(text, { x, y: 842 - y, size, font });
  return Buffer.from(await pdf.save());
};

const zohoInvoicePdf = () => draw([
  [40, 50, 'Marqland Studios', 14],
  [460, 50, 'TAX INVOICE', 12],
  [40, 66, 'TRILOK, 2nd cross 7th block New Post Office Road'],
  [40, 76, 'Bangalore, Karnataka - 560070, India'],
  [40, 86, '9980069897   info@marqland.com | www.marqlandstudios.com'],
  [40, 96, 'GSTIN: 29ACGFM9082Q1Z5'],
  [40, 130, 'Invoice#:'], [120, 130, ': INV-26-27/000016'],
  [40, 142, 'Invoice Date'], [120, 142, ': 21/08/2026'],
  [40, 170, 'Bill To'], [300, 170, 'Ship To'],
  [40, 182, 'Ovation Production Pvt Ltd.'], [300, 182, 'SeventhAvenue Eventz Pvt Ltd'],
  [40, 194, 'PRACHI VIHAR, BANKERS ENCLAVE, BHUBANESWAR'], [300, 194, 'IRC Village, Nayapalli'],
  [40, 206, 'GSTIN 21AACCO5117B1Z8'],
  [40, 230, 'Subject :'],
  [40, 242, 'WEIGHING SCALE Order'],
  [40, 270, '#'], [60, 270, 'Item & Description'], [250, 270, 'Qty'], [290, 270, 'Rate'], [340, 270, 'Amount'], [400, 270, 'Taxable Amount'], [475, 270, 'IGST'], [525, 270, 'Total'],
  [40, 290, '1'], [60, 290, 'Goodies'], [250, 290, '62 pcs'], [290, 290, '425.00'], [340, 290, '26,350.00'], [400, 290, '26,350.00'], [475, 290, '18%'], [525, 290, '31,093.00'],
  [60, 302, 'WEIGHING SCALE'],
  [60, 314, 'HSN: 84231000'],
  [40, 334, '2'], [60, 334, 'Transportation Services'], [250, 334, '1'], [290, 334, '4,000.00'], [340, 334, '4,000.00'], [400, 334, '4,000.00'], [475, 334, '18%'], [525, 334, '4,720.00'],
  [60, 346, 'SAC: 996511'],
  [290, 372, 'Sub Total'], [340, 372, '30,350.00'], [400, 372, 'Rs.30,350.00'], [475, 372, '5,463.00'], [525, 372, 'Rs.35,813.00'],
  [400, 400, 'Balance Due'], [525, 400, 'Rs.35,813.00'],
  [40, 430, 'Total In Words'],
  [40, 442, 'Indian Rupee Thirty-Five Thousand Eight Hundred Thirteen Only'],
  [40, 470, 'Notes'],
  [40, 482, 'Name of Account - MARQLAND STUDIOS LLP.'],
  [40, 494, 'Account Number - 45188854942'],
  [40, 506, 'Branch/IFSC Code - START UP BRANCH/SBIN0064074'],
  [420, 540, 'Authorized Signature'],
]);

const zohoQuotePdf = () => draw([
  [40, 50, 'Marqland Studios', 14],
  [480, 50, 'QUOTE', 12],
  [40, 66, 'TRILOK, 2nd cross 7th block New Post Office Road opp road of Mahaveer Marketing Jayanagar'],
  [40, 76, 'Bangalore, Karnataka - 560070, India 9980069897 info@marqland.com'],
  [40, 86, 'GSTIN: 29ACGFM9082Q1Z5'],
  [40, 120, 'Quote#'], [120, 120, ': QT-26-27/000053'],
  [40, 132, 'Quote Date'], [120, 132, ': 23/09/2026'],
  [40, 160, 'Bill To'], [300, 160, 'Ship To'],
  [40, 172, 'Microsoft India (R&D) Private Limited'],
  [40, 184, 'Sy no 7/1, 7/2, 8/1A Prestige Ferns Galaxy, outer ring road'], [300, 184, 'Bangalore'],
  [40, 196, 'Bangalore 560103 Karnataka'], [300, 196, '560103 Karnataka'],
  [40, 208, 'GSTIN 29AABCM6358F1ZA'],
  [40, 232, 'Subject :'],
  [40, 244, 'Hydro Boil Mini order by Tejaswini'],
  [40, 270, '#'], [55, 270, 'Item & Description'], [215, 270, 'HSN/SAC'], [260, 270, 'Qty'], [295, 270, 'Rate'], [340, 270, 'Taxable Amount'], [410, 270, 'CGST'], [455, 270, 'SGST'], [510, 270, 'Total'],
  [40, 290, '1'], [55, 290, 'Goodies Hydro Boil Mini with branding'], [215, 290, '8308'], [260, 290, '21 pcs'], [295, 290, '1,100.00'], [340, 290, '23,100.00'], [410, 290, '9%'], [455, 290, '9%'], [510, 290, '27,258.00'],
  [290, 320, 'Sub Total'], [340, 320, 'Rs.23,100.00'], [410, 320, '2,079.00'], [455, 320, '2,079.00'], [510, 320, 'Rs.27,258.00'],
  [40, 350, 'Total In Words'],
  [40, 362, 'Indian Rupee Twenty-Seven Thousand Two Hundred Fifty-Eight Only'],
  [40, 390, 'Notes'],
  [40, 402, 'Looking forward for your business.'],
  [420, 440, 'Authorized Signature'],
]);

/** A scanned-style PDF: no text layer, only a drawn rectangle. */
const blankPdf = async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]).drawRectangle({ x: 20, y: 20, width: 50, height: 50 });
  return Buffer.from(await pdf.save());
};

/**
 * Multi-item quote in Zoho's layout: a generic item title ("Goodies") with
 * the real product on the line below, units under the quantity, a
 * description that wraps onto two lines, and a service row.
 */
const zohoMultiItemQuotePdf = () => draw([
  [40, 50, 'Marqland Studios', 14],
  [480, 50, 'QUOTE', 12],
  [40, 86, 'GSTIN: 29ACGFM9082Q1Z5'],
  [40, 120, 'Quote#'], [120, 120, ': QT-26-27/000099'],
  [40, 132, 'Quote Date'], [120, 132, ': 07/09/2026'],
  [40, 160, 'Bill To'], [300, 160, 'Ship To'],
  [40, 172, 'Example Client Pvt Ltd'],
  [40, 232, 'Subject :'],
  [40, 244, 'Goodies - Team Offsite'],
  [48, 270, '#'], [66, 270, 'Item & Description'], [193, 270, 'HSN/SAC'], [263, 270, 'Qty'], [315, 270, 'Rate'], [363, 270, 'Amount'], [429, 270, 'CGST'], [485, 270, 'SGST'], [540, 270, 'Total'],
  [48, 290, '1'], [65, 290, 'Goodies'], [191, 290, '8308'], [274, 290, '1'], [303, 290, '5,278.00'], [364, 290, '5,278.00'], [439, 290, '9%'], [495, 290, '9%'], [531, 290, '6,228.04'],
  [65, 300, 'Stand Mixer Deluxe'], [267, 300, 'pcs'],
  [48, 320, '2'], [65, 320, 'Goodies'], [191, 320, '8308'], [274, 320, '2'], [303, 320, '4,716.00'], [364, 320, '9,432.00'], [439, 320, '9%'], [495, 320, '9%'], [527, 320, '11,129.76'],
  [65, 330, 'Travel Backpack 20L'], [267, 330, 'pcs'],
  [65, 340, '- Black'],
  [48, 360, '3'], [65, 360, 'Transportation Services'], [191, 360, '996511'], [274, 360, '1'], [303, 360, '2,100.00'], [364, 360, '2,100.00'], [439, 360, '9%'], [495, 360, '9%'], [531, 360, '2,478.00'],
  [65, 370, 'For all units of goodies'],
  [65, 380, 'shipments'],
  [298, 400, 'Sub Total'], [355, 400, 'Rs.16,810.00'], [420, 400, '1,512.90'], [475, 400, '1,512.90'], [522, 400, 'Rs.19,835.80'],
  [342, 415, 'Rounding'], [543, 415, '0.20'],
  [46, 425, 'Total In Words'],
  [342, 432, 'Total'], [520, 432, 'Rs.19,836.00'],
  [40, 460, 'Notes'],
  [40, 472, 'Looking forward for your business.'],
]);

module.exports = { zohoInvoicePdf, zohoQuotePdf, zohoMultiItemQuotePdf, blankPdf };
