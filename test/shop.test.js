// Shop tools: users & PINs, owner checks, history & reprint, labor timers → InkFlow,
// maintenance meters, roll usage, shared setup publish/pull, phone view sign-in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const store = require('../electron/store');
const shop = require('../electron/shop');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inksign-shop-'));
const shareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inksign-share-'));
store.init(dir);

const calls = { costs: [], usage: [], queued: [], notices: [] };
const fakeInkflow = {
  addCost: async (_cfg, orderId, body) => { calls.costs.push({ orderId, ...body }); return { ok: true }; },
  rolls: async () => ({ rolls: [{ id: 'r1', widthIn: 24, materialName: 'Oracal 651', remainingFeet: 30, reorderFeet: 25 }] }),
  rollUsage: async (_cfg, rollId, body) => { calls.usage.push({ rollId, ...body }); return { remainingFeet: 30 - body.feet }; },
};
const fakeQueue = { add: (j) => { calls.queued.push(j); return { id: 'q' + calls.queued.length, ...j }; }, release() {}, retry() {}, cancelJob() {} };
const handlers = {};
shop.register({ handle: (name, fn) => { handlers[name] = fn; } });
const call = (name, ...args) => handlers[name]({}, ...args);

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

test.before(async () => {
  store.saveSettings({ inkflow: { url: 'http://inkflow.test', secret: 'x' }, phone: { enabled: true, port: await freePort() } });
  shop.init({ store, queue: fakeQueue, drivers: {}, inkflow: fakeInkflow, app: { getVersion: () => '1.0.0' }, dir, notice: (m) => calls.notices.push(m), reloadUi: () => {} });
});
test.after(() => shop.stopPhone());

test('PIN hashing', () => {
  const h = shop.hashPin('4321');
  assert.ok(shop.pinOk('4321', h));
  assert.ok(!shop.pinOk('1234', h));
  assert.notStrictEqual(shop.hashPin('4321'), h, 'salted');
});

test('users: owner/staff, sign-in and owner-only actions', async () => {
  const r = call('users:save', [{ name: 'John', role: 'owner', newPin: '1111' }, { name: 'Sam', role: 'staff', newPin: '2222' }], true);
  assert.strictEqual(r.requireLogin, true);
  const st = call('users:state');
  assert.strictEqual(st.users.length, 2);
  assert.ok(!('pin' in st.users[0]), 'PIN hashes never leave the main process');
  assert.strictEqual(st.current.name, 'John', 'the owner who turned sign-in on stays signed in');

  await assert.rejects(call('users:login', st.users[1].id, '9999'), /Wrong PIN/);
  const sam = await call('users:login', st.users[1].id, '2222');
  assert.strictEqual(sam.role, 'staff');
  assert.throws(() => shop.requireOwner(), /Only an owner/);
  assert.strictEqual(shop.userName(), 'Sam');

  call('users:logout');
  assert.throws(() => shop.requireOwner(), /Sign in first/);
  await call('users:login', st.users[0].id, '1111');
  assert.doesNotThrow(() => shop.requireOwner());
  // Keeping a PIN: blank newPin leaves the hash alone
  const again = call('users:save', call('users:state').users.map((u) => ({ ...u })), true);
  assert.strictEqual(again.users.length, 2);
  assert.ok(await call('users:login', st.users[1].id, '2222'));
  await call('users:login', st.users[0].id, '1111');
});

test('job done: meters, roll usage, material cost, history and reprint', async () => {
  const cutter = store.getDevices().find((d) => d.kind === 'cutter');
  const jobFile = path.join(dir, 'job.plt');
  fs.writeFileSync(jobFile, 'IN;PU0,0;PD100,0;');
  const job = { id: 'j1', name: 'Window letters', deviceId: cutter.id, deviceName: cutter.name, action: 'file', filePath: jobFile, status: 'done',
    inkflow: { orderId: 'o9' }, meta: { rollId: 'r1', feet: 6.04, costCents: 420, costNote: 'Vinyl 6 ft', cutMm: 12500 }, createdAt: Date.now() };
  await shop.onJobDone(job);
  assert.deepStrictEqual(calls.usage[0], { rollId: 'r1', feet: 6, orderId: 'o9', key: 'inksign-j1', note: `Window letters on ${cutter.name}` });
  assert.ok(calls.notices.some((n) => /down to 24 ft/.test(n)), 'low stock warning');
  assert.strictEqual(calls.costs[0].cents, 420);
  assert.strictEqual(calls.costs[0].key, 'j1');
  const m = call('maint:list').find((d) => d.deviceId === cutter.id).meters;
  assert.strictEqual(m.jobs, 1);
  assert.strictEqual(m.cutM, 12.5);

  const h = call('history:list');
  assert.strictEqual(h[h.length - 1].id, 'j1');
  const q = call('history:reprint', 'j1');
  assert.strictEqual(q.name, 'Window letters (reprint)');
  assert.strictEqual(q.meta.reprintOf, 'j1');
  assert.strictEqual(q.inkflow, null, 'a reprint is not reported to InkFlow again');
  // reprint finishing doesn't take stock or add cost twice
  await shop.onJobDone({ ...q, id: 'j2', deviceId: cutter.id, status: 'done' });
  assert.strictEqual(calls.usage.length, 1);
  assert.strictEqual(calls.costs.length, 1);
  const printer = store.getDevices().find((d) => d.kind === 'printer');
  assert.throws(() => call('history:reprint', 'j1', printer.id), /is a printer/);
  fs.unlinkSync(jobFile);
  assert.throws(() => call('history:reprint', 'j1'), /cleaned up/);
});

test('labor timer adds minutes × rate to the order', async () => {
  store.saveSettings({ pricing: { ...store.getSettings().pricing, laborPerHour: 60 } });
  const t = call('timers:start', { task: 'Weeding', orderId: 'o9', orderLabel: '#1042' });
  const it = t.running[t.running.length - 1];
  // pretend it ran 30 minutes
  const tf = path.join(dir, 'timers.json');
  const raw = JSON.parse(fs.readFileSync(tf, 'utf8'));
  raw.running.find((x) => x.id === it.id).start -= 30 * 60000;
  fs.writeFileSync(tf, JSON.stringify(raw));
  const r = await call('timers:stop', it.id);
  assert.strictEqual(r.entry.minutes, 30);
  assert.strictEqual(r.entry.costCents, 3000);
  assert.ok(r.entry.sentToInkFlow);
  const c = calls.costs[calls.costs.length - 1];
  assert.strictEqual(c.key, `labor:${it.id}`);
  assert.match(c.note, /Weeding, 30 min \(John\)/);
  await assert.rejects(call('timers:stop', it.id), /already stopped/);
});

test('maintenance: custom tasks, due status and done', () => {
  const cutter = store.getDevices().find((d) => d.kind === 'cutter');
  call('maint:saveTasks', cutter.id, [{ name: 'Blade', everyCutM: 10 }, { name: 'Bad', everyDays: '' }]);
  let d = call('maint:list').find((x) => x.deviceId === cutter.id);
  assert.strictEqual(d.tasks.length, 2);
  assert.ok(d.tasks[0].due, '12.5 m cut of 10 → due');
  assert.ok(!d.tasks[1].due);
  d = call('maint:done', cutter.id, d.tasks[0].id, 'new 45°').find((x) => x.deviceId === cutter.id);
  assert.ok(!d.tasks[0].due);
  assert.strictEqual(call('maint:log').slice(-1)[0].note, 'new 45°');
});

test('shared setup: publish then pull keeps local USB connections', () => {
  store.saveSettings({ shared: { folder: shareRoot, mode: 'publish' }, materials: [{ id: 'm1', name: 'Shared vinyl', costPerFt: 1 }] });
  const cutter = store.getDevices().find((d) => d.kind === 'cutter');
  store.saveDevice({ ...cutter, config: { ...cutter.config, connection: 'printer', printerName: 'Graphtec on PC1', speed: 30 } });
  const man = call('shared:publish');
  assert.ok(fs.existsSync(path.join(shareRoot, 'InkSign-shared', 'manifest.json')));
  const pub = JSON.parse(fs.readFileSync(path.join(shareRoot, 'InkSign-shared', 'devices.json'), 'utf8'));
  assert.ok(!('printerName' in pub.find((d) => d.id === cutter.id).config), 'local connection is not shared');

  // This "PC" changes things locally, then loads the shared setup
  store.saveSettings({ materials: [{ id: 'mx', name: 'Local only', costPerFt: 9 }] });
  store.saveDevice({ ...store.getDevice(cutter.id), config: { ...store.getDevice(cutter.id).config, printerName: 'Graphtec on PC2', speed: 10 } });
  const r = call('shared:pull');
  assert.strictEqual(r.manifest.updatedAt, man.updatedAt);
  assert.strictEqual(store.getSettings().materials[0].name, 'Shared vinyl');
  const after = store.getDevice(cutter.id);
  assert.strictEqual(after.config.speed, 30, 'shared settings win');
  assert.strictEqual(after.config.printerName, 'Graphtec on PC2', 'this PC keeps its own USB printer name');
  assert.ok(after.state && after.state.meters, 'meters kept');
});

test('phone view: PIN sign-in required, then state and job actions', async () => {
  const port = store.getSettings().phone.port;
  const base = `http://127.0.0.1:${port}`;
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /InkSign/);
  assert.strictEqual((await fetch(base + '/api/state')).status, 401);
  const bad = await (await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ pin: '0000' }) })).json();
  assert.strictEqual(bad.error, 'Wrong PIN');
  const { token } = await (await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ pin: '2222' }) })).json();
  assert.ok(token);
  const s = await (await fetch(base + '/api/state', { headers: { 'X-Token': token } })).json();
  assert.strictEqual(s.user, 'Sam');
  assert.ok(Array.isArray(s.jobs));
  const nf = await fetch(base + '/api/jobs/nope/release', { method: 'POST', headers: { 'X-Token': token } });
  assert.strictEqual(nf.status, 404);
});
