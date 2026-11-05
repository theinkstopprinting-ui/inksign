// Wires the Print Server into InkSign: decides whether this PC *is* the server or uses the server on
// another shop PC, exposes it to the Job Center / Press / Paper Catalog pages, reports printed jobs
// to InkFlow / usage / history, and sets up Windows printers + firewall on the shop PCs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const printServer = require('./printServer');
const httpApi = require('./http');
const client = require('./client');
const ticket = require('./ticket');
const nixdev = require('../color/nixdevice');

let ctx = null; // { app, store, shop, inkflow, transports, ipcMain, dialog, getWin, notice }
let httpSrv = null;
let started = false;
let remote = null;

const API_PORT = 8631;
const settings = () => ctx.store.getSettings().printServer || {};
const IS_WIN = process.platform === 'win32';

function lanIps() {
  return Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
}

// 'server' | 'client' | 'off'
function role() {
  const s = settings();
  const r = s.role || 'auto';
  if (r === 'server' || r === 'client' || r === 'off') return r;
  const link = ctx.store.getSettings().printServerLink;
  const sh = ctx.store.getSettings().shared || {};
  if (sh.mode === 'follow' && link?.address && link.key !== s.key) return 'client';
  return 'server';
}

function ensureKey() {
  const s = settings();
  if (s.key) return s.key;
  const key = crypto.randomBytes(9).toString('base64url');
  ctx.store.saveSettings({ printServer: { ...s, key } });
  return key;
}

// The backend the pages talk to: this PC's server, or the one on another PC
function backend() {
  const r = role();
  if (r === 'server') return printServer;
  if (r === 'off') throw new Error('The print server is turned off on this PC — Settings → Print server');
  const s = settings();
  const link = ctx.store.getSettings().printServerLink || {};
  const address = s.role === 'client' ? s.address : (s.address || link.address);
  const key = s.role === 'client' ? s.clientKey : (s.clientKey || link.key);
  const id = `${address}|${key}`;
  if (!remote || remote.id !== id) remote = { id, api: client.make({ address, key, user: () => ctx.shop.userName() }) };
  return remote.api;
}

const profileBytes = (id) => {
  try { return fs.readFileSync(path.join(ctx.app.getPath('userData'), 'profiles', `${String(id).replace(/[^\w-]/g, '')}.icc`)); } catch { return null; }
};

function onFinished(job, dev) {
  // Usage log: sheets and paper cost
  const p = ticket.mergeProps(job.props);
  let cost = 0;
  try {
    const paper = ticket.jobPaper(require('../lib/ppd').loadPpd(dev.config?.model || 'xerox-7845'), p, ctx.store.getSettings().paperCatalog || []);
    cost = (paper.costPerSheet || 0) * (job.lastSheets || 0);
  } catch { /* no cost */ }
  ctx.store.addUsage({ date: Date.now(), jobId: job.id, jobName: job.name, deviceName: dev.name, media: job.paperName, sheets: job.lastSheets || 0, mediaCost: Math.round(cost * 100) / 100, inkCost: 0 });
  // History page + device meters
  ctx.shop.onJobDone({
    id: job.id, name: job.name, deviceId: dev.id, deviceName: dev.name, action: 'server', status: 'done', message: job.message, user: job.user,
    inkflow: job.inkflow, copies: p.copies, createdAt: job.createdAt, finishedAt: Date.now(), meta: { server: true, sheets: job.lastSheets },
  }).catch(() => {});
  // InkFlow: mark the order item printed
  const cfg = ctx.store.getSettings().inkflow || {};
  if (job.inkflow?.orderId && cfg.url && cfg.secret && cfg.autoReport !== false) {
    ctx.inkflow.reportStatus(cfg, job.inkflow.orderId, {
      itemId: job.inkflow.itemId, status: job.inkflow.status || 'printed', job: job.id, device: dev.name,
      note: `${job.name} — ${job.lastSheets || '?'} sheets on ${dev.name} (InkSign Print Server)`, ...(cost ? { cost } : {}),
    }).catch((e) => ctx.notice(`Couldn't update InkFlow: ${e.message}`));
  }
}

function startServer() {
  if (started) return;
  ensureKey();
  printServer.init({
    dir: path.join(ctx.app.getPath('userData'), 'print-server'), store: ctx.store, gs: require('../lib/ghostscript'), ppdLib: require('../lib/ppd'),
    transports: ctx.transports, userName: () => ctx.shop.userName(), profileBytes, onFinished, log: ctx.notice,
    profilesDir: path.join(ctx.app.getPath('userData'), 'profiles'),
    notify: (job) => { const w = ctx.getWin(); if (w && !w.isDestroyed()) w.webContents.send('srv:changed', job); },
  });
  const port = Number(settings().apiPort) || API_PORT;
  httpSrv = httpApi.start({ server: printServer, port, getKey: () => settings().key, version: ctx.app.getVersion(), log: ctx.notice, asUser: (user, fn) => ctx.shop.asUser ? ctx.shop.asUser(user, fn) : fn() });
  started = true;
  // Tell the other PCs where the server is (goes out with the shared setup)
  const ip = lanIps()[0];
  if (ip) {
    const link = { address: `${ip}:${port}`, key: settings().key, name: os.hostname() };
    const cur = ctx.store.getSettings().printServerLink || {};
    if (cur.address !== link.address || cur.key !== link.key) { ctx.store.saveSettings({ printServerLink: link }); ctx.shop.changed(); }
  }
}
function stopServer() {
  nixdev.stop();
  if (!started) return;
  printServer.stop();
  try { httpSrv.close(); } catch { /* closed */ }
  httpSrv = null; started = false;
}
function apply() { if (role() === 'server') startServer(); else stopServer(); }

function info() {
  const s = settings();
  const r = role();
  const port = Number(s.apiPort) || API_PORT;
  const link = ctx.store.getSettings().printServerLink || {};
  return {
    role: r, setting: s.role || 'auto', apiPort: port, holdPort: Number(s.holdPort) || 9101, printPort: Number(s.printPort) || 9102,
    addresses: r === 'server' ? lanIps().map((ip) => `${ip}:${port}`) : [], key: r === 'server' ? s.key : null,
    address: s.address || (r === 'client' ? link.address : '') || '', clientKey: s.clientKey || '', linkFromShared: !s.address && r === 'client' ? link : null,
    printerDeviceId: s.printerDeviceId || '', capture: s.capture !== false, keepPrintedDays: Number(s.keepPrintedDays) || 30,
    computer: os.hostname(), isWindows: IS_WIN,
  };
}

// ---- Windows setup (elevated PowerShell): Xerox PPD driver, InkSign printers, firewall ----
const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const driverDir = () => unpacked(path.join(__dirname, '..', 'printers', 'xerox-7845-ppd-driver'));
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

function runElevated(script) {
  return new Promise((resolve, reject) => {
    if (!IS_WIN) return reject(new Error('This only works on Windows'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inksign-'));
    const scriptFile = path.join(tmp, 'setup.ps1');
    const logFile = path.join(tmp, 'result.txt');
    fs.writeFileSync(scriptFile, `$ErrorActionPreference = 'Stop'\ntry {\n${script}\n'OK' | Out-File -Encoding utf8 ${psq(logFile)} -Append\n} catch { ('ERROR: ' + $_.Exception.Message) | Out-File -Encoding utf8 ${psq(logFile)} -Append }\n`, 'utf8');
    const outer = `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psq(`"${scriptFile}"`)}`;
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer], { windowsHide: true, timeout: 5 * 60 * 1000 }, (err) => {
      let out = '';
      try { out = fs.readFileSync(logFile, 'utf8').replace(/^﻿/, ''); } catch { /* not written */ }
      fs.rmSync(tmp, { recursive: true, force: true });
      if (/^ERROR: /m.test(out)) return reject(new Error(out.match(/^ERROR: (.*)$/m)[1].trim()));
      if (!/OK/.test(out)) return reject(new Error(err ? 'Windows asked for permission and it was not given' : 'Setup did not finish'));
      resolve(out.trim());
    });
  });
}

// Add "InkSign 7845 – Hold" and "InkSign 7845 – Print" printers on this PC pointing at the server
async function addWindowsPrinters({ host, which = ['hold', 'print'] } = {}) {
  const i = info();
  let serverHost = host;
  if (!serverHost) serverHost = role() === 'server' ? '127.0.0.1' : String(i.address || '').split(':')[0];
  if (!serverHost) throw new Error('Set the print server address first');
  const lines = [
    `$inf = ${psq(path.join(driverDir(), 'xrcdspy_ppd.inf'))}`,
    "$drv = 'Xerox WorkCentre 7845 PS3'",
    'if (-not (Get-PrinterDriver -Name $drv -ErrorAction SilentlyContinue)) {',
    '  & pnputil.exe /add-driver $inf /install | Out-Null',
    '  Add-PrinterDriver -Name $drv',
    '}',
  ];
  for (const w of which) {
    const port = w === 'hold' ? i.holdPort : i.printPort;
    const name = w === 'hold' ? 'InkSign 7845 - Hold' : 'InkSign 7845 - Print';
    const portName = `InkSign_${serverHost}_${port}`;
    lines.push(
      `if (-not (Get-PrinterPort -Name ${psq(portName)} -ErrorAction SilentlyContinue)) { Add-PrinterPort -Name ${psq(portName)} -PrinterHostAddress ${psq(serverHost)} -PortNumber ${port} }`,
      `if (Get-Printer -Name ${psq(name)} -ErrorAction SilentlyContinue) { Remove-Printer -Name ${psq(name)} }`,
      `Add-Printer -Name ${psq(name)} -DriverName $drv -PortName ${psq(portName)}`,
      // Same defaults the Xerox ships with; the job's own settings come through the driver
      `try { Set-PrintConfiguration -PrinterName ${psq(name)} -Collate $true } catch {}`,
    );
  }
  await runElevated(lines.join('\n'));
  return which.map((w) => (w === 'hold' ? 'InkSign 7845 - Hold' : 'InkSign 7845 - Print'));
}

async function allowFirewall() {
  const i = info();
  const ports = [i.apiPort, i.holdPort, i.printPort].join(',');
  await runElevated([
    "Get-NetFirewallRule -DisplayName 'InkSign Print Server' -ErrorAction SilentlyContinue | Remove-NetFirewallRule",
    `New-NetFirewallRule -DisplayName 'InkSign Print Server' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${ports} -Profile Private,Domain | Out-Null`,
  ].join('\n'));
  return ports;
}

function register() {
  const { ipcMain, dialog } = ctx;
  const h = (name, fn) => ipcMain.handle(name, (_e, ...a) => fn(...a));
  h('srv:info', () => info());
  h('srv:saveConfig', (patch) => {
    ctx.shop.requireOwner();
    const s = settings();
    const allowed = ['role', 'address', 'clientKey', 'printerDeviceId', 'holdPort', 'printPort', 'apiPort', 'capture', 'keepPrintedDays', 'defaults'];
    const next = { ...s };
    for (const k of allowed) if (k in patch) next[k] = patch[k];
    ctx.store.saveSettings({ printServer: next });
    remote = null;
    const needRestart = ['holdPort', 'printPort', 'apiPort', 'capture', 'role'].some((k) => k in patch);
    if (needRestart && started) { stopServer(); }
    apply();
    if (started && ('capture' in patch || 'holdPort' in patch || 'printPort' in patch)) printServer.startCapture();
    return info();
  });
  h('srv:newKey', () => {
    ctx.shop.requireOwner();
    ctx.store.saveSettings({ printServer: { ...settings(), key: crypto.randomBytes(9).toString('base64url') } });
    stopServer(); apply();
    return info();
  });
  h('srv:test', async (address, key) => {
    const c = client.make({ address, key });
    const ping = await c.ping();
    await c.state();
    return ping;
  });
  h('srv:state', () => backend().state());
  h('srv:capabilities', () => backend().capabilities());
  h('srv:action', (id, act, arg) => backend().action(id, act, arg));
  h('srv:setProps', (id, props, name) => backend().setProps(id, props, name));
  h('srv:preview', (id, props) => backend().preview(id, props));
  h('srv:check', (props) => backend().checkProps(props));
  h('srv:thumb', async (id) => { const b = await backend().thumb(id); return b ? Buffer.from(b).toString('base64') : null; });
  h('srv:saveCatalog', (list) => { ctx.shop.requireOwner(); return backend().saveCatalog(list); });
  h('srv:saveTrays', (trays) => backend().saveTrays(trays));
  h('srv:pause', (v) => backend().setPaused(v));
  // Send a PDF the renderer already has (Press page, Orders)
  h('srv:submit', ({ name, base64, ext = 'pdf', props, hold, inkflow }) => {
    const buf = Buffer.from(base64, 'base64');
    return backend().submit({ name, user: ctx.shop.userName(), from: os.hostname(), props, hold, inkflow, ...(ext === 'ps' ? { ps: buf } : { pdf: buf }) });
  });
  h('srv:import', async ({ hold = true } = {}) => {
    const win = ctx.getWin();
    const r = await dialog.showOpenDialog(win, { title: 'Import jobs to the print server', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF or PostScript', extensions: ['pdf', 'ps', 'eps', 'prn'] }] });
    if (r.canceled) return [];
    const out = [];
    for (const f of r.filePaths) {
      const ext = path.extname(f).toLowerCase();
      const buf = fs.readFileSync(f);
      const isPdf = /^%PDF-/.test(buf.subarray(0, 8).toString('latin1'));
      out.push(await backend().submit({ name: path.basename(f, ext), user: ctx.shop.userName(), from: os.hostname(), hold, source: 'import', ...(isPdf ? { pdf: buf } : { ps: ticket.stripPjl(buf) }) }));
    }
    return out;
  });
  h('srv:export', async (id, name) => {
    const pdf = await backend().original(id);
    const r = await dialog.showSaveDialog(ctx.getWin(), { title: 'Save the job PDF', defaultPath: `${String(name || 'job').replace(/[\\/:*?"<>|]+/g, '-')}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, Buffer.from(pdf));
    return r.filePath;
  });
  h('srv:addPrinters', (opts) => addWindowsPrinters(opts || {}));
  // Profile maker: chart / readings / profile on the server; the Nix is read on this PC
  h('prof:patches', (kind, n) => backend().profPatches(kind, n));
  h('prof:topups', () => backend().profTopups());
  h('prof:chart', (o) => backend().profChart(o));
  h('prof:check', (o) => backend().profCheck(o));
  h('prof:build', (o) => { ctx.shop.requireOwner(); return backend().profBuild(o); });
  h('prof:topupBuild', (o) => { ctx.shop.requireOwner(); return backend().profTopupBuild(o); });
  h('nix:info', () => nixdev.status());
  h('nix:connect', () => nixdev.connect());
  h('nix:disconnect', () => nixdev.disconnect());
  h('nix:measure', () => nixdev.measure());
  h('nix:saveLicense', (text) => nixdev.saveLicense(text));
  h('nix:pickBridge', async () => {
    const r = await dialog.showOpenDialog(ctx.getWin(), { title: 'Find NixBridge.exe (in the InkRIP program folder → nixbridge)', properties: ['openFile'], filters: [{ name: 'NixBridge', extensions: ['exe'] }] });
    if (r.canceled) return nixdev.info();
    return nixdev.setBridge(r.filePaths[0]);
  });
  h('srv:firewall', () => { ctx.shop.requireOwner(); return allowFirewall(); });
}

function init(c) {
  ctx = c;
  nixdev.init({ getSettings: () => ctx.store.getSettings(), saveSettings: (p) => ctx.store.saveSettings(p), dataDir: ctx.app.getPath('userData') });
  register();
  apply();
}

module.exports = { init, role, info, backend, startServer, stopServer, apply, addWindowsPrinters };
