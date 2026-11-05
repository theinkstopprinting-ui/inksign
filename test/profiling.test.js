// Xerox profile maker (InkRIP's system): chart, readings check, build, paper assignment, top-up, Nix USB
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { PDFDocument, rgb } = require('pdf-lib');
const gs = require('../electron/lib/ghostscript');
const ic = require('../electron/color/iccengine');
const nd = require('../electron/color/nixdata');

test.after(() => gs.shutdown());
const until = async (fn, ms = 60000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); } };
// a made-up Xerox: CMYK -> Lab
const model = (c) => ic.srgbToLab(255 * (1 - c[0]) * (1 - c[3]) * (1 - 0.1 * c[1]), 255 * (1 - 0.92 * c[1]) * (1 - c[3]) * (1 - 0.3 * c[0]), 255 * (1 - 0.95 * c[2]) * (1 - c[3]) * (1 - 0.15 * c[1]));
const nixCsv = (patches) => `User Color Name,L,a,b\n${patches.map((c, i) => { const l = model(c); return `Patch ${i + 1},${l.map((v) => v.toFixed(2)).join(',')}`; }).join('\n')}`;

test('chart patches are InkRIP\'s, and the chart PDF is pure CMYK on the paper', async () => {
  const chart = require('../electron/color/chart');
  const p = nd.chartPatches(200);
  assert.strictEqual(p.length, 200);
  assert.deepStrictEqual(p[0], [0, 0, 0, 0]);
  assert.strictEqual(nd.chartCode(200), 'NIX-200-v1');
  const c = await chart.chartPdf(p, { paper: { name: 'Letter', w: 612, h: 792 }, code: 'NIX-200-v1' });
  assert.strictEqual(c.pages, 2);
  const doc = await PDFDocument.load(c.pdf);
  assert.deepStrictEqual(doc.getPages().map((x) => [x.getWidth(), x.getHeight()]), [[612, 792], [612, 792]]);
  const big = await chart.chartPdf(p, { paper: { name: '12x18', w: 864, h: 1296 }, code: 'x' });
  assert.strictEqual(big.pages, 1);
  const labs = await chart.expectedLabs(gs, p);
  assert.ok(labs[0][0] > 95, 'white patch is white');
  const k100 = p.findIndex((x) => x.join() === '0,0,0,1');
  assert.ok(labs[k100][0] < 40, `solid black is dark (L ${labs[k100][0]})`);
});

test('print chart → check → build → paper uses it → top-up', async () => {
  const got = [];
  const fake = net.createServer((s) => { const c = []; s.on('data', (d) => c.push(d)); s.on('end', () => got.push(Buffer.concat(c))); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inksign-prof-'));
  let settings = { paperCatalog: [{ id: 'gloss', name: 'Letter 100# gloss', size: 'Letter', type: 'LightweightGlossyCardstock', color: 'White', tray: 'auto' }], printServer: { holdPort: 0, printPort: 0 }, iccProfiles: [] };
  const devices = [{ id: 'x', name: 'Xerox', driver: 'network-printer', config: { host: '127.0.0.1', port: fake.address().port, model: 'xerox-7845' } }];
  const store = { getSettings: () => settings, saveSettings: (p) => { settings = { ...settings, ...p }; }, getDevices: () => devices, newId: () => crypto.randomUUID() };
  const profDir = path.join(dir, 'profiles');
  const srv = require('../electron/server/printServer');
  srv.init({ dir: path.join(dir, 'ps'), store, gs, ppdLib: require('../electron/lib/ppd'), transports: require('../electron/transports'), userName: () => 'T', log: () => {}, profilesDir: profDir,
    profileBytes: (id) => { try { return fs.readFileSync(path.join(profDir, `${id}.icc`)); } catch { return null; } } });

  const ch = await srv.profChart({ patches: 200, catalogId: 'gloss', quality: 'Enhanced' });
  assert.strictEqual(ch.code, 'NIX-200-v1');
  await until(() => got.length === 1);
  const s = got[0].toString('latin1');
  assert.ok(s.includes('*OutputMode Enhanced') && s.includes('*MediaType LightweightGlossyCardstock'));
  assert.ok(!/^[\d. ]+ rg$/m.test(s), 'no RGB colours in the chart');
  // colour handling on a chart can't be changed
  await until(() => srv.state().jobs[0].status === 'printed');
  const j = srv.state().jobs[0];
  srv.setProps(j.id, { ...j.props, color: { manage: true, mode: 'gray' }, scale: 'fit' });
  assert.strictEqual(srv.state().jobs[0].props.color.manage, false);
  assert.strictEqual(srv.state().jobs[0].props.color.mode, 'color');
  assert.strictEqual(srv.state().jobs[0].props.scale, 'none');

  const csv = nixCsv(nd.chartPatches(200));
  const ok = await srv.profCheck({ patches: 200, text: csv });
  assert.strictEqual(ok.readings, 200);
  assert.deepStrictEqual(ok.problems, []);
  // two scans skipped at patch 61: everything after is shifted -> caught
  const lines = csv.split('\n');
  const skipped = [lines[0], ...lines.slice(1, 61), ...lines.slice(63)].map((l, i) => (i ? l.replace(/^Patch \d+/, 'x') : l)).join('\n');
  const bad = await srv.profCheck({ patches: 200, text: skipped });
  assert.ok(bad.problems.some((p) => /don't look like their patch/.test(p)), bad.problems.join(' | '));

  const b = await srv.profBuild({ patches: 200, text: csv, catalogId: 'gloss', quality: 'Enhanced' });
  assert.ok(b.fit.avg < 2.5, `fit ${b.fit.avg}`);
  assert.strictEqual(settings.paperCatalog[0].outputProfileId, b.id);
  assert.ok(srv.state().profiles.some((p) => p.id === b.id && p.space === 'CMYK'));
  const desc = ic.describeProfile(fs.readFileSync(path.join(profDir, `${b.id}.icc`)));
  assert.strictEqual(desc.colorSpace, 'CMYK');
  assert.strictEqual(desc.deviceClass, 'prtr');

  // a colour-managed job on that paper is converted with the new profile
  const d = await PDFDocument.create();
  d.addPage([612, 792]).drawRectangle({ x: 50, y: 50, width: 300, height: 300, color: rgb(0, 0.4, 0.9) });
  await srv.submit({ name: 'managed', pdf: Buffer.from(await d.save()), props: { media: { catalogId: 'gloss' }, color: { mode: 'color', manage: true, intent: 1 } } });
  await until(() => got.length === 2);
  const s2 = got[1].toString('latin1');
  assert.ok(!/^[\d. ]+ rg$/m.test(s2), 'RGB was converted to CMYK');
  assert.ok(/[\d.]+ [\d.]+ [\d.]+ [\d.]+ k$/m.test(s2));

  // top-up
  assert.deepStrictEqual(srv.profTopups().map((t) => t.id), [b.id]);
  const tc = await srv.profChart({ kind: 'topup', profileId: b.id });
  assert.strictEqual(tc.patches, 100);
  const tb = await srv.profTopupBuild({ profileId: b.id, text: nixCsv(nd.topupPatches()) });
  assert.strictEqual(tb.patches, 300);
  assert.ok(tb.after.avg <= tb.before.avg, `${tb.before.avg} -> ${tb.after.avg}`);
  assert.ok(fs.existsSync(path.join(profDir, `${b.id}.icc.before-topup`)));
  srv.stop();
  fake.close();
});

test('Nix on USB through the bridge protocol', async () => {
  process.env.NIX_BRIDGE_TEST = path.join(__dirname, 'fixtures', 'fakeNixBridge.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inksign-nix-'));
  const nix = require('../electron/color/nixdevice');
  let s = {};
  nix.init({ getSettings: () => s, saveSettings: (p) => { s = { ...s, ...p }; }, dataDir: dir });
  await assert.rejects(nix.connect(), /licence/);
  assert.throws(() => nix.saveLicense('nope'), /Options and Signature/);
  nix.saveLicense('Options: abc\nSignature: def');
  const c = await nix.connect();
  assert.strictEqual(c.device.name, 'Nix Mini 3 (test)');
  const m = await nix.measure();
  assert.strictEqual(m.lab.length, 3);
  assert.strictEqual((await nix.status()).device.name, 'Nix Mini 3 (test)');
  await nix.disconnect();
  nix.stop();
  delete process.env.NIX_BRIDGE_TEST;
});
