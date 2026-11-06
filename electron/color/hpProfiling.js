// Profile maker for the HP Latex printers — the same system as the Xerox one and InkRIP's
// (Nix Mini readings → InkRIP's profile maker), but each profile belongs to an HP media preset and
// print mode, the way HP / Flexi profiles do:
//   1. print a chart (100–400 patches) on the loaded roll, in the media preset and print mode being
//      profiled, with colour management OFF (the CMYK numbers go to the printer untouched)
//   2. read it with the Nix (USB, or the Nix app's CSV export)
//   3. check the readings
//   4. build the ICC profile; it's used automatically ("Auto" profile) for that media + print mode
//   5. later: a 100-patch top-up chart of hard colours, added and rebuilt in place
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const nix = require('./nixdata');
const chart = require('./chart');
const { readingCheck, predictionError } = require('./profilemaker');

const DEFAULT_TAC = 300; // HP Latex on vinyl / banner: about 280–320 % total in CMYK
let ctx = null; // { store, gs, queue, drivers, profilesDir }
const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const profilesDir = () => { fs.mkdirSync(ctx.profilesDir(), { recursive: true }); return ctx.profilesDir(); };
const readingsFile = (id) => path.join(profilesDir(), `${String(id).replace(/[^\w-]/g, '')}.readings.json`);
const loadReadings = (id) => { try { return JSON.parse(fs.readFileSync(readingsFile(id), 'utf8')); } catch { return null; } };
const count = (v) => { const n = Math.round(Number(v) || 200); if (n < 60 || n > 400) throw new Error('Patches must be 60 to 400.'); return n; };
const patchesFor = (kind, n) => (kind === 'topup' ? nix.topupPatches() : nix.chartPatches(count(n)));
const codeFor = (kind, n) => (kind === 'topup' ? nix.TOPUP.code : nix.chartCode(count(n)));
const cleanName = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 80);

const expectCache = new Map();
async function expectFor(kind, n) {
  const key = codeFor(kind, n);
  if (!expectCache.has(key)) {
    const patches = patchesFor(kind, n);
    expectCache.set(key, chart.expectFn(patches, await chart.expectedLabs(ctx.gs, patches)));
  }
  return expectCache.get(key);
}

function hpDevice(deviceId) {
  const d = ctx.store.getDevice(deviceId);
  if (!d || d.driver !== 'hp-latex') throw new Error('Pick an HP Latex printer');
  return d;
}
// Media + print mode, by the printer's own lists
function mediaMode(d, mediaId, modeKey) {
  const M = require('../lib/hpMedia');
  const media = M.findMedia(M.listMedia(d.config.host), mediaId || d.config.mediaId);
  const mode = media.modes.find((m) => M.modeKey(m) === modeKey)
    || media.modes.find((m) => m.passes === 8 && m.inkDensity === 'L10' && m.efficiency) || media.modes.find((m) => m.passes === 6) || media.modes[0];
  return { media, mode, modeKey: M.modeKey(mode), modeLabel: M.modeLabel(mode) };
}

/** The chart as one long page across the roll (up to 24" wide), so it prints in one piece */
async function chartForRoll(patches, { widthIn = 24, code, title, quality }) {
  const X = chart.XC;
  const wIn = Math.max(8, Math.min(24, widthIn));
  const cell = X.patch + X.gap;
  const cols = Math.max(3, Math.floor((wIn - 2 * X.margin + X.gap) / cell));
  const rows = Math.ceil(patches.length / cols);
  const hIn = 2 * X.margin + X.title + rows * (X.label + X.patch + X.gap) + 0.1;
  return chart.chartPdf(patches, { paper: { name: 'Roll', w: wIn * 72, h: hIn * 72 }, code, title, quality });
}

async function printChart({ deviceId, mediaId, modeKey, kind = 'main', patches: n = 200, profileId, widthIn } = {}) {
  let rec = null;
  if (kind === 'topup') {
    rec = loadReadings(profileId);
    if (!rec?.sets || !rec.hp) throw new Error('That profile has no saved HP readings — only profiles made in the HP profile maker can be topped up here.');
    deviceId = deviceId || rec.hp.deviceId; mediaId = rec.hp.mediaId; modeKey = rec.hp.modeKey;
  }
  const d = hpDevice(deviceId);
  const mm = mediaMode(d, mediaId, modeKey);
  const patches = patchesFor(kind, n);
  const code = codeFor(kind, patches.length);
  const roll = Number(widthIn) || Number(d.config.rollWidthIn) || 24;
  const c = await chartForRoll(patches, {
    widthIn: Math.min(24, roll - 1), code, quality: `${mm.media.name}, ${mm.modeLabel}`,
    title: kind === 'topup' ? 'InkSign HP Latex TOP-UP chart' : 'InkSign HP Latex profile chart',
  });
  const dir = path.join(path.dirname(profilesDir()), 'charts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${code}-${Date.now()}.pdf`);
  fs.writeFileSync(file, c.pdf);
  const job = ctx.queue.add({
    deviceId: d.id, action: 'file', filePath: file,
    name: `${kind === 'topup' ? 'Top-up chart' : 'Profile chart'} – ${mm.media.name}, ${mm.modeLabel} (${patches.length})`,
    // colour management OFF: the chart's CMYK numbers go to the printer as they are
    options: { icc: 'none', intent: 1, mediaId: mm.media.id, modeKey: mm.modeKey, orientation: 'across', removeCut: true },
  });
  return { job, pages: c.pages, patches: patches.length, code, media: mm.media.name, mode: mm.modeLabel };
}

function readFrom(b, kind, n) {
  const patches = patchesFor(kind, n);
  const r = nix.parseReadings(String(b?.text || ''), { illuminant: b?.illuminant === 'D65' ? 'D65' : 'D50', patchCount: patches.length });
  return { patches, r };
}

async function check(b = {}) {
  const kind = b.kind === 'topup' ? 'topup' : 'main';
  const n = kind === 'topup' ? nix.TOPUP.n : count(b.patches);
  const { patches, r } = readFrom(b, kind, n);
  const { samples, problems } = nix.samplesFromReadings(patches, r.readings, await expectFor(kind, n));
  const missing = [];
  for (let i = 1; i <= patches.length; i++) if (!samples.some((x) => x.n === i)) missing.push(i);
  let rescan, before = null;
  if (kind === 'topup') {
    const rec = loadReadings(b.profileId);
    if (!rec?.sets) throw new Error('That profile has no saved readings.');
    const base = Object.entries(rec.sets).filter(([k]) => k !== nix.TOPUP.code).flatMap(([, v]) => v);
    rescan = readingCheck([...base.map((x) => ({ ...x, n: -1 })), ...samples], 12).filter((x) => x.patch > 0).slice(0, 20);
    before = predictionError(base, samples.filter((x) => x.n > 1));
  } else rescan = readingCheck(samples, 12).slice(0, 20);
  return { patches: patches.length, readings: samples.length, used: r.used, notes: r.notes, problems, rescan, missing, before };
}

function runBuild(samples, opts) {
  return new Promise((resolve, reject) => {
    const w = new Worker(unpacked(path.join(__dirname, 'buildWorker.js')), { workerData: { profilemaker: unpacked(path.join(__dirname, 'profilemaker.js')) } });
    const t = setTimeout(() => { w.terminate(); reject(new Error('Building the profile took too long')); }, 5 * 60 * 1000);
    w.once('message', (m) => { clearTimeout(t); w.terminate(); if (m.ok) resolve({ ...m, icc: Buffer.from(m.icc) }); else reject(new Error(m.error)); });
    w.once('error', (e) => { clearTimeout(t); reject(e); });
    w.postMessage({ samples, opts });
  });
}

async function build(b = {}) {
  const d = hpDevice(b.deviceId);
  const mm = mediaMode(d, b.mediaId, b.modeKey);
  const n = count(b.patches);
  const { patches, r } = readFrom(b, 'main', n);
  const { samples, problems } = nix.samplesFromReadings(patches, r.readings, await expectFor('main', n));
  const model = d.config.model === 'hp-latex-115' ? 'HP Latex 115' : 'HP Latex 335';
  const name = cleanName(b.name) || cleanName(`${model} – ${mm.media.name} ${mm.modeLabel}`);
  const tac = Math.max(150, Math.min(400, Number(b.tac) || DEFAULT_TAC));
  const gcr = ['light', 'medium', 'heavy'].includes(b.gcr) ? b.gcr : 'medium';
  const p = await runBuild(samples, { name, tac, gcr, source: `${samples.length} Nix Mini readings` });
  const id = ctx.store.newId();
  fs.writeFileSync(path.join(profilesDir(), `${id}.icc`), p.icc);
  const hp = { deviceId: d.id, model: d.config.model || 'hp-latex-335', mediaId: mm.media.id, mediaName: mm.media.name, modeKey: mm.modeKey, modeLabel: mm.modeLabel };
  const meta = {
    id, fileName: `${name}.icc`, name, space: 'CMYK', madeBy: 'InkSign profile maker (HP Latex)', hp, auto: b.assign !== false,
    notes: `${samples.length} Nix patches (${nix.chartCode(n)}), ${mm.media.name}, ${mm.modeLabel}, ink limit ${tac}%, model fit ΔE avg ${p.fit.avg} / max ${p.fit.max}`,
    createdAt: Date.now(),
  };
  // one "auto" profile per printer model + media + mode: the new one takes over
  const list = (ctx.store.getSettings().iccProfiles || []).map((x) => (meta.auto && x.hp && x.hp.model === hp.model && x.hp.mediaId === hp.mediaId && x.hp.modeKey === hp.modeKey ? { ...x, auto: false } : x));
  ctx.store.saveSettings({ iccProfiles: [...list, meta] });
  fs.writeFileSync(readingsFile(id), JSON.stringify({ hp, tac, gcr, sets: { [nix.chartCode(n)]: samples.map((x) => ({ cmyk: x.cmyk, lab: x.lab, n: x.n })) } }));
  return { id, name, fit: p.fit, paperLab: p.paperLab, blackLab: p.blackLab, patches: samples.length, assigned: meta.auto ? `${mm.media.name}, ${mm.modeLabel}` : null, notes: r.notes, problems };
}

function topups() {
  return (ctx.store.getSettings().iccProfiles || []).map((p) => {
    const rec = loadReadings(p.id);
    if (!rec?.sets || !rec.hp) return null;
    return { id: p.id, name: p.name, mediaName: rec.hp.mediaName, modeLabel: rec.hp.modeLabel, counts: Object.fromEntries(Object.entries(rec.sets).map(([k, v]) => [k, v.length])), toppedUp: !!rec.sets[nix.TOPUP.code] };
  }).filter(Boolean);
}

async function topupBuild(b = {}) {
  const rec = loadReadings(b.profileId);
  if (!rec?.sets || !rec.hp) throw new Error('That profile has no saved readings.');
  const meta = (ctx.store.getSettings().iccProfiles || []).find((p) => p.id === b.profileId);
  if (!meta) throw new Error('That profile was removed.');
  const { patches, r } = readFrom(b, 'topup', nix.TOPUP.n);
  const { samples, problems } = nix.samplesFromReadings(patches, r.readings, await expectFor('topup', nix.TOPUP.n));
  const base = Object.entries(rec.sets).filter(([k]) => k !== nix.TOPUP.code).flatMap(([, v]) => v);
  const all = [...base, ...samples];
  const before = predictionError(base, samples.filter((x) => x.n > 1));
  const p = await runBuild(all, { name: meta.name, tac: rec.tac || DEFAULT_TAC, gcr: rec.gcr || 'medium', source: `${all.length} Nix Mini readings` });
  const after = predictionError(all, samples.filter((x) => x.n > 1));
  const file = path.join(profilesDir(), `${meta.id}.icc`);
  try { fs.copyFileSync(file, `${file}.before-topup`); } catch { /* first time */ }
  fs.writeFileSync(file, p.icc);
  fs.writeFileSync(readingsFile(meta.id), JSON.stringify({ ...rec, sets: { ...rec.sets, [nix.TOPUP.code]: samples.map((x) => ({ cmyk: x.cmyk, lab: x.lab, n: x.n })) } }));
  ctx.store.saveSettings({ iccProfiles: (ctx.store.getSettings().iccProfiles || []).map((x) => (x.id === meta.id ? { ...x, notes: `${x.notes || ''}; topped up ${new Date().toISOString().slice(0, 10)} (${all.length} patches, fit ΔE avg ${p.fit.avg})` } : x)) });
  return { id: meta.id, name: meta.name, fit: p.fit, before, after, patches: all.length, added: samples.length, notes: r.notes, problems };
}

/** The InkSign-made profile for this printer model + media + mode (exact mode first, then any mode of that media) */
function autoProfile(profiles, model, mediaId, modeKey) {
  const mine = (profiles || []).filter((p) => p.hp && p.hp.model === model && String(p.hp.mediaId) === String(mediaId));
  return mine.filter((p) => p.hp.modeKey === modeKey).sort((a, b) => (b.auto - a.auto) || (b.createdAt - a.createdAt))[0]
    || null;
}

const patchList = (kind, n) => ({ kind, code: codeFor(kind, n), patches: patchesFor(kind, n) });
function init(c) { ctx = c; }

module.exports = { init, printChart, check, build, topups, topupBuild, patchList, autoProfile, chartForRoll, mediaMode, DEFAULT_TAC };
