// Profiling charts for the Xerox: the same patches InkRIP's Nix charts use (nixdata.js), laid out as
// a CMYK PDF on the paper being profiled. Patches are DeviceCMYK, printed through the Xerox Server
// with InkSign colour management off, so the Xerox gets the exact CMYK numbers.
const { PDFDocument, StandardFonts, cmyk } = require('pdf-lib');
const { srgbToLab } = require('./iccengine');

// Paper is flat and smooth (not a pressed shirt), so patches can be a bit smaller than InkRIP's
// 0.75" — the Nix Mini needs 13 mm; 0.6" is 15 mm.
const XC = { patch: 0.6, gap: 0.12, label: 0.16, margin: 0.4, title: 0.42 };
const PT = 72;

function layout(n, wIn, hIn) {
  const cell = XC.patch + XC.gap;
  const cols = Math.max(3, Math.floor((wIn - 2 * XC.margin + XC.gap) / cell));
  const rowH = XC.label + XC.patch + XC.gap;
  const rows = Math.max(2, Math.floor((hIn - 2 * XC.margin - XC.title + XC.gap) / rowH));
  const perPage = cols * rows;
  const pages = Math.ceil(n / perPage);
  const pos = [];
  for (let i = 0; i < n; i++) {
    const page = Math.floor(i / perPage), k = i % perPage, r = Math.floor(k / cols), c = k % cols;
    // inches from the top-left of the page
    pos.push({ page, x: XC.margin + c * cell, y: XC.margin + XC.title + r * rowH + XC.label });
  }
  return { cols, rows, perPage, pages, pos };
}

/**
 * The chart PDF. paper: { name, w, h } in points (portrait). patches: [[c,m,y,k] 0..1].
 * Returns { pdf: Buffer, pages, layout }.
 */
async function chartPdf(patches, { paper, code, title = 'InkSign Xerox profile chart', quality = '' }) {
  const wIn = paper.w / PT, hIn = paper.h / PT;
  const L = layout(patches.length, wIn, hIn);
  const doc = await PDFDocument.create();
  doc.setTitle(`${title} ${code}`);
  doc.setCreator('InkSign');
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const black = cmyk(0, 0, 0, 1);
  const pages = [];
  for (let p = 0; p < L.pages; p++) {
    const page = doc.addPage([paper.w, paper.h]);
    pages.push(page);
    const yTop = (inch) => paper.h - inch * PT;
    page.drawText(`${title} · ${patches.length} patches · ${code} · page ${p + 1} of ${L.pages}`, { x: XC.margin * PT, y: yTop(XC.margin + 0.16), size: 10, font: bold, color: black });
    page.drawText(`${paper.name}${quality ? ` · quality: ${quality}` : ''} · printed as-is (no colour management) · measure every patch in number order`, { x: XC.margin * PT, y: yTop(XC.margin + 0.32), size: 7.5, font, color: black });
  }
  patches.forEach((v, i) => {
    const at = L.pos[i];
    const page = pages[at.page];
    const x = at.x * PT, yBottom = paper.h - (at.y + XC.patch) * PT;
    page.drawRectangle({ x, y: yBottom, width: XC.patch * PT, height: XC.patch * PT, color: cmyk(v[0], v[1], v[2], v[3]) });
    if (v.every((c) => c === 0)) page.drawRectangle({ x, y: yBottom, width: XC.patch * PT, height: XC.patch * PT, borderColor: cmyk(0, 0, 0, 0.35), borderWidth: 0.4, borderDashArray: [2, 2] });
    page.drawText(String(i + 1), { x: x + 1, y: paper.h - (at.y - 0.035) * PT, size: 8, font: bold, color: black });
  });
  return { pdf: Buffer.from(await doc.save()), pages: L.pages, layout: L };
}

/**
 * What a typical CMYK printer gives for each patch (Ghostscript's default CMYK, about SWOP), only to
 * spot readings that are out of order — the role InkRIP's EZ-JET profile plays for DTF.
 * Renders a strip of 1-point patches to raw pixels and converts them to Lab.
 */
async function expectedLabs(gs, patches) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([patches.length, 1]);
  patches.forEach((v, i) => page.drawRectangle({ x: i, y: 0, width: 1, height: 1, color: cmyk(v[0], v[1], v[2], v[3]) }));
  const pdf = Buffer.from(await doc.save());
  const r = await gs.run(['-sDEVICE=ppmraw', '-r72', '-dTextAlphaBits=1', '-dGraphicsAlphaBits=1', '-sOutputFile=/out/s.ppm', '/in/s.pdf'], { files: { '/in/s.pdf': pdf }, outputs: ['/out/s.ppm'] });
  const ppm = r.out['/out/s.ppm'];
  if (!ppm) throw new Error('Could not work out the expected chart colours');
  // P6 header: "P6\n<w> <h>\n255\n"
  let off = 0, fields = [];
  while (fields.length < 4) {
    let tok = '';
    while (off < ppm.length && /\s/.test(String.fromCharCode(ppm[off]))) off++;
    if (ppm[off] === 0x23) { while (ppm[off] !== 0x0a) off++; continue; }
    while (off < ppm.length && !/\s/.test(String.fromCharCode(ppm[off]))) tok += String.fromCharCode(ppm[off++]);
    fields.push(tok);
  }
  off++;
  const w = Number(fields[1]);
  return patches.map((_, i) => {
    const x = Math.min(w - 1, i);
    const p = off + x * 3;
    return srgbToLab(ppm[p], ppm[p + 1], ppm[p + 2]);
  });
}

// expect(cmyk) -> Lab, from expectedLabs (exact patches only; others fall back to the nearest)
function expectFn(patches, labs) {
  const map = new Map(patches.map((p, i) => [p.join(','), labs[i]]));
  return (c) => map.get(c.join(',')) || labs[0];
}

module.exports = { XC, layout, chartPdf, expectedLabs, expectFn };
