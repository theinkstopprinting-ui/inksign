import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as D from '../src/lib/doc.js';
import * as FX from '../src/lib/docEffects.js';
import { toScene, toSvg, cutGroups, cutPanels } from '../src/lib/docExport.js';
import { pdfToObjects } from '../src/lib/pdfObjects.js';
import { qrPaths, code128Codes, code128Paths } from '../src/lib/barcode.js';
import { rectangle, ellipse } from '../src/lib/shapes.js';
import { area } from '../src/lib/cuttools.js';

const require = createRequire(import.meta.url);
const { buildDesignPdf } = require('../electron/lib/designPdf.js');
const { prepareArt, markCutSeparations } = require('../electron/lib/artPrep.js');
const gs = require('../electron/lib/ghostscript.js');

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const box = (x, y, w, h, color = '#ff0000') => D.shapeFromPaths(rectangle(w, h), { x, y, fill: { type: 'solid', color } });

test('placement: scale, rotate, flip map points and back', () => {
  const o = { ...box(10, 20, 40, 10), w: 80, h: 20, rot: 90, flipX: true };
  const p = D.placePoint(o, { x: 5, y: 2 });
  const back = D.unplacePoint(o, p);
  assert.ok(near(back.x, 5, 1e-9) && near(back.y, 2, 1e-9));
  const b = D.objBounds(o);
  assert.ok(near(b.w, 20, 1e-9) && near(b.h, 80, 1e-9)); // rotated 90°
});

test('selection box, align, distribute, order, group', () => {
  let doc = D.newDoc({ widthIn: 10, heightIn: 10 });
  const a = box(0, 0, 10, 10), b = box(50, 30, 20, 10), c = box(100, 5, 10, 30);
  doc = { ...doc, objects: [a, b, c] };
  const ids = [a.id, b.id, c.id];
  let d = D.align(doc, ids, 'top');
  assert.ok(d.objects.every((o) => near(D.objBounds(o).minY, 0)));
  d = D.distribute(doc, ids, 'h');
  const xs = d.objects.map((o) => D.objBounds(o));
  assert.ok(near(xs[1].minX - xs[0].maxX, xs[2].minX - xs[1].maxX, 1e-9));
  d = D.setSelBox(doc, [b.id], { w: 40 }, true);
  assert.ok(near(D.objBounds(d.objects[1]).h, 20, 1e-9));
  d = D.reorder(doc, [a.id], 'front');
  assert.strictEqual(d.objects[2].id, a.id);
  d = D.group(doc, [a.id, c.id]);
  assert.deepStrictEqual(D.expandGroups(d, [a.id]).sort(), [a.id, c.id].sort());
  const sr = D.stepRepeat(doc, [a.id], { cols: 3, rows: 2, gapX: 5, gapY: 5 });
  assert.strictEqual(sr.ids.length, 6);
  const h = D.history();
  h.push(doc);
  assert.strictEqual(h.undo(d).objects.length, 3);
});

test('hit test finds the top filled shape and respects holes', () => {
  const ring = D.shapeFromPaths([...ellipse(40, 40), ...ellipse(20, 20).map((p) => p.map((q) => ({ x: q.x + 10, y: q.y + 10 })))], { x: 0, y: 0 });
  assert.strictEqual(D.hitTest([ring], { x: 3, y: 20 })?.id, ring.id);
  assert.strictEqual(D.hitTest([ring], { x: 20, y: 20 }, 0.1), null); // the hole
});

test('combine: weld, cut out, remove overlap, common', () => {
  const a = box(0, 0, 20, 20), b = box(10, 10, 20, 20, '#0000ff');
  const doc = { ...D.newDoc(), objects: [a, b] };
  const w = FX.combine(doc, [a.id, b.id], 'weld');
  assert.strictEqual(w.doc.objects.length, 1);
  assert.ok(near(Math.abs(area(D.placedPaths(w.doc.objects[0])[0])), 700, 0.01));
  const co = FX.combine(doc, [a.id, b.id], 'cutout');
  assert.ok(near(Math.abs(area(D.placedPaths(co.doc.objects[0])[0])), 300, 0.01));
  const ro = FX.combine(doc, [a.id, b.id], 'removeOverlap');
  assert.strictEqual(ro.doc.objects.length, 2);
  const cm = FX.combine(doc, [a.id, b.id], 'common');
  assert.ok(near(Math.abs(area(D.placedPaths(cm.doc.objects[0])[0])), 100, 0.01));
});

test('contour cut, outline, shadow, finisher, trim marks', () => {
  const a = box(10, 10, 20, 20);
  let doc = { ...D.newDoc(), objects: [a] };
  const cc = FX.contourCut(doc, [a.id], { offsetMm: 2, corners: 'square' });
  const cut = cc.doc.objects.find((o) => o.cut);
  assert.ok(cut && near(D.objBounds(cut).w, 24, 0.05));
  assert.strictEqual(cc.doc.objects[1].id, cut.id); // above the art
  const ol = FX.outline(doc, [a.id], { distMm: 3 });
  assert.strictEqual(ol.doc.objects[0].name, 'Outline'); // behind
  const sh = FX.shadow(doc, [a.id], { kind: 'block', dxMm: 4, dyMm: 4 });
  assert.ok(near(D.objBounds(sh.doc.objects[0]).w, 24, 0.05));
  const fin = FX.rectFinisher(doc, [], { usePage: true, insetMm: 10, spacingMm: 200 });
  assert.ok(fin.count >= 4);
  const tm = FX.trimMarks(doc, [a.id]);
  assert.strictEqual(D.placedPaths(tm.doc.objects[1]).length, 8);
  doc = cc.doc;
  const groups = cutGroups(doc);
  assert.strictEqual(groups.length, 1);
  const panels = cutPanels(groups, { weedMm: 3 });
  assert.strictEqual(panels[0].paths.length, 2);
});

test('blend makes in-between shapes with mixed colors', () => {
  const a = box(0, 0, 10, 10, '#000000'), b = D.shapeFromPaths(ellipse(30, 30), { x: 100, y: 0, fill: { type: 'solid', color: '#ffffff' } });
  const r = FX.blend({ ...D.newDoc(), objects: [a, b] }, [a.id, b.id], { steps: 3 });
  assert.strictEqual(r.ids.length, 3);
  assert.strictEqual(r.doc.objects[1].fill.color, '#404040');
});

test('QR and Code 128', () => {
  const q = qrPaths('https://theinkstopprinting.com', { sizeMm: 42 });
  assert.ok(q.modules >= 25 && q.paths.length > 50);
  // Code 128 "ABC" checksum: 104 + 33*1 + 34*2 + 35*3 = 310 -> 310 % 103 = 1
  assert.deepStrictEqual(code128Codes('ABC'), [104, 33, 34, 35, 1, 106]);
  assert.deepStrictEqual(code128Codes('123456').slice(0, 4), [105, 12, 34, 56]);
  const c = code128Paths('INK-42', { widthMm: 50, heightMm: 15 });
  assert.ok(c.paths.length > 10);
});

test('design -> PDF -> editable objects round trip (fills, strokes, CutContour, pictures)', async () => {
  const red = box(10, 10, 50, 30, '#ff0000');
  const line = D.shapeFromPaths(rectangle(20, 20), { x: 80, y: 10, fill: { type: 'none' }, stroke: { color: '#0000ff', width: 1 } });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==';
  const img = D.imageObject({ src: png, natW: 20, natH: 10, x: 120, y: 40 });
  let doc = { ...D.newDoc({ widthIn: 8, heightIn: 4 }), objects: [red, line, img] };
  doc = FX.contourCut(doc, [red.id], { offsetMm: 2 }).doc;
  const scene = toScene(doc);
  const { pdf, cutCount } = await buildDesignPdf(scene);
  assert.strictEqual(cutCount, 1);
  assert.ok(pdf.toString('latin1').includes('/CutContour'));
  const marked = (await markCutSeparations(pdf)).pdf;
  const r = await pdfToObjects(pdfjs, new Uint8Array(marked), { imageToDataUrl: async (i) => `data:fake;${i.width}x${i.height}`, cutMagenta: false });
  assert.ok(near(r.page.w, 8 * 25.4, 0.01));
  const fills = r.objects.filter((o) => o.fill?.color === '#ff0000');
  assert.strictEqual(fills.length, 1);
  assert.ok(near(fills[0].x, 10, 0.05) && near(fills[0].w, 50, 0.05));
  const strokes = r.objects.filter((o) => o.stroke?.color === '#0000ff');
  assert.ok(strokes.length === 1 && near(strokes[0].stroke.width, 1, 0.02));
  assert.strictEqual(r.objects.filter((o) => o.cut).length, 1);
  const im = r.objects.find((o) => o.type === 'image');
  assert.ok(im && near(im.x, 120, 0.05) && near(im.y, 40, 0.05) && near(im.w, 20, 0.05));
  // printed without the cut line
  const omit = await buildDesignPdf(scene, { cut: 'omit' });
  assert.ok(!omit.pdf.toString('latin1').includes('/CutContour'));
  assert.ok(toSvg(doc).includes('CutContour'));
});

test('EPS opens: text becomes shapes, CutContour spot becomes a cut line', async () => {
  const eps = Buffer.from(`%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 200 100
/Helvetica findfont 40 scalefont setfont 1 0 0 setrgbcolor 10 30 moveto (SALE) show
[/Separation /CutContour /DeviceCMYK {dup 0 exch 0 0}] setcolorspace 1 setcolor 2 2 moveto 198 2 lineto 198 98 lineto 2 98 lineto closepath stroke
showpage
%%EOF`);
  try {
    const prep = await prepareArt(eps, 'eps', gs);
    const r = await pdfToObjects(pdfjs, new Uint8Array(prep.pdf), { cutMagenta: false });
    assert.strictEqual(r.objects.filter((o) => o.fill?.color === '#ff0000').length, 4); // S A L E
    assert.strictEqual(r.objects.filter((o) => o.cut).length, 1);
  } finally { gs.shutdown(); }
});

test('contour cut around a box with lettering on it follows the box, not the letters', () => {
  const back = box(0, 0, 100, 50, '#0066cc');
  const letter = D.shapeFromPaths([...rectangle(20, 30), ...rectangle(10, 10).map((p) => p.map((q) => ({ x: q.x + 5, y: q.y + 10 })))], { x: 10, y: 10, fill: { type: 'solid', color: '#ffffff' } });
  const oldCut = D.shapeFromPaths(rectangle(100, 50), { x: 0, y: 0, fill: { type: 'none' }, cut: true });
  const doc = { ...D.newDoc(), objects: [back, letter, oldCut] };
  const r = FX.contourCut(doc, [back.id, letter.id, oldCut.id], { offsetMm: 2, corners: 'miter' });
  const cut = r.doc.objects.find((o) => o.id === r.ids[0]);
  assert.ok(near(cut.w, 104, 0.05) && near(cut.h, 54, 0.05), `${cut.w} x ${cut.h}`);
});

test('a very detailed design (150,000 points) still makes a PDF — no call-stack overflow', async () => {
  const pts = [];
  for (let i = 0; i < 150000; i++) pts.push({ x: 10 + 50 * Math.cos(i / 1000), y: 10 + 50 * Math.sin(i / 997) });
  const r = await buildDesignPdf({ w: 200, h: 200, items: [{ kind: 'path', paths: [pts], fill: '#ff0000' }, { kind: 'path', paths: [pts], cut: true }] });
  assert.ok(r.pdf.length > 100000);
  assert.strictEqual(r.cutCount, 1);
});

test('PDF import honors clipping masks and trims art at the page edge', async () => {
  const { PDFDocument, PDFOperator, PDFNumber } = await import('pdf-lib');
  const d = await PDFDocument.create();
  const pg = d.addPage([200, 200]);
  const N = (v) => PDFNumber.of(v), O = (o, a = []) => PDFOperator.of(o, a);
  pg.pushOperators(
    // a box hanging off the page on all sides
    O('q'), O('rg', [N(1), N(0), N(0)]), O('re', [N(-50), N(-50), N(300), N(300)]), O('f'), O('Q'),
    // a big blue box drawn inside a 50x40 clip
    O('q'), O('re', [N(20), N(20), N(50), N(40)]), O('W'), O('n'), O('rg', [N(0), N(0), N(1)]), O('re', [N(0), N(0), N(200), N(200)]), O('f'), O('Q'),
  );
  const r = await pdfToObjects(pdfjs, new Uint8Array(await d.save()), {});
  const red = r.objects.find((o) => o.fill?.color === '#ff0000');
  const blue = r.objects.find((o) => o.fill?.color === '#0000ff');
  const PT = 25.4 / 72;
  assert.ok(near(red.w, 200 * PT, 0.05) && near(red.x, 0, 0.05), `red ${red.x} ${red.w}`);
  assert.ok(near(blue.w, 50 * PT, 0.05) && near(blue.h, 40 * PT, 0.05) && near(blue.x, 20 * PT, 0.05), `blue ${blue.x} ${blue.w} ${blue.h}`);
});
