// Banner finishing, templates, preflight, name lists and multiple pages
import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../src/lib/doc.js';
import * as FX from '../src/lib/docEffects.js';
import { TEMPLATES, templateSetup } from '../src/lib/templates.js';
import { preflightDoc } from '../src/lib/docPreflight.js';
import { parseList, fillText, fieldsIn } from '../src/lib/nameList.js';
import * as P from '../src/lib/pages.js';

const box = (x, y, w, h) => [[{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }]];

test('banner finishing grows the page by the hems, moves the art in and adds grommets', () => {
  const a = D.shapeFromPaths(box(100, 100, 200, 100));
  const d = { ...D.newDoc({ widthIn: 48, heightIn: 24 }), objects: [a] };
  const r = FX.bannerFinish(d, { hemMm: 25.4, spacingMm: 609.6 });
  assert.ok(Math.abs(r.doc.page.w - 50 * 25.4) < 1e-6);
  assert.ok(Math.abs(r.doc.page.h - 26 * 25.4) < 1e-6);
  assert.equal(r.doc.objects[0].x, a.x + 25.4);
  assert.ok(r.doc.guides.x.some((g) => Math.abs(g - 25.4) < 1e-6) && r.doc.guides.x.some((g) => Math.abs(g - 49 * 25.4) < 1e-6));
  assert.equal(r.doc.objects.length, 2);
  assert.equal(r.count, 6); // corners + the middle of each long side, as on a 2 × 4 ft banner
  const plain = FX.bannerFinish(d, { hemMm: 0, grommets: false });
  assert.equal(plain.doc.page.w, d.page.w);
  assert.equal(plain.doc.objects.length, 1);
});

test('every template has a sensible setup', () => {
  assert.ok(TEMPLATES.length >= 15);
  for (const t of TEMPLATES) {
    const s = templateSetup(t);
    assert.ok(s.page.w > 0 && s.page.h > 0, t.id);
    if (t.safeIn) assert.equal(s.guides.x.length, 2);
  }
  assert.ok(templateSetup(TEMPLATES.find((t) => t.marks)).marks);
});

test('preflight flags low resolution, off-page art, missing cut lines and art in the marks', () => {
  const img = { ...D.imageObject({ src: 'data:image/png;base64,AA==', natW: 600, natH: 600, name: 'logo' }), natPx: { w: 300, h: 300 } };
  const d = { ...D.newDoc({ widthIn: 24, heightIn: 24 }), objects: [img] };
  const rows = preflightDoc(d, { purpose: 'printcut' });
  assert.ok(rows.some((r) => r.level === 'error' && /ppi/.test(r.text)), JSON.stringify(rows));
  assert.ok(rows.some((r) => r.level === 'error' && /No cut line/.test(r.text)));
  const off = { ...d, objects: [D.shapeFromPaths(box(-50, 10, 100, 10))] };
  assert.ok(preflightDoc(off).some((r) => /off the page/.test(r.text)));
  const marked = { ...d, marks: { margin: 10, size: 10, thickness: 0.5 }, objects: [D.shapeFromPaths(box(5, 5, 50, 50))] };
  assert.ok(preflightDoc(marked).some((r) => /registration-mark/.test(r.text)));
  assert.equal(preflightDoc({ ...d, objects: [] })[0].level, 'error');
});

test('name lists: plain lines, CSV with quotes, tab paste, fields', () => {
  assert.deepEqual(parseList('Smith\n\nJones\r\n'), { headers: ['Name'], rows: [['Smith'], ['Jones']] });
  const c = parseList('Name,Number\n"O\'Brien, Pat",12\nLee,7');
  assert.deepEqual(c.headers, ['Name', 'Number']);
  assert.deepEqual(c.rows[0], ["O'Brien, Pat", '12']);
  assert.deepEqual(parseList('Name\tNo\nAl\t3').rows, [['Al', '3']]);
  assert.deepEqual(fieldsIn('{Name} #{Number}'), ['Name', 'Number']);
  assert.equal(fillText('{name} #{Number}', ['Lee', '7'], c.headers), 'Lee #7');
  assert.equal(fillText('JONES', ['Lee', '7'], c.headers), 'Lee');
});

test('pages: add, switch, keep each page’s objects, remove, save', () => {
  const a = D.shapeFromPaths(box(0, 0, 10, 10)), b = D.shapeFromPaths(box(20, 0, 10, 10));
  let d = { ...D.newDoc(), objects: [a] };
  assert.equal(P.pageCount(d), 1);
  d = P.addPage(d);
  assert.equal(P.pageCount(d), 2); assert.equal(P.pageIndex(d), 1); assert.deepEqual(d.objects, []);
  d = { ...d, objects: [b] };
  d = P.goToPage(d, 0);
  assert.equal(d.objects[0].id, a.id);
  const saved = P.syncPages(d);
  assert.equal(saved.sheets[1].objects[0].id, b.id);
  assert.equal(P.docForPage(d, 1).objects[0].id, b.id);
  d = P.removePage(d, 0);
  assert.equal(P.pageCount(d), 1); assert.equal(d.objects[0].id, b.id); assert.equal(d.sheets, undefined);
});

test('outlining module: outlines from the outside in, then an inline on top', () => {
  const a = D.shapeFromPaths(box(50, 50, 100, 60));
  const d = { ...D.newDoc(), objects: [a] };
  const r = FX.outlineSet(d, [a.id], { count: 2, distMm: 3, colors: ['#ffffff', '#000000'], inlineMm: 1, inlineColor: '#ff0000' });
  assert.equal(r.doc.objects.length, 4);
  const w = (o) => D.objBounds(o).w;
  const [o2, o1, art, inl] = r.doc.objects;
  assert.equal(art.id, a.id);
  assert.ok(w(o2) > w(o1) && w(o1) > w(art) && w(inl) < w(art) + 0.01);
  assert.equal(o1.fill.color, '#ffffff'); assert.equal(o2.fill.color, '#000000'); assert.equal(inl.fill.color, '#ff0000');
});
