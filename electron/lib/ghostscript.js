// Ghostscript for the Xerox print server: PDF -> PostScript (so the exact PPD driver commands can be
// added), color conversion (gray / CMYK with ICC profiles), PostScript -> PDF (jobs printed from
// Windows to the InkSign virtual printer), page counts and thumbnails. Ghostscript 9.56 compiled to
// WebAssembly (@jspawn/ghostscript-wasm, AGPL) — nothing to install on the shop PCs.
const path = require('path');
const { Worker } = require('worker_threads');

const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
function gsFiles() {
  const pkg = path.dirname(require.resolve('@jspawn/ghostscript-wasm/package.json'));
  return { gsJs: unpacked(path.join(pkg, 'gs.js')), gsWasm: unpacked(path.join(pkg, 'gs.wasm')) };
}

let worker = null, seq = 0;
const pending = new Map();
let idleTimer = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(unpacked(path.join(__dirname, 'gsWorker.js')), { workerData: gsFiles() });
  worker.on('message', (m) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve({ code: m.code, log: m.log, out: Object.fromEntries(Object.entries(m.out).map(([k, v]) => [k, Buffer.from(v)])) });
    else p.reject(new Error(`Ghostscript failed: ${m.error}`));
    scheduleIdle();
  });
  const fail = (err) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
    worker = null;
  };
  worker.on('error', (e) => fail(new Error(`Ghostscript stopped: ${e.message}`)));
  worker.on('exit', (code) => { if (pending.size) fail(new Error(`Ghostscript stopped (${code})`)); worker = null; });
  worker.unref();
  return worker;
}

// Free the ~100 MB Ghostscript worker when it hasn't been used for a few minutes
function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!pending.size && worker) { worker.terminate(); worker = null; } }, 3 * 60 * 1000);
  idleTimer.unref?.();
}

// Run Ghostscript with args; files = { '/in.pdf': Buffer }, outputs = ['/out.ps']
function run(args, { files = {}, outputs = [], outputGlob, timeoutMs = 10 * 60 * 1000 } = {}) {
  const w = getWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Ghostscript took too long on this job'));
      if (worker) { worker.terminate(); worker = null; }
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    const req = { args: ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', ...args], files, outputs, outputGlob };
    w.postMessage({ id, req });
  });
}

const errText = (r) => r.log.filter((l) => /error|unable|failed/i.test(l)).slice(0, 4).join(' · ') || `code ${r.code}`;

/**
 * PDF -> Level 3 PostScript.
 * color: { mode: 'color'|'gray', rgbProfile, cmykProfile, outputProfile (Buffers), intent: 0..3,
 *          blackText (pure K text & lines), overprint ('simulate'|'printer') }
 */
async function pdfToPs(pdf, color = {}) {
  const files = { '/in/job.pdf': pdf };
  const args = ['-sDEVICE=ps2write', '-dLanguageLevel=3', '-dNoOutputFonts=false', '-dAutoRotatePages=/None'];
  if (color.mode === 'gray') args.push('-sColorConversionStrategy=Gray', '-sProcessColorModel=DeviceGray');
  else if (color.convert) {
    // Convert RGB etc. to the printer's CMYK here (InkSign color management); otherwise the Xerox does it
    args.push('-sColorConversionStrategy=CMYK', '-sProcessColorModel=DeviceCMYK');
    if (color.rgbProfile) { files['/icc/rgb.icc'] = color.rgbProfile; args.push('-sDefaultRGBProfile=/icc/rgb.icc'); }
    if (color.cmykProfile) { files['/icc/cmyk.icc'] = color.cmykProfile; args.push('-sDefaultCMYKProfile=/icc/cmyk.icc'); }
    if (color.outputProfile) { files['/icc/out.icc'] = color.outputProfile; args.push('-sOutputICCProfile=/icc/out.icc'); }
    if (color.intent != null) args.push(`-dRenderIntent=${Number(color.intent) || 0}`);
    if (color.blackText) args.push('-dBlackText', '-dBlackVector');
    if (color.preserveCmyk !== false) args.push('-dKPreserve=1');
  }
  if (color.overprint === 'simulate') args.push('-dOverprint=/simulate');
  args.push('-sOutputFile=/out/job.ps', '/in/job.pdf');
  const r = await run(args, { files, outputs: ['/out/job.ps'] });
  const ps = r.out['/out/job.ps'];
  if (r.code !== 0 || !ps || !ps.length) throw new Error(`Couldn't convert the PDF for the printer: ${errText(r)}`);
  return ps;
}

// PostScript (e.g. from the Windows Xerox driver) -> PDF for preview, imposition and editing
async function psToPdf(ps) {
  const r = await run(['-sDEVICE=pdfwrite', '-dAutoRotatePages=/None', '-sOutputFile=/out/job.pdf', '/in/job.ps'],
    { files: { '/in/job.ps': ps }, outputs: ['/out/job.pdf'] });
  const pdf = r.out['/out/job.pdf'];
  if (r.code !== 0 || !pdf || pdf.length < 100) throw new Error(`Couldn't read the PostScript job: ${errText(r)}`);
  return pdf;
}

// PNG thumbnails of pages first..last
async function thumbnails(pdf, { first = 1, last = 1, dpi = 24 } = {}) {
  const r = await run(['-sDEVICE=png16m', `-r${dpi}`, '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', `-dFirstPage=${first}`, `-dLastPage=${last}`,
    '-sOutputFile=/out/p%03d.png', '/in/job.pdf'], { files: { '/in/job.pdf': pdf }, outputGlob: { dir: '/out', prefix: 'p' } });
  return Object.keys(r.out).sort().map((k) => r.out[k]);
}

module.exports = { run, pdfToPs, psToPdf, thumbnails, gsFiles };
// For tests: stop the worker so node can exit
module.exports.shutdown = () => { if (worker) { worker.terminate(); worker = null; } };
