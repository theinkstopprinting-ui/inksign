// HP Latex 335 / 115 printed directly from InkSign — no Flexi. InkSign rasterizes the job itself and
// sends the printer the same job Flexi would (PJL media + print mode, PCL3GUI 600 dpi K C M Y rows),
// over the network on port 9100.
const fs = require('fs');
const path = require('path');
const T = require('../transports');
const { makeTestPdf } = require('../lib/testPdf');
const R = require('../lib/hpRaster');
const M = require('../lib/hpMedia');

const fields = [
  { key: 'host', label: 'Printer IP address', type: 'text', required: true, help: 'From the printer\'s front panel (Connectivity) — the same address Flexi uses, e.g. 10.1.1.23.' },
  { key: 'port', label: 'Port', type: 'number', default: 9100 },
  { key: 'model', label: 'Printer model', type: 'select', default: 'hp-latex-335',
    options: Object.entries(R.MODELS).map(([value, m]) => ({ value, label: `${m.name} (up to ${m.maxWidthIn}")` })) },
  { key: 'rollWidthIn', label: 'Roll width (in)', type: 'number', default: 64, help: 'The width of the roll you normally load. Jobs wider than this are refused.' },
  { key: 'mediaId', label: 'Media', type: 'dynselect', optionsFrom: 'hpMedia', default: '150100', section: 'Media & quality (same choices as on the printer and in Flexi)',
    help: 'The printer\'s media preset — sets heat, vacuum and tension. The shop\'s own presets show up when Flexi is installed on this PC.' },
  { key: 'modeKey', label: 'Print mode', type: 'dynselect', optionsFrom: 'hpMode', default: '',
    help: 'More passes = better quality, slower. Ink % is the ink density.' },
  { key: 'icc', label: 'Color profile', type: 'dynselect', optionsFrom: 'hpProfile', default: 'auto',
    help: 'Auto picks Flexi\'s profile for this media and mode when Flexi is on this PC. Add other profiles under Color.' },
  { key: 'intent', label: 'Rendering intent', type: 'select', default: '0',
    options: [{ value: '0', label: 'Perceptual (photos)' }, { value: '1', label: 'Relative colorimetric (logos, spot colors)' }, { value: '2', label: 'Saturation (bold graphics)' }, { value: '3', label: 'Absolute colorimetric (proofing)' }] },
  { key: 'offsetIn', label: 'Start this far from the right edge (in)', type: 'number', default: 0, section: 'Placement' },
  { key: 'removeCut', label: 'Leave cut lines off the print', type: 'bool', default: true, help: 'Lines in a CutContour / Thru-cut spot color are for the cutter only.' },
];

function missing(cfg) { return cfg.host ? [] : ['Printer IP address']; }

async function checkStatus(cfg) {
  const miss = missing(cfg);
  if (miss.length) return { state: 'setup', message: `Needs setup: ${miss.join(', ')}` };
  const ok = await T.tcpReachable(cfg.host, Number(cfg.port) || 9100);
  return ok ? { state: 'ok', message: `Online at ${cfg.host}` } : { state: 'error', message: `No answer from ${cfg.host} — is the printer on?` };
}

function dataDir() {
  if (process.env.INKSIGN_DATA) return process.env.INKSIGN_DATA;
  try { return require('electron').app.getPath('userData'); } catch { return null; }
}
function inksignProfiles() {
  try { return require('../store').getSettings().iccProfiles || []; } catch { return []; }
}

// The media, print mode and profile a job will use (job options can override the device's choice)
function resolve(cfg, opt = {}) {
  const model = R.MODELS[cfg.model] ? cfg.model : 'hp-latex-335';
  const list = M.listMedia(cfg.host);
  const media = M.findMedia(list, opt.mediaId || cfg.mediaId);
  const wantMode = opt.modeKey || cfg.modeKey;
  const mode = media.modes.find((m) => M.modeKey(m) === wantMode)
    || media.modes.find((m) => m.passes === 8 && m.inkDensity === 'L10' && m.efficiency)
    || media.modes.find((m) => m.passes === 6) || media.modes[0];
  const pick = opt.icc || cfg.icc || 'auto';
  let icc = null, iccName = 'printer default';
  if (pick === 'auto') {
    const p = M.suggestProfile(M.flexiProfiles(model), media.name, mode);
    if (p) { try { icc = fs.readFileSync(p.file); iccName = p.name; } catch { /* unreadable */ } }
  } else if (pick.startsWith('flexi:')) {
    try { icc = fs.readFileSync(pick.slice(6)); iccName = path.basename(pick.slice(6)); } catch { throw new Error(`Color profile not found: ${pick.slice(6)}`); }
  } else if (pick.startsWith('inksign:')) {
    const id = pick.slice(8).replace(/[^\w-]/g, '');
    const dir = dataDir();
    try { icc = fs.readFileSync(path.join(dir, 'profiles', `${id}.icc`)); iccName = inksignProfiles().find((p) => p.id === id)?.name || 'InkSign profile'; } catch { throw new Error('That color profile was removed — pick another in the printer\'s settings'); }
  }
  return { model, media, mode, icc, iccName };
}

// Options for the media / mode / profile drop-downs in the printer's settings
function fieldOptions(key, cfg = {}) {
  const model = R.MODELS[cfg.model] ? cfg.model : 'hp-latex-335';
  if (key === 'hpMedia') {
    return M.listMedia(cfg.host).map((m) => ({ value: m.id, label: `${m.name}${m.custom ? ' (shop preset)' : ''}`, group: m.custom ? 'Your presets' : 'HP presets' }));
  }
  if (key === 'hpMode') {
    const media = M.findMedia(M.listMedia(cfg.host), cfg.mediaId);
    return [{ value: '', label: 'Recommended (8 pass · 100%)' }, ...media.modes.slice().sort((a, b) => a.passes - b.passes || a.inkDensity.localeCompare(b.inkDensity, 'en', { numeric: true }))
      .map((m) => ({ value: M.modeKey(m), label: M.modeLabel(m) }))];
  }
  if (key === 'hpProfile') {
    const out = [{ value: 'auto', label: 'Auto — Flexi\'s profile for this media & mode' }, { value: 'none', label: 'None (printer default conversion)' }];
    for (const p of M.flexiProfiles(model)) out.push({ value: `flexi:${p.file}`, label: p.name, group: 'Flexi profiles' });
    for (const p of inksignProfiles().filter((x) => !x.space || /cmyk/i.test(x.space))) out.push({ value: `inksign:${p.id}`, label: p.name, group: 'InkSign profiles' });
    return out;
  }
  return [];
}

async function printBytes(cfg, pdf, { jobName, options = {}, orientation, progress, sink } = {}) {
  const r = resolve(cfg, options);
  const J = require('../lib/hpLatexJob');
  const out = sink || J.tcpSink(cfg.host, Number(cfg.port) || 9100);
  let last = 0;
  const res = await J.printPdf(pdf, {
    model: r.model, rollWidthIn: Number(options.rollWidthIn) || Number(cfg.rollWidthIn) || R.MODELS[r.model].maxWidthIn,
    mediaId: r.media.id, mode: r.mode, icc: r.icc, intent: Number(options.intent ?? cfg.intent) || 0,
    jobName, user: options.user || 'InkSign', orientation: orientation || options.orientation || 'auto',
    offsetIn: Number(options.offsetIn ?? cfg.offsetIn) || 0, removeCut: options.removeCut != null ? options.removeCut !== false : cfg.removeCut !== false, cutterId: options.cutterId,
    onProgress: (f, text) => { if (progress && Date.now() - last > 700) { last = Date.now(); progress(`Printing… ${text}`); } },
  }, out);
  const ft = (res.rows / R.DPI / 12);
  return {
    message: `Printed on ${r.media.name}, ${M.modeLabel(r.mode)} — ${ft < 1 ? `${(res.rows / R.DPI).toFixed(1)}"` : `${ft.toFixed(1)} ft`} (${(res.bytes / 1048576).toFixed(1)} MB${r.icc ? `, ${r.iccName}` : ''}${res.cutLinesRemoved ? `, ${res.cutLinesRemoved} cut line${res.cutLinesRemoved > 1 ? 's' : ''} left off` : ''})`,
    ...res,
  };
}

async function sendTest(cfg, { jobName = 'InkSign test', deviceName = 'HP Latex', progress } = {}) {
  const w = Math.min(12, Number(cfg.rollWidthIn) || 12);
  const pdf = await makeTestPdf({ widthIn: w, heightIn: 8, title: `InkSign test — ${deviceName}`, subtitle: `Printed directly by InkSign · ${new Date().toLocaleString()}` });
  return printBytes(cfg, pdf, { jobName, progress });
}

const TYPES = ['.pdf', '.png', '.jpg', '.jpeg'];
async function imageToPdf(file) {
  const { PDFDocument } = require('pdf-lib');
  const bytes = fs.readFileSync(file);
  const doc = await PDFDocument.create();
  const img = /\.png$/i.test(file) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  // Use the picture's own resolution if it has one, else 150 ppi
  const ppi = require('../lib/preflight')[/\.png$/i.test(file) ? 'pngInfo' : 'jpegInfo'](bytes)?.dpi || 150;
  const w = (img.width / ppi) * 72, h = (img.height / ppi) * 72;
  doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  return Buffer.from(await doc.save());
}

async function sendFile(cfg, filePath, ctx = {}) {
  const ext = path.extname(filePath).toLowerCase();
  if (!TYPES.includes(ext)) throw new Error(`The HP prints ${TYPES.join(', ')}`);
  const pdf = ext === '.pdf' ? fs.readFileSync(filePath) : await imageToPdf(filePath);
  return printBytes(cfg, pdf, { jobName: ctx.jobName || path.basename(filePath), options: ctx.options || {}, progress: ctx.progress });
}

module.exports = {
  id: 'hp-latex', name: 'HP Latex — printed directly by InkSign (no Flexi)', kind: 'printer',
  fields, fileTypes: TYPES, missing, checkStatus, sendTest, sendFile, fieldOptions, resolve, printBytes,
};
