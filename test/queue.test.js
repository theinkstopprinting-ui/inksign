const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fakeMachine() {
  return new Promise((resolve) => {
    const got = [];
    const srv = net.createServer((s) => { const c = []; s.on('data', (d) => c.push(d)); s.on('end', () => got.push(Buffer.concat(c).toString('latin1'))); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, got }));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// a square whose size tells the jobs apart in what the cutter received (HP-GL units: 40 per mm)
const square = (mm) => [[{ x: 0, y: 0 }, { x: mm, y: 0 }, { x: mm, y: mm }, { x: 0, y: mm }, { x: 0, y: 0 }]];

test('queue: reorder waiting jobs, move one to the other cutter, reprint, cancel, pictures', async () => {
  const store = require('../electron/store');
  const queue = require('../electron/queue');
  const drivers = require('../electron/drivers');
  const J = require('../electron/lib/jobThumb');
  store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'q-')));
  const a = await fakeMachine(), b = await fakeMachine();
  const devs = store.getDevices().filter((d) => d.driver === 'cutter');
  const [g, t] = [devs[0], devs[1]];
  const cfg = (port) => ({ connection: 'tcp', tcpHost: '127.0.0.1', tcpPort: port, overcutMm: 0, advanceMm: 0, hpglStyle: 'standard', language: 'hpgl' });
  store.saveDevice({ id: g.id, name: g.name, config: cfg(a.port) });
  store.saveDevice({ id: t.id, name: t.name, config: cfg(b.port) });
  const thumbs = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-'));
  queue.init(store, drivers, () => {});
  queue.setThumbMaker((job) => J.makeJobThumb(job, { dir: thumbs }), (name) => J.removeThumb(thumbs, name));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qj-'));
  const add = (name, mm, deviceId = g.id) => {
    const f = path.join(dir, `${name}.json`);
    fs.writeFileSync(f, JSON.stringify({ paths: square(mm), overrides: {} }));
    return queue.add({ deviceId, action: 'paths', filePath: f, name });
  };
  const job = (id) => store.getJobs().find((j) => j.id === id);
  const sizeOf = (s) => Number((/PD(\d+),0/.exec(s) || [])[1]) / 40;

  // paused: three wait; "c" goes to the top, "a" moves down one
  queue.setPaused(g.id, true);
  const ja = add('a', 10), jb = add('b', 20), jc = add('c', 30);
  assert.ok(queue.move(jc.id, 'top'));
  assert.ok(queue.move(ja.id, 'down'));
  assert.equal(queue.move(jc.id, 'up'), false, 'already first');
  // "b" goes to the other cutter
  queue.reassign(jb.id, t.id);
  assert.equal(job(jb.id).deviceName, t.name);
  await wait(600);
  assert.equal(b.got.length, 1, 'moved job printed on the other cutter right away');
  assert.equal(sizeOf(b.got[0]), 20);
  assert.equal(a.got.length, 0, 'paused cutter sent nothing');
  queue.setPaused(g.id, false);
  await wait(900);
  assert.deepEqual(a.got.map(sizeOf), [30, 10], 'sent in the new order: c then a');

  // pictures: cut lines drawn as SVG, size worked out
  await wait(100);
  assert.match(job(jc.id).thumb, /\.svg$/);
  assert.match(J.thumbDataUrl(thumbs, job(jc.id).thumb), /^data:image\/svg\+xml;base64,/);
  assert.ok(Math.abs(job(jc.id).info.wIn - 30 / 25.4) < 0.01);

  // reprint a finished job: a new job with the same file and picture
  const again = queue.reprint(jc.id);
  await wait(700);
  assert.equal(job(again.id).status, 'done');
  assert.equal(a.got.length, 3);
  assert.equal(sizeOf(a.got[2]), 30);

  // cancel: waiting jobs come off; a cutter job already being sent can't be stopped from here
  queue.setPaused(g.id, true);
  const jd = add('d', 40);
  assert.ok(queue.cancelJob(jd.id));
  assert.equal(job(jd.id).status, 'cancelled');
  assert.equal(queue.canAbort(jd), false);
  assert.throws(() => queue.reassign(jd.id, t.id), /Only waiting jobs/);
  queue.setPaused(g.id, false);

  // clear one machine's finished jobs: pictures still used by a kept job stay
  const shared = job(jc.id).thumb;
  queue.clearFinished(t.id);
  assert.ok(!store.getJobs().some((j) => j.deviceId === t.id));
  assert.ok(fs.existsSync(path.join(thumbs, shared)));
  queue.clearFinished();
  assert.equal(store.getJobs().length, 0);
  assert.ok(!fs.existsSync(path.join(thumbs, shared)), 'pictures of cleared jobs are deleted');
  a.srv.close(); b.srv.close();
});

test('HP job stopped while sending ends cleanly, and the queue marks it cancelled', { timeout: 300000 }, async () => {
  const { PDFDocument, cmyk } = require('pdf-lib');
  const J = require('../electron/lib/hpLatexJob');
  const R = require('../electron/lib/hpRaster');
  const doc = await PDFDocument.create();
  const p = doc.addPage([12 * 72, 36 * 72]); // 12" wide: two bands at 600 dpi
  p.drawRectangle({ x: 0, y: 0, width: 12 * 72, height: 36 * 72, color: cmyk(0, 0, 0, 1) });
  const pdf = Buffer.from(await doc.save());
  const signal = { aborted: false };
  const sink = J.memorySink();
  const r = await J.printPdf(pdf, { model: 'hp-latex-335', rollWidthIn: 54, mode: { passes: 6, inkDensity: 'L10' }, signal,
    onProgress: () => { signal.aborted = true; } }, sink);
  assert.equal(r.aborted, true);
  assert.ok(r.rows > 0 && r.rows < 36 * 600, `stopped part way (${r.rows} rows)`);
  const buf = sink.buffer();
  assert.ok(buf.toString('latin1').endsWith('@PJL EOJ \n'), 'job closed with end of raster + end of job');
  assert.equal(R.parseJob(buf).rows.length, r.rows);

  // through the driver + queue: Stop while sending -> cancelled, with the "press Cancel on the printer" note
  const store = require('../electron/store');
  const queue = require('../electron/queue');
  const drivers = require('../electron/drivers');
  store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'qh-')));
  const srv = net.createServer((s) => s.on('data', () => {}));
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const hp = store.getDevices().find((d) => d.driver === 'hp-latex');
  store.saveDevice({ id: hp.id, name: hp.name, config: { ...drivers.defaultsFor('hp-latex'), host: '127.0.0.1', port: srv.address().port, model: 'hp-latex-335', rollWidthIn: 54, mediaId: '150100' } });
  const updates = [];
  queue.init(store, drivers, (j) => updates.push({ status: j.status, progress: j.progress }));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qhf-')), 'big.pdf');
  fs.writeFileSync(file, pdf);
  const j = queue.add({ deviceId: hp.id, action: 'file', filePath: file, name: 'Big black' });
  assert.match(j.info.setup, /Generic Self-Adhesive Vinyl/);
  assert.ok(queue.canAbort(j));
  for (let i = 0; i < 600 && store.getJobs().find((x) => x.id === j.id).status !== 'sending'; i++) await wait(50);
  assert.ok(queue.cancelJob(j.id), 'stop asked for');
  for (let i = 0; i < 1200 && store.getJobs().find((x) => x.id === j.id).status === 'sending'; i++) await wait(100);
  const done = store.getJobs().find((x) => x.id === j.id);
  assert.equal(done.status, 'cancelled');
  assert.match(done.message, /Stopped while sending|too late/);
  srv.close();
});

test('job picture of a PDF: first page drawn small, size in inches', { timeout: 120000 }, async () => {
  const { PDFDocument, rgb } = require('pdf-lib');
  const J = require('../electron/lib/jobThumb');
  const doc = await PDFDocument.create();
  doc.addPage([24 * 72, 36 * 72]).drawRectangle({ x: 0, y: 0, width: 12 * 72, height: 36 * 72, color: rgb(1, 0, 0) });
  doc.addPage([24 * 72, 36 * 72]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-'));
  const file = path.join(dir, 'job.pdf');
  fs.writeFileSync(file, Buffer.from(await doc.save()));
  const r = await J.makeJobThumb({ id: 'x1', action: 'file', filePath: file }, { dir, gs: require('../electron/lib/ghostscript') });
  assert.deepEqual(r.info, { wIn: 24, hIn: 36, pages: 2 });
  const png = fs.readFileSync(path.join(dir, r.thumb));
  assert.equal(png.readUInt32BE(0), 0x89504e47);
  assert.equal(png.readUInt32BE(20), 360, 'longest side 360 px');
  assert.equal(png.readUInt32BE(16), 240);
});
