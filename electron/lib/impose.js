// Imposition for the Xerox (Fiery-style): step & repeat, n-up, saddle-stitch booklets.
// Pages stay vector (embedded PDF pages). All sizes in points unless noted.
const { PDFDocument, rgb, degrees } = require('pdf-lib');

const IN = 72;

// Grid that fits the most items of size w x h on the sheet; tries both item rotations.
function bestGrid(sheetW, sheetH, w, h, gap, margin, allowRotate = true) {
  const fit = (iw, ih) => {
    const cols = Math.max(0, Math.floor((sheetW - 2 * margin + gap) / (iw + gap)));
    const rows = Math.max(0, Math.floor((sheetH - 2 * margin + gap) / (ih + gap)));
    return { cols, rows, n: cols * rows, iw, ih };
  };
  const a = { ...fit(w, h), rotated: false };
  if (!allowRotate) return a;
  const b = { ...fit(h, w), rotated: true };
  return b.n > a.n ? b : a;
}

function cropMarks(page, x, y, w, h, { len = 0.25 * IN, off = (1 / 16) * IN, thickness = 0.3 } = {}) {
  const c = rgb(0, 0, 0);
  const L = (x1, y1, x2, y2) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color: c });
  for (const [cx, sx] of [[x, -1], [x + w, 1]]) for (const [cy, sy] of [[y, -1], [y + h, 1]]) {
    L(cx + sx * off, cy, cx + sx * (off + len), cy);
    L(cx, cy + sy * off, cx, cy + sy * (off + len));
  }
}

// Crop marks around the outside of the block, one at every cut line (Fiery-style gang-up).
function perimeterMarks(page, cells, { len, off, thickness = 0.3 }) {
  const c = rgb(0, 0, 0);
  const L = (x1, y1, x2, y2) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color: c });
  const xs = [...new Set(cells.flatMap((k) => [k.x, k.x + k.w]).map((v) => Math.round(v * 100) / 100))];
  const ys = [...new Set(cells.flatMap((k) => [k.y, k.y + k.h]).map((v) => Math.round(v * 100) / 100))];
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  for (const x of xs) { L(x, maxY + off, x, maxY + off + len); L(x, minY - off, x, minY - off - len); }
  for (const y of ys) { L(minX - off, y, minX - off - len, y); L(maxX + off, y, maxX + off + len, y); }
}

async function loadSource(src) {
  // src: { pdf: Buffer } or { image: { bytes, png } , trimW, trimH (pt) }
  if (src.pdf) return PDFDocument.load(src.pdf, { ignoreEncryption: true });
  const d = await PDFDocument.create();
  if (src.cmyk) {
    // Already converted to the printer's CMYK with its ICC profile
    const { embedCmyk, drawCmyk } = require('./pdfCmyk');
    const img = embedCmyk(d, src.cmyk);
    const w = src.trimW || src.cmyk.w, h = src.trimH || src.cmyk.h;
    drawCmyk(d.addPage([w, h]), img, { x: 0, y: 0, width: w, height: h });
    return d;
  }
  const img = src.image.png ? await d.embedPng(src.image.bytes) : await d.embedJpg(src.image.bytes);
  const w = src.trimW || img.width, h = src.trimH || img.height;
  d.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  return d;
}

// Place one source page into a cell. trim = finished size; bleed shown around it up to `show`.
function place(page, emb, cell, { rotated, bleed, show }) {
  // emb is clipped to trim+show (in source space). Draw it so the trim lands on cell.
  const ew = emb.width, eh = emb.height; // = trimW+2*show, trimH+2*show (unrotated)
  if (!rotated) {
    page.drawPage(emb, { x: cell.x - show, y: cell.y - show, width: ew, height: eh });
  } else {
    // rotate 90°: source width becomes vertical
    page.drawPage(emb, { x: cell.x + cell.w + show, y: cell.y - show, width: ew, height: eh, rotate: degrees(90) });
  }
}

/**
 * opts:
 *  mode: 'repeat' | 'nup' | 'booklet'
 *  sheetW, sheetH (in)
 *  bleedIn: bleed included in the source file on each side (0 if none)
 *  gapIn, marginIn, cropMarks (bool), allowRotate
 *  duplex: for 'repeat', page 2 of the source is the back
 *  sheets: number of sheets for 'repeat'
 */
async function impose(src, opts) {
  const s = await loadSource(src);
  const out = await PDFDocument.create();
  out.setCreator('InkSign');
  const SW = opts.sheetW * IN, SH = opts.sheetH * IN;
  const bleed = (opts.bleedIn || 0) * IN;
  const gap = (opts.gapIn || 0) * IN;
  const margin = (opts.marginIn ?? 0.16) * IN; // Xerox printable edge ~4 mm
  const srcPages = s.getPages();
  if (!srcPages.length) throw new Error('The file has no pages');
  const first = srcPages[0];
  const trimW = first.getWidth() - 2 * bleed, trimH = first.getHeight() - 2 * bleed;
  if (trimW <= 0 || trimH <= 0) throw new Error('Bleed is bigger than the page');
  const marks = opts.cropMarks !== false;
  // Gutter between pieces: what was asked, or 2x bleed (each piece keeps its full bleed).
  const G = opts.gapIn === '' || opts.gapIn == null ? 2 * bleed : gap;
  let show = Math.min(bleed, G / 2);
  const markOpts = { off: Math.max((1 / 16) * IN, show + (1 / 32) * IN), len: 0.125 * IN };
  const markSpace = marks ? markOpts.off + markOpts.len : 0;

  const embed = async (pageIndexes) => {
    const pages = pageIndexes.map((i) => (i == null ? null : srcPages[i]));
    const real = pages.filter(Boolean);
    const embedded = real.length ? await out.embedPages(real, real.map((p) => ({
      left: bleed - show, bottom: bleed - show, right: p.getWidth() - bleed + show, top: p.getHeight() - bleed + show,
    }))) : [];
    let k = 0;
    return pages.map((p) => (p ? embedded[k++] : null));
  };

  const info = { mode: opts.mode, trimIn: [trimW / IN, trimH / IN], sheets: 0, perSheet: 0 };

  if (opts.mode === 'booklet') {
    show = 0;
    // Saddle stitch: two pages side by side on a sheet twice the page width.
    const n = srcPages.length, total = Math.ceil(n / 4) * 4;
    const sheetsNeeded = total / 4;
    const cellW = trimW, cellH = trimH;
    const scale = Math.min(1, (SW - 2 * margin) / (2 * cellW), (SH - 2 * margin) / cellH);
    const ox = (SW - 2 * cellW * scale) / 2, oy = (SH - cellH * scale) / 2;
    const idx = (i) => (i < n ? i : null);
    for (let sh = 0; sh < sheetsNeeded; sh++) {
      const sides = [[total - 1 - 2 * sh, 2 * sh], [2 * sh + 1, total - 2 - 2 * sh]];
      for (const [left, right] of sides) {
        const page = out.addPage([SW, SH]);
        const [eL, eR] = await embed([idx(left), idx(right)]);
        if (eL) page.drawPage(eL, { x: ox - show * scale, y: oy - show * scale, xScale: scale, yScale: scale });
        if (eR) page.drawPage(eR, { x: ox + cellW * scale - show * scale, y: oy - show * scale, xScale: scale, yScale: scale });
        if (marks) cropMarks(page, ox, oy, 2 * cellW * scale, cellH * scale, markOpts);
        if (marks) page.drawLine({ start: { x: ox + cellW * scale, y: oy + cellH * scale + 6 }, end: { x: ox + cellW * scale, y: oy + cellH * scale + 20 }, thickness: 0.3 });
      }
    }
    info.sheets = sheetsNeeded; info.perSheet = 4; info.scale = scale; info.blankPages = total - n;
    return { pdf: Buffer.from(await out.save()), info };
  }

  const g = bestGrid(SW, SH, trimW, trimH, G, margin + markSpace, opts.allowRotate !== false);
  if (!g.n) throw new Error(`A ${(trimW / IN).toFixed(2)} × ${(trimH / IN).toFixed(2)}" piece doesn't fit on this sheet`);
  const blockW = g.cols * g.iw + (g.cols - 1) * G, blockH = g.rows * g.ih + (g.rows - 1) * G;
  const ox = (SW - blockW) / 2, oy = (SH - blockH) / 2;
  const cells = [];
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
    cells.push({ x: ox + c * (g.iw + G), y: oy + (g.rows - 1 - r) * (g.ih + G), w: g.iw, h: g.ih, c, r });
  }
  const drawSheet = async (pageIndexForCell, mirror) => {
    const page = out.addPage([SW, SH]);
    const idxs = cells.map((_, i) => pageIndexForCell(i));
    const embs = await embed(idxs);
    cells.forEach((cell0, i) => {
      if (!embs[i]) return;
      // Backs: mirror columns so fronts and backs line up after flipping on the long edge
      const cell = mirror ? cells.find((x) => x.r === cell0.r && x.c === g.cols - 1 - cell0.c) : cell0;
      place(page, embs[i], cell, { rotated: g.rotated, bleed, show });
    });
    if (marks) perimeterMarks(page, cells, markOpts);
    return page;
  };

  if (opts.mode === 'repeat') {
    const sheets = Math.max(1, Math.round(opts.sheets || 1));
    const hasBack = opts.duplex && srcPages.length > 1;
    // one front + one back is enough: copies are set on the printer
    await drawSheet(() => 0, false);
    if (hasBack) await drawSheet(() => 1, true);
    info.sheets = sheets; info.perSheet = g.n; info.total = g.n * sheets; info.duplex = hasBack;
  } else {
    // n-up: pages in order
    const n = srcPages.length;
    const sheetsNeeded = Math.ceil(n / g.n);
    for (let sh = 0; sh < sheetsNeeded; sh++) {
      await drawSheet((i) => (sh * g.n + i < n ? sh * g.n + i : null), false);
    }
    info.sheets = sheetsNeeded; info.perSheet = g.n;
  }
  info.cols = g.cols; info.rows = g.rows; info.rotated = g.rotated;
  info.cells = cells.map((c) => ({ x: c.x / IN, y: (SH - c.y - c.h) / IN, w: c.w / IN, h: c.h / IN }));
  return { pdf: Buffer.from(await out.save()), info };
}

module.exports = { impose, bestGrid };
