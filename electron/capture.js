// "Learn from Flexi": catch exactly what Flexi sends a machine, so InkSign can be matched to it
// byte for byte (the way InkRIP was matched to AcroRIP / CADlink).
//   - Network machines (HP Latex): InkSign listens like a printer; point the Flexi setup's TCP/IP
//     port at this PC for one job.
//   - USB cutters: Flexi's TCP/IP port pointed here as well when Flexi allows it, or Flexi's
//     "File" port and the file is picked in InkSign.
// Every capture is saved in Downloads\InkSign captures (and InkSign's own data folder).
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, cmyk, PDFName, PDFNumber, PDFOperator } = require('pdf-lib');

let server = null, current = null, notify = () => {}, dataDir = os.tmpdir();

const outDir = () => {
  const d = path.join(os.homedir(), 'Downloads', 'InkSign captures');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const slug = (s) => String(s || 'machine').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 40);
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');

function lanIps() {
  return Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
}

function save(machine, buf, how) {
  const name = `${slug(machine)}_${stamp()}.prn`;
  const file = path.join(outDir(), name);
  fs.writeFileSync(file, buf);
  try { fs.mkdirSync(path.join(dataDir, 'captures'), { recursive: true }); fs.writeFileSync(path.join(dataDir, 'captures', name), buf); } catch { /* best effort */ }
  const head = buf.subarray(0, 400).toString('latin1');
  const looks = /\x1b%-12345X|@PJL/.test(head) ? 'PJL printer job' : /^\s*(IN|PA|PU|PD|SP|VS|FS)[\d;,\s]/m.test(head) || /;(PU|PD)/.test(head) ? 'HP-GL cutter commands'
    : /^[\x1b]?[A-Z]{1,2}\d/.test(head) ? 'cutter commands' : 'machine data';
  const rec = { machine, file, bytes: buf.length, how, looks, at: Date.now() };
  notify(rec);
  return rec;
}

// Listen like a printer (raw TCP, port 9100 by default) until one job has arrived
function listen({ machine, port = 9100 } = {}) {
  stop();
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => {
      const chunks = [];
      let size = 0;
      sock.setTimeout(10 * 60 * 1000, () => sock.destroy());
      sock.on('data', (d) => { size += d.length; chunks.push(d); notify({ machine, receiving: size }); });
      sock.on('error', () => {});
      sock.on('close', () => { if (size) save(machine, Buffer.concat(chunks), `network port ${port}`); });
    });
    srv.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use on this PC — pick another port (and use it in Flexi too)` : e.message)));
    srv.listen(Number(port), '0.0.0.0', () => {
      server = srv;
      current = { machine, port: Number(port) };
      resolve({ listening: true, port: Number(port), addresses: ['127.0.0.1', ...lanIps()] });
    });
  });
}
function stop() {
  if (server) { try { server.close(); } catch { /* closed */ } }
  server = null; current = null;
  return { listening: false };
}
const state = () => ({ listening: !!server, ...(current || {}), folder: outDir(), addresses: ['127.0.0.1', ...lanIps()] });

function importFile(machine, file) {
  return save(machine, fs.readFileSync(file), `file ${path.basename(file)}`);
}

// ---- the capture kit: small test jobs to send from Flexi ----
function cutContourOps(doc, page, draw) {
  const fn = doc.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 });
  const cs = doc.context.register(doc.context.obj([PDFName.of('Separation'), PDFName.of('CutContour'), PDFName.of('DeviceCMYK'), fn]));
  const { Resources } = page.node.normalizedEntries();
  let csDict = Resources.lookup(PDFName.of('ColorSpace'));
  if (!csDict) { csDict = doc.context.obj({}); Resources.set(PDFName.of('ColorSpace'), csDict); }
  csDict.set(PDFName.of('CSCut'), cs);
  const n = (v) => PDFNumber.of(+v.toFixed(3));
  const ops = [PDFOperator.of('q'), PDFOperator.of('CS', [PDFName.of('CSCut')]), PDFOperator.of('SCN', [PDFNumber.of(1)]), PDFOperator.of('w', [n(0.25)])];
  for (const path of draw) {
    path.forEach(([x, y], i) => ops.push(PDFOperator.of(i ? 'l' : 'm', [n(x), n(y)])));
    ops.push(PDFOperator.of('h'), PDFOperator.of('S'));
  }
  ops.push(PDFOperator.of('Q'));
  page.pushOperators(...ops);
}
const square = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const circle = (cx, cy, r, n = 72) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
const star = (cx, cy, r) => Array.from({ length: 10 }, (_, i) => { const a = Math.PI / 2 + (Math.PI * i) / 5; const rr = i % 2 ? r * 0.45 : r; return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)]; });

async function kit(dir) {
  const target = dir || path.join(os.homedir(), 'Downloads', 'InkSign capture kit');
  fs.mkdirSync(target, { recursive: true });
  const IN = 72;
  // 1) HP print test: 12 x 12" — CMYK and RGB patches, ramps, fine text
  {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const p = doc.addPage([12 * IN, 12 * IN]);
    p.drawText('InkSign capture test — HP Latex', { x: IN, y: 11 * IN, size: 26, font, color: cmyk(0, 0, 0, 1) });
    const cm = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [1, 1, 0, 0], [0, 1, 1, 0], [1, 0, 1, 0], [0.6, 0.5, 0.5, 1]];
    cm.forEach((c, i) => p.drawRectangle({ x: IN + i * 1.25 * IN, y: 9 * IN, width: 1.1 * IN, height: 1.1 * IN, color: cmyk(...c) }));
    const rg = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0.5, 0], [0.4, 0, 0.6], [0, 0.6, 0.6], [0.95, 0.85, 0.75], [0.5, 0.5, 0.5]];
    rg.forEach((c, i) => p.drawRectangle({ x: IN + i * 1.25 * IN, y: 7.5 * IN, width: 1.1 * IN, height: 1.1 * IN, color: rgb(...c) }));
    for (let k = 0; k < 4; k++) for (let i = 0; i <= 20; i++) {
      const v = [0, 0, 0, 0]; v[k] = i / 20;
      p.drawRectangle({ x: IN + i * 0.48 * IN, y: (6 - k * 0.6) * IN, width: 0.48 * IN, height: 0.5 * IN, color: cmyk(...v) });
    }
    [6, 8, 10, 14].forEach((sz, i) => p.drawText(`The Ink Stop ${sz} pt — small text check`, { x: IN, y: (2.6 - i * 0.4) * IN, size: sz, font, color: cmyk(0, 0, 0, 1) }));
    fs.writeFileSync(path.join(target, '1 - HP print test 12x12.pdf'), Buffer.from(await doc.save({ useObjectStreams: false })));
  }
  // 2) Cutter test: 4 x 4" — 2" square, 1" circle, star, as CutContour lines
  {
    const doc = await PDFDocument.create();
    const p = doc.addPage([4 * IN, 4 * IN]);
    cutContourOps(doc, p, [square(0.5 * IN, 0.5 * IN, 2 * IN), circle(3.1 * IN, 3.1 * IN, 0.5 * IN), star(3.1 * IN, 1.3 * IN, 0.6 * IN)]);
    fs.writeFileSync(path.join(target, '2 - Cutter test 4x4 (CutContour).pdf'), Buffer.from(await doc.save({ useObjectStreams: false })));
  }
  // 3) Print & cut test: 6 x 4" artwork with a CutContour around each shape (Flexi adds its own marks)
  {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const p = doc.addPage([6 * IN, 4 * IN]);
    p.drawCircle({ x: 1.5 * IN, y: 2 * IN, size: 1.1 * IN, color: rgb(1, 0.45, 0.1) });
    p.drawText('INK', { x: 0.95 * IN, y: 1.8 * IN, size: 30, font, color: rgb(1, 1, 1) });
    p.drawRectangle({ x: 3.2 * IN, y: 0.9 * IN, width: 2.2 * IN, height: 2.2 * IN, color: rgb(0.1, 0.4, 0.9) });
    cutContourOps(doc, p, [circle(1.5 * IN, 2 * IN, 1.2 * IN), square(3.1 * IN, 0.8 * IN, 2.4 * IN)]);
    fs.writeFileSync(path.join(target, '3 - Print and cut test 6x4.pdf'), Buffer.from(await doc.save({ useObjectStreams: false })));
  }
  return { folder: target, files: fs.readdirSync(target).filter((f) => f.endsWith('.pdf')) };
}

function init(c) { notify = c.notify || notify; dataDir = c.dataDir || dataDir; }

module.exports = { init, listen, stop, state, importFile, kit, lanIps };
