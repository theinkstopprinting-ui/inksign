// Builds the PDF that actually goes to the printer from the Print window's layout: the job (any PDF page)
// placed, scaled, turned, tiled and repeated on a page as wide as the used part of the media.
// Coordinates come from src/lib/printPlan.js: mm, x from the RIGHT edge of the printable area,
// y along the feed from the LEADING edge. The PDF page's bottom is the leading edge (the HP prints
// the bottom row first) and its right edge is the printer's origin (hpLatexJob mirrors x),
// so the page prints exactly where the preview shows it.
const { PDFDocument, PDFName, PDFNumber, PDFOperator, StandardFonts, rgb } = require('pdf-lib');

const PT = 72 / 25.4, MMPT = 25.4 / 72;
const n = (v) => PDFNumber.of(Math.round(v * 10000) / 10000);
const op = (o, a = []) => PDFOperator.of(o, a);

/**
 * src: PDF bytes. lay: { pieces, usedW, usedL, rotate, scale (%), labels: [{x,y,text}], trim: [[{x,y},{x,y}]], page (index) }
 * Returns { pdf: Buffer, widthMm, lengthMm }
 */
async function buildLayoutPdf(src, lay) {
  const srcDoc = await PDFDocument.load(src, { ignoreEncryption: true });
  const doc = await PDFDocument.create();
  doc.setTitle(lay.name || 'InkSign print');
  doc.setCreator('InkSign');
  const W = Math.max(1, lay.usedW), L = Math.max(1, lay.usedL);
  const page = doc.addPage([W * PT, L * PT]);
  const srcPage = srcDoc.getPages()[Math.min(lay.page || 0, srcDoc.getPageCount() - 1)];
  const emb = await doc.embedPage(srcPage);
  const name = 'Job0';
  const { Resources } = page.node.normalizedEntries();
  let xo = Resources.lookup(PDFName.of('XObject'));
  if (!xo) { xo = doc.context.obj({}); Resources.set(PDFName.of('XObject'), xo); }
  xo.set(PDFName.of(name), emb.ref);

  const s = (Number(lay.scale) || 100) / 100;
  const r = ((Number(lay.rotate) || 0) % 360 + 360) % 360;
  const ew = emb.width, eh = emb.height;              // form units (pt), content 0..ew × 0..eh, y up
  const W0 = ew * s * MMPT, H0 = eh * s * MMPT;       // job size before turning (mm)
  // form point (pt, y up) -> shown job coords (mm, y down, after turning clockwise by r)
  const toShown = (a, b) => {
    const u = a * s * MMPT, v = (eh - b) * s * MMPT;
    if (r === 90) return [H0 - v, u];
    if (r === 180) return [W0 - u, H0 - v];
    if (r === 270) return [v, W0 - u];
    return [u, v];
  };
  const ops = [];
  for (const p of lay.pieces) {
    const [u0, v0, u1, v1] = p.clip;
    // piece on the page (pt): left = W - (x + w), bottom = y
    const X0 = (W - p.x - p.w) * PT, Y0 = p.y * PT;
    const toPage = ([u, v]) => [X0 + (u - u0) * PT, Y0 + (v1 - v) * PT];
    const o = toPage(toShown(0, 0)), ax = toPage(toShown(1, 0)), ay = toPage(toShown(0, 1));
    const cm = [ax[0] - o[0], ax[1] - o[1], ay[0] - o[0], ay[1] - o[1], o[0], o[1]];
    ops.push(op('q'), op('re', [n(X0), n(Y0), n((u1 - u0) * PT), n((v1 - v0) * PT)]), op('W'), op('n'),
      op('cm', cm.map(n)), op('Do', [PDFName.of(name)]), op('Q'));
  }
  if (lay.trim && lay.trim.length) {
    ops.push(op('q'), op('RG', [n(0), n(0), n(0)]), op('w', [n(0.5)]));
    for (const [a, b] of lay.trim) ops.push(op('m', [n((W - a.x) * PT), n(a.y * PT)]), op('l', [n((W - b.x) * PT), n(b.y * PT)]), op('S'));
    ops.push(op('Q'));
  }
  page.pushOperators(...ops);
  if (lay.labels && lay.labels.length) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const l of lay.labels) {
      const size = 9;
      const tw = font.widthOfTextAtSize(String(l.text), size);
      // labels read along the job's bottom edge, right-aligned to the job's right edge (x from right)
      page.drawText(String(l.text), { x: Math.max(2, (W - l.x) * PT - tw), y: l.y * PT, size, font, color: rgb(0, 0, 0) });
    }
  }
  return { pdf: Buffer.from(await doc.save({ useObjectStreams: false })), widthMm: W, lengthMm: L };
}

module.exports = { buildLayoutPdf };
