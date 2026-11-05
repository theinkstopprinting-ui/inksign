// Shop tools: job history & reprint, labor timers, real costs + roll stock to InkFlow,
// maintenance log, users & permissions, phone view (LAN web page), and shared setup between PCs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

let ctx = null; // { store, queue, drivers, inkflow, app, notice, dir, getWin }
const J = (name) => path.join(ctx.dir, name);
const readJson = (name, fb) => { try { return JSON.parse(fs.readFileSync(J(name), 'utf8')); } catch { return fb; } };
const writeJson = (name, data) => { const t = J(name) + '.tmp'; fs.writeFileSync(t, JSON.stringify(data, null, 2)); fs.renameSync(t, J(name)); };
const iflCfg = () => ctx.store.getSettings().inkflow || {};
const iflOn = () => { const c = iflCfg(); return Boolean(c.url && c.secret); };

// =============================================================================
// Users & permissions
// =============================================================================
let currentUser = null;

function hashPin(pin, salt = crypto.randomBytes(8).toString('hex')) {
  return `${salt}:${crypto.scryptSync(String(pin), salt, 32).toString('hex')}`;
}
function pinOk(pin, stored) {
  if (!stored) return false;
  const [salt, h] = String(stored).split(':');
  const test = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(test, 'hex'), Buffer.from(h, 'hex'));
}
const publicUser = (u) => (u ? { id: u.id, name: u.name, role: u.role } : null);
function users() { return ctx.store.getSettings().users || []; }
function loginRequired() { return Boolean(ctx.store.getSettings().requireLogin && users().some((u) => u.role === 'owner')); }

// Owner-only actions (settings, device setup, calibration, pricing, users) when sign-in is on.
function requireOwner() {
  if (!loginRequired()) return;
  if (!currentUser) throw new Error('Sign in first.');
  if (currentUser.role !== 'owner') throw new Error(`Only an owner can change that (signed in as ${currentUser.name}).`);
}
const userName = () => (currentUser ? currentUser.name : os.userInfo().username);

function saveUsers(list) {
  requireOwner();
  const old = users();
  const next = list.map((u) => {
    const prev = old.find((o) => o.id === u.id);
    const pin = u.newPin ? hashPin(u.newPin) : prev?.pin;
    if (!pin) throw new Error(`${u.name || 'New user'} needs a PIN.`);
    if (u.newPin && !/^\d{4,8}$/.test(String(u.newPin))) throw new Error('PINs are 4 to 8 digits.');
    return { id: u.id || crypto.randomUUID(), name: String(u.name || '').trim().slice(0, 40) || 'User', role: u.role === 'owner' ? 'owner' : 'staff', pin };
  });
  if (next.length && !next.some((u) => u.role === 'owner')) throw new Error('Keep at least one owner.');
  ctx.store.saveSettings({ users: next });
  return next.map(publicUser);
}

// =============================================================================
// History & reprint (kept longer than the queue: 5,000 jobs)
// =============================================================================
function history() { return readJson('history.json', []); }
function addHistory(job) {
  const h = history();
  h.push({
    id: job.id, name: job.name, deviceId: job.deviceId, deviceName: job.deviceName, action: job.action,
    filePath: job.filePath, options: job.options, copies: job.copies, inkflow: job.inkflow, meta: job.meta || null,
    status: job.status, message: job.message, user: job.user || null, createdAt: job.createdAt, finishedAt: job.finishedAt || Date.now(),
  });
  writeJson('history.json', h.slice(-5000));
}
function reprint(id, deviceId) {
  const h = history().find((x) => x.id === id);
  if (!h) throw new Error('That job is no longer in the history.');
  if (h.action === 'test') throw new Error('Test jobs can be sent again from Devices.');
  if (!h.filePath || !fs.existsSync(h.filePath)) throw new Error('The job file was cleaned up — send it again from its tool.');
  const dev = ctx.store.getDevice(deviceId || h.deviceId);
  if (!dev) throw new Error('That machine was removed — pick another.');
  const orig = ctx.store.getDevice(h.deviceId);
  if (orig && orig.kind !== dev.kind) throw new Error(`${dev.name} is a ${dev.kind}; this job was for a ${orig.kind}.`);
  return ctx.queue.add({ deviceId: dev.id, action: h.action, filePath: h.filePath, name: `${h.name.replace(/ \(reprint\)$/, '')} (reprint)`, options: h.options, copies: h.copies, meta: h.meta ? { ...h.meta, reprintOf: h.id } : null, inkflow: null, user: userName() });
}
// Job files older than N days (default 90) are removed at startup; history rows stay.
function cleanupFiles() {
  const days = Number(ctx.store.getSettings().keepJobsDays) || 90;
  const cutoff = Date.now() - days * 86400000;
  for (const sub of ['printjobs', 'cutjobs']) {
    const d = path.join(ctx.dir, sub);
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) { const f = path.join(d, n); try { if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f); } catch { /* in use */ } }
  }
}

// =============================================================================
// Labor timers → InkFlow order costs
// =============================================================================
function timers() { return readJson('timers.json', { running: [], log: [] }); }
function startTimer({ task, orderId, orderLabel, note }) {
  const t = timers();
  const it = { id: crypto.randomUUID(), task: String(task || 'Labor').slice(0, 40), orderId: orderId || null, orderLabel: orderLabel || null, note: note || '', user: userName(), start: Date.now() };
  t.running.push(it);
  writeJson('timers.json', t);
  return t;
}
async function stopTimer(id, { discard = false } = {}) {
  const t = timers();
  const it = t.running.find((x) => x.id === id);
  if (!it) throw new Error('That timer already stopped.');
  t.running = t.running.filter((x) => x.id !== id);
  if (discard) { writeJson('timers.json', t); return { timers: t }; }
  const minutes = Math.max(1, Math.round((Date.now() - it.start) / 60000));
  const rate = Number(ctx.store.getSettings().pricing?.laborPerHour) || 0;
  const costCents = Math.round((minutes / 60) * rate * 100);
  const entry = { ...it, end: Date.now(), minutes, costCents, sentToInkFlow: false };
  let note = '';
  if (it.orderId && costCents > 0 && iflOn()) {
    try {
      await ctx.inkflow.addCost(iflCfg(), it.orderId, { cents: costCents, note: `Labor — ${it.task}, ${minutes} min (${it.user})`, key: `labor:${it.id}` });
      entry.sentToInkFlow = true;
    } catch (e) { note = `Couldn't add it to InkFlow: ${e.message}`; }
  }
  t.log.push(entry);
  t.log = t.log.slice(-5000);
  writeJson('timers.json', t);
  return { timers: t, entry, note };
}

// =============================================================================
// Maintenance log + machine meters
// =============================================================================
const DEFAULT_TASKS = {
  cutter: [
    { id: 'blade', name: 'Change the blade', everyCutM: 2000, everyDays: 120 },
    { id: 'strip', name: 'Clean cutting strip, rollers & sensor', everyDays: 30 },
  ],
  'flexi-hotfolder': [
    { id: 'heads', name: 'Printhead check & clean (print a status plot)', everyDays: 7 },
    { id: 'platen', name: 'Clean platen, pinch rollers & curing zone', everyDays: 30 },
    { id: 'maint', name: 'Check maintenance cartridge level', everySqft: 2000, everyDays: 60 },
  ],
  'network-printer': [
    { id: 'clean', name: 'Clean paper path & check toner waste', everyDays: 60 },
  ],
};
function tasksFor(d) { return (d.state && d.state.maintTasks) || (d.kind === 'cutter' ? DEFAULT_TASKS.cutter : DEFAULT_TASKS[d.driver] || []); }
function meters(d) { return { cutM: 0, sqft: 0, jobs: 0, ...(d.state && d.state.meters) }; }
function taskStatus(d, t) {
  const m = meters(d), last = (d.state && d.state.maintLast && d.state.maintLast[t.id]) || { at: d.state?.since || Date.now(), cutM: 0, sqft: 0 };
  const parts = [];
  let due = false, frac = 0;
  if (t.everyDays) { const days = (Date.now() - last.at) / 86400000; frac = Math.max(frac, days / t.everyDays); parts.push(`${Math.floor(days)} of ${t.everyDays} days`); }
  if (t.everyCutM) { const cm = m.cutM - (last.cutM || 0); frac = Math.max(frac, cm / t.everyCutM); parts.push(`${Math.round(cm)} of ${t.everyCutM} m cut`); }
  if (t.everySqft) { const sf = m.sqft - (last.sqft || 0); frac = Math.max(frac, sf / t.everySqft); parts.push(`${Math.round(sf)} of ${t.everySqft} sq ft`); }
  due = frac >= 1;
  return { ...t, due, soon: !due && frac >= 0.85, progress: Math.min(1, frac), detail: parts.join(' · '), lastAt: last.at };
}
function maintList() {
  return ctx.store.getDevices().map((d) => ({ deviceId: d.id, deviceName: d.name, kind: d.kind, meters: meters(d), tasks: tasksFor(d).map((t) => taskStatus(d, t)) }));
}
function maintDone(deviceId, taskId, note) {
  const d = ctx.store.getDevice(deviceId);
  if (!d) throw new Error('Device not found');
  const m = meters(d);
  const maintLast = { ...(d.state?.maintLast || {}), [taskId]: { at: Date.now(), cutM: m.cutM, sqft: m.sqft } };
  ctx.store.setDeviceState(deviceId, { maintLast });
  const log = readJson('maintlog.json', []);
  const task = tasksFor(d).find((t) => t.id === taskId);
  log.push({ at: Date.now(), deviceId, deviceName: d.name, taskId, task: task ? task.name : taskId, note: String(note || '').slice(0, 300), user: userName(), meters: m });
  writeJson('maintlog.json', log.slice(-5000));
  return maintList();
}
function maintSaveTasks(deviceId, tasks) {
  requireOwner();
  const clean = (tasks || []).map((t) => ({
    id: t.id || crypto.randomUUID().slice(0, 8), name: String(t.name || 'Task').slice(0, 80),
    ...(Number(t.everyDays) > 0 ? { everyDays: Number(t.everyDays) } : {}),
    ...(Number(t.everyCutM) > 0 ? { everyCutM: Number(t.everyCutM) } : {}),
    ...(Number(t.everySqft) > 0 ? { everySqft: Number(t.everySqft) } : {}),
  }));
  const d = ctx.store.getDevice(deviceId);
  if (!d.state?.since) ctx.store.setDeviceState(deviceId, { since: Date.now() });
  ctx.store.setDeviceState(deviceId, { maintTasks: clean });
  return maintList();
}
function remindDue() {
  const due = maintList().flatMap((d) => d.tasks.filter((t) => t.due).map((t) => `${d.deviceName}: ${t.name}`));
  if (due.length) ctx.notice(`Maintenance due — ${due.slice(0, 3).join('; ')}${due.length > 3 ? ` (+${due.length - 3} more)` : ''}. See Devices → Maintenance.`);
}

// =============================================================================
// Job finished: meters, real costs, roll stock, history
// =============================================================================
let rollCache = { at: 0, rolls: [] };
async function knownRolls() {
  if (!iflOn()) return [];
  if (Date.now() - rollCache.at < 60000) return rollCache.rolls;
  try { const r = await ctx.inkflow.rolls(iflCfg()); rollCache = { at: Date.now(), rolls: r.rolls || [] }; } catch { /* offline */ }
  return rollCache.rolls;
}

async function onJobDone(job) {
  const d = ctx.store.getDevice(job.deviceId);
  if (job.status === 'done' || job.status === 'warning') {
    if (d) {
      const m = meters(d);
      const add = { jobs: m.jobs + 1 };
      if (job.meta && job.meta.cutMm) add.cutM = m.cutM + job.meta.cutMm / 1000;
      if (job.usage && job.usage.mediaSqFt) add.sqft = m.sqft + job.usage.mediaSqFt;
      if (!d.state?.since) ctx.store.setDeviceState(d.id, { since: Date.now() });
      ctx.store.setDeviceState(d.id, { meters: { ...m, ...add } });
    }
    const meta = job.meta || {};
    const orderId = job.inkflow && job.inkflow.orderId;
    if (iflOn() && !meta.reprintOf) {
      // Roll stock: take the feet used off the InkFlow roll
      if (meta.rollId && meta.feet > 0) {
        try {
          const r = await ctx.inkflow.rollUsage(iflCfg(), meta.rollId, { feet: Math.round(meta.feet * 10) / 10, orderId: orderId || undefined, key: `inksign-${job.id}`.slice(0, 80), note: `${job.name} on ${job.deviceName}` });
          const roll = (await knownRolls()).find((x) => x.id === meta.rollId);
          if (roll) roll.remainingFeet = r.remainingFeet;
          if (roll && roll.reorderFeet > 0 && r.remainingFeet <= roll.reorderFeet) ctx.notice(`${roll.widthIn}" ${roll.materialName} is down to ${Math.round(r.remainingFeet)} ft — time to reorder.`);
        } catch (e) { ctx.notice(`Couldn't update the roll in InkFlow: ${e.message}`); }
      }
      // Real material cost of a cut job on the order
      if (orderId && meta.costCents > 0) {
        try { await ctx.inkflow.addCost(iflCfg(), orderId, { cents: Math.round(meta.costCents), note: meta.costNote || `Material for ${job.name}`, key: job.id }); }
        catch (e) { ctx.notice(`Couldn't add the cost to InkFlow: ${e.message}`); }
      }
    }
  }
  if (job.status !== 'queued' && job.status !== 'sending' && job.status !== 'held') addHistory(job);
}

// =============================================================================
// Shared setup between shop PCs (a shared/network/Nextcloud folder)
// =============================================================================
const SHARED_SETTINGS = ['materials', 'pricing', 'wideMedia', 'colors', 'inkCostPerMl', 'iccProfiles', 'keepJobsDays'];
const LOCAL_DEVICE_KEYS = ['connection', 'printerName', 'comPort', 'baud', 'handshake'];
const sharedDir = () => path.join(ctx.store.getSettings().shared?.folder || '', 'InkSign-shared');

function publishShared() {
  const sh = ctx.store.getSettings().shared || {};
  if (!sh.folder) throw new Error('Pick the shared folder first.');
  if (!fs.existsSync(sh.folder)) throw new Error(`Can't reach ${sh.folder}.`);
  const dir = sharedDir();
  fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
  const s = ctx.store.getSettings();
  const settings = Object.fromEntries(SHARED_SETTINGS.map((k) => [k, s[k]]));
  const devices = ctx.store.getDevices().map((d) => ({ id: d.id, name: d.name, presetId: d.presetId, driver: d.driver, kind: d.kind, config: Object.fromEntries(Object.entries(d.config).filter(([k]) => !LOCAL_DEVICE_KEYS.includes(k))) }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify(devices, null, 2));
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(ctx.store.getLibrary(), null, 2));
  for (const p of s.iccProfiles || []) {
    const src = path.join(ctx.dir, 'profiles', `${p.id}.icc`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'profiles', `${p.id}.icc`));
  }
  const manifest = { updatedAt: Date.now(), by: os.hostname(), app: ctx.app.getVersion() };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  ctx.store.saveSettings({ shared: { ...sh, lastSync: manifest.updatedAt } });
  return manifest;
}

function pullShared({ force = false } = {}) {
  const sh = ctx.store.getSettings().shared || {};
  if (!sh.folder) throw new Error('Pick the shared folder first.');
  const dir = sharedDir();
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { throw new Error('No shared setup in that folder yet — publish it from the main PC first.'); }
  if (!force && sh.lastSync && manifest.updatedAt <= sh.lastSync) return { changed: false, manifest };
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  const shared = JSON.parse(fs.readFileSync(path.join(dir, 'devices.json'), 'utf8'));
  const library = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'));
  fs.mkdirSync(path.join(ctx.dir, 'profiles'), { recursive: true });
  for (const p of settings.iccProfiles || []) {
    const src = path.join(dir, 'profiles', `${p.id}.icc`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(ctx.dir, 'profiles', `${p.id}.icc`));
  }
  ctx.store.importShared({ settings, devices: shared, library, localKeys: LOCAL_DEVICE_KEYS });
  ctx.store.saveSettings({ shared: { ...sh, lastSync: manifest.updatedAt } });
  return { changed: true, manifest };
}

let sharedTimer = null, publishTimer = null;
function startShared() {
  clearInterval(sharedTimer);
  const sh = ctx.store.getSettings().shared || {};
  if (sh.mode === 'follow' && sh.folder) {
    const tick = () => { try { const r = pullShared(); if (r.changed) { ctx.notice(`Updated the shop setup from ${r.manifest.by}.`); ctx.reloadUi(); } } catch { /* folder offline */ } };
    tick();
    sharedTimer = setInterval(tick, 5 * 60 * 1000);
    sharedTimer.unref();
  }
}
// On the main PC, publish a few seconds after setup changes.
function changed() {
  const sh = ctx.store.getSettings().shared || {};
  if (sh.mode !== 'publish' || !sh.folder) return;
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => { try { publishShared(); } catch (e) { ctx.notice(`Couldn't publish the shop setup: ${e.message}`); } }, 4000);
}

// =============================================================================
// Phone view: a small web page on the shop network (queue, release, retry, cancel)
// =============================================================================
let server = null;
const sessions = new Map(); // token -> { user, at }

function lanAddresses(port) {
  return Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => `http://${a.address}:${port}`);
}

const PHONE_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>InkSign</title><style>
body{margin:0;font:15px/1.4 system-ui,sans-serif;background:#121418;color:#e7e9ee}header{padding:14px 16px;background:#1a1d23;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0}
h1{font-size:18px;margin:0}main{padding:12px 16px}.job{background:#1a1d23;border:1px solid #2e333d;border-radius:10px;padding:10px 12px;margin-bottom:8px}
.st{font-size:11px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:10px;background:#22262e}.held{color:#7aa7ff}.error{color:#ff5a5f}.done{color:#3ccf7a}.sending,.queued{color:#ffa35c}
.m{color:#8b93a3;font-size:13px}button{background:#ff7a1a;border:0;color:#111;font-weight:700;border-radius:8px;padding:8px 12px;margin:6px 6px 0 0;font-size:14px}button.g{background:#22262e;color:#e7e9ee}
input{font-size:22px;padding:10px;width:9em;border-radius:8px;border:1px solid #2e333d;background:#0d0f12;color:#fff;letter-spacing:4px}h2{font-size:13px;color:#8b93a3;text-transform:uppercase;margin:16px 0 6px}
</style></head><body><header><h1>◆ InkSign</h1><span id="who" class="m"></span></header><main id="app">Loading…</main>
<script>
const $=s=>document.querySelector(s);let tok=localStorage.getItem('inksignTok')||'';
async function api(p,o={}){const r=await fetch(p,{...o,headers:{'Content-Type':'application/json','X-Token':tok}});if(r.status===401){login();throw new Error('auth')}return r.json()}
function login(msg){$('#app').innerHTML='<p>'+(msg||'Enter your InkSign PIN')+'</p><input id=pin type=password inputmode=numeric autofocus><br><button id=go>Sign in</button>';
$('#go').onclick=async()=>{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:$('#pin').value})});const j=await r.json();if(j.token){tok=j.token;localStorage.setItem('inksignTok',tok);load()}else login(j.error||'Wrong PIN')}}
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function act(id,a){await api('/api/jobs/'+id+'/'+a,{method:'POST'});load()}
async function load(){let s;try{s=await api('/api/state')}catch{return}$('#who').textContent=s.user||'';
const row=j=>'<div class=job><b>'+esc(j.name)+'</b><div class=m>'+esc(j.deviceName)+' · <span class="st '+j.status+'">'+j.status+'</span> · '+new Date(j.updatedAt).toLocaleTimeString()+'</div><div class=m>'+esc(j.message)+'</div>'+
(j.status==='held'?'<button onclick="act(\\''+j.id+'\\',\\'release\\')">Release</button>':'')+(j.status==='error'?'<button onclick="act(\\''+j.id+'\\',\\'retry\\')">Retry</button>':'')+((j.status==='held'||j.status==='queued')?'<button class=g onclick="act(\\''+j.id+'\\',\\'cancel\\')">Cancel</button>':'')+'</div>';
const active=s.jobs.filter(j=>['held','queued','sending'].includes(j.status)),rest=s.jobs.filter(j=>!['held','queued','sending'].includes(j.status));
$('#app').innerHTML='<h2>Waiting ('+active.length+')</h2>'+(active.map(row).join('')||'<p class=m>Nothing waiting.</p>')+'<h2>Recent</h2>'+rest.slice(0,15).map(row).join('')+(s.timers.length?'<h2>Timers running</h2>'+s.timers.map(t=>'<div class=job>'+esc(t.task)+' · '+esc(t.orderLabel||'no order')+' · '+esc(t.user)+'<div class=m>'+Math.round((Date.now()-t.start)/60000)+' min</div></div>').join(''):'')}
load();setInterval(load,5000);
</script></body></html>`;

function startPhone() {
  if (server) { server.close(); server = null; }
  const ph = ctx.store.getSettings().phone || {};
  if (!ph.enabled) return null;
  const port = Number(ph.port) || 4848;
  server = http.createServer(async (req, res) => {
    const send = (code, obj, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' }); res.end(type === 'application/json' ? JSON.stringify(obj) : obj); };
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) return send(200, PHONE_HTML, 'text/html; charset=utf-8');
      const body = await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); }); req.on('end', () => r(b)); });
      if (req.method === 'POST' && req.url === '/api/login') {
        const pin = String((JSON.parse(body || '{}').pin) || '');
        const list = users();
        const u = list.length ? list.find((x) => pinOk(pin, x.pin)) : (ph.pin && pin === String(ph.pin) ? { id: 'phone', name: 'Phone', role: 'staff' } : null);
        if (!u) { await new Promise((r) => setTimeout(r, 800)); return send(200, { error: 'Wrong PIN' }); }
        const token = crypto.randomBytes(24).toString('hex');
        sessions.set(token, { user: publicUser(u), at: Date.now() });
        return send(200, { token });
      }
      const s = sessions.get(String(req.headers['x-token'] || ''));
      if (!s || Date.now() - s.at > 7 * 86400000) return send(401, { error: 'Sign in' });
      if (req.method === 'GET' && req.url === '/api/state') {
        const jobs = ctx.store.getJobs().slice(-60).reverse().map((j) => ({ id: j.id, name: j.name, deviceName: j.deviceName, status: j.status, message: j.message, updatedAt: j.updatedAt }));
        return send(200, { user: s.user.name, jobs, timers: timers().running });
      }
      const m = req.method === 'POST' && req.url.match(/^\/api\/jobs\/([\w-]+)\/(release|retry|cancel)$/);
      if (m) {
        const job = ctx.store.getJobs().find((j) => j.id === m[1]);
        if (!job) return send(404, { error: 'No such job' });
        if (m[2] === 'release') ctx.queue.release(job.id);
        else if (m[2] === 'retry') ctx.queue.retry(job.id);
        else if (job.status === 'held' || job.status === 'queued') ctx.queue.cancelJob(job.id);
        return send(200, { ok: true });
      }
      return send(404, { error: 'Not found' });
    } catch (e) { return send(500, { error: e.message }); }
  });
  server.on('error', (e) => ctx.notice(`Phone view couldn't start on port ${port}: ${e.message}`));
  server.listen(port, '0.0.0.0');
  return lanAddresses(port);
}

// =============================================================================
function init(c) {
  ctx = c;
  cleanupFiles();
  startShared();
  startPhone();
  setTimeout(remindDue, 15000).unref();
  setInterval(remindDue, 6 * 60 * 60 * 1000).unref();
}

function register(ipcMain) {
  ipcMain.handle('users:state', () => ({ required: loginRequired(), current: publicUser(currentUser), users: users().map(publicUser) }));
  ipcMain.handle('users:login', async (_e, id, pin) => {
    const u = users().find((x) => x.id === id);
    if (!u || !pinOk(pin, u.pin)) { await new Promise((r) => setTimeout(r, 600)); throw new Error('Wrong PIN.'); }
    currentUser = u;
    return publicUser(u);
  });
  ipcMain.handle('users:logout', () => { currentUser = null; return true; });
  ipcMain.handle('users:save', (_e, list, requireLogin) => {
    const out = saveUsers(list);
    ctx.store.saveSettings({ requireLogin: Boolean(requireLogin) && out.some((u) => u.role === 'owner') });
    if (currentUser && !out.some((u) => u.id === currentUser.id)) currentUser = null;
    if (!currentUser && loginRequired()) currentUser = users().find((u) => u.role === 'owner') || null; // the owner who just set it up
    return { users: out, requireLogin: loginRequired() };
  });

  ipcMain.handle('history:list', () => history().slice(-2000).reverse());
  ipcMain.handle('history:reprint', (_e, id, deviceId) => reprint(id, deviceId));

  ipcMain.handle('timers:list', () => timers());
  ipcMain.handle('timers:start', (_e, t) => startTimer(t));
  ipcMain.handle('timers:stop', (_e, id, opts) => stopTimer(id, opts));

  ipcMain.handle('maint:list', () => maintList());
  ipcMain.handle('maint:done', (_e, deviceId, taskId, note) => maintDone(deviceId, taskId, note));
  ipcMain.handle('maint:saveTasks', (_e, deviceId, tasks) => maintSaveTasks(deviceId, tasks));
  ipcMain.handle('maint:log', () => readJson('maintlog.json', []).slice(-500).reverse());

  ipcMain.handle('shared:publish', () => { requireOwner(); return publishShared(); });
  ipcMain.handle('shared:pull', () => { const r = pullShared({ force: true }); ctx.reloadUi(); return r; });
  ipcMain.handle('phone:addresses', () => { const ph = ctx.store.getSettings().phone || {}; return ph.enabled ? lanAddresses(Number(ph.port) || 4848) : []; });

  ipcMain.handle('inkflow:customers', (_e, q) => ctx.inkflow.customers(iflCfg(), q));
  ipcMain.handle('inkflow:quote', (_e, body) => ctx.inkflow.createQuote(iflCfg(), body));
  ipcMain.handle('inkflow:addItems', (_e, orderId, lines) => ctx.inkflow.addItems(iflCfg(), orderId, lines));
  ipcMain.handle('inkflow:searchOrders', (_e, q) => ctx.inkflow.listOrders(iflCfg(), null, q));
  ipcMain.handle('inkflow:rolls', async () => { rollCache.at = 0; await knownRolls(); return rollCache.rolls; });
}

function stopPhone() { if (server) { server.close(); server = null; } }

module.exports = { stopPhone, init, register, onJobDone, requireOwner, userName, changed, startPhone, startShared, publishShared, pullShared, hashPin, pinOk };
