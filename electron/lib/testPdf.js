// Builds test-print PDFs: color bars, gray ramp, corner marks, a 1-inch ruler square.
const { PDFDocument, StandardFonts, rgb, cmyk } = require('pdf-lib');

async function makeTestPdf({ widthIn = 8.5, heightIn = 11, title = 'InkSign Test Print', subtitle = '' } = {}) {
  const W = widthIn * 72, H = heightIn * 72;
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('InkSign');
  const page = doc.addPage([W, H]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const m = 36;

  page.drawText(title, { x: m, y: H - m - 20, size: 20, font: bold, color: rgb(0.1, 0.1, 0.1) });
  page.drawText(subtitle || new Date().toLocaleString(), { x: m, y: H - m - 38, size: 10, font: reg, color: rgb(0.3, 0.3, 0.3) });

  // CMYK solids + overprints
  const swatches = [
    ['C', cmyk(1, 0, 0, 0)], ['M', cmyk(0, 1, 0, 0)], ['Y', cmyk(0, 0, 1, 0)], ['K', cmyk(0, 0, 0, 1)],
    ['R', cmyk(0, 1, 1, 0)], ['G', cmyk(1, 0, 1, 0)], ['B', cmyk(1, 1, 0, 0)], ['Rich K', cmyk(0.6, 0.4, 0.4, 1)],
  ];
  const sw = (W - 2 * m) / swatches.length;
  const sy = H - m - 110;
  swatches.forEach(([label, color], i) => {
    page.drawRectangle({ x: m + i * sw, y: sy, width: sw - 4, height: 50, color });
    page.drawText(label, { x: m + i * sw + 2, y: sy - 12, size: 8, font: reg, color: rgb(0.2, 0.2, 0.2) });
  });

  // Gray ramp 0-100%
  const steps = 11, gw = (W - 2 * m) / steps, gy = sy - 70;
  for (let i = 0; i < steps; i++) {
    page.drawRectangle({ x: m + i * gw, y: gy, width: gw, height: 36, color: cmyk(0, 0, 0, i / 10) });
    page.drawText(`${i * 10}%`, { x: m + i * gw + 2, y: gy - 12, size: 7, font: reg, color: rgb(0.2, 0.2, 0.2) });
  }

  // 1-inch measuring square
  const sq = 72, sqy = Math.max(m + 20, gy - 40 - sq);
  page.drawRectangle({ x: m, y: sqy, width: sq, height: sq, borderColor: rgb(0, 0, 0), borderWidth: 0.75 });
  page.drawText('1 in. square — measure me', { x: m + sq + 10, y: sqy + sq / 2 - 4, size: 9, font: reg });

  // Corner marks
  const L = 18;
  for (const [cx, cy, dx, dy] of [[12, 12, 1, 1], [W - 12, 12, -1, 1], [12, H - 12, 1, -1], [W - 12, H - 12, -1, -1]]) {
    page.drawLine({ start: { x: cx, y: cy }, end: { x: cx + dx * L, y: cy }, thickness: 0.75 });
    page.drawLine({ start: { x: cx, y: cy }, end: { x: cx, y: cy + dy * L }, thickness: 0.75 });
  }
  return Buffer.from(await doc.save());
}

module.exports = { makeTestPdf };
