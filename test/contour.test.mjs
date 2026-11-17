// Create Cut Contour (VinylMaster: Curves › Create Cut Contour): contourPaths + contourApply
import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../src/lib/doc.js';
import * as FX from '../src/lib/docEffects.js';

const box = (x, y, w, h) => [[{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }]];
const ring = (x, y, w, h, t) => [...box(x, y, w, h), [{ x: x + t, y: y + t }, { x: x + t, y: y + h - t }, { x: x + w - t, y: y + h - t }, { x: x + w - t, y: y + t }, { x: x + t, y: y + t }]];
const span = (paths) => { const xs = paths.flat().map((p) => p.x), ys = paths.flat().map((p) => p.y); return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; };
const docWith = (...objs) => ({ ...D.newDoc({ widthIn: 24, heightIn: 12 }), objects: objs });

test('contour goes around the art at the distance asked for', () => {
  const a = D.shapeFromPaths(box(50, 50, 100, 40));
  const out = FX.contourPaths(docWith(a), [a.id], { offsetMm: 3, corners: 'miter' });
  assert.equal(out.length, 1);
  const s = span(out);
  assert.ok(Math.abs(s.w - 106) < 0.1 && Math.abs(s.h - 46) < 0.1, JSON.stringify(s));
});

test('touching shapes get one contour; keep holes adds the inside cut', () => {
  const a = D.shapeFromPaths(box(10, 10, 40, 40)), b = D.shapeFromPaths(box(40, 20, 40, 40));
  assert.equal(FX.contourPaths(docWith(a, b), [a.id, b.id], { offsetMm: 2 }).length, 1);
  const r = D.shapeFromPaths(ring(10, 10, 60, 60, 15), { fillRule: 'evenodd' });
  assert.equal(FX.contourPaths(docWith(r), [r.id], { offsetMm: 2, keepHoles: false }).length, 1);
  assert.equal(FX.contourPaths(docWith(r), [r.id], { offsetMm: 2, keepHoles: true }).length, 2);
});

test('a traced picture shape is used instead of the picture rectangle', () => {
  const img = D.imageObject({ src: 'data:image/png;base64,AA==', natW: 100, natH: 100, name: 'pic' });
  const d = docWith(img);
  const plain = span(FX.contourPaths(d, [img.id], { offsetMm: 1, corners: 'miter' }));
  const traced = span(FX.contourPaths(d, [img.id], { offsetMm: 1, corners: 'miter', traced: { [img.id]: box(img.x + 20, img.y + 20, 30, 30) } }));
  assert.ok(Math.abs(plain.w - 102) < 0.1);
  assert.ok(Math.abs(traced.w - 32) < 0.1);
});

test('apply adds a cut line on top, or a solid outline underneath', () => {
  const a = D.shapeFromPaths(box(50, 50, 100, 40));
  const d = docWith(a);
  const paths = FX.contourPaths(d, [a.id], { offsetMm: 3 });
  const cut = FX.contourApply(d, [a.id], paths, { output: 'cut' });
  const c = cut.doc.objects[cut.doc.objects.length - 1];
  assert.equal(c.cut, true); assert.equal(c.fill.type, 'none'); assert.equal(cut.doc.objects.length, 2);
  const fill = FX.contourApply(d, [a.id], paths, { output: 'fill', color: '#ff0000' });
  assert.equal(fill.doc.objects[0].fill.color, '#ff0000'); assert.ok(!fill.doc.objects[0].cut);
  assert.throws(() => FX.contourApply(d, [a.id], []));
});

test('stencil bridges and knockout (moved in from the old Cut Studio)', () => {
  const o = D.shapeFromPaths(ring(10, 10, 60, 60, 15), { fillRule: 'evenodd' });
  const d = docWith(o);
  const st = FX.stencil(d, [o.id], { widthMm: 3, direction: 'vertical' });
  assert.equal(st.doc.objects.length, 1);
  assert.equal(st.doc.objects[0].name, 'Stencil');
  const solid = D.shapeFromPaths(box(10, 10, 40, 40));
  assert.throws(() => FX.stencil(docWith(solid), [solid.id]), /No islands/);
  const ko = FX.knockoutBlock(docWith(solid), [solid.id], { marginMm: 10 });
  const s = span(D.placedPaths(ko.doc.objects[0]));
  assert.ok(Math.abs(s.w - 60) < 0.1 && Math.abs(s.h - 60) < 0.1, JSON.stringify(s));
});
