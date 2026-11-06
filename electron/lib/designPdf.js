// PDF from the Design workspace. The page sends a flat "scene" (already resolved: every shape as page
// paths in mm, y down, with its colors; every picture with its placement), and this writes it out:
//  - fills / strokes in RGB, with opacity
//  - cut lines in the CutContour spot color (what Flexi, ONYX, Caldera and InkSign's HP path read)
//    or left off (cut: 'omit') when the print shouldn't carry them
//  - optional print & cut registration marks around the page
const { PDFDocument, PDFName, PDFNumber, PDFOperator, PDFDict } = require('pdf-lib');
const { markRects } = require('./printCutPdf');

const PT = 72 / 25.4;
const n = (v) => PDFNumber.of(Math.round(v * 1000) / 1000);
const op = (o, args = []) => PDFOperator.of(o, args);

function rgbOf(hex) {
  const h = String(hex || '#000000').replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => parseInt(c + c, 16)) : [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return v.map((x) => (Number.isFinite(x) ? x / 255 : 0));
}

function resources(doc, page) {
  const { Resources } = page.node.normalizedEntries();
  const get = (key) => {
    let d = Resources.lookup(PDFName.of(key));
    if (!(d instanceof PDFDict)) { d = doc.context.obj({}); Resources.set(PDFName.of(key), d); }
    return d;
  };
  return get;
}

/**
 * scene = { w, h (mm), name, items: [
 *   { kind:'path', paths:[[{x,y}]], fill:'#rrggbb'|null, fillRule:'evenodd'|'nonzero', stroke:'#rrggbb'|null, strokeMm, opacity, cut }
 *   { kind:'image', dataUrl, m:[a,b,c,d,e,f] }   // unit square (0..1, y down) -> page mm
 * ], marks: { margin, size, thickness } | null }
 * opts.cut: 'spot' (CutContour, default) | 'omit' | 'only' (cut lines alone, e.g. a cut proof)
 */
async function buildDesignPdf(scene, { cut = 'spot', title } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(title || scene.name || 'InkSign design');
  doc.setCreator('InkSign');
  const W = scene.w * PT, H = scene.h * PT;
  const page = doc.addPage([W, H]);
  const res = resources(doc, page);
  const ops = [];
  const X = (x) => n(x * PT), Y = (y) => n(H - y * PT);

  const pathOps = (paths, closeAll) => {
    const out = [];
    for (const p of paths) {
      if (!p || p.length < 2) continue;
      out.push(op('m', [X(p[0].x), Y(p[0].y)]));
      for (let i = 1; i < p.length; i++) out.push(op('l', [X(p[i].x), Y(p[i].y)]));
      const closed = p.length > 2 && Math.abs(p[0].x - p[p.length - 1].x) < 1e-6 && Math.abs(p[0].y - p[p.length - 1].y) < 1e-6;
      if (closed || closeAll) out.push(op('h'));
    }
    return out;
  };

  let gsN = 0;
  const alphaState = (a) => {
    const key = `GSa${gsN++}`;
    res('ExtGState').set(PDFName.of(key), doc.context.obj({ Type: 'ExtGState', ca: a, CA: a }));
    return key;
  };

  let cutCs = null;
  const cutSpace = () => {
    if (cutCs) return cutCs;
    const fn = doc.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 });
    const cs = doc.context.register(doc.context.obj([PDFName.of('Separation'), PDFName.of('CutContour'), PDFName.of('DeviceCMYK'), fn]));
    res('ColorSpace').set(PDFName.of('CSCut'), cs);
    cutCs = 'CSCut';
    return cutCs;
  };

  const imgCache = new Map();
  let imN = 0;
  let cutCount = 0;
  for (const it of scene.items || []) {
    if (it.kind === 'image') {
      if (cut === 'only') continue;
      let name = imgCache.get(it.dataUrl);
      if (!name) {
        const [head, b64] = String(it.dataUrl).split(',');
        const bytes = Buffer.from(b64 || '', 'base64');
        const emb = /png/i.test(head) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        name = `Im${imN++}`;
        res('XObject').set(PDFName.of(name), emb.ref);
        imgCache.set(it.dataUrl, name);
      }
      // unit square y-down in mm -> PDF: image space has y up, so flip inside
      const [a, b, c, d, e, f] = it.m;
      // point (u, v) in mm-page = (a u + c v + e, b u + d v + f); PDF image (s, t) with v = 1 - t
      const A = a * PT, B = -b * PT, C = -c * PT, D = d * PT;
      const E = (a * 0 + c * 1 + e) * PT, F = H - (b * 0 + d * 1 + f) * PT;
      ops.push(op('q'));
      if (it.opacity != null && it.opacity < 1) ops.push(op('gs', [PDFName.of(alphaState(it.opacity))]));
      ops.push(op('cm', [n(A), n(B), n(C), n(D), n(E), n(F)]), op('Do', [PDFName.of(name)]), op('Q'));
      continue;
    }
    if (it.kind !== 'path' || !it.paths || !it.paths.length) continue;
    if (it.cut) {
      if (cut === 'omit') continue;
      cutCount++;
      ops.push(op('q'), op('CS', [PDFName.of(cutSpace())]), op('SCN', [n(1)]), op('w', [n(0.25)]), ...pathOps(it.paths), op('S'), op('Q'));
      continue;
    }
    if (cut === 'only') continue;
    const hasFill = !!it.fill, hasStroke = !!it.stroke && it.strokeMm > 0;
    if (!hasFill && !hasStroke) continue;
    ops.push(op('q'));
    if (it.opacity != null && it.opacity < 1) ops.push(op('gs', [PDFName.of(alphaState(it.opacity))]));
    if (hasFill) ops.push(op('rg', rgbOf(it.fill).map(n)));
    if (hasStroke) ops.push(op('RG', rgbOf(it.stroke).map(n)), op('w', [n(it.strokeMm * PT)]), op('j', [n(1)]), op('J', [n(1)]));
    ops.push(...pathOps(it.paths));
    const eo = it.fillRule !== 'nonzero';
    ops.push(op(hasFill && hasStroke ? (eo ? 'B*' : 'B') : hasFill ? (eo ? 'f*' : 'f') : 'S'), op('Q'));
  }

  if (scene.marks && scene.marks.size > 0 && cut !== 'only') {
    ops.push(op('q'), op('rg', [n(0), n(0), n(0)]));
    for (const [x, y, w, h] of markRects(scene.w, scene.h, scene.marks)) ops.push(op('re', [X(x), n(H - (y + h) * PT), n(w * PT), n(h * PT)]), op('f'));
    ops.push(op('Q'));
  }
  page.pushOperators(...ops);
  return { pdf: Buffer.from(await doc.save({ useObjectStreams: false })), cutCount };
}

module.exports = { buildDesignPdf, rgbOf };
