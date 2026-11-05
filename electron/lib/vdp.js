// Variable data printing: one page per row of data (names, numbers…) on top of a template,
// then imposed like any multi-page job. Sizes in inches; text positions from the top-left of the finished piece.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const FONTS = {
  'Helvetica': StandardFonts.Helvetica, 'Helvetica Bold': StandardFonts.HelveticaBold,
  'Times': StandardFonts.TimesRoman, 'Times Bold': StandardFonts.TimesRomanBold,
  'Courier': StandardFonts.Courier, 'Courier Bold': StandardFonts.CourierBold,
};

function hexRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '#000000'));
  return m ? rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255) : rgb(0, 0, 0);
}

// Fill {Column} placeholders from a row: "Ticket #{Number}" → "Ticket #0042".
function fill(text, row) {
  return String(text || '').replace(/\{([^}]+)\}/g, (_m, k) => (row[k.trim()] ?? ''));
}

async function buildVdp({ template, rows, fields, widthIn, heightIn, bleedIn = 0 }) {
  if (!rows || !rows.length) throw new Error('No data rows.');
  if (rows.length > 5000) throw new Error('More than 5,000 rows — split the list.');
  const out = await PDFDocument.create();
  out.setCreator('InkSign');
  const W = (widthIn + 2 * bleedIn) * 72, H = (heightIn + 2 * bleedIn) * 72, B = bleedIn * 72;

  let bg = null;
  if (template && template.pdf) {
    const src = await PDFDocument.load(template.pdf, { ignoreEncryption: true });
    [bg] = await out.embedPdf(src, [0]);
    bg.kind = 'pdf';
  } else if (template && template.image) {
    bg = template.image.png ? await out.embedPng(template.image.bytes) : await out.embedJpg(template.image.bytes);
    bg.kind = 'img';
  }
  // Installed fonts (TrueType/OpenType files) are embedded, so the printer prints exactly this font.
  const fontCache = {};
  const font = async (f) => {
    const key = f.fontFile || f.font;
    if (fontCache[key]) return fontCache[key];
    if (f.fontFile) {
      out.registerFontkit(require('@pdf-lib/fontkit'));
      fontCache[key] = await out.embedFont(require('fs').readFileSync(f.fontFile), { subset: true });
    } else fontCache[key] = await out.embedFont(FONTS[f.font] || StandardFonts.Helvetica);
    return fontCache[key];
  };

  for (const row of rows) {
    const page = out.addPage([W, H]);
    if (bg) {
      if (bg.kind === 'pdf') page.drawPage(bg, { x: 0, y: 0, width: W, height: H });
      else page.drawImage(bg, { x: 0, y: 0, width: W, height: H });
    }
    for (const f of fields || []) {
      const text = fill(f.text, row);
      if (!text) continue;
      const fnt = await font(f);
      const size = Math.max(4, Number(f.sizePt) || 12);
      const w = fnt.widthOfTextAtSize(text, size);
      let x = B + (Number(f.xIn) || 0) * 72;
      if (f.align === 'center') x -= w / 2; else if (f.align === 'right') x -= w;
      const y = H - B - (Number(f.yIn) || 0) * 72 - size * 0.75; // yIn = top of the text
      page.drawText(text, { x, y, size, font: fnt, color: hexRgb(f.color) });
    }
  }
  return Buffer.from(await out.save());
}

// Numbered rows: 1..N with optional padding (0042) — for tickets, raffle stubs, invoices.
function numberRows({ start = 1, end = 100, pad = 0, column = 'Number' }) {
  const rows = [];
  for (let n = Number(start); n <= Number(end) && rows.length < 5000; n++) rows.push({ [column]: String(n).padStart(Number(pad) || 0, '0') });
  return rows;
}

module.exports = { buildVdp, numberRows, fill, FONTS: Object.keys(FONTS) };
