// HP Latex job format — matched byte for byte to what Flexi 22 (HP DesignJet Raster Language Library
// v4.06) sends a Latex 335 / 115, from jobs captured on the shop's own printers:
//
//   131072 NUL bytes, ESC E, UEL, PJL job settings (media id, passes, ink density, sizes in 1/720"),
//   ENTER LANGUAGE = PCL3GUI,
//   ESC*w<n>J  + JPEG preview for the printer's front panel,
//   ESC&u600D  ESC*r<roll px>S  ESC*g12W <06 0e 00 01 02 58 02 58 0c 01 20 01>  ESC*r1A,
//   ESC*b  then one "<n>w<data>" per raster row, ending "0Y",
//   ESC*rC  FF  ESC E  UEL @PJL EOJ.
//
// Raster rows are 600 dpi, 4 bytes per pixel in K, C, M, Y order (8-bit ink amounts, 0 = no ink),
// full roll width, compressed with HP's delta-row "mode 10" scheme (32-bit pixels). The first row
// is the bottom of the print as it comes out of the printer, and x = 0 is the printer's right side
// (Flexi's 0,0 corner), so a page goes in rotated 180° from how it looks on screen.
const crypto = require('crypto');

const DPI = 600;
const PJL_UNITS = 720; // PAPERLENGTH / PAPERWIDTH etc. are in 1/720 inch
const MARGIN = 142; // HP "NORMAL" margins in 1/720" (≈ 5 mm)
const CONFIG_RASTER = Buffer.from([0x06, 0x0e, 0x00, 0x01, 0x02, 0x58, 0x02, 0x58, 0x0c, 0x01, 0x20, 0x01]);
const LEAD_NULS = 131072;

// Passes -> HP "extended print mode" number (from the printer's own media presets)
const XPM_FOR_PASSES = { 1: 0, 2: 2, 4: 3, 6: 5, 8: 7, 10: 10, 12: 11, 16: 13, 18: 17, 20: 19 };

const MODELS = {
  'hp-latex-335': { name: 'HP Latex 335', maxWidthIn: 64 },
  'hp-latex-115': { name: 'HP Latex 115', maxWidthIn: 54 },
};

// ---- mode 10 (32-bit) row compression ----
// Command byte: bit 7 = run (1) / literal (0); bits 6-5 = where the first pixel comes from
// (0 new pixel follows, 1 = pixel to the left, 2 = pixel above-right in the seed row, 3 = cached);
// bits 4-3 = pixels to skip (copied from the row above), 3 = more skip bytes follow;
// bits 2-0 = count (run: +2 pixels, literal: +1), 7 = more count bytes follow. Extension bytes are
// added until one is < 255.
function pushExt(out, value) {
  // value already had the 3/7 taken off
  while (value >= 255) { out.push(255); value -= 255; }
  out.push(value);
}

const samePx = (a, i, b, j) => a[i] === b[j] && a[i + 1] === b[j + 1] && a[i + 2] === b[j + 2] && a[i + 3] === b[j + 3];

/**
 * Compress one row. cur / seed: Uint8Array (width * 4, KCMY). Returns a Buffer.
 * Like Flexi, the last pixel of the row is always sent, so every row has data.
 * activeW: pixels past this are known to be blank in both rows (a speed-up for narrow jobs on a wide roll).
 */
function encodeRow(cur, seed, width, activeW = width) {
  const out = [];
  let x = 0; // next pixel the printer will place
  const end = Math.min(width, activeW);
  const emit = (start, isRun, count) => {
    // count = pixels covered by this command (run >= 2, literal >= 1)
    const skip = start - x;
    let cmd = isRun ? 0x80 : 0;
    cmd |= (skip >= 3 ? 3 : skip) << 3;
    const c = isRun ? count - 2 : count - 1;
    cmd |= c >= 7 ? 7 : c;
    out.push(cmd);
    if (skip >= 3) pushExt(out, skip - 3);
    const p = start * 4;
    out.push(cur[p], cur[p + 1], cur[p + 2], cur[p + 3]);
    if (isRun) {
      if (c >= 7) pushExt(out, c - 7);
    } else {
      // literals are kept to at most 7 pixels, so no count bytes are ever needed
      for (let k = 1; k < count; k++) { const q = (start + k) * 4; out.push(cur[q], cur[q + 1], cur[q + 2], cur[q + 3]); }
    }
    x = start + count;
  };
  let i = 0;
  while (i < end) {
    if (samePx(cur, i * 4, seed, i * 4)) { i++; continue; }
    // pixel i differs from the row above: run or literal?
    let j = i + 1;
    while (j < end && samePx(cur, j * 4, cur, i * 4)) j++;
    if (j - i >= 2) { emit(i, true, j - i); i = j; continue; }
    // literal: gather pixels that differ from the seed and don't start a run
    let k = i + 1;
    while (k < end && k - i < 7 && !samePx(cur, k * 4, seed, k * 4) && !(k + 1 < end && samePx(cur, k * 4, cur, (k + 1) * 4))) k++;
    emit(i, false, k - i);
    i = k;
  }
  if (x < width) emit(width - 1, false, 1); // always end on the last pixel
  return Buffer.from(out);
}

/** Decompress one row (for tests and for reading captures). Returns a new Uint8Array. */
function decodeRow(data, seed, width) {
  const cur = Uint8Array.from(seed);
  let x = 0, i = 0;
  let cache = [0, 0, 0, 0];
  const ext = (base) => { let v = base; for (;;) { const e = data[i++]; v += e; if (e !== 255) return v; } };
  const put = (px) => { if (x < width) { const p = x * 4; cur[p] = px[0]; cur[p + 1] = px[1]; cur[p + 2] = px[2]; cur[p + 3] = px[3]; } x++; };
  const raw = () => { const px = [data[i], data[i + 1], data[i + 2], data[i + 3]]; i += 4; cache = px; return px; };
  while (i < data.length) {
    const c = data[i++];
    const run = c & 0x80, src = (c >> 5) & 3;
    let off = (c >> 3) & 3, cnt = c & 7;
    if (off === 3) off = ext(3);
    x += off;
    let first;
    if (src === 0) first = raw();
    else if (src === 1) first = x > 0 ? Array.from(cur.subarray((x - 1) * 4, x * 4)) : [0, 0, 0, 0];
    else if (src === 2) first = x + 1 < width ? Array.from(seed.subarray((x + 1) * 4, (x + 2) * 4)) : [0, 0, 0, 0];
    else first = cache;
    if (run) {
      if (cnt === 7) cnt = ext(7);
      for (let k = 0; k < cnt + 2; k++) put(first);
    } else {
      put(first);
      if (cnt === 7) {
        for (let k = 0; k < 7; k++) put(raw());
        for (;;) { const e = data[i++]; for (let k = 0; k < e; k++) put(raw()); if (e !== 255) break; }
      } else for (let k = 0; k < cnt; k++) put(raw());
    }
  }
  return cur;
}

// ---- job framing ----
const stamp = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
const clean = (s) => String(s || '').replace(/["\r\n]/g, '').slice(0, 120);

/** 1/720" length of a run of 600-dpi pixels plus HP's margins, as Flexi writes it */
const pjlLength = (px) => Math.round((px * PJL_UNITS) / DPI + 2 * MARGIN + 2);

/**
 * PJL header. o: { model, jobName, user, mode: { passes, efficiency, inkDensity ('L8'), xpm ('XPM5'), unidirectional },
 *   mediaId, rows, cols, rollPx, cutterId, now, uuid }
 */
function pjlHeader(o) {
  const m = MODELS[o.model] || MODELS['hp-latex-335'];
  const mode = o.mode || {};
  const passes = Number(mode.passes) || 6;
  const now = o.now || new Date();
  const ts = stamp(now);
  const uni = mode.unidirectional ? 'ON' : 'OFF';
  const lines = [
    '@PJL JOB ',
    '@PJL SET STRINGCODESET = UTF8 ',
    `@PJL SET JOBNAME = "${clean(o.jobName || 'InkSign job')}" `,
    '@PJL COMMENT This printer ready file has been generated by InkSign for The Ink Stop ',
    `@PJL COMMENT Job Info -->[Printer Model]: ${m.name} `,
    `@PJL COMMENT Contone Job ->  600dpi-2bpp-${passes}pass-${mode.unidirectional ? 'UniDir' : 'BiDir'}- `,
    `@PJL SET TIMESTAMP = "${ts}" `,
    `@PJL SET JOBATTR = "JobAcct1=${clean(o.user || 'InkSign')}" `,
    `@PJL SET JOBATTR = "JobAcct4=${ts}" `,
    `@PJL SET JOBATTR = "JobAcct5=${o.uuid || crypto.randomUUID()}" `,
    `@PJL SET JOBATTR = "JobAcct6=${o.cutterId ? `CID:${clean(o.cutterId)}|` : ''}InkSign" `,
    '@PJL SET JOBATTR = "JobAcct7=InkSign" ',
    '@PJL SET JOBATTR = "JobAcct8=" ',
    '@PJL SET JOBATTR = "JobAcct10=" ',
    `@PJL SET USERNAME = "${clean(o.user || 'InkSign')}" `,
    `@PJL SET EFFICIENCYMODE = ${mode.efficiency === false || mode.efficiency === 'OFF' ? 'OFF' : 'ON'} `,
    `@PJL SET INKDENSITY = ${mode.inkDensity || 'L10'} `,
    `@PJL SET UNIDIRECTIONAL = ${uni} `,
    `@PJL SET EXTENDEDPM = ${mode.xpm || `XPM${XPM_FOR_PASSES[passes] ?? 5}`} `,
    '@PJL SET PRINTAREA = FULLSIZE ',
    `@PJL SET PAPERLENGTH = ${pjlLength(o.rows)} `,
    `@PJL SET PAPERWIDTH = ${Math.round((o.rollPx * PJL_UNITS) / DPI) + 3} `,
    `@PJL SET TAILGATINGACTUALPAGEWIDTH = ${pjlLength(o.cols)} `,
    '@PJL SET MARGINS = NORMAL ',
    '@PJL SET MARGINLAYOUT = STANDARD ',
    `@PJL SET LEFTMARGIN = ${MARGIN} `,
    `@PJL SET TOPMARGIN = ${MARGIN} `,
    `@PJL SET RIGHTMARGIN = ${MARGIN} `,
    `@PJL SET BOTTOMMARGIN = ${MARGIN} `,
    `@PJL SET MEDIAID = "${clean(o.mediaId || '150100')}" `,
    '@PJL SET CUTTER = OFF ',
    `@PJL SET TAILGATING = ${o.tailgating === false ? 'OFF' : 'ON'} `,
    '@PJL SET NESTMODE = OFF ',
    '@PJL ENTER LANGUAGE = PCL3GUI ',
  ];
  return Buffer.concat([Buffer.alloc(o.leadNuls ?? LEAD_NULS), Buffer.from(`\x1bE\x1b%-12345X${lines.join('\n')}\n`, 'utf8')]);
}

/** Preview + raster setup, up to the start of the row data */
function rasterStart({ rollPx, previewJpeg }) {
  const parts = [];
  if (previewJpeg && previewJpeg.length) parts.push(Buffer.from(`\x1b*w${previewJpeg.length}J`, 'latin1'), previewJpeg);
  parts.push(Buffer.from(`\x1b&u${DPI}D\x1b*r${rollPx}S\x1b*g${CONFIG_RASTER.length}W`, 'latin1'), CONFIG_RASTER, Buffer.from('\x1b*r1A\x1b*b', 'latin1'));
  return Buffer.concat(parts);
}

const rowChunk = (data) => Buffer.concat([Buffer.from(`${data.length}w`, 'latin1'), data]);
const trailer = () => Buffer.from('0Y\x1b*rC\x0c\x1bE\x1b%-12345X@PJL EOJ \n', 'latin1');

/** Read a captured job back: PJL settings, preview, roll width and the rows (for tests / learning) */
function parseJob(buf) {
  const s = buf.toString('latin1');
  const head = s.slice(Math.max(0, s.indexOf('\x1b%-12345X')), Math.max(0, s.indexOf('\x1b%-12345X')) + 20000);
  const pjl = {};
  for (const m of head.matchAll(/@PJL SET (\w+) = "?([^"\n]*?)"? ?\n/g)) if (m[1] !== 'JOBATTR') pjl[m[1]] = m[2].trim();
  const contone = /Contone Job ->\s*(\S+)/.exec(head);
  const out = { pjl, contone: contone ? contone[1] : '', preview: null, rollPx: 0, rows: [] };
  let i = s.indexOf('\x1b*w');
  if (i >= 0) {
    const m = /^\x1b\*w(\d+)J/.exec(s.slice(i, i + 20));
    if (m) { out.preview = buf.subarray(i + m[0].length, i + m[0].length + Number(m[1])); i += m[0].length + Number(m[1]); }
  } else i = 0;
  const r = /\x1b\*r(\d+)S/.exec(s.slice(i, i + 200));
  out.rollPx = r ? Number(r[1]) : 0;
  let p = s.indexOf('\x1b*r1A\x1b*b', i);
  if (p < 0) return out;
  p += 8;
  for (;;) {
    const m = /^(\d+)([wWyY])/.exec(s.slice(p, p + 12));
    if (!m) break;
    const n = Number(m[1]);
    p += m[0].length;
    if (m[2] === 'w' || m[2] === 'W') { out.rows.push(buf.subarray(p, p + n)); p += n; }
    if (m[2] === 'W' || m[2] === 'Y') break;
  }
  return out;
}

/** A print mode from a captured Flexi job (Learn from Flexi) */
function modeFromPjl(pjl, contone = '') {
  const passes = Number((/(\d+)pass/.exec(contone) || [])[1]) || Number(Object.entries(XPM_FOR_PASSES).find(([, v]) => `XPM${v}` === pjl.EXTENDEDPM)?.[0]) || 6;
  return {
    passes,
    efficiency: pjl.EFFICIENCYMODE !== 'OFF',
    inkDensity: pjl.INKDENSITY || 'L10',
    xpm: pjl.EXTENDEDPM || `XPM${XPM_FOR_PASSES[passes] ?? 5}`,
    unidirectional: pjl.UNIDIRECTIONAL === 'ON',
  };
}

module.exports = {
  DPI, MODELS, XPM_FOR_PASSES, CONFIG_RASTER, LEAD_NULS,
  encodeRow, decodeRow, pjlHeader, pjlLength, rasterStart, rowChunk, trailer, parseJob, modeFromPjl,
};
