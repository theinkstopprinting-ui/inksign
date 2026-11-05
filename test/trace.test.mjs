import test from 'node:test';
import assert from 'node:assert';
import { traceMask, polygonArea, traceToPaths, makeMask } from '../src/lib/trace.js';
import * as G from '../src/lib/geometry.js';

function grid(w, h, fn) { const m = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = fn(x, y) ? 1 : 0; return m; }

test('square with a hole gives outer + hole loops with correct areas', () => {
  const m = grid(20, 20, (x, y) => x >= 2 && x < 18 && y >= 2 && y < 18 && !(x >= 7 && x < 13 && y >= 7 && y < 13));
  const loops = traceMask(m, 20, 20);
  assert.strictEqual(loops.length, 2);
  const areas = loops.map((l) => Math.abs(polygonArea(l))).sort((a, b) => a - b);
  assert.deepStrictEqual(areas, [36, 256]);
  // outer and hole have opposite winding
  const signs = loops.map((l) => Math.sign(polygonArea(l)));
  assert.notStrictEqual(signs[0], signs[1]);
});

test('diagonal touching pixels trace as clean loops', () => {
  const m = grid(4, 4, (x, y) => (x === 1 && y === 1) || (x === 2 && y === 2));
  const loops = traceMask(m, 4, 4);
  const total = loops.reduce((s, l) => s + Math.abs(polygonArea(l)), 0);
  assert.strictEqual(total, 2);
  for (const l of loops) assert.ok(l.length >= 4);
});

test('circle traced to mm at the right size, smoothed', () => {
  const N = 200, r = 80;
  const m = grid(N, N, (x, y) => (x - 100) ** 2 + (y - 100) ** 2 < r * r);
  const paths = traceToPaths(m, N, N, { widthMm: 100 });
  assert.strictEqual(paths.length, 1);
  const b = G.bounds(paths);
  assert.ok(Math.abs(b.w - 80) < 1.5, `width ${b.w}`);
  assert.ok(paths[0].length < 400, `too many points ${paths[0].length}`);
});

test('mask modes', () => {
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 255, 255, 255, 0]);
  assert.deepStrictEqual([...makeMask(rgba, 4, 1, { mode: 'alpha' })], [1, 1, 1, 0]);
  assert.deepStrictEqual([...makeMask(rgba, 4, 1, { mode: 'dark', threshold: 128 })], [0, 1, 1, 0]);
});
