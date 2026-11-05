const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { buildPrintCutPdf, markRects, toMarkOrigin, markDistances } = require('../electron/lib/printCutPdf');
const L = require('../electron/lib/cutterLang');

// 1x1 red PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

function pageContent(pdf) {
  const s = pdf.toString('latin1');
  let out = '';
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(s))) { try { out += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { out += m[1]; } }
  return s + out;
}

test('print & cut PDF has image, marks and CutContour spot color', async () => {
  const sq = [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }, { x: 20, y: 20 }];
  const pdf = await buildPrintCutPdf({ sheetW: 215.9, sheetH: 279.4, images: [{ dataUrl: PNG, x: 20, y: 20, w: 40, h: 40 }], cutPaths: [sq], marks: { margin: 10, size: 10, thickness: 0.5 }, cutContour: true });
  const all = pageContent(pdf);
  assert.ok(all.includes('/Separation /CutContour') || all.includes('/Separation/CutContour'), 'spot color');
  assert.ok(/\/CSCut CS/.test(all) && /1 SCN/.test(all), 'stroke uses spot');
  assert.ok(all.includes('/Image'), 'image embedded');
});

test('no CutContour when not asked', async () => {
  const pdf = await buildPrintCutPdf({ sheetW: 100, sheetH: 100, cutPaths: [[{ x: 1, y: 1 }, { x: 2, y: 2 }]], marks: { margin: 10 } });
  assert.ok(!pageContent(pdf).includes('CutContour'));
});

test('marks sit inside the sheet at the corners', () => {
  const r = markRects(215.9, 279.4, { margin: 10, size: 10, thickness: 0.5 });
  assert.strictEqual(r.length, 8);
  for (const [x, y, w, h] of r) assert.ok(x >= 10 && y >= 10 && x + w <= 205.91 && y + h <= 269.41);
});

test('cut coordinates are relative to the bottom-left mark and survive generation unshifted', () => {
  const sheetW = 215.9, sheetH = 279.4, m = 10;
  const p = toMarkOrigin([[{ x: 20, y: 259.4 }, { x: 30, y: 259.4 }]], sheetW, { y0: 0, h: sheetH }, m);
  assert.deepStrictEqual(p[0][0], { x: 10, y: 10 });
  const hp = L.toHPGL(p, { unitsPerMm: 40, keepOrigin: true });
  assert.ok(hp.includes('PU400,400;PD800,400;'), hp);
});

test('roll segments: each frame has its own 4 marks, cuts measured from that frame', () => {
  const W = 1371.6, segH = 914.4, m = 10;
  const f2 = { y0: segH, h: segH };
  const r = markRects(W, segH * 2, { margin: m, size: 10, thickness: 0.5 }, f2);
  for (const [, y, , h] of r) assert.ok(y >= segH + m - 0.01 && y + h <= 2 * segH - m + 0.01);
  // a point 10 mm right and 10 mm up from frame 2's bottom-left mark
  const p = toMarkOrigin([[{ x: m + 10, y: 2 * segH - m - 10 }]], W, f2, m);
  assert.deepStrictEqual(p[0][0], { x: 10, y: 10 });
  assert.deepStrictEqual(markDistances(W, f2, m), { dx: W - 2 * m, dy: segH - 2 * m });
});

test('alignment correction and rotation are applied to the cut', () => {
  const W = 215.9, H = 279.4, m = 10, f = { y0: 0, h: H };
  const pt = [[{ x: m + 10, y: H - m - 20 }]]; // u=10, v=20
  assert.deepStrictEqual(toMarkOrigin(pt, W, f, m, { offsetXmm: 1.5, offsetYmm: -0.5 })[0][0], { x: 11.5, y: 19.5 });
  const bw = W - 2 * m, bh = H - 2 * m;
  assert.deepStrictEqual(toMarkOrigin(pt, W, f, m, { rotate: '180' })[0][0], { x: bw - 10, y: bh - 20 });
  assert.deepStrictEqual(toMarkOrigin(pt, W, f, m, { rotate: '90' })[0][0], { x: 20, y: bw - 10 });
});

test('mark-reading commands wrap the cut, with distances filled in', () => {
  const sq = [[{ x: 0, y: 0 }, { x: 10, y: 0 }]];
  const hp = L.generate(sq, { keepOrigin: true, unitsPerMm: 40, markDxMm: 195.9, markDyMm: 259.4, regCommands: 'IN;REG{DX},{DY};{CUT}END;' });
  assert.ok(hp.startsWith('IN;REG7836,10376;PA;PU0,0;PD400,0;'), hp);
  assert.ok(hp.endsWith('END;'));
  assert.ok(!hp.slice(3).includes('IN;'), 'no second IN; that could reset the mark alignment');
  const gp = L.generate(sq, { keepOrigin: true, language: 'gpgl', gpglStepMm: 0.1, markDxMm: 100, markDyMm: 50, regCommands: 'TB{DX_MM}<ETX>' });
  assert.ok(gp.startsWith('TB100.0\x03M0,0\x03D100,0\x03'), JSON.stringify(gp));
  // no commands = plain cut (panel-started scan)
  assert.ok(L.generate(sq, { keepOrigin: true, unitsPerMm: 40 }).startsWith('IN;PA;'));
});
