// Ported unchanged from InkRIP (theinkstopprinting-ui/inkrip, server/iccengine.js) so InkSign builds
// printer profiles exactly the way InkRIP does for the DTF printers.
// A small ICC colour engine, so InkRIP can use any printer profile on its own — the ones that come
// with Digital Factory, ones made in DTF Prep with the i1Pro (ArgyllCMS), or from a profiling service.
//
// It reads the profile's lookup tables (lut8 / lut16 = "mft1/mft2", and the v4 "mAB/mBA" types),
// and builds InkRIP's .lut colour table:  sRGB -> printer CMYK (perceptual, like Digital Factory)
// plus a soft-proof table:  printer CMYK -> how it prints, in sRGB (relative colorimetric).

const D50 = [0.9642, 1.0, 0.8249];
const PERCEPTUAL_BLACK = [0.00336, 0.0034731, 0.00287];
// sRGB (D65) -> XYZ adapted to D50 (Bradford), as used by ICC colour management
const SRGB_TO_XYZ = [
  [0.4360747, 0.3850649, 0.1430804],
  [0.2225045, 0.7168786, 0.0606169],
  [0.0139322, 0.0971045, 0.7141733],
];
const XYZ_TO_SRGB = invert3(SRGB_TO_XYZ);

class IccError extends Error {}

// ------------------------------------------------------------------ reading
function parseIcc(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 132 || b.toString('latin1', 36, 40) !== 'acsp') throw new IccError("This isn't an ICC profile.");
  const header = {
    size: b.readUInt32BE(0),
    version: `${b[8]}.${b[9] >> 4}`,
    deviceClass: b.toString('latin1', 12, 16),
    colorSpace: b.toString('latin1', 16, 20).trim(),
    pcs: b.toString('latin1', 20, 24).trim(),
    renderingIntent: b.readUInt32BE(64),
  };
  const n = b.readUInt32BE(128);
  const tags = {};
  for (let i = 0; i < n; i++) {
    const o = 132 + i * 12;
    const sig = b.toString('latin1', o, o + 4);
    const off = b.readUInt32BE(o + 4), size = b.readUInt32BE(o + 8);
    if (off + size <= b.length) tags[sig] = { off, size, type: b.toString('latin1', off, off + 4) };
  }
  return { buf: b, header, tags, description: readDesc(b, tags.desc) };
}

function readDesc(b, t) {
  if (!t) return '';
  try {
    if (t.type === 'desc') {
      const len = b.readUInt32BE(t.off + 8);
      return b.toString('latin1', t.off + 12, t.off + 12 + len - 1).trim();
    }
    if (t.type === 'mluc') {
      const n = b.readUInt32BE(t.off + 8);
      if (!n) return '';
      const len = b.readUInt32BE(t.off + 20), off = b.readUInt32BE(t.off + 24);
      const s = b.subarray(t.off + off, t.off + off + len);
      let out = '';
      for (let i = 0; i + 1 < s.length; i += 2) out += String.fromCharCode(s.readUInt16BE(i));
      return out.replace(/\0+$/, '').trim();
    }
  } catch {}
  return '';
}

function s15(b, o) { return b.readInt32BE(o) / 65536; }

function readCurve(b, o) {
  // returns { fn(x) for x in [0,1], bytes }
  const type = b.toString('latin1', o, o + 4);
  if (type === 'curv') {
    const n = b.readUInt32BE(o + 8);
    const bytes = 12 + 2 * n;
    if (n === 0) return { fn: (x) => x, bytes };
    if (n === 1) { const g = b.readUInt16BE(o + 12) / 256; return { fn: (x) => Math.pow(Math.max(0, x), g), bytes }; }
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++) t[i] = b.readUInt16BE(o + 12 + 2 * i) / 65535;
    return { fn: tableFn(t), bytes };
  }
  if (type === 'para') {
    const fType = b.readUInt16BE(o + 8);
    const np = [1, 3, 4, 5, 7][fType];
    const p = [];
    for (let i = 0; i < np; i++) p.push(s15(b, o + 12 + 4 * i));
    const [g, a = 1, bb = 0, c = 0, d = 0, e = 0, f = 0] = p;
    let fn;
    if (fType === 0) fn = (x) => Math.pow(x, g);
    else if (fType === 1) fn = (x) => (x >= -bb / a ? Math.pow(a * x + bb, g) : 0);
    else if (fType === 2) fn = (x) => (x >= -bb / a ? Math.pow(a * x + bb, g) + c : c);
    else if (fType === 3) fn = (x) => (x >= d ? Math.pow(a * x + bb, g) : c * x);
    else fn = (x) => (x >= d ? Math.pow(a * x + bb, g) + e : c * x + f);
    return { fn: (x) => clamp01(fn(clamp01(x))), bytes: 12 + 4 * np };
  }
  throw new IccError(`Unsupported curve type ${type}`);
}

function tableFn(t) {
  const n = t.length - 1;
  return (x) => {
    const f = clamp01(x) * n;
    const i = Math.min(n - 1, Math.floor(f));
    const u = f - i;
    return t[i] + (t[i + 1] - t[i]) * u;
  };
}

/** lut8Type / lut16Type */
function readMft(b, off, type) {
  const inCh = b[off + 8], outCh = b[off + 9], g = b[off + 10];
  const matrix = [];
  for (let i = 0; i < 9; i++) matrix.push(s15(b, off + 12 + 4 * i));
  let p, inEnt, outEnt, rd, max;
  if (type === 'mft2') {
    inEnt = b.readUInt16BE(off + 48); outEnt = b.readUInt16BE(off + 50);
    p = off + 52; rd = (o) => b.readUInt16BE(o); max = 65535;
    var step = 2;
  } else {
    inEnt = 256; outEnt = 256; p = off + 48; rd = (o) => b[o]; max = 255;
    var step = 1;
  }
  const inCurves = [];
  for (let c = 0; c < inCh; c++) {
    const t = new Float32Array(inEnt);
    for (let i = 0; i < inEnt; i++) { t[i] = rd(p) / max; p += step; }
    inCurves.push(tableFn(t));
  }
  const nGrid = Math.pow(g, inCh) * outCh;
  const clut = new Float32Array(nGrid);
  for (let i = 0; i < nGrid; i++) { clut[i] = rd(p) / max; p += step; }
  const outCurves = [];
  for (let c = 0; c < outCh; c++) {
    const t = new Float32Array(outEnt);
    for (let i = 0; i < outEnt; i++) { t[i] = rd(p) / max; p += step; }
    outCurves.push(tableFn(t));
  }
  return { kind: type, inCh, outCh, grid: new Array(inCh).fill(g), clut, inCurves, outCurves, matrix, legacyLab: true };
}

/** lutAtoBType / lutBtoAType (v4) */
function readMab(b, off, type) {
  const inCh = b[off + 8], outCh = b[off + 9];
  const oB = b.readUInt32BE(off + 12), oMat = b.readUInt32BE(off + 16), oM = b.readUInt32BE(off + 20);
  const oClut = b.readUInt32BE(off + 24), oA = b.readUInt32BE(off + 28);
  const curves = (o, n) => {
    if (!o) return null;
    const out = [];
    let p = off + o;
    for (let i = 0; i < n; i++) {
      const c = readCurve(b, p);
      out.push(c.fn);
      p += c.bytes;
      p += (4 - (p % 4)) % 4;
    }
    return out;
  };
  const aToB = type === 'mAB';
  // A curves are on the device side, B on the PCS side
  const nA = aToB ? inCh : outCh;
  const nB = aToB ? outCh : inCh;
  const A = curves(oA, nA), B = curves(oB, nB), M = curves(oM, 3);
  let mat = null;
  if (oMat) { mat = []; for (let i = 0; i < 12; i++) mat.push(s15(b, off + oMat + 4 * i)); }
  let clut = null, grid = null;
  if (oClut) {
    const p = off + oClut;
    const clutIn = aToB ? inCh : 3;
    const clutOut = aToB ? 3 : outCh;
    grid = [];
    for (let i = 0; i < clutIn; i++) grid.push(b[p + i]);
    const prec = b[p + 16];
    const n = grid.reduce((a, x) => a * x, 1) * clutOut;
    clut = new Float32Array(n);
    for (let i = 0; i < n; i++) clut[i] = prec === 1 ? b[p + 20 + i] / 255 : b.readUInt16BE(p + 20 + 2 * i) / 65535;
  }
  return { kind: type, inCh, outCh, A, B, M, mat, clut, grid, legacyLab: false };
}

function readLut(icc, sig) {
  const t = icc.tags[sig];
  if (!t) return null;
  if (t.type === 'mft2' || t.type === 'mft1') return readMft(icc.buf, t.off, t.type);
  if (t.type === 'mAB ' || t.type === 'mBA ') return readMab(icc.buf, t.off, t.type.trim());
  throw new IccError(`Unsupported table type ${t.type} in ${sig}`);
}

// ------------------------------------------------------------------ evaluating
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/** n-linear interpolation in a CLUT (any number of inputs), result into out[] */
function interp(clut, grid, outCh, inp, out) {
  const n = grid.length;
  const idx = new Array(n), frac = new Array(n), stride = new Array(n);
  let s = outCh;
  for (let d = n - 1; d >= 0; d--) { stride[d] = s; s *= grid[d]; }
  for (let d = 0; d < n; d++) {
    const f = clamp01(inp[d]) * (grid[d] - 1);
    let i = Math.floor(f);
    if (i >= grid[d] - 1) i = grid[d] - 2;
    if (i < 0) i = 0;
    idx[d] = i; frac[d] = f - i;
  }
  for (let c = 0; c < outCh; c++) out[c] = 0;
  const corners = 1 << n;
  for (let k = 0; k < corners; k++) {
    let w = 1, o = 0;
    for (let d = 0; d < n; d++) {
      const bit = (k >> d) & 1;
      w *= bit ? frac[d] : 1 - frac[d];
      o += (idx[d] + bit) * stride[d];
    }
    if (w === 0) continue;
    for (let c = 0; c < outCh; c++) out[c] += w * clut[o + c];
  }
  return out;
}

function evalLut(L, inp) {
  const out = new Array(L.outCh).fill(0);
  if (L.kind === 'mft2' || L.kind === 'mft1') {
    const x = inp.map((v, i) => L.inCurves[i](v));
    const y = interp(L.clut, L.grid, L.outCh, x, new Array(L.outCh));
    for (let c = 0; c < L.outCh; c++) out[c] = L.outCurves[c](y[c]);
    return out;
  }
  if (L.kind === 'mAB') {
    let x = inp.slice();
    if (L.A) x = x.map((v, i) => L.A[i](v));
    if (L.clut) x = interp(L.clut, L.grid, 3, x, [0, 0, 0]);
    if (L.M) x = x.map((v, i) => L.M[i](v));
    if (L.mat) x = applyMat(L.mat, x);
    if (L.B) x = x.map((v, i) => L.B[i](v));
    return x;
  }
  // mBA
  let x = inp.slice();
  if (L.B) x = x.map((v, i) => L.B[i](v));
  if (L.mat) x = applyMat(L.mat, x);
  if (L.M) x = x.map((v, i) => L.M[i](v));
  if (L.clut) x = interp(L.clut, L.grid, L.outCh, x, new Array(L.outCh));
  if (L.A) x = x.map((v, i) => L.A[i](v));
  return x;
}

function applyMat(m, x) {
  return [0, 1, 2].map((r) => clamp01(m[r * 3] * x[0] + m[r * 3 + 1] * x[1] + m[r * 3 + 2] * x[2] + m[9 + r]));
}

// PCS encodings
function labToPcs(lab, legacy) {
  const [L, a, b] = lab;
  if (legacy) return [clamp01((L * 652.8) / 65535), clamp01(((a + 128) * 256) / 65535), clamp01(((b + 128) * 256) / 65535)];
  return [clamp01(L / 100), clamp01((a + 128) / 255), clamp01((b + 128) / 255)];
}
function pcsToLab(p, legacy) {
  if (legacy) return [(p[0] * 65535) / 652.8, (p[1] * 65535) / 256 - 128, (p[2] * 65535) / 256 - 128];
  return [p[0] * 100, p[1] * 255 - 128, p[2] * 255 - 128];
}
function xyzToPcs(xyz) { return xyz.map((v) => clamp01((v * 32768) / 65535)); }
function pcsToXyz(p) { return p.map((v) => (v * 65535) / 32768); }

const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const finv = (t) => (t * t * t > 216 / 24389 ? t * t * t : (116 * t - 16) / (24389 / 27));
function xyzToLab([X, Y, Z]) {
  const fx = f(X / D50[0]), fy = f(Y / D50[1]), fz = f(Z / D50[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function labToXyz([L, a, b]) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  return [finv(fx) * D50[0], finv(fy) * D50[1], finv(fz) * D50[2]];
}
const toLin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toGam = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
function srgbToLab(r, g, b) {
  const l = [toLin(r / 255), toLin(g / 255), toLin(b / 255)];
  return xyzToLab(mul3(SRGB_TO_XYZ, l));
}
function labToSrgb(lab) {
  const lin = mul3(XYZ_TO_SRGB, labToXyz(lab));
  return lin.map((v) => Math.round(255 * clamp01(toGam(clamp01(v)))));
}
function mul3(m, v) { return [0, 1, 2].map((r) => m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2]); }
function invert3(m) {
  const [[a, b, c], [d, e, f2], [g, h, i]] = m;
  const A = e * i - f2 * h, B = -(d * i - f2 * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f2 - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f2 - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

// ------------------------------------------------------------------ public
/** Check a profile can drive the printer; returns a short summary. */
function describeProfile(buf) {
  const icc = parseIcc(buf);
  const h = icc.header;
  const problems = [];
  if (h.colorSpace !== 'CMYK') problems.push(`It's a ${h.colorSpace} profile — InkRIP needs a CMYK printer profile.`);
  if (!['Lab', 'XYZ'].includes(h.pcs)) problems.push(`Unknown connection space ${h.pcs}.`);
  const has = (s) => !!icc.tags[s];
  if (!has('B2A0') && !has('B2A1')) problems.push('The profile has no colour-to-printer table (B2A0/B2A1).');
  if (!has('A2B1') && !has('A2B0')) problems.push('The profile has no printer-to-colour table (A2B0/A2B1).');
  return { description: icc.description, version: h.version, deviceClass: h.deviceClass, colorSpace: h.colorSpace, pcs: h.pcs, problems };
}

/**
 * Build InkRIP's .lut colour table from an ICC profile.
 * @returns Buffer  'TULK' N 4 3 | N³ × CMYK bytes | N³ × soft-proof RGB bytes
 */
function buildLutFromIcc(buf, { N = 33, intent = 0 } = {}) {
  const icc = parseIcc(buf);
  const d = describeProfile(buf);
  if (d.problems.length) throw new IccError(d.problems[0]);
  const xyzPcs = icc.header.pcs === 'XYZ';
  const toPrinter = readLut(icc, `B2A${intent}`) || readLut(icc, 'B2A1') || readLut(icc, 'B2A0');
  const toColour = readLut(icc, 'A2B1') || readLut(icc, 'A2B0');
  // Like LittleCMS (and so Digital Factory): v4 profiles in perceptual intent map sRGB black onto
  // the v4 "perceptual black" (black point compensation is always on for them).
  const bpc = intent === 0 && parseInt(icc.header.version, 10) >= 4;
  const n3 = N * N * N;
  const out = Buffer.alloc(16 + n3 * 7);
  out.writeUInt32LE(0x4b4c5554, 0);
  out.writeUInt32LE(N, 4);
  out.writeUInt32LE(4, 8);
  out.writeUInt32LE(3, 12);
  const cm = out.subarray(16, 16 + n3 * 4);
  const pr = out.subarray(16 + n3 * 4);
  let i = 0;
  for (let ir = 0; ir < N; ir++) {
    for (let ig = 0; ig < N; ig++) {
      for (let ib = 0; ib < N; ib++, i++) {
        const r = (ir * 255) / (N - 1), g = (ig * 255) / (N - 1), b = (ib * 255) / (N - 1);
        let lab = srgbToLab(r, g, b);
        if (bpc) lab = xyzToLab(labToXyz(lab).map((v, k) => v * (1 - PERCEPTUAL_BLACK[k] / D50[k]) + PERCEPTUAL_BLACK[k]));
        const pcsIn = xyzPcs ? xyzToPcs(labToXyz(lab)) : labToPcs(lab, toPrinter.legacyLab);
        const cmyk = evalLut(toPrinter, pcsIn);
        for (let c = 0; c < 4; c++) cm[i * 4 + c] = Math.round(clamp01(cmyk[c]) * 255);
        // soft proof: what that CMYK prints as
        const back = evalLut(toColour, cmyk.map(clamp01));
        const labOut = xyzPcs ? xyzToLab(pcsToXyz(back)) : pcsToLab(back, toColour.legacyLab);
        const rgb = labToSrgb(labOut);
        pr[i * 3] = rgb[0]; pr[i * 3 + 1] = rgb[1]; pr[i * 3 + 2] = rgb[2];
      }
    }
  }
  return out;
}

/** CMYK (0..1 each) -> Lab through the profile (relative colorimetric), for reports. */
function makeCmykToLab(buf) {
  const icc = parseIcc(buf);
  const L = readLut(icc, 'A2B1') || readLut(icc, 'A2B0');
  const xyzPcs = icc.header.pcs === 'XYZ';
  return (cmyk) => {
    const p = evalLut(L, cmyk.map(clamp01));
    return xyzPcs ? xyzToLab(pcsToXyz(p)) : pcsToLab(p, L.legacyLab);
  };
}

module.exports = { IccError, parseIcc, xyzToLab, labToXyz, srgbToLab, labToSrgb, describeProfile, buildLutFromIcc, makeCmykToLab };
