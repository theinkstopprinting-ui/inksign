// Customer proof: the design on a letter-size sheet (landscape or portrait to suit it) with the job name,
// finished size, colors and date across the top, a faint PROOF watermark over the art, and a line asking
// the customer to check spelling, colors and size before approving.
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const { buildDesignPdf } = require('./designPdf');

const PT = 72 / 25.4;

async function buildProofPdf(scene, info = {}) {
  const art = (await buildDesignPdf(scene, { cut: info.showCut ? 'spot' : 'omit', title: info.title })).pdf;
  const doc = await PDFDocument.create();
  doc.setTitle(`${info.title || 'Design'} — proof`);
  doc.setCreator('InkSign');
  const wide = scene.w >= scene.h;
  const W = (wide ? 11 : 8.5) * 72, H = (wide ? 8.5 : 11) * 72;
  const page = doc.addPage([W, H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [emb] = await doc.embedPdf(art);
  const m = 36, top = 92, bottom = 52;
  const k = Math.min((W - 2 * m) / emb.width, (H - top - bottom) / emb.height);
  const w = emb.width * k, h = emb.height * k;
  const x = (W - w) / 2, y = bottom + (H - top - bottom - h) / 2;
  page.drawRectangle({ x, y, width: w, height: h, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 0.5, color: rgb(1, 1, 1) });
  page.drawPage(emb, { x, y, width: w, height: h });
  // watermark
  const wm = 'PROOF';
  const size = Math.min(w, h) * 0.32;
  const tw = bold.widthOfTextAtSize(wm, size);
  page.drawText(wm, { x: W / 2 - (tw / 2) * 0.82, y: H / 2 - (tw / 2) * 0.55 - size * 0.3, size, font: bold, color: rgb(0.85, 0.1, 0.1), opacity: 0.12, rotate: degrees(wide ? 28 : 45) });
  // header
  const ink = rgb(0.1, 0.1, 0.12), grey = rgb(0.4, 0.4, 0.45);
  page.drawText(String(info.title || 'Design').slice(0, 80), { x: m, y: H - 44, size: 18, font: bold, color: ink });
  const fmtIn = (mm) => `${(mm / 25.4).toFixed(2)}"`;
  const line2 = [`Finished size ${fmtIn(info.wMm || scene.w)} wide x ${fmtIn(info.hMm || scene.h)} tall`, info.material, info.order ? `Order ${info.order}` : '', new Date().toLocaleDateString()].filter(Boolean).join('   ·   ');
  page.drawText(line2.slice(0, 140), { x: m, y: H - 64, size: 10, font, color: grey });
  if (info.colors && info.colors.length) page.drawText(`Colors: ${info.colors.join(', ')}`.slice(0, 160), { x: m, y: H - 80, size: 10, font, color: grey });
  if (info.shop) { const sw = font.widthOfTextAtSize(info.shop, 10); page.drawText(info.shop, { x: W - m - sw, y: H - 44, size: 10, font, color: grey }); }
  // footer
  page.drawText('Please check spelling, colors and size carefully. Production starts once you approve. Colors on screen may differ from the finished piece.', { x: m, y: 26, size: 8.5, font, color: grey });
  return Buffer.from(await doc.save());
}

module.exports = { buildProofPdf };
