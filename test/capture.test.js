// Learn from Flexi: listener, file import, capture kit; Mutoh Kona preset
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

test('captures a job sent to the listener and saves it to Downloads\\InkSign captures', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inksign-home-'));
  const old = os.homedir;
  os.homedir = () => home;
  try {
    const c = require('../electron/capture');
    const events = [];
    c.init({ notify: (r) => events.push(r), dataDir: path.join(home, 'data') });
    const free = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
    const s = await c.listen({ machine: 'HP Latex 335', port: free });
    assert.ok(s.listening);
    const job = Buffer.from('\x1b%-12345X@PJL JOB\n@PJL ENTER LANGUAGE=PCL3GUI\n0123456789', 'latin1');
    await new Promise((r) => { const k = net.createConnection({ host: '127.0.0.1', port: free }, () => k.end(job)); k.on('close', r); });
    await new Promise((r) => setTimeout(r, 200));
    const got = events.find((e) => e.file);
    assert.ok(got, 'saved');
    assert.ok(got.file.startsWith(path.join(home, 'Downloads', 'InkSign captures')));
    assert.ok(fs.readFileSync(got.file).equals(job));
    assert.strictEqual(got.looks, 'PJL printer job');
    c.stop();
    const plt = path.join(home, 'x.plt');
    fs.writeFileSync(plt, 'IN;SP1;PU0,0;PD400,0;');
    assert.strictEqual(c.importFile('Graphtec', plt).looks, 'HP-GL cutter commands');
    const k = await c.kit();
    assert.strictEqual(k.files.length, 3);
    const { PDFDocument } = require('pdf-lib');
    const cut = await PDFDocument.load(fs.readFileSync(path.join(k.folder, '2 - Cutter test 4x4 (CutContour).pdf')));
    assert.deepStrictEqual([cut.getPage(0).getWidth(), cut.getPage(0).getHeight()], [288, 288]);
    assert.ok(fs.readFileSync(path.join(k.folder, '3 - Print and cut test 6x4.pdf')).toString('latin1').includes('CutContour'));
  } finally { os.homedir = old; }
});

test('Mutoh Kona 1400 is a ready-made cutter and is added to the shop machines', () => {
  const presets = require('../electron/drivers/presets');
  const k = presets.byId('mutoh-kona-1400');
  assert.strictEqual(k.kind, 'cutter');
  assert.strictEqual(k.config.language, 'hpgl');
  assert.ok(presets.shopDefaults.some((d) => d.presetId === 'mutoh-kona-1400'));
});
