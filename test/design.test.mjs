import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import opentype from 'opentype.js';
import { simplify, nodeCount, envelope, TEMPLATES, stackLines } from '../src/lib/design.js';
import { bounds } from '../src/lib/geometry.js';
import { textToPaths } from '../src/lib/text.js';

const circle = (n) => { const p = []; for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; p.push({ x: 50 + 50 * Math.cos(a), y: 50 + 50 * Math.sin(a) }); } return [p]; };

test('reduce nodes keeps the shape within tolerance', () => {
  const c = circle(720);
  const s = simplify(c, 0.2);
  assert.ok(nodeCount(s) < nodeCount(c) / 4, `${nodeCount(c)} -> ${nodeCount(s)}`);
  for (const q of s[0]) assert.ok(Math.abs(Math.hypot(q.x - 50, q.y - 50) - 50) < 0.21);
  // still closed
  assert.deepStrictEqual(s[0][0], s[0][s[0].length - 1]);
});

test('envelopes bend as named', () => {
  const box = [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 0, y: 20 }, { x: 0, y: 0 }]];
  const arch = envelope(box, 'arch', 50);
  const mid = arch[0].reduce((best, q) => (Math.abs(q.x - 50) < Math.abs(best.x - 50) ? q : best));
  assert.ok(mid.y < -5, `arch lifts the middle (${mid.y})`);
  const bulge = bounds(envelope(box, 'bulge', 50));
  assert.ok(bulge.h > 25, 'bulge is taller in the middle');
  const persp = envelope(box, 'perspective', 50);
  const top = persp[0].filter((q) => q.y < 1), bot = persp[0].filter((q) => q.y > 19);
  const w = (pts) => Math.max(...pts.map((q) => q.x)) - Math.min(...pts.map((q) => q.x));
  assert.ok(w(top) < w(bot), 'perspective narrows the top');
});

test('templates: boat numbers get letter-width gaps; yard sign has a frame', () => {
  const fontPath = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'].find((f) => fs.existsSync(f));
  if (!fontPath) return;
  const buf = fs.readFileSync(fontPath);
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const boat = TEMPLATES.find((t) => t.id === 'boat');
  const lines = boat.lines({ state: 'tx', number: '12-34', suffix: 'ab' });
  assert.strictEqual(lines[0].text, 'TX 1234 AB');
  assert.strictEqual(lines[0].heightIn, 3);
  const h = textToPaths(font, 'H', { heightMm: 76.2 });
  assert.ok(Math.abs(bounds(h).h - 76.2) < 1, 'letter height is the cap height');
  const yard = TEMPLATES.find((t) => t.id === 'yard');
  const r = [{ paths: [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 0, y: 0 }]], w: 100, h: 40 }];
  const out = stackLines(r, { frame: yard.frame });
  const b = bounds(out);
  assert.ok(Math.abs(b.w - 24 * 25.4) < 0.01 && Math.abs(b.h - 18 * 25.4) < 0.01);
  const dot = TEMPLATES.find((t) => t.id === 'usdot').lines({ company: 'X', city: '', dot: 'US 123-4567', mc: '' });
  assert.deepStrictEqual(dot.map((l) => l.text), ['X', 'USDOT 1234567']);
});
