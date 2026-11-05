import test from 'node:test';
import assert from 'node:assert';
import * as G from '../src/lib/geometry.js';

const sq = (x, y, s) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }, { x, y }];

test('weed lines skip over shapes with clearance', () => {
  const art = [sq(0, 0, 50), sq(100, 0, 50)];
  const lines = G.weedLines(art, { marginMm: 5, spacingMm: 40, gapMm: 2 });
  assert.ok(lines.length > 0);
  for (const l of lines) for (const p of l) {
    const inA = p.x > 0 && p.x < 50 && p.y > 0.5 && p.y < 49.5;
    const inB = p.x > 100 && p.x < 150 && p.y > 0.5 && p.y < 49.5;
    assert.ok(!inA && !inB, `line point inside shape at ${p.x},${p.y}`);
  }
  // A line in the gap between squares runs full height (border to border)
  const gapLine = lines.find((l) => l[0].x > 50 && l[0].x < 100);
  assert.ok(gapLine && Math.abs(gapLine[0].y - -5) < 0.01 && Math.abs(gapLine[1].y - 55) < 0.01);
});

test('letter with a hole: weed line stops at the outline and inside the counter', () => {
  const art = [sq(0, 0, 60), sq(20, 20, 20)]; // "O"
  const lines = G.weedLines(art, { marginMm: 5, spacingMm: 25, gapMm: 1 });
  const through = lines.filter((l) => l[0].x > 20 && l[0].x < 40);
  // outside top, inside counter, outside bottom = 3 segments
  assert.strictEqual(through.length, 3);
});

test('tiling splits a 60" wide job for a 24" cutter with overlap', () => {
  const W = 24 * 25.4, ov = 12.7;
  const job = [sq(0, 0, 60 * 25.4)];
  const panels = G.tileJob(job, { maxAcrossMm: W, overlapMm: ov });
  assert.strictEqual(panels.length, 3);
  for (const p of panels) {
    const b = G.bounds(p.paths);
    assert.ok(b.maxY <= W + 0.01, `panel too wide: ${b.maxY}`);
  }
  assert.ok(panels[1].rect.y0 < panels[0].rect.y1, 'panels overlap');
});

test('fits in one panel when small; closed shape stays one cut', () => {
  const panels = G.tileJob([sq(0, 0, 100)], { maxAcrossMm: 600 });
  assert.strictEqual(panels.length, 1);
  assert.strictEqual(panels[0].paths.length, 1);
});

test('cut order: inner counter cut before its outline', () => {
  const order = G.sortCutOrder([sq(0, 0, 60), sq(20, 20, 20)]);
  assert.strictEqual(order[0][0].x, 20);
});

test('flatten cubic/Z closes path', () => {
  const p = G.flattenCommands([{ type: 'M', x: 0, y: 0 }, { type: 'C', x1: 0, y1: 10, x2: 10, y2: 10, x: 10, y: 0 }, { type: 'Z' }]);
  assert.strictEqual(p.length, 1);
  assert.ok(G.isClosed(p[0]));
});
