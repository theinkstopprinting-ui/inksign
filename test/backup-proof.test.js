// Backup round trip, the customer proof PDF, and weed lines in the cut plan
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const backup = require('../electron/backup');
const { buildProofPdf } = require('../electron/lib/proofPdf');

test('backup: collect, write, keep 14, restore with .before-restore copies', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inksign-bk-'));
  const data = path.join(tmp, 'data'), out = path.join(tmp, 'Nextcloud');
  fs.mkdirSync(path.join(data, 'barcode-jobs'), { recursive: true });
  fs.writeFileSync(path.join(data, 'settings.json'), '{"a":1}');
  fs.writeFileSync(path.join(data, 'devices.json'), '[{"id":"g"}]');
  fs.writeFileSync(path.join(data, 'barcode-jobs', '000012.json'), '{"name":"job"}');
  const b = backup.collect(data, { 'inksign.cut.presets': '[]', other: 'x' });
  assert.equal(b.kind, 'inksign-backup');
  assert.deepEqual(Object.keys(b.files).sort(), ['devices.json', 'settings.json']);
  let file;
  for (let i = 0; i < 16; i++) file = backup.write(out, { ...b, at: Date.UTC(2026, 10, 1 + i, 12) });
  assert.equal(fs.readdirSync(out).filter((f) => f.endsWith('.inksign-backup')).length, 14);
  fs.writeFileSync(path.join(data, 'settings.json'), '{"a":2}');
  fs.rmSync(path.join(data, 'barcode-jobs', '000012.json'));
  const r = backup.restore(data, backup.read(file));
  assert.equal(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'), '{"a":1}');
  assert.equal(fs.readFileSync(path.join(data, 'settings.json.before-restore'), 'utf8'), '{"a":2}');
  assert.ok(fs.existsSync(path.join(data, 'barcode-jobs', '000012.json')));
  assert.equal(r.localStore['inksign.cut.presets'], '[]');
  assert.throws(() => backup.read(path.join(data, 'devices.json')), /not an InkSign backup/);
  assert.ok(backup.lastBackup(out).file.endsWith('.inksign-backup'));
});

test('proof PDF: one page with the art, landscape for wide art', async () => {
  const { PDFDocument } = require('pdf-lib');
  const sq = [{ x: 10, y: 10 }, { x: 290, y: 10 }, { x: 290, y: 90 }, { x: 10, y: 90 }, { x: 10, y: 10 }];
  const scene = { w: 300, h: 100, items: [{ kind: 'path', paths: [sq], fill: { type: 'solid', color: '#d0202e' }, stroke: null }] };
  const pdf = await buildProofPdf(scene, { title: 'Vital Medical', colors: ['Red'], order: '1975', shop: 'The Ink Stop' });
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getPageCount(), 1);
  const { width, height } = doc.getPage(0).getSize();
  assert.equal(width, 792); assert.equal(height, 612);
});
