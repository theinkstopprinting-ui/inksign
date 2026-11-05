// InkSign Print Server — a Fiery-style front end for the Xerox WorkCentre 7845.
// One shop PC runs the server: it holds every job (Held / Printing / Printed queues, like Fiery
// Command WorkStation), turns each job into the exact Xerox PostScript stream (ticket.js), spools
// jobs to the printer one at a time, keeps printed jobs for reprinting, and accepts jobs from:
//   - InkSign's Press page and Job Center on any shop PC (network API, see http.js)
//   - Windows "virtual printers": add a printer on any PC that points at this PC (port 9101 = Hold
//     queue, 9102 = Print queue) using the Xerox PostScript driver — print from Word, Illustrator…
//   - Import (PDF / PostScript files)
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const ticket = require('./ticket');
const profiling = require('./profiling');

let ctx = null; // { dir, store, gs, ppdLib, transports, notify, onFinished, userName, profileBytes, log }
let jobs = [];
let busy = false;
let captureServers = [];
let paused = false;
const listeners = new Set();

const ACTIVE = ['waiting', 'processing', 'printing'];
const spoolDir = (id) => path.join(ctx.dir, 'spool', String(id).replace(/[^\w-]/g, ''));
const jobsFile = () => path.join(ctx.dir, 'jobs.json');

function config() {
  const s = ctx.store.getSettings().printServer || {};
  return {
    enabled: s.enabled !== false, printerDeviceId: s.printerDeviceId || '', holdPort: Number(s.holdPort) || 9101, printPort: Number(s.printPort) || 9102,
    capture: s.capture !== false, keepPrintedDays: Number(s.keepPrintedDays) || 30, trays: s.trays || {}, defaults: s.defaults || {},
    serverName: s.serverName || require('os').hostname(),
  };
}
const catalog = () => ctx.store.getSettings().paperCatalog || [];

function printerDevice() {
  const devs = ctx.store.getDevices().filter((d) => d.driver === 'network-printer');
  return devs.find((d) => d.id === config().printerDeviceId) || devs.find((d) => d.config?.model === 'xerox-7845') || devs[0] || null;
}
function ppd() {
  const d = printerDevice();
  return ctx.ppdLib.loadPpd(d?.config?.ppdFile || d?.config?.model || 'xerox-7845');
}

function save() {
  const tmp = `${jobsFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 1));
  fs.renameSync(tmp, jobsFile());
}
function emit(job) {
  save();
  for (const fn of listeners) { try { fn(job); } catch { /* listener errors never break the server */ } }
  if (ctx.notify) ctx.notify(job);
}
function update(job, patch, what) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  if (what) (job.log = job.log || []).push({ at: Date.now(), what, who: ctx.userName ? ctx.userName() : null });
  if (job.log && job.log.length > 40) job.log = job.log.slice(-40);
  emit(job);
}
const find = (id) => {
  const j = jobs.find((x) => x.id === id);
  if (!j) throw new Error('That job is no longer on the server');
  return j;
};

// Text summaries shown in the job list (Fiery's columns)
function describe(job) {
  const p = ticket.mergeProps(job.props);
  let paperName = '';
  try {
    const paper = ticket.jobPaper(ppd(), p, catalog());
    paperName = paper.id ? paper.name : `${ppd().sizes[paper.size]?.label?.replace(/\s*\(.*\)/, '') || paper.size}${paper.type !== 'PrinterDefault' ? `, ${ppd().options.MediaType?.choices.find((c) => c.key === paper.type)?.label || paper.type}` : ''}`;
  } catch (e) { paperName = 'Paper missing'; }
  const label = (opt, key) => ppd().options[opt]?.choices.find((c) => c.key === key)?.label || key;
  const fin = [];
  if (p.finishing.fold !== 'None') fin.push(label('XRFold', p.finishing.fold));
  if (p.finishing.staple !== 'None') fin.push(label('StapleLocation', p.finishing.staple));
  if (p.finishing.punch !== 'None') fin.push(label('XRPunch', p.finishing.punch));
  const layout = { none: '', nup: 'N-up', repeat: 'Step & repeat', booklet: 'Booklet' }[p.layout.mode] || '';
  const mixed = p.layout.mode === 'none' && (p.mixed.ranges.length || p.mixed.inserts.length || p.mixed.chapters || p.mixed.frontCover.catalogId || p.mixed.backCover.catalogId);
  return {
    paperName, finishing: fin.join(', '), layout, mixed: !!mixed, copies: p.copies,
    sidesText: p.sides === 'two' ? '2-sided' : '1-sided', colorText: p.color.mode === 'gray' ? 'B&W' : 'Color',
  };
}

function view(job) {
  return { ...job, ...describe(job), queue: ACTIVE.includes(job.status) ? 'printing' : job.status === 'printed' ? 'printed' : 'held' };
}

function state() {
  const dev = printerDevice();
  const c = config();
  return {
    server: { name: c.serverName, paused, holdPort: c.holdPort, printPort: c.printPort, capture: c.capture, listening: captureServers.map((s) => s.port) },
    printer: dev ? { id: dev.id, name: dev.name, host: dev.config?.host || '', model: ppd().nickName } : null,
    trays: c.trays, catalog: catalog(), jobs: jobs.map(view),
    profiles: (ctx.store.getSettings().iccProfiles || []).map((x) => ({ id: x.id, name: x.name, space: x.space, notes: x.notes || '', paperId: x.paperId || null, madeBy: x.madeBy || null })),
  };
}

// The printer's choices for the UI (sizes, paper types, colors, trays, finishing, quality)
function capabilities() {
  const p = ppd();
  const opt = (k) => (p.options[k] ? p.options[k].choices.map((c) => ({ key: c.key, label: c.label })) : []);
  return {
    model: p.nickName, fileVersion: p.fileVersion,
    sizes: Object.entries(p.sizes).map(([key, s]) => ({ key, label: s.label, w: s.w, h: s.h })),
    custom: p.custom ? { minW: p.custom.minW, maxW: p.custom.maxW, minH: p.custom.minH, maxH: p.custom.maxH } : null,
    mediaTypes: opt('MediaType'), mediaColors: opt('MediaColor'), trays: opt('InputSlot'), quality: opt('OutputMode'),
    staple: opt('StapleLocation'), fold: opt('XRFold'), punch: opt('XRPunch'),
  };
}

// Pick a catalog paper that matches what a Windows driver job asked for
function matchCatalog(media = {}) {
  const list = catalog();
  return list.find((c) => c.size === media.size && c.type === (media.type || c.type) && (!media.tray || media.tray === 'auto' || c.tray === media.tray))
    || list.find((c) => c.size === media.size && c.type === media.type) || null;
}

async function makeThumb(job, pdf) {
  try {
    const [png] = await ctx.gs.thumbnails(pdf, { first: 1, last: 1, dpi: 20 });
    if (png) fs.writeFileSync(path.join(spoolDir(job.id), 'thumb.png'), png);
  } catch { /* a missing thumbnail is fine */ }
}

/**
 * Add a job.
 * { name, user, from, pdf (Buffer) | ps (Buffer) | raw (Buffer, a full printer stream), props, hold, inkflow, source }
 */
async function submit(input) {
  const id = crypto.randomUUID();
  const dir = spoolDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const c = config();
  const job = {
    id, name: String(input.name || 'Job').slice(0, 120), user: input.user || (ctx.userName ? ctx.userName() : null) || null, from: input.from || c.serverName,
    source: input.source || 'inksign', createdAt: Date.now(), updatedAt: Date.now(), status: 'processing', message: 'Receiving…',
    props: ticket.mergeProps({ ...c.defaults, ...(input.props || {}) }), edited: false, raw: false, inkflow: input.inkflow || null, printCount: 0, rush: false, log: [],
    profiling: input.profiling || null,
  };
  jobs.push(job);
  emit(job);
  try {
    let pdf = input.pdf || null;
    if (input.raw) {
      // A job printed to the virtual printer: keep the driver's stream to print exactly as sent
      fs.writeFileSync(path.join(dir, 'raw.prn'), input.raw);
      job.raw = true;
      const doc = ticket.stripPjl(input.raw);
      pdf = /^%PDF-/.test(doc.subarray(0, 8).toString('latin1')) ? Buffer.from(doc) : await ctx.gs.psToPdf(doc);
    } else if (input.ps) pdf = await ctx.gs.psToPdf(input.ps);
    if (!pdf) throw new Error('No file in the job');
    fs.writeFileSync(path.join(dir, 'source.pdf'), pdf);
    const prep = await ticket.preparePdf(pdf, job.props, { ppd: ppd(), catalog: catalog() }).catch((e) => ({ error: e.message }));
    const srcPages = prep.srcPages || (await countPages(pdf));
    Object.assign(job, { pages: srcPages, sheets: prep.sheets || null, sides: prep.sides || null });
    await makeThumb(job, pdf);
    const problems = ticket.check(ppd(), job.props, catalog(), c.trays);
    const hold = input.hold || problems.length || prep.error;
    update(job, {
      status: hold ? 'held' : 'waiting',
      message: prep.error ? prep.error : problems.length ? `Check job properties: ${problems[0]}` : hold ? 'Held' : 'Waiting to print',
    }, `Received from ${job.from}${job.source === 'virtual-printer' ? ' (Windows printer)' : ''}`);
    pump();
    return view(job);
  } catch (e) {
    update(job, { status: 'error', message: e.message }, 'Could not read the job');
    return view(job);
  }
}

async function countPages(pdf) {
  try { return (await require('pdf-lib').PDFDocument.load(pdf, { ignoreEncryption: true })).getPageCount(); } catch { return null; }
}

const sourcePdf = (job) => fs.readFileSync(path.join(spoolDir(job.id), 'source.pdf'));
const keyFor = (job) => crypto.createHash('sha1').update(JSON.stringify([job.props, catalog(), config().trays, printerDevice()?.config?.model, ctx.store.getSettings().iccProfiles || []])).digest('hex');

async function streamFor(job) {
  const dir = spoolDir(job.id);
  // Untouched Windows-printer job: send exactly what the Xerox driver made
  if (job.raw && !job.edited && fs.existsSync(path.join(dir, 'raw.prn'))) return fs.readFileSync(path.join(dir, 'raw.prn'));
  const ready = path.join(dir, 'ready.prn');
  const key = keyFor(job);
  if (job.processedKey === key && fs.existsSync(ready)) return fs.readFileSync(ready);
  const problems = ticket.check(ppd(), job.props, catalog(), config().trays);
  if (problems.length) throw new Error(problems.join(' · '));
  const prep = await ticket.preparePdf(sourcePdf(job), job.props, { ppd: ppd(), catalog: catalog() });
  const stream = await ticket.buildStream(prep, {
    ppd: ppd(), gs: ctx.gs, trays: config().trays, profileBytes: ctx.profileBytes, user: job.user || '', jobName: job.name,
  });
  fs.writeFileSync(ready, stream);
  Object.assign(job, { processedKey: key, sheets: prep.sheets, sides: prep.sides, pages: prep.srcPages });
  return stream;
}

async function pump() {
  if (busy || paused) return;
  busy = true;
  try {
    for (;;) {
      if (paused) break;
      const waiting = jobs.filter((j) => j.status === 'waiting');
      if (!waiting.length) break;
      const job = waiting.find((j) => j.rush) || waiting[0];
      const proof = job.proofNext;
      update(job, { status: 'processing', message: 'Processing (RIP)…' });
      let stream;
      try {
        if (proof) {
          const prep = await ticket.preparePdf(sourcePdf(job), { ...job.props, copies: 1 }, { ppd: ppd(), catalog: catalog() });
          stream = await ticket.buildStream(prep, { ppd: ppd(), gs: ctx.gs, trays: config().trays, profileBytes: ctx.profileBytes, user: job.user || '', jobName: `${job.name} (proof)` });
        } else stream = await streamFor(job);
      } catch (e) {
        update(job, { status: 'error', message: e.message, proofNext: false }, 'Processing failed');
        continue;
      }
      const dev = printerDevice();
      if (!dev || !dev.config?.host) { update(job, { status: 'held', message: 'No Xerox set up — add its IP address in Devices', proofNext: false }); continue; }
      update(job, { status: 'printing', message: `Sending to ${dev.name}…` });
      try {
        await ctx.transports.sendToTcp(dev.config.host, dev.config.port || 9100, stream, 10 * 60 * 1000);
        const copies = proof ? 1 : ticket.mergeProps(job.props).copies;
        update(job, {
          status: proof ? 'held' : 'printed', message: proof ? 'Proof printed — still held' : `Printed on ${dev.name}`, printedAt: Date.now(),
          printCount: (job.printCount || 0) + (proof ? 0 : 1), rush: false, proofNext: false, lastSheets: (job.sheets || 0) * copies,
        }, proof ? 'Printed a proof (1 copy)' : `Printed ${copies} cop${copies === 1 ? 'y' : 'ies'}`);
        if (!proof && ctx.onFinished) { try { ctx.onFinished(view(job), dev); } catch { /* reporting never breaks printing */ } }
      } catch (e) {
        update(job, { status: 'error', message: e.message, proofNext: false }, 'Printer did not take the job');
      }
    }
  } finally { busy = false; }
}

// Fiery job actions
async function action(id, act, arg) {
  const job = find(id);
  const who = ctx.userName ? ctx.userName() : null;
  switch (act) {
    case 'print':
      if (job.status === 'printing' || job.status === 'processing') return view(job);
      if (job.status === 'waiting') return view(job);
      update(job, { status: 'waiting', message: 'Waiting to print', proofNext: false }, job.status === 'printed' ? 'Reprint' : 'Print');
      break;
    case 'printNext':
      update(job, { status: job.status === 'printing' || job.status === 'processing' ? job.status : 'waiting', rush: true, message: 'Prints next' }, 'Print next');
      break;
    case 'proof':
      update(job, { status: 'waiting', proofNext: true, message: 'Printing a proof (1 copy)' }, 'Proof');
      break;
    case 'hold':
      if (job.status === 'printing') throw new Error('This job is already going to the printer');
      update(job, { status: 'held', message: 'Held', rush: false }, 'Hold');
      break;
    case 'processHold': {
      update(job, { status: 'processing', message: 'Processing (RIP)…' });
      try { await streamFor(job); update(job, { status: 'held', message: 'Processed — ready to print' }, 'Process and hold'); }
      catch (e) { update(job, { status: 'error', message: e.message }, 'Processing failed'); }
      break;
    }
    case 'cancel':
      if (job.status === 'printing') throw new Error('Already at the printer — cancel it on the Xerox panel (Job Status)');
      update(job, { status: 'held', message: 'Cancelled — still here if you need it', rush: false, proofNext: false }, 'Cancel');
      break;
    case 'rename':
      update(job, { name: String(arg || job.name).slice(0, 120) }, 'Rename');
      break;
    case 'duplicate': {
      const id2 = crypto.randomUUID();
      fs.mkdirSync(spoolDir(id2), { recursive: true });
      for (const f of ['source.pdf', 'thumb.png', 'raw.prn']) {
        const from = path.join(spoolDir(job.id), f);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(spoolDir(id2), f));
      }
      const copy = { ...JSON.parse(JSON.stringify(job)), id: id2, name: `${job.name} copy`, status: 'held', message: 'Held (duplicate)', createdAt: Date.now(), updatedAt: Date.now(), printCount: 0, printedAt: null, processedKey: null, rush: false, log: [{ at: Date.now(), what: `Duplicated from ${job.name}`, who }] };
      jobs.push(copy);
      emit(copy);
      return view(copy);
    }
    case 'remove':
      if (job.status === 'printing') throw new Error('Wait until it finishes printing');
      jobs = jobs.filter((j) => j.id !== id);
      fs.rmSync(spoolDir(id), { recursive: true, force: true });
      save();
      for (const fn of listeners) { try { fn({ id, removed: true }); } catch { /* ignore */ } }
      if (ctx.notify) ctx.notify({ id, removed: true });
      return { id, removed: true };
    default: throw new Error(`Unknown action ${act}`);
  }
  pump();
  return view(job);
}

function setProps(id, props, name) {
  const job = find(id);
  if (job.status === 'printing' || job.status === 'processing') throw new Error('Wait until the printer has the job, then change it');
  let merged = ticket.mergeProps(props);
  // profiling charts must print exactly as made: paper may change, colour handling and layout may not
  if (job.profiling) {
    const lock = profiling.chartProps(merged.media.catalogId || job.profiling.catalogId, merged.quality);
    merged = ticket.mergeProps({ ...lock, copies: merged.copies, notes: merged.notes });
  }
  update(job, { props: merged, edited: true, processedKey: null, ...(name ? { name: String(name).slice(0, 120) } : {}), message: job.status === 'printed' ? job.message : 'Properties changed' }, 'Changed job properties');
  return view(job);
}

// Imposed / mixed-media preview: the laid-out PDF plus sheet counts and any problems
async function preview(id, props) {
  const job = find(id);
  const use = props ? ticket.mergeProps(props) : job.props;
  const problems = ticket.check(ppd(), use, catalog(), config().trays);
  try {
    const prep = await ticket.preparePdf(sourcePdf(job), use, { ppd: ppd(), catalog: catalog() });
    return {
      base64: prep.pdf.toString('base64'), sheets: prep.sheets, sides: prep.sides, pages: prep.srcPages, info: prep.info,
      papers: prep.pages.map((p) => ({ name: p.paper.name, blank: p.blank })), problems,
    };
  } catch (e) { return { error: e.message, problems }; }
}

function checkProps(props) { return ticket.check(ppd(), props, catalog(), config().trays); }
const thumb = (id) => { const f = path.join(spoolDir(id), 'thumb.png'); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
const original = (id) => { find(id); return fs.readFileSync(path.join(spoolDir(id), 'source.pdf')); };

function saveCatalog(list) {
  const clean = (Array.isArray(list) ? list : []).map((c) => ({
    id: c.id || crypto.randomUUID(), name: String(c.name || 'Paper').slice(0, 60), size: c.size || 'Letter', customW: Number(c.customW) || null, customH: Number(c.customH) || null,
    type: c.type || 'Plain', color: c.color || 'White', weightGsm: Number(c.weightGsm) || null, coated: !!c.coated, tray: c.tray || 'auto',
    outputProfileId: c.outputProfileId || '', costPerSheet: Number(c.costPerSheet) || 0, notes: String(c.notes || '').slice(0, 200),
  }));
  ctx.store.saveSettings({ paperCatalog: clean });
  return clean;
}
function saveTrays(trays) {
  const s = ctx.store.getSettings().printServer || {};
  ctx.store.saveSettings({ printServer: { ...s, trays: trays || {} } });
  return config().trays;
}
function setPaused(v) { paused = !!v; if (!paused) pump(); return paused; }

// ---- Windows virtual printers (raw TCP like a real printer's port 9100) ----
function startCapture() {
  stopCapture();
  const c = config();
  if (!c.enabled || !c.capture) return;
  for (const [port, hold] of [[c.holdPort, true], [c.printPort, false]]) {
    if (!port) continue;
    const srv = net.createServer((sock) => {
      const chunks = [];
      let size = 0;
      sock.setTimeout(5 * 60 * 1000, () => sock.destroy());
      sock.on('data', (d) => { size += d.length; if (size > 1024 * 1024 * 1024) sock.destroy(); else chunks.push(d); });
      sock.on('error', () => {});
      sock.on('close', () => {
        if (!size) return;
        const raw = Buffer.concat(chunks);
        const info = ticket.readCapturedJob(raw);
        const media = info.props.media || {};
        const match = matchCatalog(media);
        const props = { ...info.props, media: match ? { catalogId: match.id } : { ...ticket.DEFAULT_PROPS.media, ...media } };
        submit({ name: info.name, user: info.user, from: sock.remoteAddress?.replace(/^::ffff:/, '') || 'Windows', raw, props, hold, source: 'virtual-printer' })
          .catch((e) => ctx.log && ctx.log(`Print server: ${e.message}`));
      });
    });
    srv.on('error', (e) => ctx.log && ctx.log(`Print server port ${port}: ${e.message}`));
    srv.listen(port, '0.0.0.0');
    srv.port = port;
    captureServers.push(srv);
  }
}
function stopCapture() { for (const s of captureServers) { try { s.close(); } catch { /* closed */ } } captureServers = []; }

// Printed jobs older than keepPrintedDays are removed with their files
function cleanup() {
  const cutoff = Date.now() - config().keepPrintedDays * 24 * 3600 * 1000;
  const old = jobs.filter((j) => j.status === 'printed' && (j.printedAt || j.updatedAt) < cutoff);
  for (const j of old) fs.rmSync(spoolDir(j.id), { recursive: true, force: true });
  if (old.length) { jobs = jobs.filter((j) => !old.includes(j)); save(); }
}

function init(c) {
  ctx = c;
  profiling.init({ store: ctx.store, printServer: module.exports, gs: ctx.gs, ppd, catalog, profilesDir: ctx.profilesDir || path.join(ctx.dir, '..', 'profiles') });
  fs.mkdirSync(path.join(ctx.dir, 'spool'), { recursive: true });
  try { jobs = JSON.parse(fs.readFileSync(jobsFile(), 'utf8')); } catch { jobs = []; }
  // Anything mid-flight when InkSign closed goes back on hold
  for (const j of jobs) if (ACTIVE.includes(j.status)) Object.assign(j, { status: 'held', message: 'Held — InkSign was closed while this job was waiting' });
  save();
  startCapture();
  cleanup();
  const t = setInterval(cleanup, 6 * 3600 * 1000); t.unref?.();
  pump();
}
function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function stop() { stopCapture(); }

module.exports = {
  init, stop, state, capabilities, submit, action, setProps, preview, checkProps, thumb, original, saveCatalog, saveTrays, setPaused,
  startCapture, onChange, config, printerDevice,
  // Profile maker (same system as InkRIP's, see profiling.js)
  profChart: (o) => profiling.printChart(o), profCheck: (o) => profiling.check(o), profBuild: (o) => profiling.build(o),
  profTopups: () => profiling.topups(), profTopupBuild: (o) => profiling.topupBuild(o), profPatches: (kind, n) => profiling.patchList(kind, n),
};
