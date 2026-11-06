const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../electron/lib/cutterLang');
const drivers = require('../electron/drivers');

function fakeServer() {
  return new Promise((resolve) => {
    const received = [];
    const srv = net.createServer((s) => { const chunks = []; s.on('data', (c) => chunks.push(c)); s.on('end', () => received.push(Buffer.concat(chunks))); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, received }));
  });
}

test('HP-GL test square is exactly 1 inch at 40 units/mm', () => {
  const s = L.toHPGL(L.testPattern(), { unitsPerMm: 40 });
  assert.match(s, /^IN;PA;PU0,0;PD1016,0,1016,1016,0,1016,0,0;/);
  assert.match(s, /PU0,0;$/);
});

test('GP-GL uses step size and ETX terminators', () => {
  const s = L.toGPGL(L.testPattern(), { gpglStepMm: 0.1 });
  assert.ok(s.startsWith('M0,0\x03D254,0,254,254,0,254,0,0\x03'));
});

test('rotate 90 keeps job in positive space; overcut extends closed shapes', () => {
  const r = L.transformPaths(L.testPattern(), { rotate: 90 });
  const b = L.bounds(r);
  assert.strictEqual(Math.round(b.minX), 0); assert.strictEqual(Math.round(b.minY), 0);
  const oc = L.addOvercut([[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 }]], 2);
  assert.deepStrictEqual(oc[0][4], { x: 2, y: 0 });
});

test('speed/force/advance only sent when set', () => {
  const s = L.toHPGL(L.testPattern(), { speed: 30, force: 80, advanceMm: 25 });
  assert.match(s, /^IN;VS30;FS80;PA;/);
  assert.match(s, /PU2016,0;$/);
});

test('cutter driver sends test cut over TCP', async () => {
  const { srv, port, received } = await fakeServer();
  const cfg = { ...drivers.defaultsFor('cutter'), connection: 'tcp', tcpHost: '127.0.0.1', tcpPort: port };
  assert.deepStrictEqual(drivers.get('cutter').missing(cfg), []);
  const st = await drivers.get('cutter').checkStatus(cfg);
  assert.strictEqual(st.state, 'ok');
  await drivers.get('cutter').sendTest(cfg);
  await new Promise((r) => setTimeout(r, 300));
  srv.close();
  assert.ok(received.some((b) => b.toString().startsWith('IN;PA;')));
});

test('network printer (Xerox) sends PJL-wrapped PDF', async () => {
  const { srv, port, received } = await fakeServer();
  const cfg = { ...drivers.defaultsFor('network-printer'), host: '127.0.0.1', port };
  const res = await drivers.get('network-printer').sendTest(cfg, { jobName: 'T', deviceName: 'Xerox 7845' });
  await new Promise((r) => setTimeout(r, 300));
  srv.close();
  const s = received.find((b) => b.length > 1000).toString('latin1');
  assert.ok(s.startsWith('\x1B%-12345X@PJL JOB NAME="T"'));
  assert.ok(s.includes('@PJL ENTER LANGUAGE=PDF\r\n%PDF-'));
  assert.ok(s.trimEnd().endsWith('\x1B%-12345X'));
  assert.match(res.message, /Sent/);
});

test('Flexi hot folder: file appears complete and pickup is detected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-'));
  const seen = [];
  const watcher = setInterval(() => {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.part')) continue;
      const head = fs.readFileSync(path.join(dir, f)).subarray(0, 5).toString();
      seen.push(head); fs.unlinkSync(path.join(dir, f));
    }
  }, 200);
  const cfg = { ...drivers.defaultsFor('flexi-hotfolder'), hotFolder: dir, pickupTimeoutSec: 10 };
  const res = await drivers.get('flexi-hotfolder').sendTest(cfg, { deviceName: 'HP Latex 335' });
  clearInterval(watcher);
  assert.ok(!res.warning, res.message);
  assert.deepStrictEqual(seen, ['%PDF-']);
});

test('Flexi hot folder warns when nothing picks the file up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-'));
  const res = await drivers.get('flexi-hotfolder').sendTest({ hotFolder: dir, pickupTimeoutSec: 2 });
  assert.ok(res.warning);
});

test('every preset points at a real driver and catalog is plain data', () => {
  const c = drivers.catalog();
  for (const p of c.presets) assert.ok(c.drivers.find((d) => d.id === p.driver), p.id);
  assert.doesNotThrow(() => structuredClone(c));
});

test('store seeds the six shop machines; queue runs a job', async () => {
  const store = require('../electron/store');
  const queue = require('../electron/queue');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ud-'));
  store.init(dir);
  assert.deepStrictEqual(store.getDevices().map((d) => d.name), ['Graphtec CE6000-60 Plus', 'Titan 3 68"', 'Mutoh Kona 1400', 'HP Latex 335', 'HP Latex 115', 'Xerox 7845']);
  const { srv, port } = await fakeServer();
  const x = store.getDevices().find((d) => d.presetId === 'xerox-7845');
  store.saveDevice({ id: x.id, name: x.name, config: { host: '127.0.0.1', port } });
  const updates = [];
  queue.init(store, drivers, (j) => updates.push(j.status));
  queue.add({ deviceId: x.id, action: 'test' });
  const g = store.getDevices().find((d) => d.presetId === 'graphtec-ce6000-60plus');
  queue.add({ deviceId: g.id, action: 'test' });
  await new Promise((r) => setTimeout(r, 1500));
  srv.close();
  const jobs = store.getJobs();
  assert.strictEqual(jobs.find((j) => j.deviceId === x.id).status, 'done');
  const gj = jobs.find((j) => j.deviceId === g.id);
  assert.strictEqual(gj.status, 'error');
  assert.match(gj.message, /needs setup/i);
});
