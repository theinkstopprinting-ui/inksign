import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import opentype from 'opentype.js';
import * as G from '../src/lib/geometry.js';
import { offsetPaths } from '../src/lib/offset.js';
import { nest } from '../src/lib/nest.js';
import { SHAPES } from '../src/lib/shapes.js';
import { textToPaths, textOnArc } from '../src/lib/text.js';

const sq = (x, y, s) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }, { x, y }];

test('offset grows a 100mm square by 5mm each side', () => {
  const out = offsetPaths([sq(0, 0, 100)], 5, { corners: 'miter' });
  const b = G.bounds(out);
  assert.ok(Math.abs(b.w - 110) < 0.1 && Math.abs(b.h - 110) < 0.1, JSON.stringify(b));
});

test('solid offset of an "O" drops the hole', () => {
  const out = offsetPaths([sq(0, 0, 60), sq(20, 20, 20)], 3, { outerOnly: true });
  assert.strictEqual(out.length, 1);
  const hollow = offsetPaths([sq(0, 0, 60), sq(20, 20, 20)], 3);
  assert.strictEqual(hollow.length, 2);
});

test('nesting fits pieces inside the roll width and never overlaps', () => {
  const pieces = Array.from({ length: 14 }, (_, i) => ({ id: i, w: 100 + (i % 3) * 40, h: 80 + (i % 4) * 30 }));
  const W = 610;
  const res = nest(pieces, W, { gap: 6 });
  const rects = res.map((r) => { const p = pieces[r.id]; const w = r.rotated ? p.h : p.w, h = r.rotated ? p.w : p.h; return { x0: r.x, y0: r.y, x1: r.x + w, y1: r.y + h }; });
  for (const r of rects) assert.ok(r.y1 <= W + 0.01, 'outside roll');
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    const overlap = a.x0 < b.x1 - 0.01 && b.x0 < a.x1 - 0.01 && a.y0 < b.y1 - 0.01 && b.y0 < a.y1 - 0.01;
    assert.ok(!overlap, `pieces ${i} and ${j} overlap`);
  }
  const used = Math.max(...rects.map((r) => r.x1));
  const area = pieces.reduce((s, p) => s + p.w * p.h, 0);
  assert.ok(area / (used * W) > 0.6, `poor packing ${(area / (used * W)).toFixed(2)}`);
});

test('all shapes are closed and sized as asked', () => {
  for (const s of SHAPES) {
    const p = s.make(100, 50, {});
    const b = G.bounds(p);
    assert.ok(p.every(G.isClosed), s.id);
    assert.ok(Math.abs(b.w - 100) < 0.5 && Math.abs(b.h - 50) < 0.5, `${s.id} ${b.w}x${b.h}`);
  }
});

const fontFile = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/crosextra/Carlito-Bold.ttf'].find((f) => fs.existsSync(f));
test('text: capital H is the requested height; arc text curves', { skip: !fontFile }, () => {
  const buf = fs.readFileSync(fontFile);
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const h = G.bounds(textToPaths(font, 'H', { heightMm: 50.8 }));
  assert.ok(Math.abs(h.h - 50.8) < 0.5, `H height ${h.h}`);
  const straight = G.bounds(textToPaths(font, 'INK STOP', { heightMm: 50 }));
  const arced = G.bounds(textOnArc(font, 'INK STOP', { heightMm: 50, radiusMm: 150, position: 'top' }));
  assert.ok(arced.h > straight.h + 20, 'arc should add height');
});
