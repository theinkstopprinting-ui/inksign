const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../electron/lib/cutterLang');

function fakeCutter() {
  return new Promise((resolve) => {
    const got = [];
    const srv = net.createServer((s) => { const c = []; s.on('data', (d) => c.push(d)); s.on('end', () => got.push(Buffer.concat(c).toString('latin1'))); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, got }));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sq = [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }, { x: 0, y: 0 }]];

test('jog commands go to absolute spots from the origin', () => {
  assert.strictEqual(L.moveTo(25.4, 10, { unitsPerMm: 40 }), 'IN;PA;PU1016,400;');
  assert.strictEqual(L.moveTo(25.4, 10, { language: 'gpgl', gpglStepMm: 0.1 }), 'M254,100\x03');
});

test('roll position, pause and cancel through the real queue', async () => {
  const store = require('../electron/store');
  const queue = require('../electron/queue');
  const drivers = require('../electron/drivers');
  store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-')));
  const { srv, port, got } = await fakeCutter();
  const g = store.getDevices().find((d) => d.presetId === 'graphtec-ce6000-60plus');
  store.saveDevice({ id: g.id, name: g.name, config: { connection: 'tcp', tcpHost: '127.0.0.1', tcpPort: port, overcutMm: 0, advanceMm: 0, hpglStyle: 'standard' } });
  store.setDeviceState(g.id, { continueRoll: true, rollUsedMm: 0 });
  queue.init(store, drivers, () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-'));
  const add = (name, extra = {}) => {
    const f = path.join(dir, `${name}.json`);
    fs.writeFileSync(f, JSON.stringify({ paths: sq, overrides: {} }));
    return queue.add({ deviceId: g.id, action: 'paths', filePath: f, name, ...extra });
  };
  add('one'); await wait(600);
  add('two'); await wait(600);
  assert.strictEqual(got.length, 2);
  assert.ok(got[0].startsWith('IN;PA;PU0,0;'), got[0].slice(0, 30));
  // second job starts 100 mm + 12.7 mm gap along the roll = 4508 units
  assert.ok(got[1].startsWith('IN;PA;PU4508,0;'), got[1].slice(0, 30));
  assert.ok(Math.abs(store.getDevice(g.id).state.rollUsedMm - 225.4) < 0.01);

  // pause: job waits; resume sends it
  queue.setPaused(g.id, true);
  const j3 = add('three'); await wait(500);
  assert.strictEqual(store.getJobs().find((j) => j.id === j3.id).status, 'queued');
  queue.setPaused(g.id, false); await wait(600);
  assert.strictEqual(store.getJobs().find((j) => j.id === j3.id).status, 'done');
  assert.strictEqual(got.length, 3);

  // cancel waiting: held + queued while paused
  queue.setPaused(g.id, true);
  add('four'); add('five', { hold: true, holdMessage: 'Load Red vinyl' });
  assert.strictEqual(queue.cancelWaiting(g.id), 2);
  queue.setPaused(g.id, false); await wait(400);
  assert.strictEqual(got.length, 3);
  assert.ok(store.getJobs().filter((j) => j.status === 'cancelled').length === 2);

  // start point from jogging (no continue): job shifted by startX/startY
  store.setDeviceState(g.id, { continueRoll: false, startX: 50, startY: 25 });
  add('six'); await wait(600);
  assert.ok(got[3].startsWith('IN;PA;PU2000,1000;'), got[3].slice(0, 30));
  // registered (print & cut) jobs ignore the start point
  const f = path.join(dir, 'reg.json');
  fs.writeFileSync(f, JSON.stringify({ paths: sq, overrides: { keepOrigin: true } }));
  queue.add({ deviceId: g.id, action: 'paths', filePath: f, name: 'reg' }); await wait(600);
  assert.ok(got[4].startsWith('IN;PA;PU0,0;'), got[4].slice(0, 30));
  srv.close();
});
