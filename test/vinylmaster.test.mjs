import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import * as D from '../src/lib/doc.js';
import { jobBarcode } from '../src/lib/jobBarcode.js';

const require = createRequire(import.meta.url);
const box = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }];
const docWith = (...shapes) => { const d = D.newDoc(); return { ...d, page: { ...d.page, w: 600, h: 400 }, objects: shapes.map((s) => D.shapeFromPaths([s], {})) }; };
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

test('circle array: copies sit on the circle, turned to face out (or kept upright)', () => {
  const d = docWith(box(290, 40, 20, 10));
  const id = d.objects[0].id;
  const r = D.circleArray(d, [id], { count: 4, radius: 100 });
  assert.equal(r.doc.objects.length, 4);
  const centers = r.doc.objects.map((o) => { const b = D.objBounds(o); return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]; });
  for (const [x, y] of centers) assert.ok(near(Math.hypot(x - 300, y - 145), 100), `on the circle (${x}, ${y})`);
  assert.ok(centers.some(([x, y]) => near(x, 400) && near(y, 145)), 'one at 3 o\'clock');
  assert.deepEqual(r.doc.objects.map((o) => o.rot || 0).sort((a, b) => a - b), [0, 90, 180, 270]);
  const up = D.circleArray(d, [id], { count: 4, radius: 100, rotate: false });
  assert.ok(up.doc.objects.every((o) => !(o.rot % 360)), 'kept upright');
  const arc = D.circleArray(d, [id], { count: 3, radius: 100, sweepDeg: 90 });
  assert.deepEqual(arc.doc.objects.map((o) => o.rot || 0), [0, 45, 90], 'three copies across a quarter circle');
});

test('fit to page (auto / width / height / stretch) and fit page to selection', () => {
  const d = docWith(box(10, 10, 100, 50));
  const id = d.objects[0].id;
  const b = (doc) => D.selBounds(doc.objects);
  const auto = b(D.fitToPage(d, [id], 'auto', 0));
  assert.ok(near(auto.w, 600) && near(auto.h, 300) && near(auto.cy, 200), 'width fits first, centered');
  const h = b(D.fitToPage(d, [id], 'height', 0));
  assert.ok(near(h.h, 400) && near(h.w, 800));
  const st = b(D.fitToPage(d, [id], 'stretch', 10));
  assert.ok(near(st.w, 580) && near(st.h, 380) && near(st.minX, 10) && near(st.minY, 10));
  const two = docWith(box(100, 100, 50, 50), box(300, 200, 40, 40));
  const fp = D.fitPageToSel(two, [two.objects[0].id], 5);
  assert.deepEqual([fp.page.w, fp.page.h], [60, 60]);
  assert.ok(near(D.objBounds(fp.objects[0]).minX, 5) && near(D.objBounds(fp.objects[1]).minX, 205), 'everything moved together');
});

test('job barcode sits in the bottom strip, clear of the corner marks, with the number beside it', async () => {
  const marks = { margin: 10, size: 26, thickness: 1 };
  const bc = jobBarcode({ w: 600, h: 400 }, marks, '100123');
  assert.equal(bc.no, '100123');
  assert.equal(bc.text, 'InkSign job 100123');
  const x0 = Math.min(...bc.bars.map((r) => r[0])), x1 = Math.max(...bc.bars.map((r) => r[0] + r[2]));
  assert.ok(near(x0, 10 + 26 + 15), '15 mm after the corner mark');
  assert.ok(near(x1 - x0, 45, 0.5));
  assert.ok(bc.bars.every((r) => near(r[1] + r[3], 390)), 'on the bottom mark line');
  assert.equal(jobBarcode({ w: 100, h: 100 }, marks, '100123'), null, 'sheet too small: no barcode');
  assert.equal(jobBarcode({ w: 600, h: 400 }, null, '1'), null);
  // and it goes into the print file
  const { buildDesignPdf } = require('../electron/lib/designPdf.js');
  const scene = { w: 600, h: 400, name: 't', items: [{ kind: 'path', paths: [box(100, 100, 50, 50)], fill: '#ff0000' }], marks };
  const plain = await buildDesignPdf(scene);
  const coded = await buildDesignPdf({ ...scene, marks: { ...marks, barcode: bc } });
  assert.ok(coded.pdf.length > plain.pdf.length + 300, 'bars and number added');
  assert.ok(coded.pdf.toString('latin1').includes('Helvetica'));
});

test('cutter: area test runs the blade-up outline where the job will land; position offset; Titan keeps its format', () => {
  const L = require('../electron/lib/cutterLang.js');
  const job = [box(0, 0, 100, 50)];
  const titan = { language: 'hpgl', hpglStyle: 'titan', unitsPerMm: 40 };
  assert.equal(L.areaTrace(job, titan), 'IN;PA;PU0,0;PU4000,0;PU4000,2000;PU0,2000;PU0,0;PU0,0;');
  assert.ok(!/PD/.test(L.areaTrace(job, titan)), 'never puts the blade down');
  assert.equal(L.areaTrace(job, { ...titan, shiftX: 10, posXmm: 5, posYmm: 2 }), 'IN;PA;PU600,80;PU4600,80;PU4600,2080;PU600,2080;PU600,80;PU0,0;');
  assert.match(L.generate(job, { ...titan, posXmm: 5 }), /^IN;PU200,0;PD;PD4200,0;/);
  assert.match(L.areaTrace(job, { language: 'gpgl', gpglStepMm: 0.1 }), /^M0,0\x03M1000,0\x03M1000,500\x03/);
});
