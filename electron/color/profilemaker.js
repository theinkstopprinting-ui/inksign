// Ported unchanged from InkRIP (theinkstopprinting-ui/inkrip, server/profilemaker.js) so InkSign builds
// printer profiles exactly the way InkRIP does for the DTF printers.
const { xyzToLab, labToXyz, srgbToLab, labToSrgb } = require('./iccengine');
// Build a printer profile (ICC) inside InkRIP from measurements (i1Pro .ti3 / CGATS, or a Nix Mini —
// see nixchart.js).
//
// Input: the measurement file ArgyllCMS (.ti3) or i1Profiler (.txt, CGATS) saves after the chart is
// read — every patch's CMYK values and the Lab (or XYZ) colour the i1Pro measured.
//
//   1. a smooth model of the printer (CMYK → colour) is fitted to the patches: each grid point is
//      a weighted local fit of its nearest patches, so measuring noise is smoothed out
//   2. the inverse (colour → CMYK) is solved for every point of the profile's table: black is
//      chosen first by a medium GCR rule (more black in dark, neutral colours), then C, M, Y are
//      solved to hit the colour, within the total ink limit; out-of-gamut colours land on the
//      closest colour the printer can make
//   3. both tables are written as a standard ICC v2 profile (lut16), usable here and in other apps,
//      plus InkRIP's own sRGB → CMYK table built straight from the model (v1.7)
//
// v1.7 colour fixes (why earlier profiles looked off): perceptual gamut mapping (saturated screen
// colours go to the printer's own saturated colours — screen yellow prints as solid yellow ink —
// while medium colours are kept), black point compensation on luminance instead of L* (L* scaling
// lifted every mid-tone and washed prints out), black only in greys, and a solver that can't get
// stuck at the edge of the printer's range.

const D50 = [0.9642, 1.0, 0.8249];

// ---------------------------------------------------------------- CGATS (.ti3 / .txt)
function parseCgats(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  let fields = null;
  const rows = [];
  let inFmt = false, inData = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^BEGIN_DATA_FORMAT/.test(line)) { inFmt = true; fields = []; continue; }
    if (/^END_DATA_FORMAT/.test(line)) { inFmt = false; continue; }
    if (/^BEGIN_DATA\b/.test(line)) { inData = true; continue; }
    if (/^END_DATA\b/.test(line)) { inData = false; continue; }
    if (inFmt) { fields.push(...line.split(/\s+/)); continue; }
    if (inData && fields) {
      const cells = line.match(/"[^"]*"|\S+/g) || [];
      if (cells.length >= fields.length) rows.push(cells);
    }
  }
  if (!fields || !rows.length) throw new Error("That file has no measurement table — use the .ti3 from ArgyllCMS or the CGATS .txt from i1Profiler.");
  const col = (n) => fields.indexOf(n);
  const num = (v) => Number(String(v).replace(',', '.'));
  const ci = ['CMYK_C', 'CMYK_M', 'CMYK_Y', 'CMYK_K'].map(col);
  if (ci.some((i) => i < 0)) throw new Error('The file has no CMYK values (CMYK_C … CMYK_K) — it must be a CMYK printer chart.');
  const li = ['LAB_L', 'LAB_A', 'LAB_B'].map(col), xi = ['XYZ_X', 'XYZ_Y', 'XYZ_Z'].map(col);
  if (li.some((i) => i < 0) && xi.some((i) => i < 0)) throw new Error('The file has no measured colours (LAB_L … or XYZ_X …).');
  const cmykMax = Math.max(...rows.map((r) => Math.max(...ci.map((i) => num(r[i])))));
  const scale = cmykMax > 1.5 ? 100 : 1;
  const out = [];
  for (const r of rows) {
    const cmyk = ci.map((i) => Math.max(0, Math.min(1, num(r[i]) / scale)));
    let lab;
    if (li.every((i) => i >= 0)) lab = li.map((i) => num(r[i]));
    else { const xyz = xi.map((i) => num(r[i]) / 100); lab = xyzToLab(xyz); }
    if (cmyk.every(Number.isFinite) && lab.every(Number.isFinite)) out.push({ cmyk, lab });
  }
  if (out.length < 50) throw new Error(`Only ${out.length} patches — a profile needs a proper chart (a few hundred patches or more).`);
  return out;
}

// ---------------------------------------------------------------- printer model
const G = 9; // forward grid points per ink

function fitForward(samples) {
  const n = samples.length;
  const K = Math.min(40, Math.max(12, Math.round(n / 25)));
  const S = samples.map((s) => s.cmyk), Lab = samples.map((s) => s.lab);
  const d2 = new Float64Array(n), idx = new Int32Array(n);
  const predict = (q) => {
    for (let i = 0; i < n; i++) {
      const a = S[i];
      d2[i] = (a[0] - q[0]) ** 2 + (a[1] - q[1]) ** 2 + (a[2] - q[2]) ** 2 + (a[3] - q[3]) ** 2;
      idx[i] = i;
    }
    const ord = Array.from(idx).sort((x, y) => d2[x] - d2[y]).slice(0, K);
    const dmax = Math.sqrt(d2[ord[K - 1]]) * 1.05 + 1e-6;
    // weighted affine fit: lab ≈ A·[1, c, m, y, k]
    const M = Array.from({ length: 5 }, () => new Float64Array(5)), B = [new Float64Array(5), new Float64Array(5), new Float64Array(5)];
    for (const i of ord) {
      const u = Math.sqrt(d2[i]) / dmax;
      const w = (1 - u * u * u) ** 3 + 1e-4;
      const x = [1, S[i][0] - q[0], S[i][1] - q[1], S[i][2] - q[2], S[i][3] - q[3]];
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) M[r][c] += w * x[r] * x[c];
        for (let o = 0; o < 3; o++) B[o][r] += w * x[r] * Lab[i][o];
      }
    }
    for (let r = 1; r < 5; r++) M[r][r] += 1e-3; // a little ridge so sparse corners stay calm
    return [0, 1, 2].map((o) => solve5(M, B[o])[0]);
  };
  const grid = new Float32Array(G ** 4 * 3);
  let p = 0;
  for (let c = 0; c < G; c++) for (let m = 0; m < G; m++) for (let y = 0; y < G; y++) for (let k = 0; k < G; k++) {
    const lab = predict([c / (G - 1), m / (G - 1), y / (G - 1), k / (G - 1)]);
    grid[p++] = lab[0]; grid[p++] = lab[1]; grid[p++] = lab[2];
  }
  return grid;
}

function solve5(M0, b0) {
  const M = M0.map((r) => Array.from(r)), b = Array.from(b0);
  for (let c = 0; c < 5; c++) {
    let p = c;
    for (let r = c + 1; r < 5; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]]; [b[c], b[p]] = [b[p], b[c]];
    const d = M[c][c] || 1e-9;
    for (let r = c + 1; r < 5; r++) {
      const f = M[r][c] / d;
      for (let k = c; k < 5; k++) M[r][k] -= f * M[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(5).fill(0);
  for (let r = 4; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < 5; k++) s -= M[r][k] * x[k];
    x[r] = s / (M[r][r] || 1e-9);
  }
  return x;
}

/** CMYK (0..1) → measured Lab, quadrilinear on the model grid. */
function forwardFn(grid) {
  const g1 = G - 1;
  const st = [G ** 3 * 3, G ** 2 * 3, G * 3, 3];
  const out = [0, 0, 0];
  return (q) => {
    const i = [0, 0, 0, 0], f = [0, 0, 0, 0];
    for (let d = 0; d < 4; d++) {
      const v = Math.max(0, Math.min(1, q[d])) * g1;
      i[d] = Math.min(g1 - 1, Math.floor(v));
      f[d] = v - i[d];
    }
    out[0] = out[1] = out[2] = 0;
    for (let corner = 0; corner < 16; corner++) {
      let w = 1, o = 0;
      for (let d = 0; d < 4; d++) {
        const bit = (corner >> d) & 1;
        w *= bit ? f[d] : 1 - f[d];
        o += (i[d] + bit) * st[d];
      }
      if (w === 0) continue;
      out[0] += w * grid[o]; out[1] += w * grid[o + 1]; out[2] += w * grid[o + 2];
    }
    return [out[0], out[1], out[2]];
  };
}

/**
 * How well each reading agrees with the rest (the smooth printer model fitted to all of them).
 * A reading far off its neighbours is usually a mis-scan: over an edge, the wrong patch, a
 * doubled or skipped scan. Returns the patches worth re-scanning, worst first.
 */
/** How far a model fitted to `fitSamples` is from other readings (ΔE avg / max) — "how wrong was it here". */
function predictionError(fitSamples, testSamples) {
  const F = forwardFn(fitForward(fitSamples));
  let sum = 0, max = 0;
  for (const s of testSamples) { const e = dE(F(s.cmyk), s.lab); sum += e; max = Math.max(max, e); }
  const n = Math.max(1, testSamples.length);
  return { avg: Math.round((sum / n) * 100) / 100, max: Math.round(max * 100) / 100 };
}

function readingCheck(samples, limit = 5) {
  const F = forwardFn(fitForward(samples));
  return samples
    .map((s) => ({ n: s.n, dE: dE(F(s.cmyk), s.lab) }))
    .filter((x) => x.dE > limit)
    .sort((a, b) => b.dE - a.dE)
    .map((x) => ({ patch: x.n, dE: Math.round(x.dE * 10) / 10 }));
}

// ---------------------------------------------------------------- the profile
function makeProfile(samples, { name = 'InkRIP printer profile', tac = 320, gcr = 'medium', source = 'measurements' } = {}) {
  const grid = fitForward(samples);
  const F = forwardFn(grid);
  const paperLab = F([0, 0, 0, 0]);
  const paperXyz = labToXyz(paperLab);
  // darkest the printer gets (within the ink limit)
  let blackLab = F([0, 0, 0, 1]);
  for (const k of [1]) for (const c of [0.4, 0.6, 0.8]) {
    const t = F([c, c * 0.85, c * 0.85, k]);
    if (c + 1.7 * c + k <= tac / 100 && t[0] < blackLab[0]) blackLab = t;
  }
  const absToRel = (lab) => xyzToLab(labToXyz(lab).map((v, i) => (v * D50[i]) / paperXyz[i]));
  const relToAbs = (lab) => xyzToLab(labToXyz(lab).map((v, i) => (v * paperXyz[i]) / D50[i]));
  const Lw = 100, Lb = absToRel(blackLab)[0];
  const tacLim = tac / 100;
  const gcrAmt = gcr === 'light' ? 0.6 : gcr === 'heavy' ? 1.4 : 1;

  // colour (relative Lab, perceptual: black point compensated) → CMYK
  let warm = [0.2, 0.2, 0.2];
  const gamut = makeGamutMap(F, absToRel, tacLim, Lb);
  // starting points for the solver: the model's colours on a CMY grid, at a few black levels
  const seeds = [0, 0.25, 0.5, 0.75, 1].map((k) => {
    const list = [];
    for (let c = 0; c <= 10; c++) for (let m = 0; m <= 10; m++) for (let y = 0; y <= 10; y++) {
      const v = [c / 10, m / 10, y / 10];
      if (v[0] + v[1] + v[2] + k > tacLim + 1e-9) continue;
      list.push({ v, lab: F([...v, k]) });
    }
    return { k, list };
  });
  const seedFor = (t, K) => {
    const S = seeds.reduce((a, b) => (Math.abs(b.k - K) < Math.abs(a.k - K) ? b : a));
    const W = weigher(t);
    let bd = Infinity, bv = null;
    for (const s of S.list) { const r = W([t[0] - s.lab[0], t[1] - s.lab[1], t[2] - s.lab[2]]); const d = r[0] * r[0] + r[1] * r[1] + r[2] * r[2]; if (d < bd) { bd = d; bv = s.v; } }
    return bv && bv.slice();
  };
  const inverse = (labRel, perceptual) => {
    let target = labRel;
    if (perceptual) target = gamut(labRel);
    const t = relToAbs(target);
    // black: only for greys and near-greys (judged on the artwork's colour, before mapping), and only
    // from mid-tones down — black in pastels and saturated colours makes them dirty
    const C = Math.min(Math.hypot(t[1], t[2]), Math.hypot(labRel[1], labRel[2]));
    const dark = Math.max(0, Math.min(1, (paperLab[0] - t[0]) / Math.max(1, paperLab[0] - blackLab[0])));
    const neutral = Math.max(0, 1 - C / 30) ** 1.5;
    let K = Math.min(1, gcrAmt * neutral * Math.max(0, (dark - 0.35) / 0.65) ** 1.2 + (dark > 0.97 ? (dark - 0.97) * 10 : 0));
    let best = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      // start from the previous table point and from the closest model colour; keep the better fit
      // (one start alone can get stuck on the edge of the printer's range)
      let cmy = solveCmy(F, t, K, warm, tacLim);
      const seed = seedFor(t, K);
      if (seed && cmy.werr > 0.5) { const c2 = solveCmy(F, t, K, seed, tacLim); if (c2.werr < cmy.werr - 0.05) cmy = c2; }
      if (!best || cmy.err < best.err - 0.3) best = { cmy: cmy.x, K, err: cmy.err };
      if (cmy.err < 2 || K >= 1 || t[0] > paperLab[0] - 30) break;
      K = Math.min(1, K + 0.2); // too dark to reach: more black
    }
    warm = best.cmy;
    return [...best.cmy, best.K];
  };

  // tables
  const A2B = new Uint16Array(G ** 4 * 3);
  let p = 0;
  for (let c = 0; c < G; c++) for (let m = 0; m < G; m++) for (let y = 0; y < G; y++) for (let k = 0; k < G; k++) {
    const lab = absToRel(F([c / (G - 1), m / (G - 1), y / (G - 1), k / (G - 1)]));
    const e = encLab(lab);
    A2B[p++] = e[0]; A2B[p++] = e[1]; A2B[p++] = e[2];
  }
  const N = 33;
  const B2A = new Uint16Array(N ** 3 * 4);
  p = 0;
  for (let l = 0; l < N; l++) {
    for (let a = 0; a < N; a++) {
      warm = [0.2, 0.2, 0.2];
      for (let b = 0; b < N; b++) {
        const lab = decLab([(l / (N - 1)) * 65535, (a / (N - 1)) * 65535, (b / (N - 1)) * 65535]);
        const cmyk = inverse(lab, true);
        for (let q = 0; q < 4; q++) B2A[p++] = Math.round(Math.max(0, Math.min(1, cmyk[q])) * 65535);
      }
    }
  }
  // InkRIP's own colour table, straight from sRGB (artwork) to CMYK through the same mapping —
  // no second interpolation through the Lab table, so the edges of sRGB (pure yellow …) come out exact
  const LN = 33, n3 = LN ** 3;
  const lutBuf = Buffer.alloc(16 + n3 * 7);
  lutBuf.writeUInt32LE(0x4b4c5554, 0); lutBuf.writeUInt32LE(LN, 4); lutBuf.writeUInt32LE(4, 8); lutBuf.writeUInt32LE(3, 12);
  const cmOut = lutBuf.subarray(16, 16 + n3 * 4), prOut = lutBuf.subarray(16 + n3 * 4);
  let li = 0;
  for (let ir = 0; ir < LN; ir++) for (let ig = 0; ig < LN; ig++) {
    warm = [0.2, 0.2, 0.2];
    for (let ib = 0; ib < LN; ib++, li++) {
      const lab = srgbToLab((ir * 255) / (LN - 1), (ig * 255) / (LN - 1), (ib * 255) / (LN - 1));
      const cmyk = ir === LN - 1 && ig === LN - 1 && ib === LN - 1 ? [0, 0, 0, 0] : inverse(lab, true);
      for (let c = 0; c < 4; c++) cmOut[li * 4 + c] = Math.round(Math.max(0, Math.min(1, cmyk[c])) * 255);
      const rgb = labToSrgb(absToRel(F(cmyk)));
      prOut[li * 3] = rgb[0]; prOut[li * 3 + 1] = rgb[1]; prOut[li * 3 + 2] = rgb[2];
    }
  }

  // how well the model fits the measurements
  let sum = 0, max = 0;
  for (const s of samples) { const e = dE(F(s.cmyk), s.lab); sum += e; max = Math.max(max, e); }
  const fit = { avg: Math.round((sum / samples.length) * 100) / 100, max: Math.round(max * 100) / 100 };
  const icc = writeIcc({ name, A2B, B2A, N, paperXyz, source });
  return { lut: lutBuf, icc, fit, paperLab: paperLab.map((v) => Math.round(v * 10) / 10), blackLab: blackLab.map((v) => Math.round(v * 10) / 10), patches: samples.length };
}


// ---------------------------------------------------------------- perceptual gamut mapping
// Artwork is sRGB; the printer's colour range is a different shape. Colours well inside both are
// matched exactly (skin, greys, pastels). The more saturated a colour is *for its hue in sRGB*, the
// more it is moved onto the printer's own most saturated colour of that hue — so screen yellow
// prints as solid yellow ink, screen blue as the printer's deepest blue, and so on, instead of a
// duller "nearest" colour. The six primaries (Y, R, M, B, C, G) are anchored to the printer's
// solid inks and two-ink overprints.
const SRGB_D50 = [[0.4360747, 0.3850649, 0.1430804], [0.2225045, 0.7168786, 0.0606169], [0.0139322, 0.0971045, 0.7141733]];
function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
const SRGB_INV = inv3(SRGB_D50);
function srgbInGamut(L, a, b) {
  const xyz = labToXyz([L, a, b]);
  for (const row of SRGB_INV) { const v = row[0] * xyz[0] + row[1] * xyz[1] + row[2] * xyz[2]; if (v < -1e-4 || v > 1.0001) return false; }
  return true;
}
const HB = 360; // hue bins (1°)
// 1 across the azure → teal hues (≈225–280°), fading out over 12° on each side
function blueKeep(h) {
  const up = smooth(213, 225, h), down = 1 - smooth(280, 292, h);
  return Math.max(0, Math.min(up, down));
}
const hueOf = (a, b) => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

function srgbMaxC(L, h) {
  if (L <= 0 || L >= 100) return 0;
  const ca = Math.cos((h * Math.PI) / 180), sa = Math.sin((h * Math.PI) / 180);
  let lo = 0, hi = 160;
  for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (srgbInGamut(L, m * ca, m * sa)) lo = m; else hi = m; }
  return lo;
}

function makeGamutMap(F, absToRel, tacLim, Lb) {
  // printer boundary: max chroma per hue degree and lightness unit
  const box = new Float32Array(HB * 101);
  const addPt = (cmyk) => {
    if (cmyk[0] + cmyk[1] + cmyk[2] + cmyk[3] > tacLim + 1e-9) return;
    const [L, a, b] = absToRel(F(cmyk));
    const C = Math.hypot(a, b);
    const hb = Math.round(hueOf(a, b)) % HB, lb = Math.max(0, Math.min(100, Math.round(L)));
    if (C > box[hb * 101 + lb]) box[hb * 101 + lb] = C;
  };
  const st = 24;
  for (let c = 0; c <= st; c++) for (let m = 0; m <= st; m++) for (let y = 0; y <= st; y++) addPt([c / st, m / st, y / st, 0]);
  for (const k of [0.2, 0.4, 0.6, 0.8, 1]) for (let c = 0; c <= 12; c++) for (let m = 0; m <= 12; m++) for (let y = 0; y <= 12; y++) addPt([c / 12, m / 12, y / 12, k]);
  // spread across neighbouring hues, then fill each hue's lightness gaps
  const dst = new Float32Array(HB * 101);
  for (let h = 0; h < HB; h++) for (let l = 0; l <= 100; l++) {
    let m = 0;
    for (let dh = -2; dh <= 2; dh++) for (let dl = -1; dl <= 1; dl++) {
      const ll = l + dl; if (ll < 0 || ll > 100) continue;
      m = Math.max(m, box[((h + dh + HB) % HB) * 101 + ll] * (1 - 0.04 * Math.abs(dh)));
    }
    dst[h * 101 + l] = m;
  }
  for (let h = 0; h < HB; h++) {
    const row = dst.subarray(h * 101, h * 101 + 101);
    const filled = [];
    for (let l = 0; l <= 100; l++) if (row[l] > 0) filled.push(l);
    if (!filled.length) continue;
    for (let l = 0; l <= 100; l++) {
      if (row[l] > 0) continue;
      const lo = filled.filter((v) => v < l).pop(), hi = filled.find((v) => v > l);
      row[l] = lo !== undefined && hi !== undefined ? row[lo] + ((row[hi] - row[lo]) * (l - lo)) / (hi - lo) : 0;
    }
  }
  const dstMaxC = (L, h) => {
    const h0 = Math.floor(h) % HB, h1 = (h0 + 1) % HB, fh = h - Math.floor(h);
    const l = Math.max(0, Math.min(100, L)), l0 = Math.min(99, Math.floor(l)), fl = l - l0;
    const v = (hh, ll) => dst[hh * 101 + ll];
    return (1 - fh) * ((1 - fl) * v(h0, l0) + fl * v(h0, l0 + 1)) + fh * ((1 - fl) * v(h1, l0) + fl * v(h1, l0 + 1));
  };
  const cuspOf = (fn, h) => { let bl = 50, bc = -1; for (let L = 2; L <= 98; L += 0.5) { const c = fn(L, h); if (c > bc) { bc = c; bl = L; } } return bl; };
  const srcCusp = new Float32Array(HB), dstCusp = new Float32Array(HB);
  for (let h = 0; h < HB; h++) { srcCusp[h] = cuspOf(srgbMaxC, h); dstCusp[h] = cuspOf(dstMaxC, h); }
  const cuspAt = (arr, h) => { const h0 = Math.floor(h) % HB, f = h - Math.floor(h); return arr[h0] * (1 - f) + arr[(h0 + 1) % HB] * f; };

  // primaries: sRGB Y R M B C G → the printer's Y, MY, M, CM, C, CY solids
  const srcP = [[255, 255, 0], [255, 0, 0], [255, 0, 255], [0, 0, 255], [0, 255, 255], [0, 255, 0]].map((c) => { const l = srgbToLab(...c); return hueOf(l[1], l[2]); });
  const dstP = [[0, 0, 1, 0], [0, 1, 1, 0], [0, 1, 0, 0], [1, 1, 0, 0], [1, 0, 0, 0], [1, 0, 1, 0]].map((c) => { const l = absToRel(F(c)); return hueOf(l[1], l[2]); });
  const pairs = srcP.map((s, i) => [s, dstP[i]]).sort((a, b) => a[0] - b[0]);
  const hueMap = (h) => {
    for (let i = 0; i < pairs.length; i++) {
      const [s0, d0] = pairs[i], [s1r, d1r] = pairs[(i + 1) % pairs.length];
      const s1 = s1r + (i + 1 === pairs.length ? 360 : 0);
      const hh = h < s0 ? h + 360 : h;
      if (hh >= s0 && hh <= s1) {
        let d1 = d1r; while (d1 < d0) d1 += 360; if (d1 - d0 > 300) d1 -= 360;
        return ((d0 + ((hh - s0) / (s1 - s0 || 1)) * (d1 - d0)) % 360 + 360) % 360;
      }
    }
    return h;
  };
  // black point compensation, done on luminance (like LittleCMS): the deepest black maps to the
  // printer's deepest black and mid-tones barely move — scaling L* itself lifts every mid-tone
  // and washes the print out
  const LtoY = (L) => (L > 8 ? ((L + 16) / 116) ** 3 : L / 903.3);
  const YtoL = (Y) => (Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y);
  const Yb = LtoY(Lb);
  const Lscale = (L) => YtoL(Yb + LtoY(L) * (1 - Yb));

  return (lab0) => {
    let [L, a, b] = lab0;
    const Lp0 = Lscale(L);
    if (Math.hypot(a, b) < 0.5) return [Lp0, a, b];
    const h = hueOf(a, b);
    // colours outside sRGB (table corners no artwork reaches): pull them onto the sRGB edge,
    // toward the grey at the cusp's lightness, so the table stays smooth out there
    if (!srgbInGamut(L, a, b)) {
      const gL = cuspAt(srcCusp, h);
      let lo = 0, hi = 1;
      for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (srgbInGamut(L + (gL - L) * m, a * (1 - m), b * (1 - m))) hi = m; else lo = m; }
      L += (gL - L) * hi; a *= 1 - hi; b *= 1 - hi;
    }
    const C = Math.hypot(a, b);
    const Lp = Lscale(L);
    const Csrc = Math.max(1, srgbMaxC(L, h));
    const p = Math.min(1.15, C / Csrc); // how saturated, for its hue, on screen
    const w = smooth(0.25, 0.95, p);
    // turn toward the printer's own primary only near a screen primary, and only a little:
    // a whole-circle remap drags teals into blues and greens into teals
    let near = 0;
    for (const [s0] of pairs) { let d = Math.abs(h - s0); if (d > 180) d = 360 - d; near = Math.max(near, 1 - d / 15); }
    let dh = hueMap(h) - h; if (dh > 180) dh -= 360; if (dh < -180) dh += 360;
    dh = Math.max(-10, Math.min(10, dh));
    const sc = cuspAt(srcCusp, h);
    const nearCusp = Math.max(0, 1 - Math.abs(L - sc) / 25);
    const h2 = (h + w * nearCusp * Math.max(0, near) * dh + 360) % 360;
    // only colours near the screen's brightest-saturated point of their hue (pure yellow, pure green …)
    // move toward the printer's: a dark teal or a sky blue keeps its lightness
    const shift = Math.max(-15, Math.min(15, 0.7 * (cuspAt(dstCusp, h2) - Lscale(sc))));
    // azure / sky / teal blues: printer cyan is darker than a screen's, and darkening these to keep
    // their saturation turns a bright blue into royal blue — keep their lightness, give up a little
    // saturation instead (what people expect a "teal-ish" logo blue to look like)
    // (screen-pure azure and process cyan, at the very edge of sRGB, still go full-strength)
    const shiftL = shift < 0 ? shift * (1 - 0.8 * blueKeep(h) * (1 - smooth(0.94, 1, p))) : shift;
    let Lt = Math.max(Lb + 3, Lp + w * w * nearCusp * shiftL);
    const t = smooth(0.35, 0.95, p);
    // the printer can't reach this saturation at this exact hue: allow a small hue turn (up to 8°)
    // if it keeps clearly more of the colour — what a magenta-ink pink or a cyan-ink teal wants
    let h3 = h2;
    if (dstMaxC(Lt, h2) < C) {
      let bs = Math.min(C, dstMaxC(Lt, h2));
      for (let d = -8; d <= 8; d += 2) {
        if (!d) continue;
        const hh = (h2 + d + 360) % 360;
        const sc2 = Math.min(C, dstMaxC(Lt, hh)) - 0.6 * Math.abs(d);
        if (sc2 > bs) { bs = sc2; h3 = hh; }
      }
      let d3 = h3 - h2; if (d3 > 180) d3 -= 360; if (d3 < -180) d3 += 360;
      h3 = (h2 + t * d3 + 360) % 360;
    }
    const Cdst = dstMaxC(Lt, h3);
    // printer smaller than sRGB here: keep chroma as is up to 80% of the printer's reach and squeeze
    // only the rest in (a "knee"), so medium colours stay full. Printer bigger: stretch the most
    // saturated screen colours out to the printer's edge (screen yellow → solid yellow ink)
    const Csrc2 = Math.max(Csrc, C);
    let newC;
    if (Cdst < Csrc2) {
      const kn = 0.8 * Cdst;
      newC = C <= kn ? C : kn + ((C - kn) * (Cdst - kn)) / Math.max(1e-6, Csrc2 - kn);
    } else newC = C + t * nearCusp * (Math.min(p, 1) * Cdst - C);
    const r = (h3 * Math.PI) / 180;
    return [Lt, newC * Math.cos(r), newC * Math.sin(r)];
  };
}

const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * C, M, Y for a target colour with black fixed (damped Gauss-Newton, kept within the inks).
 * Errors are weighed in lightness / chroma / hue: when a colour is out of the printer's reach
 * (strong yellows, deep blues, purples) it keeps its hue first and its saturation second, and gives
 * up lightness before either — a plain "closest colour" fit makes those prints dull and flat.
 */
const W_L = 0.7, W_C = 1, W_H = 1.2;
function weigher(target) {
  const C = Math.hypot(target[1], target[2]);
  if (C < 6) return (r) => r; // near-neutral: plain distance
  const ux = target[1] / C, uy = target[2] / C;
  const f = Math.min(1, (C - 6) / 14); // fade in from greys to colours
  const bk = blueKeep(hueOf(target[1], target[2]));
  const wl = 1 + (W_L + (1.15 - W_L) * bk - 1) * f, wc = 1 + (W_C - 1) * f, wh = 1 + (W_H - 1) * f;
  return (r) => [wl * r[0], wc * (r[1] * ux + r[2] * uy), wh * (-r[1] * uy + r[2] * ux)];
}
const norm3 = (v) => Math.hypot(v[0], v[1], v[2]);

function solveCmy(F, target, K, start, tacLim) {
  const Wt = weigher(target);
  const resid = (lab) => Wt([target[0] - lab[0], target[1] - lab[1], target[2] - lab[2]]);
  let x = start.slice();
  let lam = 0.01;
  let cur = F([x[0], x[1], x[2], K]);
  let r = resid(cur);
  let err = norm3(r);
  for (let it = 0; it < 24 && err > 0.2; it++) {
    const J = [];
    const h = 0.01;
    for (let d = 0; d < 3; d++) {
      const xp = x.slice();
      xp[d] = x[d] + h > 1 ? x[d] - h : x[d] + h;
      const fp = F([xp[0], xp[1], xp[2], K]);
      const dx = xp[d] - x[d];
      // derivative of the weighted residual: -(W·dF)/dx
      const rd = resid(fp);
      J.push([(r[0] - rd[0]) / dx, (r[1] - rd[1]) / dx, (r[2] - rd[2]) / dx]);
    }
    // (JᵀJ + λI) δ = Jᵀ r
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], g = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) A[i][j] = J[i][0] * J[j][0] + J[i][1] * J[j][1] + J[i][2] * J[j][2];
      A[i][i] += lam * (1 + A[i][i]);
      g[i] = J[i][0] * r[0] + J[i][1] * r[1] + J[i][2] * r[2];
    }
    const dlt = solve3(A, g);
    let nx = x.map((v, i) => Math.max(0, Math.min(1, v + dlt[i])));
    const sum = nx[0] + nx[1] + nx[2] + K;
    if (sum > tacLim) { const f = Math.max(0, tacLim - K) / (nx[0] + nx[1] + nx[2] || 1); nx = nx.map((v) => v * f); }
    const nf = F([nx[0], nx[1], nx[2], K]);
    const nr = resid(nf);
    const ne = norm3(nr);
    if (ne < err) { x = nx; cur = nf; r = nr; err = ne; lam = Math.max(1e-4, lam * 0.3); }
    else { lam *= 4; if (lam > 1e4) break; }
  }
  return { x, err: dE(cur, target), werr: err };
}
function solve3(A, b) {
  const [[a, bb, c], [d, e, f], [g, h, i]] = A;
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g) || 1e-12;
  return [
    (b[0] * (e * i - f * h) - bb * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det,
    (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det,
    (a * (e * b[2] - b[1] * h) - bb * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det,
  ];
}

// legacy (v2) 16-bit Lab encoding used by lut16 tables
function encLab([L, a, b]) {
  return [
    Math.round(Math.max(0, Math.min(65535, (L * 65280) / 100))),
    Math.round(Math.max(0, Math.min(65535, (a + 128) * 256))),
    Math.round(Math.max(0, Math.min(65535, (b + 128) * 256))),
  ];
}
function decLab([L, a, b]) { return [(L * 100) / 65280, a / 256 - 128, b / 256 - 128]; }

// ---------------------------------------------------------------- ICC writer (v2.4, output class)
function writeIcc({ name, A2B, B2A, N, paperXyz, source = 'measurements' }) {
  const tags = [];
  const s15 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(Math.round(v * 65536)); return b; };
  const xyzTag = (x) => Buffer.concat([Buffer.from('XYZ \0\0\0\0', 'latin1'), s15(x[0]), s15(x[1]), s15(x[2])]);
  const textDesc = (t) => {
    const a = Buffer.from(`${t}\0`, 'latin1');
    const b = Buffer.alloc(12 + a.length + 12 + 67);
    b.write('desc', 0, 'latin1');
    b.writeUInt32BE(a.length, 8);
    a.copy(b, 12);
    return b; // unicode count 0, scriptcode count 0 (zeros)
  };
  const text = (t) => Buffer.concat([Buffer.from('text\0\0\0\0', 'latin1'), Buffer.from(`${t}\0`, 'latin1')]);
  const mft2 = (inCh, outCh, g, clut) => {
    const head = Buffer.alloc(52);
    head.write('mft2', 0, 'latin1');
    head[8] = inCh; head[9] = outCh; head[10] = g;
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => head.writeInt32BE(v * 65536, 12 + i * 4));
    head.writeUInt16BE(2, 48); head.writeUInt16BE(2, 50);
    const lin = (n) => { const b = Buffer.alloc(n * 4); for (let i = 0; i < n; i++) { b.writeUInt16BE(0, i * 4); b.writeUInt16BE(65535, i * 4 + 2); } return b; };
    const cl = Buffer.alloc(clut.length * 2);
    for (let i = 0; i < clut.length; i++) cl.writeUInt16BE(clut[i], i * 2);
    return Buffer.concat([head, lin(inCh), cl, lin(outCh)]);
  };
  const a2b = mft2(4, 3, G, A2B), b2a = mft2(3, 4, N, B2A);
  tags.push(['desc', textDesc(name)], ['cprt', text(`Made with InkRIP from ${source}`)], ['wtpt', xyzTag(paperXyz)],
    ['A2B0', a2b], ['A2B1', a2b], ['A2B2', a2b], ['B2A0', b2a], ['B2A1', b2a], ['B2A2', b2a]);
  // layout: header 128, tag count + table, then data (4-byte aligned); identical tables shared
  const count = tags.length;
  let off = 128 + 4 + count * 12;
  const table = Buffer.alloc(4 + count * 12);
  table.writeUInt32BE(count, 0);
  const datas = [];
  const seen = new Map();
  tags.forEach(([sig, data], i) => {
    let at = seen.get(data);
    if (at === undefined) {
      off = (off + 3) & ~3;
      at = off;
      datas.push({ at, data });
      seen.set(data, at);
      off += data.length;
    }
    table.write(sig, 4 + i * 12, 'latin1');
    table.writeUInt32BE(at, 8 + i * 12);
    table.writeUInt32BE(data.length, 12 + i * 12);
  });
  const total = (off + 3) & ~3;
  const out = Buffer.alloc(total);
  const h = out;
  h.writeUInt32BE(total, 0);
  h.write('lcms', 4, 'latin1');
  h.writeUInt32BE(0x02400000, 8);
  h.write('prtr', 12, 'latin1');
  h.write('CMYK', 16, 'latin1');
  h.write('Lab ', 20, 'latin1');
  const d = new Date();
  [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].forEach((v, i) => h.writeUInt16BE(v, 24 + i * 2));
  h.write('acsp', 36, 'latin1');
  h.writeUInt32BE(0, 64); // perceptual
  h.writeInt32BE(Math.round(0.9642 * 65536), 68); h.writeInt32BE(65536, 72); h.writeInt32BE(Math.round(0.8249 * 65536), 76);
  table.copy(out, 128);
  for (const { at, data } of datas) data.copy(out, at);
  return out;
}

module.exports = { parseCgats, predictionError, readingCheck, makeProfile, blueKeep, makeGamutMap };
