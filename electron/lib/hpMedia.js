// HP Latex media and print modes. InkSign ships the HP media presets (ids + every print mode with its
// exact PJL selectors, taken from the printer's own preset files). On a PC with Flexi, the shop's custom
// media (cloned presets like "Briteline IM2201") and Flexi's ICC profiles are picked up from Flexi's folders.
const fs = require('fs');
const path = require('path');
const os = require('os');

const BUNDLED = require('../printers/hp-latex/media.json');

const toMode = ([passes, inkDensity, efficiency, xpm, unidirectional]) => ({ passes, inkDensity, efficiency, xpm, unidirectional });
const densityPct = (L) => (Number(String(L).replace(/\D/g, '')) || 10) * 10;

function modeKey(m) { return `${m.passes}p-${m.inkDensity}-${m.efficiency ? 'E' : 'N'}${m.unidirectional ? '-U' : ''}`; }
function modeLabel(m) {
  return `${m.passes} pass · ${densityPct(m.inkDensity)}% ink${m.efficiency ? ' · efficiency' : ''}${m.unidirectional ? ' · one direction' : ''}`;
}

// Flexi / SAi install folders on this PC (any version)
function saiRoots() {
  if (process.platform !== 'win32' && !process.env.INKSIGN_SAI_ROOT) return [];
  const roots = [];
  if (process.env.INKSIGN_SAI_ROOT) roots.push(process.env.INKSIGN_SAI_ROOT);
  for (const base of [process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)']) {
    const sai = path.join(base, 'SAi');
    try { for (const d of fs.readdirSync(sai)) if (/production suite|flexi/i.test(d)) roots.push(path.join(sai, d)); } catch { /* no Flexi */ }
  }
  return roots;
}

function parseMediaXml(text) {
  const m = /<EngineOperations:Medium ([^>]*)>/.exec(text);
  if (!m) return null;
  const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
  const unesc = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const modes = [];
  const seen = new Set();
  for (const pm of text.matchAll(/<printmodeList:printmode ([^>]*)>([\s\S]*?)<\/printmodeList:printmode>/g)) {
    const at = Object.fromEntries([...pm[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const sel = Object.fromEntries([...pm[2].matchAll(/<SelectorList:Selector key="([^"]*)" value="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const mode = { passes: Number(at.Passes) || 6, inkDensity: sel.INKDENSITY || 'L10', efficiency: (sel.EFFICIENCYMODE || 'ON') === 'ON', xpm: sel.EXTENDEDPM, unidirectional: (at.Direction || 'bidir') !== 'bidir' };
    const k = modeKey(mode);
    if (!seen.has(k)) { seen.add(k); modes.push(mode); }
  }
  return { id: a.MediumId, name: unesc(a.longName || a.shortName || a.MediumId), category: a.CategoryId || '', modes, custom: !/^\d+$/.test(a.MediumId || '') };
}

// The printer's media list as Flexi last read it (…\DriverSettings\HP L25500\10_1_1_23\*.xml)
function flexiMedia(printerHost) {
  const out = [];
  if (!printerHost) return out;
  const folder = String(printerHost).trim().replace(/\./g, '_');
  for (const root of saiRoots()) {
    const dir = path.join(root, 'Jobs and Settings', 'DriverSettings', 'HP L25500', folder);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.xml')); } catch { continue; }
    for (const f of files) {
      try { const m = parseMediaXml(fs.readFileSync(path.join(dir, f), 'utf8')); if (m && m.modes.length) out.push(m); } catch { /* skip */ }
    }
    if (out.length) break;
  }
  return out;
}

/** Media for this printer: Flexi's list when Flexi is on this PC, else InkSign's bundled HP presets */
function listMedia(printerHost) {
  const fromFlexi = flexiMedia(printerHost);
  const base = BUNDLED.media.map((m) => ({ id: m.id, name: m.name, category: m.category, modes: m.modes.map(toMode), custom: false }));
  if (!fromFlexi.length) return base;
  const ids = new Set(fromFlexi.map((m) => m.id));
  return [...fromFlexi, ...base.filter((m) => !ids.has(m.id))].sort((a, b) => (a.custom === b.custom ? a.name.localeCompare(b.name) : a.custom ? -1 : 1));
}

function findMedia(list, id) { return list.find((m) => m.id === id) || list.find((m) => m.id === '150100') || list[0]; }

// Flexi's ICC profiles for this model, e.g. "Generic Self-Adhesive Vinyl_8p_CMYKcm_90.icc"
function flexiProfiles(model) {
  const sub = model === 'hp-latex-115' ? 'HP Latex 115' : 'HP Latex 335';
  const out = [];
  for (const root of saiRoots()) {
    const dir = path.join(root, 'ICCProfile', sub);
    try {
      for (const f of fs.readdirSync(dir)) if (/\.ic[cm]$/i.test(f)) out.push({ file: path.join(dir, f), name: f.replace(/\.ic[cm]$/i, ''), ...parseProfileName(f) });
    } catch { /* none */ }
  }
  return out;
}
function parseProfileName(f) {
  const m = /^(.*)_(\d+)pU?_(CMYK\w*)_(\d+)/.exec(String(f).replace(/\.ic[cm]$/i, ''));
  return m ? { media: m[1], passes: Number(m[2]), inks: m[3], density: Number(m[4]) } : { media: String(f).replace(/\.ic[cm]$/i, '') };
}

/** Best Flexi profile for a media + mode: same media and passes (closest ink density), else same media */
function suggestProfile(profiles, mediaName, mode) {
  const mine = profiles.filter((p) => p.media && mediaName && p.media.toLowerCase() === String(mediaName).toLowerCase());
  if (!mine.length) return null;
  const want = densityPct(mode?.inkDensity);
  const same = mine.filter((p) => p.passes === Number(mode?.passes));
  const pool = same.length ? same : mine;
  return pool.slice().sort((a, b) => Math.abs((a.density || 0) - want) - Math.abs((b.density || 0) - want))[0];
}

module.exports = { listMedia, findMedia, flexiMedia, flexiProfiles, suggestProfile, parseMediaXml, parseProfileName, modeKey, modeLabel, densityPct, saiRoots, BUNDLED };
