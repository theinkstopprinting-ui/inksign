// HP Latex profile maker: chart on the roll (colour management off) → Nix readings → ICC → used as "Auto"
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const gs = require('../electron/lib/ghostscript');
const ic = require('../electron/color/iccengine');
const nd = require('../electron/color/nixdata');

test.after(() => gs.shutdown());
// a made-up Latex: CMYK -> Lab
const model = (c) => ic.srgbToLab(255 * (1 - c[0]) * (1 - c[3]) * (1 - 0.12 * c[1]), 255 * (1 - 0.9 * c[1]) * (1 - c[3]) * (1 - 0.25 * c[0]), 255 * (1 - 0.93 * c[2]) * (1 - c[3]) * (1 - 0.1 * c[1]));
const nixCsv = (patches) => `User Color Name,L,a,b\n${patches.map((c, i) => `Patch ${i + 1},${model(c).map((v) => v.toFixed(2)).join(',')}`).join('\n')}`;

test('HP chart prints across the roll with colour management off, then builds the Auto profile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inksign-hpprof-'));
  process.env.INKSIGN_DATA = dir;
  let settings = { iccProfiles: [] };
  const devices = [{ id: 'hp', name: 'HP Latex 335', driver: 'hp-latex', config: { host: '127.0.0.1', model: 'hp-latex-335', rollWidthIn: 54, mediaId: '150100' } }];
  const store = { getSettings: () => settings, saveSettings: (p) => { settings = { ...settings, ...p }; }, getDevice: (id) => devices.find((d) => d.id === id), newId: () => crypto.randomUUID() };
  const added = [];
  const queue = { add: (j) => { added.push(j); return { id: 'j1', ...j }; } };
  const hp = require('../electron/color/hpProfiling');
  hp.init({ store, queue, gs, profilesDir: () => path.join(dir, 'profiles') });

  const r = await hp.printChart({ deviceId: 'hp', mediaId: '150100', patches: 200, widthIn: 54 });
  assert.strictEqual(r.code, 'NIX-200-v1');
  const job = added[0];
  assert.strictEqual(job.options.icc, 'none');
  assert.strictEqual(job.options.mediaId, '150100');
  assert.ok(job.options.modeKey);
  const pdf = await PDFDocument.load(fs.readFileSync(job.filePath));
  assert.strictEqual(pdf.getPageCount(), 1);
  assert.ok(pdf.getPages()[0].getWidth() <= 24 * 72 + 0.01, 'chart is at most 24" across');

  const patches = nd.chartPatches(200);
  const text = nixCsv(patches);
  const chk = await hp.check({ kind: 'main', patches: 200, text });
  assert.strictEqual(chk.readings, 200);
  assert.deepStrictEqual(chk.missing, []);

  const b = await hp.build({ deviceId: 'hp', mediaId: '150100', modeKey: job.options.modeKey, patches: 200, text, tac: 300 });
  assert.ok(b.fit.avg < 3, `fit ΔE ${b.fit.avg}`);
  assert.ok(fs.existsSync(path.join(dir, 'profiles', `${b.id}.icc`)));
  const meta = settings.iccProfiles.find((p) => p.id === b.id);
  assert.strictEqual(meta.hp.mediaId, '150100');
  assert.strictEqual(hp.autoProfile(settings.iccProfiles, 'hp-latex-335', '150100', job.options.modeKey).id, b.id);
  assert.ok(ic.parseIcc(fs.readFileSync(path.join(dir, 'profiles', `${b.id}.icc`))));

  // the driver's Auto profile now picks it
  const drv = require('../electron/drivers/hpLatex');
  const origGet = require('../electron/store').getSettings;
  require('../electron/store').getSettings = () => settings;
  try {
    const res = drv.resolve(devices[0].config, { mediaId: '150100', modeKey: job.options.modeKey, icc: 'auto' });
    assert.strictEqual(res.iccName, meta.name);
  } finally { require('../electron/store').getSettings = origGet; }

  // top-up
  const tp = nd.topupPatches();
  const tb = await hp.topupBuild({ profileId: b.id, text: nixCsv(tp) });
  assert.strictEqual(tb.added, tp.length);
});
