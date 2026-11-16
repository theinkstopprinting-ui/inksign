import test from 'node:test';
import assert from 'node:assert';
import { planCut, liftMarks, rowLines, dashPath, areaBox, usageReport, MM } from '../src/lib/cutPlan.js';
import { bounds, totalLength } from '../src/lib/geometry.js';

const box = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }];
// an "O": 40 mm square with a 20 mm hole, at (x, y)
const ring = (x, y) => [box(x, y, 40, 40), box(x + 10, y + 10, 20, 20)];
const red = { name: 'Red', color: '#ff0000', paths: [...ring(100, 50), ...ring(160, 50)] };
const blue = { name: 'Blue', color: '#0000ff', paths: [box(100, 120, 100, 30)] };

test('one job per color, each starting at the origin; combined = one job', () => {
  const p = planCut([red, blue]);
  assert.deepEqual(p.jobs.map((j) => j.name), ['Red', 'Blue']);
  for (const j of p.jobs) { const b = bounds(j.paths); assert.ok(Math.abs(b.minX) < 1e-6 && Math.abs(b.minY) < 1e-6); }
  assert.equal(p.jobs[0].w, 100); assert.equal(p.jobs[0].h, 40);
  const one = planCut([red, blue], { separate: false });
  assert.equal(one.jobs.length, 1);
  assert.equal(one.jobs[0].h, 100, 'red row + gap + blue row');
  assert.ok(Math.abs(one.totalCutMm - (2 * 160 + 2 * 80 + 260)) < 1e-6);
});

test('holes are cut before the outlines around them', () => {
  const j = planCut([red]).jobs[0];
  const areaOf = (p) => { const b = bounds([p]); return b.w * b.h; };
  assert.deepEqual(j.paths.map(areaOf), [400, 400, 1600, 1600]);
});

test('rotate, mirror, copies across the roll then along it, position', () => {
  const r = planCut([blue], { rotate: true }).jobs[0];
  assert.equal(r.w, 30); assert.equal(r.h, 100);
  const L = { name: 'L', color: null, paths: [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 20 }, { x: 0, y: 20 }, { x: 0, y: 0 }]] };
  const m = planCut([L], { mirror: true, cutHolesFirst: false }).jobs[0];
  assert.ok(m.paths[0].some((q) => q.x === 6 && q.y === 20), 'the notch moved to the other side');
  // 5 copies of a 100 × 30 strip on 4" (101.6 mm) wide vinyl: 2 fit across (30 + 6.35 gap), so 3 columns
  const c = planCut([blue], { copies: 5, mediaWidthMm: 101.6 }).jobs[0];
  assert.equal(c.paths.length, 5);
  assert.ok(Math.abs(c.h - (2 * 30 + 6.35)) < 1e-6);
  assert.ok(Math.abs(c.w - (3 * 100 + 2 * 6.35)) < 1e-6);
  const pos = planCut([blue], { posXMm: 12, posYMm: 7 }).jobs[0];
  assert.equal(bounds(pos.paths).minX, 12); assert.equal(bounds(pos.paths).minY, 7);
});

test('weed box, speed-weed lines between rows, easy-lift marks in holes', () => {
  const wb = planCut([red], { weedBox: true, weedOffsetMm: 5 }).jobs[0];
  assert.equal(wb.w, 110); assert.equal(wb.h, 50);
  const two = { name: 'Two rows', color: null, paths: [...ring(0, 0), ...ring(0, 60)] };
  const sw = planCut([two], { speedWeed: true, weedOffsetMm: 5, cutHolesFirst: false }).jobs[0];
  const lines = sw.paths.filter((p) => p.length === 2);
  assert.equal(lines.length, 1, 'one line in the gap between the two rows');
  assert.equal(lines[0][0].y, 55, 'half way between the rows (box starts 5 mm above)');
  assert.equal(Math.abs(lines[0][1].x - lines[0][0].x), 50, 'edge to edge of the weed box');
  const lm = liftMarks(ring(0, 0));
  assert.equal(lm.length, 1);
  assert.ok(lm[0][0].x > 10 && lm[0][1].x < 30 && Math.abs(lm[0][0].y - 20) < 0.1, 'inside the hole');
  assert.equal(planCut([red], { easyLift: true }).jobs[0].paths.filter((p) => p.length === 2).length, 2);
  assert.equal(rowLines(ring(0, 0), { minX: 0, maxX: 40 }).length, 0);
});

test('alignment squares sit in the same place on every color', () => {
  const p = planCut([red, blue], { regMarks: true, cutHolesFirst: false });
  const squares = (j) => j.paths.filter((q) => { const b = bounds([q]); return Math.abs(b.w - 5) < 1e-6 && Math.abs(b.h - 5) < 1e-6; }).map((q) => `${q[0].x.toFixed(2)},${q[0].y.toFixed(2)}`).sort();
  assert.equal(squares(p.jobs[0]).length, 4);
  assert.deepEqual(squares(p.jobs[0]), squares(p.jobs[1]));
  assert.equal(p.jobs[0].w, p.jobs[1].w); assert.equal(p.jobs[0].h, p.jobs[1].h);
});

test('passes repeat each shape; dashed cut keeps its length ratio', () => {
  const j = planCut([blue], { passes: 3 }).jobs[0];
  assert.equal(j.paths.length, 3);
  assert.deepEqual(j.paths[0], j.paths[2]);
  const d = dashPath(box(0, 0, 100, 30), 20, 1);
  assert.ok(d.length >= 12);
  const cut = totalLength(d);
  assert.ok(Math.abs(cut / 260 - 20 / 21) < 0.03, `about 20 of every 21 mm is cut (${cut.toFixed(1)} of 260)`);
  assert.ok(planCut([blue], { dash: { cutMm: 20, gapMm: 1 } }).jobs[0].paths.length >= 12);
});

test('too wide: a warning, or panels with overlap when tiling is on', () => {
  const big = { name: 'Banner', color: null, paths: [box(0, 0, 500, 300)] };
  const w = planCut([big], { mediaWidthMm: 200 });
  assert.equal(w.jobs.length, 1);
  assert.match(w.warnings[0], /wider than/);
  const t = planCut([big], { mediaWidthMm: 200, autoTile: true, tileOverlapMm: 10 });
  assert.equal(t.warnings.length, 0);
  assert.equal(t.jobs.length, 2);
  assert.ok(t.jobs.every((j) => j.h <= 200.01));
  assert.match(t.jobs[0].name, /Panel A1/);
  const long = planCut([big], { autoTile: true, tileLengthMm: 300, tileOverlapMm: 10 });
  assert.equal(long.jobs.length, 2, 'split along the roll too');
});

test('area test box and vinyl usage', () => {
  const p = planCut([blue], { posXMm: 10 });
  const a = areaBox(p.jobs[0]);
  assert.deepEqual([a[0].x, a[2].x, a[2].y], [10, 110, 30]);
  const u = usageReport(planCut([blue]), 24 * MM)[0];
  assert.ok(Math.abs(u.sqFt - (100 * 24 * MM) / (MM * MM * 144)) < 1e-9);
  assert.ok(Math.abs(u.cutFt - 260 / MM / 12) < 1e-9);
});
