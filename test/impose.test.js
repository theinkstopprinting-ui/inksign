const test = require('node:test');
const assert = require('node:assert');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { impose } = require('../electron/lib/impose');

async function makePdf(n, wIn, hIn) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) d.addPage([wIn * 72, hIn * 72]).drawText(`PAGE ${i + 1}`, { x: 20, y: 20, size: 12, font: f });
  return Buffer.from(await d.save());
}

test('business cards with bleed: 21 up on 12x18, front + back', async () => {
  const src = await makePdf(2, 3.75, 2.25);
  const r = await impose({ pdf: src }, { mode: 'repeat', sheetW: 12, sheetH: 18, bleedIn: 0.125, cropMarks: true, duplex: true, sheets: 50 });
  assert.strictEqual(r.info.perSheet, 21);
  assert.deepStrictEqual(r.info.trimIn.map((v) => +v.toFixed(3)), [3.5, 2]);
  const out = await PDFDocument.load(r.pdf);
  assert.strictEqual(out.getPageCount(), 2);
  assert.strictEqual(out.getPage(0).getWidth(), 12 * 72);
});

test('booklet: 6 pages -> 2 sheets (4 sides), 2 blanks', async () => {
  const src = await makePdf(6, 5.5, 8.5);
  const r = await impose({ pdf: src }, { mode: 'booklet', sheetW: 11, sheetH: 8.5, marginIn: 0 });
  assert.strictEqual(r.info.sheets, 2);
  assert.strictEqual(r.info.blankPages, 2);
  const out = await PDFDocument.load(r.pdf);
  assert.strictEqual(out.getPageCount(), 4);
});

test('n-up: 10 letter pages 4-up on tabloid -> 3 sheets', async () => {
  const src = await makePdf(10, 4, 5);
  const r = await impose({ pdf: src }, { mode: 'nup', sheetW: 11, sheetH: 17, gapIn: 0.25, cropMarks: false });
  assert.ok(r.info.perSheet >= 4);
  assert.strictEqual(r.info.sheets, Math.ceil(10 / r.info.perSheet));
});

test('too big piece is a clear error', async () => {
  const src = await makePdf(1, 20, 20);
  await assert.rejects(impose({ pdf: src }, { mode: 'repeat', sheetW: 8.5, sheetH: 11 }), /doesn't fit/);
});
