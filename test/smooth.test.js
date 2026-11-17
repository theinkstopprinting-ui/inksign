// Curves are thinned to long steps before they go to the cutter, so it sweeps instead of shuddering
const test = require('node:test');
const assert = require('node:assert/strict');
const { smoothPath, generate } = require('../electron/lib/cutterLang');

const circle = (r, n) => Array.from({ length: n + 1 }, (_, i) => ({ x: 100 + r * Math.cos((i % n) / n * 2 * Math.PI), y: 100 + r * Math.sin((i % n) / n * 2 * Math.PI) }));

test('a finely stepped circle becomes long steps that stay on the line', () => {
  const fine = circle(32, 3000);                      // 0.067 mm steps, like a flattened curve
  const out = smoothPath(fine, 0.025);
  assert.ok(out.length > 40 && out.length < 140, `points: ${out.length}`);
  assert.deepEqual(out[0], out[out.length - 1]);      // still closed
  for (let i = 1; i < out.length; i++) {
    const mx = (out[i].x + out[i - 1].x) / 2 - 100, my = (out[i].y + out[i - 1].y) / 2 - 100;
    assert.ok(32 - Math.hypot(mx, my) < 0.03);        // never more than 0.03 mm inside the true circle
  }
});

test('corners and straight lines are untouched', () => {
  const sq = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }, { x: 0, y: 0 }];
  assert.deepEqual(smoothPath(sq, 0.025), sq);
  const dense = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }];
  assert.deepEqual(smoothPath(dense, 0.025), [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }]);
});

test('the cut file for a fine circle is small, and smoothMm: 0 turns it off', () => {
  const cfg = { language: 'hpgl', hpglStyle: 'graphtec', unitsPerMm: 40 };
  const count = (s) => (String(s).match(/PD-?\d/g) || []).length;
  const on = count(generate([circle(32, 3000)], cfg)), off = count(generate([circle(32, 3000)], { ...cfg, smoothMm: 0 }));
  assert.ok(on < 150, `on ${on}`);
  assert.ok(off > 2500, `off ${off}`);
});
