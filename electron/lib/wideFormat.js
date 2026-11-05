// Wide-format layout for the HP Latex printers (sent through Flexi):
// hems, mirrored edges, grommet marks, tiling of oversized banners, and nesting on the roll.
// Units: inches in, PDF points out.
const { PDFDocument, PDFName, PDFNumber, PDFOperator, rgb } = require('pdf-lib');
const { nest } = require('./nest');

const PT = 72;
const MAX_PAGE_IN = 200; // PDF page limit without UserUnit

// Expand items into pieces (copies + tiles) with their outer size (finished + hem).
function planPieces(items, printableW, overlapIn) {
  const pieces = [];
  for (const it of items) {
    const hem = Number(it.hemIn) || 0;
    const ow = Number(it.widthIn) + 2 * hem, oh = Number(it.heightIn) + 2 * hem;
    const copies = Math.max(1, Math.round(Number(it.copies) || 1));
    // Pick the orientation that fits across the roll; if neither fits, tile across.
    let across = oh, along = ow, rotated = false;
    if (oh > printableW && ow <= printableW) { across = ow; along = oh; rotated = true; }
    const tiles = [];
    if (across <= printableW + 1e-6) tiles.push({ y0: 0, y1: across });
    else {
      const ov = Math.max(0, Number(overlapIn) || 0), step = printableW - ov;
      for (let y = 0; y < across - ov - 1e-6; y += step) tiles.push({ y0: y, y1: Math.min(y + printableW, across) });
    }
    for (let c = 0; c < copies; c++) {
      tiles.forEach((t, ti) => pieces.push({
        id: pieces.length, item: it, copy: c, tile: tiles.length > 1 ? ti : null, tiles: tiles.length,
        rotated, outerW: ow, outerH: oh, cropAcross: t, w: along, h: t.y1 - t.y0, hem,
        label: `${it.name}${copies > 1 ? ` #${c + 1}` : ''}${tiles.length > 1 ? ` panel ${ti + 1}/${tiles.length}` : ''}`,
      }));
    }
  }
  return pieces;
}

function layoutWide({ items, rollWidthIn, sideMarginIn = 0.2, gapIn = 0.5, overlapIn = 1, allowRotate = true }) {
  const printableW = rollWidthIn - 2 * sideMarginIn;
  if (printableW <= 0) throw new Error('Roll width is too small');
  const pieces = planPieces(items, printableW, overlapIn);
  const res = nest(pieces.map((p) => ({ id: p.id, w: p.w, h: p.h, noRotate: p.tiles > 1 || p.item.allowRotate === false })), printableW, { gap: gapIn, allowRotate });
  for (const r of res) {
    const p = pieces[r.id];
    p.x = r.x; p.y = r.y + sideMarginIn; p.extraRot = r.rotated;
    p.pw = r.rotated ? p.h : p.w; p.ph = r.rotated ? p.w : p.h;
  }
  const lengthIn = Math.max(0, ...pieces.map((p) => p.x + p.pw)) + 1; // +1" lead out
  const printedSqIn = pieces.reduce((s, p) => s + p.pw * p.ph, 0);
  return { pieces, lengthIn, rollWidthIn, printableW, printedSqFt: printedSqIn / 144, mediaSqFt: (lengthIn * rollWidthIn) / 144 };
}

// Item frame (inches, origin bottom-left of the outer art, Y up) -> page (inches, Y up).
function pieceToPage(p, rollWidthIn) {
  const f = (X, Y) => {
    let u, v; // u along the roll, v across measured down from the piece top
    if (!p.rotated) { u = X; v = p.outerH - Y; } else { u = Y; v = X; }
    v -= p.cropAcross.y0;
    if (p.extraRot) { const u2 = v, v2 = p.w - u; u = u2; v = v2; }
    return { x: p.x + u, y: rollWidthIn - (p.y + v) };
  };
  const o = f(0, 0), ax = f(1, 0), ay = f(0, 1);
  return [ax.x - o.x, ax.y - o.y, ay.x - o.x, ay.y - o.y, o.x, o.y];
}

const n3 = (v) => PDFNumber.of(Math.round(v * 10000) / 10000);
const op = (name, args = []) => PDFOperator.of(name, args.map((a) => (typeof a === 'number' ? n3(a) : a)));
const clip = (x, y, w, h) => [op('re', [x, y, w, h]), op('W'), op('n')];

async function buildWidePdf(layout, { showGrommets = true, white = null } = {}) {
  const doc = await PDFDocument.create();
  doc.setCreator('InkSign');
  const k = Math.max(1, Math.ceil(layout.lengthIn / MAX_PAGE_IN)); // UserUnit for rolls over 200"
  const S = PT / k; // points per inch in this page's units
  const page = doc.addPage([layout.lengthIn * S, layout.rollWidthIn * S]);
  if (k > 1) page.node.set(PDFName.of('UserUnit'), PDFNumber.of(k));

  const cache = new Map();
  const getArt = async (it) => {
    if (cache.has(it.id)) return cache.get(it.id);
    const bytes = Buffer.from(it.base64, 'base64');
    let art;
    if (it.ext === 'pdf') {
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const [e] = await doc.embedPdf(src, [0]);
      art = { kind: 'pdf', e };
    } else art = { kind: 'img', e: it.ext === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes) };
    cache.set(it.id, art);
    return art;
  };

  for (const p of layout.pieces) {
    const it = p.item, art = await getArt(it);
    const hem = p.hem * S, fw = Number(it.widthIn) * S, fh = Number(it.heightIn) * S;
    const draw = (x, y, w, h) => (art.kind === 'img' ? page.drawImage(art.e, { x, y, width: w, height: h }) : page.drawPage(art.e, { x, y, width: w, height: h }));
    const [a, b, c, d, e, f] = pieceToPage(p, layout.rollWidthIn);
    // Clip to this piece's box on the roll, then switch to the item's own frame.
    page.pushOperators(op('q'), ...clip(p.x * S, (layout.rollWidthIn - p.y - p.ph) * S, p.pw * S, p.ph * S), op('cm', [a, b, c, d, e * S, f * S]));
    if (white && white.spot) {
      // White ink box under the art (clear / colored media)
      const { spotColorSpace, fillSpot } = require('./spot');
      if (!white.key) white.key = spotColorSpace(doc, page, white.spot);
      fillSpot(page, white.key, [[{ x: hem, y: hem }, { x: hem + fw, y: hem }, { x: hem + fw, y: hem + fh }, { x: hem, y: hem + fh }, { x: hem, y: hem }]]);
    }
    draw(hem, hem, fw, fh);
    if (hem > 0 && it.hemFill === 'mirror') {
      // Mirror the art's edges into the hem (canvas wraps, edge-to-edge bleed)
      const strips = [
        [[0, hem, hem, fh], [-1, 0, 0, 1, 2 * hem, 0]],
        [[hem + fw, hem, hem, fh], [-1, 0, 0, 1, 2 * (hem + fw), 0]],
        [[hem, 0, fw, hem], [1, 0, 0, -1, 0, 2 * hem]],
        [[hem, hem + fh, fw, hem], [1, 0, 0, -1, 0, 2 * (hem + fh)]],
        [[0, 0, hem, hem], [-1, 0, 0, -1, 2 * hem, 2 * hem]],
        [[hem + fw, 0, hem, hem], [-1, 0, 0, -1, 2 * (hem + fw), 2 * hem]],
        [[0, hem + fh, hem, hem], [-1, 0, 0, -1, 2 * hem, 2 * (hem + fh)]],
        [[hem + fw, hem + fh, hem, hem], [-1, 0, 0, -1, 2 * (hem + fw), 2 * (hem + fh)]],
      ];
      for (const [r, m] of strips) {
        page.pushOperators(op('q'), ...clip(...r), op('cm', m));
        draw(hem, hem, fw, fh);
        page.pushOperators(op('Q'));
      }
    }
    if (showGrommets && it.grommets?.on) {
      const inset = (Number(it.grommets.insetIn) || 0.5) * S, spacing = Math.max(2, Number(it.grommets.spacingIn) || 24) * S;
      const stops = (len) => { const n = Math.max(1, Math.round((len - 2 * inset) / spacing)); return Array.from({ length: n + 1 }, (_, i) => inset + ((len - 2 * inset) * i) / n); };
      const pts = [];
      for (const x of stops(fw)) pts.push([hem + x, hem + inset], [hem + x, hem + fh - inset]);
      for (const y of stops(fh).slice(1, -1)) pts.push([hem + inset, hem + y], [hem + fw - inset, hem + y]);
      const r = 0.1 * S;
      for (const [x, y] of pts) {
        page.drawCircle({ x, y, size: r, borderColor: rgb(0, 0, 0), borderWidth: 0.6 / k });
        page.drawLine({ start: { x: x - r * 1.5, y }, end: { x: x + r * 1.5, y }, thickness: 0.5 / k });
        page.drawLine({ start: { x, y: y - r * 1.5 }, end: { x, y: y + r * 1.5 }, thickness: 0.5 / k });
      }
    }
    page.pushOperators(op('Q'));
    if (p.tiles > 1) page.drawText(p.label, { x: p.x * S + 3 / k, y: (layout.rollWidthIn - p.y - p.ph) * S + 3 / k, size: 7 / k, color: rgb(0.45, 0.45, 0.45) });
  }
  return { pdf: Buffer.from(await doc.save()), userUnit: k };
}

module.exports = { layoutWide, buildWidePdf, planPieces, pieceToPage };
