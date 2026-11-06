// HP Latex direct printing: the raster format matched to Flexi's own output (captured on the shop's printers)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const R = require('../electron/lib/hpRaster');

const fixture = (n) => zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'flexi', n)));

function decodeAll(job) {
  const W = job.rollPx;
  let seed = new Uint8Array(W * 4);
  const rows = [];
  for (const r of job.rows) { seed = R.decodeRow(r, seed, W); rows.push(seed); }
  return rows;
}
const px = (row, x) => Array.from(row.subarray(x * 4, x * 4 + 4));

test('reads a Flexi HP Latex 115 job: PJL settings, preview, 600 dpi KCMY rows', () => {
  const job = R.parseJob(fixture('hp115-test-12x12.cap.gz'));
  assert.equal(job.pjl.MEDIAID, '100100');
  assert.equal(job.pjl.EXTENDEDPM, 'XPM10');
  assert.equal(job.pjl.INKDENSITY, 'L10');
  assert.equal(job.contone, '600dpi-2bpp-10pass-BiDir-');
  assert.equal(job.rollPx, 32400); // 54" at 600 dpi
  assert.ok(job.preview && job.preview[0] === 0xff && job.preview[1] === 0xd8, 'JPEG preview');
  assert.equal(job.rows.length, 7200); // 12" at 600 dpi
  const rows = decodeAll(job);
  // Rotated 180°: the 100% cyan patch (1"–2.1" from the left, 9"–10.1" up the page) ...
  const y = Math.round(9.5 * 600), x = Math.round((12 - 1.55) * 600);
  assert.deepEqual(px(rows[y], x), [0, 236, 2, 10]); // K C M Y — mostly cyan
  // ... and the yellow patch
  assert.deepEqual(px(rows[y], Math.round((12 - (1 + 2 * 1.25 + 0.55)) * 600)), [0, 3, 6, 254]);
  // blank roll beyond the page
  assert.deepEqual(px(rows[y], 20000), [0, 0, 0, 0]);
  const m = R.modeFromPjl(job.pjl, job.contone);
  assert.deepEqual(m, { passes: 10, efficiency: false, inkDensity: 'L10', xpm: 'XPM10', unidirectional: false });
});

test('InkSign\'s row compression round-trips Flexi\'s rows exactly and stays as small', () => {
  const job = R.parseJob(fixture('hp335-printcut-6x4.cap.gz'));
  const W = job.rollPx;
  assert.equal(W, 38400); // 64"
  const rows = decodeAll(job);
  let seed = new Uint8Array(W * 4), flexiBytes = 0, ourBytes = 0;
  for (let i = 0; i < rows.length; i++) {
    const enc = R.encodeRow(rows[i], seed, W);
    const back = R.decodeRow(enc, seed, W);
    assert.ok(Buffer.from(back).equals(Buffer.from(rows[i])), `row ${i} differs after round trip`);
    flexiBytes += job.rows[i].length; ourBytes += enc.length;
    seed = rows[i];
  }
  assert.ok(ourBytes < flexiBytes * 1.3, `ours ${ourBytes} vs Flexi ${flexiBytes}`);
  // Flexi's registration marks for the Titan: black L corners 0.04" thick at the job's edges
  assert.deepEqual(px(rows[0], 10), [255, 0, 0, 0]);
});

test('compression handles runs, literals, long skips and the always-sent last pixel', () => {
  const W = 3000;
  const seed = new Uint8Array(W * 4);
  const cur = new Uint8Array(W * 4);
  const set = (x, v) => cur.set(v, x * 4);
  for (let x = 5; x < 1200; x++) set(x, [1, 2, 3, 4]); // long run
  for (let x = 1300; x < 1320; x++) set(x, [x & 255, 9, 9, 9]); // literals
  set(2999, [7, 7, 7, 7]);
  const enc = R.encodeRow(cur, seed, W);
  assert.ok(Buffer.from(R.decodeRow(enc, seed, W)).equals(Buffer.from(cur)));
  // a row equal to the one above still sends its last pixel
  const same = R.encodeRow(cur, cur, W);
  assert.ok(same.length > 0 && same.length < 20);
  assert.ok(Buffer.from(R.decodeRow(same, cur, W)).equals(Buffer.from(cur)));
});

test('PJL header and framing match Flexi\'s layout', () => {
  const flexi = fixture('hp335-printcut-6x4.cap.gz').toString('latin1');
  const ours = R.pjlHeader({ model: 'hp-latex-335', jobName: 'x', rows: 3864, cols: 5064, rollPx: 38400, mediaId: '150100',
    mode: { passes: 6, efficiency: true, inkDensity: 'L8' } }).toString('latin1');
  const keys = (s) => [...s.matchAll(/@PJL SET (\w+) = ([^\n]*)/g)].map((m) => [m[1], m[2]]).filter(([k]) => !['JOBNAME', 'TIMESTAMP', 'JOBATTR', 'USERNAME'].includes(k));
  assert.deepEqual(keys(ours), keys(flexi)); // same settings, same values, same order (PAPERLENGTH 4923, width 46083, ...)
  assert.equal(ours.indexOf('\x1bE\x1b%-12345X@PJL JOB \n'), 131072);
  assert.ok(ours.endsWith('@PJL ENTER LANGUAGE = PCL3GUI \n'));
  const start = R.rasterStart({ rollPx: 38400, previewJpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }).toString('latin1');
  const fStart = flexi.slice(flexi.indexOf('\x1b&u600D'), flexi.indexOf('\x1b*r1A\x1b*b') + 8);
  assert.ok(start.endsWith(fStart), 'raster setup bytes identical to Flexi');
  assert.ok(flexi.endsWith(R.trailer().toString('latin1')));
});

// ---- full jobs through Ghostscript ----
const { PDFDocument, rgb, cmyk, PDFName, PDFNumber, PDFOperator } = require('pdf-lib');
const J = require('../electron/lib/hpLatexJob');

async function testPdf({ w = 6, h = 4, cut = false } = {}) {
  const doc = await PDFDocument.create();
  const p = doc.addPage([w * 72, h * 72]);
  p.drawRectangle({ x: 0, y: (h - 1) * 72, width: 72, height: 72, color: cmyk(1, 0, 0, 0) }); // top-left: cyan
  p.drawRectangle({ x: (w - 1) * 72, y: 0, width: 72, height: 72, color: cmyk(0, 0, 1, 0) }); // bottom-right: yellow
  if (cut) {
    const fn = doc.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 });
    const cs = doc.context.register(doc.context.obj([PDFName.of('Separation'), PDFName.of('CutContour'), PDFName.of('DeviceCMYK'), fn]));
    const { Resources } = p.node.normalizedEntries();
    let d = Resources.lookup(PDFName.of('ColorSpace'));
    if (!d) { d = doc.context.obj({}); Resources.set(PDFName.of('ColorSpace'), d); }
    d.set(PDFName.of('CSCut'), cs);
    const n = (v) => PDFNumber.of(v);
    p.pushOperators(PDFOperator.of('q'), PDFOperator.of('CS', [PDFName.of('CSCut')]), PDFOperator.of('SCN', [n(1)]), PDFOperator.of('w', [n(6)]),
      PDFOperator.of('m', [n(144), n(144)]), PDFOperator.of('l', [n(288), n(144)]), PDFOperator.of('S'), PDFOperator.of('Q'));
  }
  return Buffer.from(await doc.save());
}
const decodeJob = (buf) => { const job = R.parseJob(buf); return { job, rows: decodeAll(job) }; };
const near = (v, want) => v.every((x, i) => Math.abs(x - want[i]) <= 40);

test('prints a PDF across the roll like Flexi: bottom row first, page right edge at the printer\'s x = 0', { timeout: 300000 }, async () => {
  const sink = J.memorySink();
  const r = await J.printPdf(await testPdf(), { model: 'hp-latex-115', rollWidthIn: 54, mediaId: '100100', mode: { passes: 10, inkDensity: 'L10', efficiency: false }, jobName: 'test' }, sink);
  assert.equal(r.rows, 2400);
  assert.equal(r.cols, 3600);
  const { job, rows } = decodeJob(sink.buffer());
  assert.equal(job.rollPx, 32400);
  assert.equal(job.rows.length, 2400);
  assert.equal(job.pjl.PAPERLENGTH, String(R.pjlLength(2400)));
  assert.equal(job.pjl.TAILGATINGACTUALPAGEWIDTH, String(R.pjlLength(3600)));
  assert.equal(job.pjl.EXTENDEDPM, 'XPM10');
  assert.ok(job.preview && job.preview[0] === 0xff, 'has a JPEG preview');
  // bottom-right yellow square -> first rows, x near 0;  top-left cyan -> last rows, x near 3600
  const [K0, C0, M0, Y0] = px(rows[300], 300);
  assert.ok(Y0 > 150 && C0 < 60 && K0 < 60, `yellow expected, got ${[K0, C0, M0, Y0]}`);
  const [K1, C1, M1, Y1] = px(rows[2100], 3300);
  assert.ok(C1 > 150 && Y1 < 60, `cyan expected, got ${[K1, C1, M1, Y1]}`);
  assert.deepEqual(px(rows[1200], 1800), [0, 0, 0, 0]);
  assert.deepEqual(px(rows[300], 5000), [0, 0, 0, 0]);
});

test('Wide Format layouts (x = roll length) print along the roll', { timeout: 300000 }, async () => {
  const sink = J.memorySink();
  // 10" long x 4" across
  const r = await J.printPdf(await testPdf({ w: 10, h: 4 }), { model: 'hp-latex-335', rollWidthIn: 64, orientation: 'along', mode: { passes: 6, inkDensity: 'L8' } }, sink);
  assert.equal(r.rows, 6000);
  assert.equal(r.cols, 2400);
  const { rows } = decodeJob(sink.buffer());
  // start of the roll (x = 0 of the layout) is printed first; the layout's top edge is the far side
  const a = px(rows[300], 2100); // layout top-left = cyan
  assert.ok(a[1] > 150, `cyan expected near the start, got ${a}`);
  const b = px(rows[5700], 300); // layout bottom-right = yellow
  assert.ok(b[3] > 150, `yellow expected near the end, got ${b}`);
});

test('cut lines (CutContour) are left off the print', { timeout: 300000 }, async () => {
  const { removeCutLines } = require('../electron/lib/pdfCutLines');
  const pdf = await testPdf({ cut: true });
  const r = await removeCutLines(pdf);
  assert.equal(r.removed, 1);
  const sinkCut = J.memorySink();
  await J.printPdf(pdf, { model: 'hp-latex-335', removeCut: false }, sinkCut);
  const sinkClean = J.memorySink();
  const res = await J.printPdf(pdf, { model: 'hp-latex-335' }, sinkClean);
  assert.equal(res.cutLinesRemoved, 1);
  // the line runs at 2" up the page from x = 2" to 4"
  const y = 1200, x = 6 * 600 - 3 * 600;
  const withLine = px(decodeJob(sinkCut.buffer()).rows[y], x);
  assert.ok(withLine[2] > 150, `the cut line prints when not removed (${withLine})`);
  assert.deepEqual(px(decodeJob(sinkClean.buffer()).rows[y], x), [0, 0, 0, 0]);
});

test('too wide for the roll is refused before anything is sent', async () => {
  assert.throws(() => J.chooseOrientation(70, 70, 64), /doesn't fit/);
  assert.equal(J.chooseOrientation(70, 40, 64), 'along');
  assert.equal(J.chooseOrientation(30, 90, 64), 'across');
});

test('the HP driver prints its test page over the network as a complete job', { timeout: 300000 }, async () => {
  const net = require('net');
  const drivers = require('../electron/drivers');
  const got = [];
  const srv = net.createServer((s) => s.on('data', (d) => got.push(d)));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cfg = { ...drivers.defaultsFor('hp-latex'), host: '127.0.0.1', port: srv.address().port, model: 'hp-latex-115', rollWidthIn: 54, mediaId: '100100' };
  assert.deepEqual(drivers.get('hp-latex').missing(cfg), []);
  const res = await drivers.get('hp-latex').sendTest(cfg, { deviceName: 'HP Latex 115' });
  await new Promise((r) => setTimeout(r, 300));
  srv.close();
  assert.match(res.message, /Generic PVC Banner/);
  const job = R.parseJob(Buffer.concat(got));
  assert.equal(job.pjl.MEDIAID, '100100');
  assert.equal(job.rollPx, 32400);
  assert.equal(job.rows.length, 8 * 600);
  // media drop-downs: the bundled HP presets and each one's print modes
  const media = drivers.fieldOptions('hp-latex', 'hpMedia', cfg);
  assert.ok(media.length > 40 && media.some((m) => m.value === '150100'));
  const modes = drivers.fieldOptions('hp-latex', 'hpMode', { ...cfg, mediaId: '150100' });
  assert.ok(modes.some((m) => /6 pass · 80% ink · efficiency/.test(m.label)));
});
