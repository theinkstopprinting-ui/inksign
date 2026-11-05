import test from 'node:test';
import assert from 'node:assert';
import { stencilBridges, knockout, rhinestones, weedBoxes, boolean, weld, insideShapes, area } from '../src/lib/cuttools.js';
import { bounds } from '../src/lib/geometry.js';

const sq = (x, y, s) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }, { x, y }];
const O = [sq(0, 0, 60), sq(20, 20, 20)]; // letter O: outline + counter

test('stencil bridges split an O so the island stays attached', () => {
  const r = stencilBridges(O, { widthMm: 4 });
  assert.strictEqual(r.bridged, 1);
  // the body is now two pieces (left and right halves), no separate island hole
  assert.strictEqual(r.paths.length, 2);
  // the bridge strip at x=30 is not inside the cut body any more
  assert.ok(!insideShapes({ x: 30, y: 10 }, r.paths));
  assert.ok(insideShapes({ x: 10, y: 10 }, r.paths));
});

test('letters without islands are untouched by bridges', () => {
  const r = stencilBridges([sq(0, 0, 10)], { widthMm: 3 });
  assert.strictEqual(r.bridged, 0);
  assert.strictEqual(r.paths.length, 1);
});

test('knockout makes a block with the design as holes', () => {
  const k = knockout([sq(10, 10, 20)], { marginMm: 5 });
  assert.ok(insideShapes({ x: 7, y: 7 }, k), 'margin is solid');
  assert.ok(!insideShapes({ x: 20, y: 20 }, k), 'design is a hole');
  const b = bounds(k);
  assert.ok(Math.abs(b.minX - 5) < 0.01 && Math.abs(b.maxX - 35) < 0.01);
});

test('rhinestones: outline stones sit inside the art, fill packs a honeycomb, no overlaps', () => {
  const o = rhinestones([sq(0, 0, 40)], { holeMm: 3.1, gapMm: 0.9, mode: 'outline' });
  assert.ok(o.count >= 30 && o.count <= 45, `outline count ${o.count}`);
  for (const c of o.paths) { const b = bounds([c]); assert.ok(b.minX >= -0.1 && b.maxX <= 40.1 && b.minY >= -0.1 && b.maxY <= 40.1); }
  const f = rhinestones([sq(0, 0, 40)], { holeMm: 3.1, gapMm: 0.9, mode: 'fill' });
  assert.ok(f.count > 80, `fill count ${f.count}`);
  const cs = f.paths.map((c) => { const b = bounds([c]); return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }; });
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) assert.ok(Math.hypot(cs[i].x - cs[j].x, cs[i].y - cs[j].y) >= 3.1 + 0.9 * 0.9);
});

test('weed boxes wrap each piece', () => {
  const boxes = weedBoxes([[sq(0, 0, 10)], [sq(50, 0, 10)]], 3);
  assert.strictEqual(boxes.length, 2);
  assert.deepStrictEqual(bounds([boxes[1]]), { minX: 47, minY: -3, maxX: 63, maxY: 13, w: 16, h: 16 });
});

test('weld merges overlapping shapes and keeps holes; subtract and intersect work', () => {
  const w = weld([sq(0, 0, 20), sq(10, 0, 20)]);
  assert.strictEqual(w.length, 1);
  assert.ok(Math.abs(Math.abs(area(w[0])) - 600) < 1);
  const wo = weld([...O, sq(50, 0, 30)]);
  assert.ok(!insideShapes({ x: 30, y: 30 }, wo), 'O counter stays a hole after weld');
  assert.ok(insideShapes({ x: 70, y: 10 }, wo));
  const d = boolean([sq(0, 0, 20)], [sq(10, 0, 20)], 'difference');
  assert.ok(Math.abs(Math.abs(area(d[0])) - 200) < 1);
  const i = boolean([sq(0, 0, 20)], [sq(10, 0, 20)], 'intersection');
  assert.ok(Math.abs(Math.abs(area(i[0])) - 200) < 1);
});
