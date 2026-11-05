// Profile maker for the Xerox — the same system InkRIP uses for the DTF printers (Profile maker +
// Nix Mini), running on the print server so every shop PC can use it:
//   1. print a chart (100–400 patches, the same patch sets as InkRIP) on a catalog paper, through
//      the Xerox Server with colour management locked off
//   2. measure it with the Nix (USB scan on any PC, or the Nix app's CSV export)
//   3. check the readings (missing, out of order, scanned twice, mis-scans to redo)
//   4. build the ICC profile (InkRIP's profile maker), save it and set it on the paper in the catalog
//   5. later: a 100-patch top-up chart of hard colours, added to the readings and rebuilt in place
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const nix = require('../color/nixdata');
const chart = require('../color/chart');
const { readingCheck, predictionError } = require('../color/profilemaker');
const ticket = require('./ticket');

let ctx = null; // { store, printServer, gs, ppd(), profilesDir, catalog() }
const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const DEFAULT_TAC = 280; // Xerox dry toner: about 260–300 % total

const profilesDir = () => { fs.mkdirSync(ctx.profilesDir, { recursive: true }); return ctx.profilesDir; };
const readingsFile = (id) => path.join(profilesDir(), `${String(id).replace(/[^\w-]/g, '')}.readings.json`);
const loadReadings = (id) => { try { return JSON.parse(fs.readFileSync(readingsFile(id), 'utf8')); } catch { return null; } };

const count = (v) => { const n = Math.round(Number(v) || 200); if (n < 60 || n > 400) throw new Error('Patches must be 60 to 400.'); return n; };
function patchesFor(kind, n) {
  return kind === 'topup' ? nix.topupPatches() : nix.chartPatches(count(n));
}
const codeFor = (kind, n) => (kind === 'topup' ? nix.TOPUP.code : nix.chartCode(count(n)));

// expected colours per chart (to catch readings out of order), cached
const expectCache = new Map();
async function expectFor(kind, n) {
  const key = codeFor(kind, n);
  if (!expectCache.has(key)) {
    const patches = patchesFor(kind, n);
    expectCache.set(key, chart.expectFn(patches, await chart.expectedLabs(ctx.gs, patches)));
  }
  return expectCache.get(key);
}

function paperById(id) {
  const e = ctx.catalog().find((c) => c.id === id);
  if (!e) throw new Error('Pick a paper from the paper catalog to profile');
  return { entry: e, paper: ticket.resolvePaper(ctx.ppd(), e) };
}

// Job properties for a chart: paper from the catalog, 100 %, colour management off, nothing else
const chartProps = (catalogId, quality) => ({
  copies: 1, collate: true, media: { catalogId }, sides: 'one', scale: 'none', rotate180: false,
  layout: { mode: 'none' }, color: { mode: 'color', manage: false, overprint: 'printer' }, quality: quality || 'Standard',
  finishing: { staple: 'None', fold: 'None', punch: 'None', banner: false },
});

async function printChart({ kind = 'main', patches: n = 200, catalogId, quality, profileId, hold = false, copies = 1 } = {}) {
  let rec = null;
  if (kind === 'topup') {
    rec = loadReadings(profileId);
    if (!rec?.sets) throw new Error('That profile has no saved readings — only profiles made in the Profile maker can be topped up.');
    catalogId = catalogId || rec.catalogId;
    quality = quality || rec.quality;
  }
  const { entry, paper } = paperById(catalogId);
  const patches = patchesFor(kind, n);
  const code = codeFor(kind, patches.length);
  const c = await chart.chartPdf(patches, {
    paper: { name: entry.name, w: paper.w, h: paper.h }, code, quality: ctx.ppd().options.OutputMode?.choices.find((x) => x.key === quality)?.label || quality,
    title: kind === 'topup' ? 'InkSign Xerox TOP-UP chart' : 'InkSign Xerox profile chart',
  });
  const props = chartProps(catalogId, quality);
  const problems = ticket.check(ctx.ppd(), props, ctx.catalog(), {});
  if (problems.length) throw new Error(problems[0]);
  const job = await ctx.printServer.submit({
    name: `${kind === 'topup' ? 'Top-up chart' : 'Profile chart'} – ${entry.name} (${patches.length})`, pdf: c.pdf, hold, props: { ...props, copies: Math.max(1, Math.min(5, Number(copies) || 1)) },
    source: 'profiling', profiling: { kind, code, patches: patches.length, catalogId, quality: props.quality, profileId: profileId || null },
  });
  return { job, pages: c.pages, patches: patches.length, code, paper: entry.name };
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
    const w = new Worker(unpacked(path.join(__dirname, '..', 'color', 'buildWorker.js')), { workerData: { profilemaker: unpacked(path.join(__dirname, '..', 'color', 'profilemaker.js')) } });
    const t = setTimeout(() => { w.terminate(); reject(new Error('Building the profile took too long')); }, 5 * 60 * 1000);
    w.once('message', (m) => { clearTimeout(t); w.terminate(); if (m.ok) resolve({ ...m, icc: Buffer.from(m.icc) }); else reject(new Error(m.error)); });
    w.once('error', (e) => { clearTimeout(t); reject(e); });
    w.postMessage({ samples, opts });
  });
}

const cleanName = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 80);

async function build(b = {}) {
  const n = count(b.patches);
  const { patches, r } = readFrom(b, 'main', n);
  const { samples, problems } = nix.samplesFromReadings(patches, r.readings, await expectFor('main', n));
  const { entry } = paperById(b.catalogId);
  const quality = b.quality || 'Standard';
  const name = cleanName(b.name) || cleanName(`Xerox 7845 – ${entry.name} ${new Date().toISOString().slice(0, 10)}`);
  const tac = Math.max(150, Math.min(400, Number(b.tac) || DEFAULT_TAC));
  const gcr = ['light', 'medium', 'heavy'].includes(b.gcr) ? b.gcr : 'medium';
  const p = await runBuild(samples, { name, tac, gcr, source: `${samples.length} Nix Mini readings` });
  const id = ctx.store.newId();
  fs.writeFileSync(path.join(profilesDir(), `${id}.icc`), p.icc);
  const meta = {
    id, fileName: `${name}.icc`, name, space: 'CMYK', madeBy: 'InkSign profile maker', paperId: entry.id, quality,
    notes: `${samples.length} Nix patches (${nix.chartCode(n)}), ${entry.name}, quality ${quality}, ink limit ${tac}%, model fit ΔE avg ${p.fit.avg} / max ${p.fit.max}`,
    createdAt: Date.now(),
  };
  ctx.store.saveSettings({ iccProfiles: [...(ctx.store.getSettings().iccProfiles || []), meta] });
  fs.writeFileSync(readingsFile(id), JSON.stringify({ catalogId: entry.id, quality, tac, gcr, sets: { [nix.chartCode(n)]: samples.map((x) => ({ cmyk: x.cmyk, lab: x.lab, n: x.n })) } }));
  let assigned = null;
  if (b.assign !== false) {
    ctx.printServer.saveCatalog(ctx.catalog().map((c) => (c.id === entry.id ? { ...c, outputProfileId: id } : c)));
    assigned = entry.name;
  }
  return { id, name, fit: p.fit, paperLab: p.paperLab, blackLab: p.blackLab, patches: samples.length, assigned, notes: r.notes, problems };
}

// Profiles that can be topped up (made here, readings kept)
function topups() {
  const list = ctx.store.getSettings().iccProfiles || [];
  return list.map((p) => {
    const rec = loadReadings(p.id);
    if (!rec?.sets) return null;
    const paper = ctx.catalog().find((c) => c.id === rec.catalogId);
    return { id: p.id, name: p.name, paperId: rec.catalogId, paperName: paper?.name || '(paper removed)', quality: rec.quality, counts: Object.fromEntries(Object.entries(rec.sets).map(([k, v]) => [k, v.length])), toppedUp: !!rec.sets[nix.TOPUP.code] };
  }).filter(Boolean);
}

async function topupBuild(b = {}) {
  const rec = loadReadings(b.profileId);
  if (!rec?.sets) throw new Error('That profile has no saved readings.');
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
  const list = (ctx.store.getSettings().iccProfiles || []).map((x) => (x.id === meta.id ? { ...x, notes: `${x.notes || ''}; topped up ${new Date().toISOString().slice(0, 10)} (${all.length} patches, fit ΔE avg ${p.fit.avg})` } : x));
  ctx.store.saveSettings({ iccProfiles: list });
  // processed jobs on that paper must be re-processed with the new profile
  return { id: meta.id, name: meta.name, fit: p.fit, before, after, patches: all.length, added: samples.length, notes: r.notes, problems };
}

const patchList = (kind, n) => ({ kind, code: codeFor(kind, n), patches: patchesFor(kind, n) });
function init(c) { ctx = c; }

module.exports = { init, printChart, check, build, topups, topupBuild, patchList, chartProps, DEFAULT_TAC };
