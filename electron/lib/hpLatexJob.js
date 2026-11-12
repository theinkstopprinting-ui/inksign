// Prints a PDF straight to an HP Latex 335 / 115 — no Flexi. The page is rendered at 600 dpi to CMYK
// through the media's ICC profile (Flexi's own profiles when Flexi is on this PC), turned into the
// printer's K C M Y rows and sent in the same job format Flexi sends (see hpRaster.js).
//
// Big prints are rendered in bands (Ghostscript on a slice of the page at a time) and streamed to the
// printer as they're made, so a 50-foot banner never has to fit in memory.
const { PDFDocument, PDFName, PDFNumber } = require('pdf-lib');
const R = require('./hpRaster');

const PT = 72;
const BAND_BYTES = 96 * 1024 * 1024; // CMYK bytes per rendered band
const PREVIEW_AREA = 682000; // Flexi's front-panel preview is ~682k pixels

function parsePam(buf) {
  const end = buf.indexOf('ENDHDR\n');
  if (end < 0) throw new Error('Ghostscript did not return a CMYK picture');
  const head = buf.subarray(0, end).toString('latin1');
  const num = (k) => Number((new RegExp(`${k}\\s+(\\d+)`).exec(head) || [])[1]);
  return { w: num('WIDTH'), h: num('HEIGHT'), depth: num('DEPTH'), data: buf.subarray(end + 7) };
}

const pageUnit = (page) => {
  const uu = page.node.get(PDFName.of('UserUnit'));
  return uu instanceof PDFNumber ? uu.asNumber() : 1;
};

/**
 * How the page lies on the roll.
 *  'across'  — page width runs across the roll (any PDF that fits; how Flexi places a page)
 *  'along'   — page width runs along the roll (InkSign Wide Format layouts: x = roll length)
 */
function chooseOrientation(wIn, hIn, rollIn, want = 'auto') {
  if (want === 'along') { if (hIn > rollIn + 0.01) throw new Error(`This print is ${hIn.toFixed(1)}" across — wider than the ${rollIn}" roll`); return 'along'; }
  if (want === 'across') { if (wIn > rollIn + 0.01) throw new Error(`This print is ${wIn.toFixed(1)}" wide — wider than the ${rollIn}" roll`); return 'across'; }
  if (wIn <= rollIn + 0.01) return 'across';
  if (hIn <= rollIn + 0.01) return 'along';
  throw new Error(`This print (${wIn.toFixed(1)}" × ${hIn.toFixed(1)}") doesn't fit on a ${rollIn}" roll either way`);
}

// One page cut down to a box (in its own units), optionally turned so it renders in printer orientation
async function slicePdf(src, pageIndex, box, rotate) {
  const doc = await PDFDocument.create();
  const [p] = await doc.copyPages(src, [pageIndex]);
  doc.addPage(p);
  const [x0, y0, x1, y1] = box;
  p.setMediaBox(x0, y0, x1 - x0, y1 - y0);
  p.setCropBox(x0, y0, x1 - x0, y1 - y0);
  for (const k of ['TrimBox', 'BleedBox', 'ArtBox']) p.node.delete(PDFName.of(k));
  p.setRotation({ type: 'degrees', angle: rotate });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/**
 * Build and stream an HP Latex job.
 * opts: { model, rollWidthIn, mediaId, mode, icc (Buffer), intent (0-3), blackPoint, jobName, user,
 *         orientation, offsetIn (from the printer's right edge), removeCut (default true), cutterId,
 *         gs (ghostscript module), onProgress(fraction, text), signal ({ aborted } — stops sending) }
 * sink: { write(Buffer): Promise, end(): Promise }
 * Returns { pages, rows, cols, bytes, cutLinesRemoved, aborted }
 *
 * Stopped part way (signal.aborted), the page is ended properly (end of raster, form feed, end of job)
 * so the printer closes the job instead of waiting for data — it prints the rows it already has.
 */
async function printPdf(pdfBytes, opts, sink) {
  const gs = opts.gs || require('./ghostscript');
  const model = R.MODELS[opts.model] ? opts.model : 'hp-latex-335';
  const rollIn = Math.min(Number(opts.rollWidthIn) || R.MODELS[model].maxWidthIn, R.MODELS[model].maxWidthIn);
  const rollPx = Math.round(rollIn * R.DPI);
  const offsetPx = Math.max(0, Math.round((Number(opts.offsetIn) || 0) * R.DPI));
  let pdf = Buffer.from(pdfBytes);
  let cutLinesRemoved = 0;
  if (opts.removeCut !== false) {
    try { const r = await require('./pdfCutLines').removeCutLines(pdf); pdf = r.pdf; cutLinesRemoved = r.removed; } catch { /* print as is */ }
  }
  const src = await PDFDocument.load(pdf, { ignoreEncryption: true });
  const pages = src.getPages();
  const files = {};
  const colorArgs = [];
  if (opts.icc && opts.icc.length) { files['/icc/out.icc'] = opts.icc; colorArgs.push('-sOutputICCProfile=/icc/out.icc'); }
  colorArgs.push(`-dRenderIntent=${Number.isInteger(opts.intent) ? opts.intent : 0}`);
  if (opts.blackPoint !== false) colorArgs.push('-dBlackPtComp=1');

  let written = 0, totalRows = 0, lastCols = 0, aborted = false;
  const stop = () => !!(opts.signal && opts.signal.aborted);
  const out = { chunks: [], size: 0 };
  const flush = async (force) => {
    if (!out.size || (!force && out.size < 1 << 20)) return;
    const b = Buffer.concat(out.chunks, out.size);
    out.chunks = []; out.size = 0;
    written += b.length;
    await sink.write(b);
  };
  const push = async (b) => { out.chunks.push(b); out.size += b.length; if (out.size >= 1 << 20) await flush(true); };

  for (let pi = 0; pi < pages.length && !aborted; pi++) {
    if (stop()) { aborted = true; break; }
    const page = pages[pi];
    const uu = pageUnit(page);
    const mb = page.getMediaBox();
    const cb = page.getCropBox ? page.getCropBox() : mb;
    const box = { x: Math.max(mb.x, cb.x), y: Math.max(mb.y, cb.y), w: Math.min(cb.width, mb.width), h: Math.min(cb.height, mb.height) };
    const baseRot = ((page.getRotation().angle % 360) + 360) % 360;
    // The page as it's seen (with its own /Rotate), in inches
    const seenW = (baseRot % 180 ? box.h : box.w) * uu / PT, seenH = (baseRot % 180 ? box.w : box.h) * uu / PT;
    const orient = chooseOrientation(seenW, seenH, rollIn, opts.orientation);
    // Rendered picture: 'across' = the page upright; 'along' = turned a quarter left so x runs along the roll
    const rot = (baseRot + (orient === 'along' ? 270 : 0)) % 360;
    const shownW = rot % 180 ? box.h : box.w, shownH = rot % 180 ? box.w : box.h; // in page units
    const cols = Math.round((shownW * uu / PT) * R.DPI), rows = Math.round((shownH * uu / PT) * R.DPI);
    if (offsetPx + cols > rollPx) throw new Error(`Doesn't fit: ${(cols / R.DPI).toFixed(1)}" + ${(offsetPx / R.DPI).toFixed(1)}" offset is wider than the ${rollIn}" roll`);
    lastCols = cols;

    // Preview for the printer's front panel (the page as it comes out of the printer)
    const shownWin = shownW * uu / PT, shownHin = shownH * uu / PT;
    const res = Math.max(4, Math.min(150, Math.sqrt(PREVIEW_AREA / Math.max(0.01, shownWin * shownHin))));
    let preview = null;
    try {
      const prevPdf = await slicePdf(src, pi, [box.x, box.y, box.x + box.w, box.y + box.h], rot);
      const r = await gs.run(['-sDEVICE=jpeg', '-dJPEGQ=80', `-r${res.toFixed(3)}`, '-o', '/out/p.jpg', '/in/p.pdf'], { files: { '/in/p.pdf': prevPdf }, outputs: ['/out/p.jpg'] });
      preview = r.out['/out/p.jpg'] || null;
    } catch { preview = null; }

    await push(R.pjlHeader({ model, jobName: opts.jobName, user: opts.user, mode: opts.mode, mediaId: opts.mediaId, rows, cols, rollPx, cutterId: opts.cutterId }));
    await push(R.rasterStart({ rollPx, previewJpeg: preview }));

    // Bands from the bottom of the shown page up (the printer's first row is the bottom of the print)
    const rowsPerBand = Math.max(32, Math.floor(BAND_BYTES / Math.max(1, cols * 4)));
    let bufA = new Uint8Array(rollPx * 4), bufB = new Uint8Array(rollPx * 4);
    let seed = bufB;
    const activeW = offsetPx + cols;
    for (let r0 = 0; r0 < rows; r0 += rowsPerBand) {
      if (stop()) { aborted = true; break; }
      const n = Math.min(rowsPerBand, rows - r0);
      // Rows r0..r0+n counted from the bottom of the shown page -> a box in the page's own units
      const a = (r0 / R.DPI) * PT / uu, bnd = ((r0 + n) / R.DPI) * PT / uu;
      let sl;
      if (rot === 0) sl = [box.x, box.y + a, box.x + box.w, box.y + bnd];
      else if (rot === 180) sl = [box.x, box.y + box.h - bnd, box.x + box.w, box.y + box.h - a];
      else if (rot === 90) sl = [box.x + box.w - bnd, box.y, box.x + box.w - a, box.y + box.h];
      else sl = [box.x + a, box.y, box.x + bnd, box.y + box.h]; // 270
      const band = await slicePdf(src, pi, sl, rot);
      const g = await gs.run(['-sDEVICE=pamcmyk32', `-r${R.DPI}`, ...colorArgs, '-o', '/out/b.pam', '/in/b.pdf'], { files: { ...files, '/in/b.pdf': band }, outputs: ['/out/b.pam'] });
      const pamBuf = g.out['/out/b.pam'];
      if (!pamBuf) throw new Error(`Ghostscript could not render this page (${(g.log || []).filter((l) => /error/i.test(l)).slice(0, 2).join(' · ') || `code ${g.code}`})`);
      const pam = parsePam(pamBuf);
      const pw = Math.min(pam.w, cols);
      for (let k = 0; k < n; k++) {
        // picture row counted from the top of this band
        const yi = Math.min(pam.h - 1, pam.h - 1 - k - Math.max(0, pam.h - n) * 0);
        const cur = seed === bufA ? bufB : bufA;
        cur.fill(0, 0, activeW * 4);
        const srcOff = yi * pam.w * 4;
        // x mirrored: the printer's x = 0 is the page's right edge
        for (let x = 0; x < pw; x++) {
          const s = srcOff + (pw - 1 - x) * 4, d = (offsetPx + x) * 4;
          const c = pam.data[s], m = pam.data[s + 1], y = pam.data[s + 2], kk = pam.data[s + 3];
          cur[d] = kk; cur[d + 1] = c; cur[d + 2] = m; cur[d + 3] = y;
        }
        await push(R.rowChunk(R.encodeRow(cur, seed, rollPx, activeW)));
        seed = cur;
      }
      totalRows += n;
      if (opts.onProgress) opts.onProgress((pi + (r0 + n) / rows) / pages.length, `Page ${pi + 1}: ${Math.round(((r0 + n) / rows) * 100)}%`);
    }
    await push(R.trailer());
    bufA = bufB = null;
  }
  await flush(true);
  await sink.end();
  return { pages: pages.length, rows: totalRows, cols: lastCols, bytes: written, cutLinesRemoved, aborted };
}

// ---- sinks ----
function memorySink() {
  const parts = [];
  return { parts, write: async (b) => { parts.push(b); }, end: async () => {}, buffer: () => Buffer.concat(parts) };
}
function fileSink(file) {
  const fs = require('fs');
  const ws = fs.createWriteStream(file);
  const done = new Promise((res, rej) => { ws.on('finish', res); ws.on('error', rej); });
  return {
    write: (b) => new Promise((res, rej) => { ws.write(b, (e) => (e ? rej(e) : res())); }),
    end: () => { ws.end(); return done; },
  };
}
function tcpSink(host, port = 9100, { connectTimeoutMs = 10000, idleTimeoutMs = 10 * 60 * 1000 } = {}) {
  const net = require('net');
  let sock = null, err = null;
  const ready = new Promise((res, rej) => {
    sock = net.connect({ host, port: Number(port) || 9100 });
    const t = setTimeout(() => { sock.destroy(); rej(new Error(`No answer from the printer at ${host}:${port}`)); }, connectTimeoutMs);
    sock.once('connect', () => { clearTimeout(t); sock.setTimeout(idleTimeoutMs, () => sock.destroy(new Error('The printer stopped taking data'))); res(); });
    sock.on('error', (e) => { err = e; clearTimeout(t); rej(e); });
  });
  return {
    write: async (b) => {
      await ready;
      if (err) throw err;
      if (!sock.write(b)) await new Promise((res, rej) => { sock.once('drain', res); sock.once('error', rej); });
    },
    end: async () => { await ready; await new Promise((res) => sock.end(res)); },
  };
}

module.exports = { printPdf, chooseOrientation, parsePam, memorySink, fileSink, tcpSink };
