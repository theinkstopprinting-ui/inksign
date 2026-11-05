import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import { parseCsv } from '../src/lib/csv.js';
const require = createRequire(import.meta.url);
const { buildVdp, numberRows, fill } = require('../electron/lib/vdp.js');
const { PDFDocument } = require('pdf-lib');

test('CSV with quotes, commas and blank lines', () => {
  const r = parseCsv('Name,Title\r\n"Smith, Jo","Owner ""Boss"""\r\n\r\nLee,Tech\n');
  assert.deepStrictEqual(r.columns, ['Name', 'Title']);
  assert.deepStrictEqual(r.rows, [{ Name: 'Smith, Jo', Title: 'Owner "Boss"' }, { Name: 'Lee', Title: 'Tech' }]);
});

test('numbering and placeholders', () => {
  assert.deepStrictEqual(numberRows({ start: 8, end: 10, pad: 4 }).map((r) => r.Number), ['0008', '0009', '0010']);
  assert.strictEqual(fill('Ticket #{Number} — {Name}', { Number: '0042', Name: 'Jo' }), 'Ticket #0042 — Jo');
});

test('one page per row, at finished size plus bleed', async () => {
  const pdf = await buildVdp({ rows: numberRows({ start: 1, end: 25 }), fields: [{ text: 'No. {Number}', xIn: 1.75, yIn: 0.8, sizePt: 18, align: 'center', font: 'Helvetica Bold' }], widthIn: 3.5, heightIn: 2, bleedIn: 0.125 });
  const d = await PDFDocument.load(pdf);
  assert.strictEqual(d.getPageCount(), 25);
  assert.ok(Math.abs(d.getPage(0).getWidth() - 3.75 * 72) < 0.01);
});
