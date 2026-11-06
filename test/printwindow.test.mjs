import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import http from 'http';
import { createRequire } from 'module';
import { PDFDocument } from 'pdf-lib';
import { plan, fitScale, printableWidth, trimLines } from '../src/lib/printPlan.js';

const require = createRequire(import.meta.url);
const H = require('../electron/lib/hpStatus.js');
const { buildLayoutPdf } = require('../electron/lib/printLayout.js');
const { buildDesignPdf } = require('../electron/lib/designPdf.js');
const fx = (n) => fs.readFileSync(new URL(`./fixtures/hp/${n}`, import.meta.url), 'utf8');
const near = (a, b, t = 1e-6) => Math.abs(a - b) <= t;

test('reads the loaded roll the way Flexi does (LEDM MediaHandlingDyn, captured from the 335)', () => {
  const [t] = H.parseMediaHandling(fx('MediaHandlingDyn.xml'));
  assert.deepStrictEqual(t, { bin: 'Roll1', mediaKey: '150100', mediaType: 'Generic Self-Adhesive Vinyl', widthMm: 1371, lengthMm: null, trayType: 'roll', state: 'notEngaged' });
  const st = H.parseProductStatus(fx('ProductStatusDyn.xml'));
  assert.strictEqual(st.status, 'missingPrintHead');
  assert.strictEqual(st.alerts.filter((a) => a.id === 'missingPrintHead').length, 2); // MY and C, duplicates folded
  assert.ok(st.alerts.some((a) => /magenta\/yellow/.test(a.text)));
});

test('ink levels for all seven 831 cartridges, refills included (no colour code)', () => {
  const { ink, heads } = H.parseConsumables(fx('ConsumableConfigDyn.xml'));
  assert.deepStrictEqual(ink.map((k) => [k.code, k.percent]), [['M', 55], ['LM', 91], ['LC', 75], ['C', 22], ['OP', 97], ['Y', 24], ['K', 60]]);
  assert.strictEqual(heads.length, 6);
});

test('printerState asks the printer over HTTP', async () => {
  const srv = http.createServer((req, res) => {
    const f = { '/DevMgmt/MediaHandlingDyn.xml': 'MediaHandlingDyn.xml', '/DevMgmt/ProductStatusDyn.xml': 'ProductStatusDyn.xml', '/DevMgmt/ConsumableConfigDyn.xml': 'ConsumableConfigDyn.xml' }[req.url];
    if (!f) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(fx(f));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const st = await H.printerState('127.0.0.1', { port: srv.address().port });
    assert.strictEqual(st.media.widthMm, 1371);
    assert.strictEqual(st.media.mediaKey, '150100');
    assert.strictEqual(st.ink.length, 7);
  } finally { srv.close(); }
});

const media = { widthMm: 1371, margins: { left: 9, right: 9 } };

test('plan: position from the right edge, copies fill across then along', () => {
  assert.ok(near(printableWidth(media), 1353));
  const p = plan({ w: 400, h: 300 }, { scale: 100, rotate: 0, x: 10, y: 20, copies: 5, gapX: 10, gapY: 15 }, media);
  assert.strictEqual(p.pieces.length, 5);
  assert.deepStrictEqual(p.pieces.slice(0, 4).map((q) => [q.x, q.y]), [[10, 20], [420, 20], [830, 20], [10, 335]]);
  assert.ok(near(p.usedL, 635) && near(p.usedW, 1230), `${p.usedW} x ${p.usedL}`);
  assert.deepStrictEqual(p.problems, []);
});

test('plan: too wide is a problem unless tiled; tiles overlap and start at the origin', () => {
  const big = { w: 3000, h: 1000 };
  assert.match(plan(big, { scale: 100 }, media).problems[0], /wider/);
  const p = plan(big, { scale: 100, tile: true, overlap: 20 }, media);
  assert.strictEqual(p.tiles, 3);
  assert.deepStrictEqual(p.problems, []);
  const c = p.pieces.map((q) => q.clip);
  assert.ok(near(c[0][2], 3000)); // first panel is the job's right-hand side
  assert.ok(near(c[0][0] - c[1][2], -20, 1e-6)); // 20 mm overlap
  assert.ok(near(c[2][0], 0));
  assert.ok(p.pieces.every((q) => q.w <= printableWidth(media) + 1e-6));
  assert.ok(near(fitScale({ w: 2706, h: 100 }, { rotate: 0 }, media), 50));
});

test('layout PDF: page as wide as used, job turned and placed from the right edge', async () => {
  const sq = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }];
  const job = await buildDesignPdf({ w: 200, h: 100, items: [{ kind: 'path', paths: [sq(0, 0, 200, 100)], fill: '#ff0000' }] });
  const p = plan({ w: 200, h: 100 }, { scale: 50, rotate: 90, x: 30, y: 10, copies: 2, gapX: 5, trim: true, labels: true }, media);
  const out = await buildLayoutPdf(job.pdf, { ...p, scale: 50, rotate: 90, trim: trimLines(p.pieces), labels: p.labels.map((l) => ({ ...l, text: 'x' })) });
  const d = await PDFDocument.load(out.pdf);
  const pg = d.getPages()[0];
  assert.ok(near(pg.getWidth(), p.usedW * 72 / 25.4, 0.01) && near(pg.getHeight(), p.usedL * 72 / 25.4, 0.01));
  assert.ok(near(p.pieces[0].w, 50) && near(p.pieces[0].h, 100));
});

test('old printhead entries in the alert log are not shown as current errors (335 after the head swap)', () => {
  const st = H.parseProductStatus(fx('ProductStatusDyn-powersave.xml'));
  assert.strictEqual(st.status, 'inPowerSave');
  assert.match(st.statusText, /power save/);
  assert.deepStrictEqual(st.alerts.filter((a) => a.current && a.severity === 'Error'), []);
  assert.ok(st.alerts.some((a) => !a.current && a.id === 'missingPrintHead'));
});
