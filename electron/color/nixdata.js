// Ported unchanged from InkRIP (theinkstopprinting-ui/inkrip, server/nixchart.js — minus the TIFF chart; InkSign prints a PDF chart, see chart.js) so InkSign builds
// printer profiles exactly the way InkRIP does for the DTF printers.
const { xyzToLab } = require('./iccengine');
// Printer profile from a Nix Mini (or any colour meter that gives Lab / hex readings).
//
//   1. chartPatches(n)  — n CMYK patches (100–400) that cover the printer: every ink's ramp, the
//      two- and three-ink overprints, then the rest spread as evenly as possible through CMYK
//   2. chartTiff()      — the printable chart: big numbered patches (the Nix Mini needs 13 mm or
//      more; these are 19 mm), printed straight through the print mode with no colour profile
//   3. parseReadings()  — the readings from the Nix app (CSV export, or pasted lines), in patch
//      order or by patch number, as CIELAB (D50 or D65) or as hex / sRGB
//   4. the samples go to the same profile maker the i1Pro measurements use (profilemaker.js)

const NIX = {
  patch: 0.75, // inch (19 mm) — Nix Mini needs 13 mm, the rest is room to aim on fabric
  gap: 0.12,
  label: 0.22, // number strip above each patch
  margin: 0.3,
  dpi: 150,
  maxWidthIn: 21.5, // fits a 22"/24" roll; narrower media just gets more rows
  counts: [100, 150, 200, 300, 400],
};

const r2 = (v) => Math.round(v * 100) / 100;

/** The CMYK patches (0..1), most important first. */
function chartPatches(n = 200) {
  n = Math.max(60, Math.min(400, Math.round(Number(n) || 200)));
  const out = [];
  const key = (p) => p.map((v) => Math.round(v * 100)).join(',');
  const seen = new Set();
  const add = (p) => { const k = key(p); if (!seen.has(k)) { seen.add(k); out.push(p.map(r2)); } };

  // must-haves: film white, every ink's ramp, the overprints that set the gamut's corners
  add([0, 0, 0, 0]);
  const ramp = [0.05, 0.1, 0.2, 0.3, 0.4, 0.55, 0.7, 0.85, 1];
  for (const v of ramp) for (let ch = 0; ch < 4; ch++) { const p = [0, 0, 0, 0]; p[ch] = v; add(p); }
  for (const v of [0.4, 0.7, 1]) { add([v, v, 0, 0]); add([v, 0, v, 0]); add([0, v, v, 0]); }
  for (const [a, b] of [[1, 0.5], [0.5, 1]]) { add([a, b, 0, 0]); add([a, 0, b, 0]); add([0, a, b, 0]); }
  // greys built from C+M+Y, with and without black
  for (const v of [0.15, 0.3, 0.5, 0.7, 0.9]) add([v, v * 0.8, v * 0.8, 0]);
  for (const k of [0.3, 0.6]) add([0.5, 0.4, 0.4, k]);
  add([0.8, 0.7, 0.7, 1]);

  // the rest: farthest-point spread over a CMY grid (with a few black levels), inside the ink limit
  const lv = [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1];
  const cand = [];
  for (const k of [0, 0.25, 0.5, 0.75]) for (const c of lv) for (const m of lv) for (const y of lv) {
    if (c + m + y + k > 3.0 + 1e-9) continue;
    if (k >= 0.5 && c + m + y > 1.6) continue; // dark corners are all near-black anyway
    cand.push([c, m, y, k]);
  }
  // distance: black counts more (it changes colour the most), colour away from white matters less
  const dist = (a, b) => {
    const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 + 2.2 * (a[3] - b[3]) ** 2;
    return d;
  };
  const best = cand.map((c) => Math.min(...out.map((o) => dist(c, o))));
  while (out.length < n) {
    let bi = -1, bv = -1;
    for (let i = 0; i < cand.length; i++) if (best[i] > bv) { bv = best[i]; bi = i; }
    if (bi < 0 || bv <= 1e-9) break;
    const p = cand[bi];
    add(p);
    for (let i = 0; i < cand.length; i++) { const d = dist(cand[i], p); if (d < best[i]) best[i] = d; }
  }
  return out.slice(0, n);
}

// ---------------------------------------------------------------- top-up chart (v1.7.6)
// 100 extra patches in the colours a DTF printer finds hardest and an even chart covers thinly:
// blues / azures / teals, greens, purples and royal blues, oranges and reds, and dark colours with
// black. Measured once and added to the readings a profile was made from, the profile is rebuilt
// with real measurements where it used to guess. Patch 1 is no ink (the white of the print).
const TOPUP = { n: 100, code: 'NIX-TOP100-v1' };
const steps = (a, b, st) => { const o = []; for (let v = a; v <= b + 1e-9; v += st) o.push(Math.round(v * 100) / 100); return o; };
function topupPatches() {
  const out = [[0, 0, 0, 0]];
  const taken = chartPatches(200).map((p) => p.slice()); // what the main chart already measured
  const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 + 2.2 * (a[3] - b[3]) ** 2;
  const grid = (C, M, Y, K) => { const o = []; for (const c of C) for (const m of M) for (const y of Y) for (const k of K) o.push([c, m, y, k]); return o; };
  // farthest-point picks inside one colour family, kept away from everything measured or picked so far
  const pick = (cand, n) => {
    const best = cand.map((c) => Math.min(...[...taken, ...out].map((o) => dist(c, o))));
    for (let added = 0; added < n; added++) {
      let bi = -1, bv = -1;
      for (let i = 0; i < cand.length; i++) if (best[i] > bv) { bv = best[i]; bi = i; }
      if (bi < 0 || bv <= 1e-6) break;
      const p = cand[bi];
      out.push(p.slice());
      for (let i = 0; i < cand.length; i++) { const d = dist(cand[i], p); if (d < best[i]) best[i] = d; }
    }
  };
  // blues and azures: cyan with a little magenta (logo blues live here)
  pick(grid(steps(0.3, 1, 0.05), steps(0, 0.45, 0.05), [0, 0.05, 0.1], [0]), 24);
  // teals and turquoise: cyan with some yellow
  pick(grid(steps(0.4, 1, 0.05), [0, 0.05, 0.1], steps(0.1, 0.5, 0.05), [0]), 10);
  // greens: cyan + yellow, from lime to deep green
  pick(grid(steps(0.15, 1, 0.05), [0, 0.05, 0.1], steps(0.4, 1, 0.05), [0]), 20);
  // purples and royal blues: cyan + magenta
  pick(grid(steps(0.35, 1, 0.05), steps(0.45, 1, 0.05), [0, 0.05], [0]), 15);
  // oranges and reds: magenta + yellow
  pick(grid([0, 0.05], steps(0.2, 1, 0.05), steps(0.5, 1, 0.05), [0]), 15);
  // dark colours with black: navy, forest, maroon, brown
  pick(grid(steps(0.7, 1, 0.1), steps(0.3, 0.7, 0.1), [0, 0.1, 0.2], [0.2, 0.4]), 4);
  pick(grid(steps(0.6, 1, 0.1), [0.1, 0.3], steps(0.6, 1, 0.1), [0.2, 0.4]), 4);
  pick(grid([0, 0.1, 0.2], steps(0.7, 1, 0.1), steps(0.5, 1, 0.1), [0.2, 0.4]), 4);
  pick(grid([0.2, 0.3, 0.4], [0.4, 0.5, 0.6], steps(0.6, 1, 0.1), [0.2, 0.4]), 3);
  return out.slice(0, TOPUP.n).map((p) => p.map(r2));
}



/** Short code printed on the chart, so readings can be checked against the right patch list. */
function chartCode(n) { return `NIX-${n}-v1`; }

// ---------------------------------------------------------------- readings
const D65 = [0.95047, 1, 1.08883];
const D50 = [0.9642, 1, 0.8249];
// Bradford D65 -> D50
const BRAD = [
  [1.0478112, 0.0228866, -0.050127],
  [0.0295424, 0.9904844, -0.0170491],
  [-0.0092345, 0.0150436, 0.7521316],
];
function labToXyzWp([L, a, b], wp) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  return [inv(fx) * wp[0], inv(fy) * wp[1], inv(fz) * wp[2]];
}
const mul = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
/** Lab measured under D65 → Lab D50 (what ICC profiles use). */
function labD65toD50(lab) { return xyzToLab(mul(BRAD, labToXyzWp(lab, D65))); }
/** sRGB (0..255) → Lab D50. */
function srgbHexToLab(r, g, b) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  // sRGB → XYZ D50 (Bradford-adapted matrix)
  const X = 0.4360747 * R + 0.3850649 * G + 0.1430804 * B;
  const Y = 0.2225045 * R + 0.7168786 * G + 0.0606169 * B;
  const Z = 0.0139322 * R + 0.0971045 * G + 0.7141733 * B;
  return xyzToLab([X, Y, Z]);
}

/**
 * Readings from the Nix app. Accepts:
 *  - a CSV export with L / a / b columns (any header spelling with L*, a*, b*, "CIELAB L" …),
 *    optionally a name/number column ("1", "Patch 12", "#12") to match patches
 *  - a CSV with only hex or sRGB columns (less accurate)
 *  - pasted lines: "L a b", "12: L a b", "#F9C602", "12 #F9C602"
 * Several readings of the same patch are averaged.
 * @returns {{ readings: Map<number, number[]>, used: string, count: number, notes: string[] }}
 */
function parseReadings(text, { illuminant = 'D50', patchCount = 0 } = {}) {
  const notes = [];
  const lines = String(text || '').replace(/^﻿/, '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error('No readings — paste them or choose the file the Nix app exported.');
  // CSV cells, keeping empty ones (so columns stay lined up); the delimiter is guessed per file
  const lines0 = lines.filter((l) => !/^sep=/i.test(l));
  const delim = [';', '\t', ','].map((d) => [d, lines0.slice(0, 20).reduce((n, l) => n + (l.split(d).length - 1), 0)]).sort((x, y) => y[1] - x[1])[0][1] > 0
    ? [';', '\t', ','].map((d) => [d, lines0.slice(0, 20).reduce((n, l) => n + (l.split(d).length - 1), 0)]).sort((x, y) => y[1] - x[1])[0][0] : ',';
  const split = (l) => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const isNum = (s) => /^[-+]?\d+([.,]\d+)?(e[-+]?\d+)?$/i.test(String(s).trim());
  const num = (s) => Number(String(s).trim().replace(',', '.'));
  const hexRe = /#?\b([0-9a-f]{6})\b/i;
  const fromD65 = illuminant === 'D65';
  const toLab = (lab) => (fromD65 ? labD65toD50(lab) : lab);

  const acc = new Map();
  let seq = 0;
  let used = '';
  const put = (idx, lab) => {
    if (!lab.every(Number.isFinite) || lab[0] < 0 || lab[0] > 105) return;
    if (!acc.has(idx)) acc.set(idx, []);
    acc.get(idx).push(lab);
  };
  const patchNo = (s) => { const m = String(s || '').match(/(\d+)/); return m ? Number(m[1]) : null; };

  // CSV with a header row? Exports (the Nix app's included) can have a few lines of export details
  // first — the header is the first line with L / a / b (or hex) column names
  const isLabHead = (cells) => { const c = cells.map((h) => h.toLowerCase().replace(/[*\s]/g, '')); return ['l', 'a', 'b'].every((k) => c.includes(k)) || c.some((h) => /^cielab/.test(h)); };
  let hi = lines0.slice(0, 25).findIndex((l) => isLabHead(split(l)));
  if (hi < 0) hi = 0;
  const head = split(lines0[hi] || '').map((h) => h.toLowerCase());
  const hasHeader = head.some((h) => /[a-z]/.test(h) && !hexRe.test(h)) && !head.every(isNum);
  if (hasHeader && lines0.length > hi + 1) {
    const find = (re) => head.findIndex((h) => re.test(h));
    const exact = (k) => head.findIndex((h) => h.replace(/[*\s]/g, '') === k);
    let iL = exact('l'), iA = exact('a'), iB = exact('b');
    if (iL < 0 || iA < 0 || iB < 0) {
      iL = find(/(^|[^a-z])l\*?($|[^a-z])|lab.?l\b|cielab.?l|^l\s*\(/); iA = find(/(^|[^a-z])a\*?($|[^a-z])|lab.?a\b|cielab.?a|^a\s*\(/); iB = find(/(^|[^a-z])b\*?($|[^a-z])|lab.?b\b|cielab.?b|^b\s*\(/);
    }
    if ([iL, iA, iB].some((i) => i < 0) || new Set([iL, iA, iB]).size < 3) iL = iA = iB = -1;
    const iHex = find(/hex|html|^#/);
    const iR = find(/^(srgb.?)?r(ed)?$/), iG = find(/^(srgb.?)?g(reen)?$/), iBl = find(/^(srgb.?)?b(lue)?$/);
    // the patch number: a "User Color Name" (Nix) or patch / sample / number column, else any name column
    let iName = find(/user.?colou?r.?name/);
    if (iName < 0) iName = find(/^(patch|sample|label|id|number|no\.?|#|patch.?(no|number|#))$/);
    if (iName < 0) iName = find(/name|patch|sample|label|number/);
    const illCol = find(/illuminant|light/);
    for (const l of lines0.slice(hi + 1)) {
      const c = split(l);
      if (c.filter(Boolean).length < 3) continue;
      const idx = iName >= 0 && patchNo(c[iName]) ? patchNo(c[iName]) : ++seq;
      if (iL >= 0) {
        let lab = [num(c[iL]), num(c[iA]), num(c[iB])];
        const ill = illCol >= 0 ? String(c[illCol] || '') : '';
        lab = /d65/i.test(ill) ? labD65toD50(lab) : /d50/i.test(ill) ? lab : toLab(lab);
        put(idx, lab); used = 'Lab';
      } else if (iHex >= 0 && hexRe.test(c[iHex] || '')) {
        const h = c[iHex].match(hexRe)[1];
        put(idx, srgbHexToLab(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16))); used = used || 'hex';
      } else if (iR >= 0 && iG >= 0 && iBl >= 0) {
        put(idx, srgbHexToLab(num(c[iR]), num(c[iG]), num(c[iBl]))); used = used || 'hex';
      }
    }
    if (!acc.size) throw new Error("Couldn't find CIELAB (L, a, b) or hex columns in that file. Export with CIELAB values, or paste the readings.");
  } else {
    // pasted lines
    for (const l of lines0) {
      const hex = l.match(hexRe);
      const nums = (l.replace(hexRe, ' ').match(/[-+]?\d+(?:[.,]\d+)?/g) || []).map(num);
      // "12: L a b", "12) …", "#12 …", or 4 numbers on a line = patch number first
      const explicit = /^\s*#?\d+\s*[:)]/.test(l) || /^\s*#\d+\s/.test(l) || (hex && nums.length === 1) || nums.length === 4;
      const idx = explicit ? nums.shift() : ++seq;
      if (explicit) seq = Math.max(seq, idx);
      if (hex && !(nums.length >= 3)) {
        const h = hex[1];
        put(idx, srgbHexToLab(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16))); used = used || 'hex';
      } else if (nums.length >= 3) { put(idx, toLab(nums.slice(0, 3))); used = 'Lab'; }
    }
    if (!acc.size) throw new Error('No readings found. Each line should be "L a b" (e.g. 52.3 -12.1 40.8) or a hex colour.');
  }
  const readings = new Map();
  const conflicts = [];
  for (const [i, arr] of acc) {
    // two scans saved under one number that disagree: one of them belongs to another patch — leave it out
    if (arr.length > 1) {
      let worst = 0;
      for (const a of arr) for (const c of arr) worst = Math.max(worst, Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]));
      if (worst > 6) { conflicts.push(i); continue; }
    }
    readings.set(i, [0, 1, 2].map((k) => arr.reduce((s, v) => s + v[k], 0) / arr.length));
  }
  if (conflicts.length) notes.push(`Patch${conflicts.length > 1 ? 'es' : ''} ${conflicts.join(', ')} ${conflicts.length > 1 ? 'have' : 'has'} two different readings saved under the same number — left out; re-scan ${conflicts.length > 1 ? 'them' : 'it'} (one scan may have been meant for another patch).`);
  if (used === 'hex') notes.push('Readings are hex/sRGB only — the profile will be less accurate than with CIELAB readings. In the Nix app, export or copy CIELAB values if you can.');
  if (patchCount) {
    const missing = [];
    for (let i = 1; i <= patchCount; i++) if (!readings.has(i)) missing.push(i);
    const extra = [...readings.keys()].filter((i) => i < 1 || i > patchCount);
    if (extra.length) notes.push(`${extra.length} reading(s) don't match a patch number (1–${patchCount}) and were ignored.`);
    for (const i of extra) readings.delete(i);
    if (missing.length) notes.push(`${missing.length} patch(es) have no reading${missing.length <= 12 ? `: ${missing.join(', ')}` : ''}.`);
  }
  return { readings, used, count: readings.size, notes };
}

/** Patches + readings → samples for makeProfile, with a check that the readings line up. */
function samplesFromReadings(patches, readings, expect = null) {
  const samples = [];
  for (let i = 0; i < patches.length; i++) {
    const lab = readings.get(i + 1);
    if (lab) samples.push({ cmyk: patches[i], lab, n: i + 1 });
  }
  if (samples.length < Math.min(80, patches.length * 0.8)) throw new Error(`Only ${samples.length} of ${patches.length} patches have readings — measure the whole chart.`);
  // sanity: the white patch must be the lightest, more ink must not get lighter (catches skipped / swapped readings)
  const problems = [];
  const white = samples.find((s) => s.n === 1);
  if (white && samples.some((s) => s.lab[0] > white.lab[0] + 3)) problems.push('Patch 1 (no ink) should be the lightest reading — check the readings start at patch 1.');
  for (let ch = 0; ch < 4; ch++) {
    const ramp = samples.filter((s) => s.cmyk.every((v, k) => (k === ch ? true : v === 0)) && s.cmyk[ch] > 0).sort((a, b) => a.cmyk[ch] - b.cmyk[ch]);
    // more ink should move further from the white of the print (yellow barely darkens, it gets more yellow)
    const base = white ? white.lab : [95, 0, 0];
    const far = (l) => Math.hypot(l[0] - base[0], l[1] - base[1], l[2] - base[2]);
    let bad = 0;
    for (let i = 1; i < ramp.length; i++) if (far(ramp[i].lab) < far(ramp[i - 1].lab) - 6) bad++;
    if (bad >= 2) problems.push(`The ${'CMYK'[ch]} ramp doesn't build up steadily — a reading may be missing or out of order (patches ${ramp.map((s) => s.n).join(', ')}).`);
  }
  // the same reading saved under two numbers: the Nix stayed on one patch
  const byN = new Map(samples.map((x) => [x.n, x.lab]));
  for (const x of samples) {
    const prev = byN.get(x.n - 1);
    if (prev && Math.hypot(prev[0] - x.lab[0], prev[1] - x.lab[1], prev[2] - x.lab[2]) < 0.05 && Math.hypot(...patches[x.n - 1].map((v, k) => v - patches[x.n - 2][k])) > 0.05) {
      problems.push(`Patch ${x.n} reads exactly like patch ${x.n - 1} — probably scanned twice without moving. It's left out; re-scan patch ${x.n}.`);
      x.doubled = true;
    }
  }
  for (let i = samples.length - 1; i >= 0; i--) if (samples[i].doubled) samples.splice(i, 1);
  // do the readings line up with the chart? Compare each to what a typical DTF printer gives for that
  // patch: a skipped or doubled scan shifts every later reading and shows up as a run of misfits
  if (expect) {
    const bad = samples.map((x) => { const e = expect(x.cmyk); return Math.hypot(e[0] - x.lab[0], (e[1] - x.lab[1]) * 0.6, (e[2] - x.lab[2]) * 0.6) > 28; });
    const nBad = bad.filter(Boolean).length;
    if (nBad > Math.max(8, samples.length * 0.12)) {
      let at = bad.findIndex((v, i) => v && bad.slice(i, i + 6).filter(Boolean).length >= 4);
      if (at < 0) at = bad.indexOf(true);
      problems.push(`${nBad} readings don't look like their patch${at >= 0 ? ` — starting around patch ${samples[at].n}` : ''}. A scan may be skipped or doubled there, or the chart was printed with a different patch count.`);
    }
  }
  return { samples, problems };
}

// ---------------------------------------------------------------- linearising from the chart
const CURVE_X = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1];
const curveAt = (pts, x) => {
  const ys = Array.isArray(pts) && pts.length === CURVE_X.length ? pts : CURVE_X;
  let k = 0; while (k < CURVE_X.length - 2 && x > CURVE_X[k + 1]) k++;
  const t = (x - CURVE_X[k]) / (CURVE_X[k + 1] - CURVE_X[k]);
  return ys[k] + (ys[k + 1] - ys[k]) * Math.max(0, Math.min(1, t));
};

/**
 * New ink curves from the chart's single-ink ramps (0, 5 … 100 % of each ink, measured).
 * The chart was printed through the print mode's curves, so the measured strength is a function of
 * the chart value. For each ink: strength = distance from the white of the print; where it stops
 * growing (96 % of its best) is the most ink worth printing; the new curve spreads 0–100 % evenly
 * over that range, so every 10 % step adds about the same amount of colour and no ink is wasted.
 * @returns {{ curves, inks: { [ink]: { fullAt, before, strength } } }}
 */
function lineariseFromSamples(samples, oldCurves = {}) {
  const white = samples.find((s) => s.cmyk.every((v) => v === 0));
  if (!white) throw new Error('Patch 1 (no ink) has no reading — it is needed to linearise.');
  const far = (l) => Math.hypot(l[0] - white.lab[0], l[1] - white.lab[1], l[2] - white.lab[2]);
  const curves = { ...oldCurves };
  const inks = {};
  ['C', 'M', 'Y', 'K'].forEach((ink, ch) => {
    const pts = [[0, 0]];
    for (const s of samples) if (s.cmyk[ch] > 0 && s.cmyk.every((v, k) => (k === ch ? true : v === 0))) pts.push([s.cmyk[ch], far(s.lab)]);
    pts.sort((a, b) => a[0] - b[0]);
    if (pts.length < 6) throw new Error(`Not enough ${ink} readings to linearise (need the ${ink} ramp patches).`);
    // a measured ramp is a little noisy: keep it rising (running maximum), lightly smoothed
    const ys = pts.map((p) => p[1]);
    const sm = ys.map((y, i) => (i === 0 || i === ys.length - 1 ? y : (ys[i - 1] + 2 * y + ys[i + 1]) / 4));
    let m = 0; const mono = sm.map((y) => (m = Math.max(m, y)));
    const top = mono[mono.length - 1];
    const goal = 0.96 * top;
    // chart value where it reaches 96 % of its best
    let cFull = 1;
    for (let i = 1; i < pts.length; i++) if (mono[i] >= goal) { const t = (goal - mono[i - 1]) / Math.max(1e-6, mono[i] - mono[i - 1]); cFull = pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]); break; }
    // inverse: strength → chart value (piecewise linear over the monotone ramp)
    const inv = (target) => {
      for (let i = 1; i < pts.length; i++) if (mono[i] >= target - 1e-9) { const d = mono[i] - mono[i - 1]; const t = d > 1e-6 ? (target - mono[i - 1]) / d : 1; return pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]); }
      return 1;
    };
    const strengthFull = goal;
    const old = oldCurves[ink];
    const ysNew = CURVE_X.map((x) => (x === 0 ? 0 : Math.round(curveAt(old, Math.min(cFull, inv(x * strengthFull))) * 10000) / 10000));
    for (let i = 1; i < ysNew.length; i++) ysNew[i] = Math.max(ysNew[i], ysNew[i - 1]); // never decreasing
    curves[ink] = ysNew;
    inks[ink] = {
      fullAt: Math.round(cFull * 100), // % of the old print mode's ink where it is already full strength
      inkAtFull: Math.round(curveAt(old, cFull) * 100), // ink output there (after the old curve)
      strength: Math.round(top),
    };
  });
  return { curves, inks };
}

module.exports = { NIX, chartPatches, TOPUP, topupPatches, chartCode, labD65toD50, srgbHexToLab, parseReadings, samplesFromReadings, lineariseFromSamples };
