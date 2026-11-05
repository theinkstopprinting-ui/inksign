// Nix colour meter on USB for the Xerox profile maker — the same NixBridge.exe InkRIP uses (built on
// the Nix Universal SDK; source in theinkstopprinting-ui/inkrip-nixbridge). InkSign doesn't ship the
// bridge or the licence: it uses InkRIP's copy when InkRIP is installed on this PC, or a folder you
// point it to (Xerox Server → Profile maker → Nix on USB). Commands go one JSON line at a time on the
// bridge's stdin; answers come back on stdout (ported from InkRIP server/nixdevice.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let cfg = { getSettings: () => ({}), saveSettings: () => {}, dataDir: os.tmpdir() };
let proc = null, ready = null, readyInfo = null, nextId = 1, buf = '', lastError = '', procKey = '';
const waiting = new Map();

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
function paths() {
  const s = cfg.getSettings().nix || {};
  const exeCandidates = [
    s.bridgeExe,
    path.join(LOCAL, 'Programs', 'InkRIP', 'nixbridge', 'NixBridge.exe'), // InkRIP installed on this PC
    path.join(os.homedir(), 'InkRIP', 'app', 'nixbridge', 'NixBridge.exe'), // older InkRIP folder
  ].filter(Boolean);
  const licCandidates = [
    s.licenseFile,
    path.join(cfg.dataDir, 'nix-license.txt'), // InkSign's own copy (saved from the profile maker)
    path.join(LOCAL, 'InkRIP', 'data', 'nix-license.txt'), // InkRIP's
    path.join(os.homedir(), 'InkRIP', 'app', 'data', 'nix-license.txt'),
  ].filter(Boolean);
  return {
    exe: exeCandidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null,
    license: licCandidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null,
  };
}

function start() {
  const testBridge = process.env.NIX_BRIDGE_TEST; // stand-in bridge for tests (development only)
  const { exe, license } = paths();
  const key = `${testBridge || exe}|${license}`;
  if (proc && procKey === key) return ready;
  if (proc) { try { proc.kill(); } catch { /* gone */ } proc = null; }
  if (!testBridge && process.platform !== 'win32') throw new Error('The Nix USB connection only works on Windows.');
  if (!testBridge && !exe) throw new Error("NixBridge isn't on this PC. Install InkRIP here (it includes NixBridge) or point InkSign to the NixBridge folder — or paste the readings from the Nix app instead.");
  if (!license) throw new Error('No Nix licence on this PC — paste the licence from Nix (Options + Signature) under "Nix on USB".');
  lastError = '';
  procKey = key;
  proc = testBridge
    ? spawn(process.execPath, [testBridge, license], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    : spawn(exe, [license], { cwd: path.dirname(exe), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const me = proc;
  ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The Nix bridge did not start.')), 20000);
    me.once('nix-ready', (info) => { clearTimeout(t); resolve(info); });
    me.once('exit', () => { clearTimeout(t); reject(new Error(`The Nix bridge stopped${lastError ? `: ${lastError}` : ''}.`)); });
  });
  ready.catch(() => {});
  me.stdout.setEncoding('utf8');
  me.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.evt === 'ready') { readyInfo = msg; me.emit('nix-ready', msg); continue; }
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); clearTimeout(w.timer); w.resolve(msg); }
    }
  });
  me.stderr.setEncoding('utf8');
  me.stderr.on('data', (d) => { lastError = String(d).trim().split('\n').pop().slice(0, 300); });
  me.on('exit', () => {
    for (const [, w] of waiting) { clearTimeout(w.timer); w.reject(new Error(`The Nix bridge stopped${lastError ? `: ${lastError}` : ''}.`)); }
    waiting.clear();
    if (proc === me) { proc = null; ready = null; readyInfo = null; buf = ''; }
  });
  return ready;
}

async function send(cmd, timeoutMs = 15000) {
  await start();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('The Nix did not answer in time.')); }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    try { proc.stdin.write(`${JSON.stringify({ id, cmd })}\n`); } catch (e) { clearTimeout(timer); waiting.delete(id); reject(e); }
  });
}

function info() {
  const p = paths();
  return {
    windows: process.platform === 'win32', bridge: p.exe, license: !!p.license, licensePath: p.license,
    available: !!process.env.NIX_BRIDGE_TEST || (process.platform === 'win32' && !!p.exe),
    running: !!proc, licenseState: readyInfo?.license || null,
  };
}

async function status() {
  const i = info();
  if (!i.running) return { ...i, device: null };
  try { const st = await send('status', 10000); return { ...i, licenseState: st.license, device: st.device }; } catch { return { ...i, device: null }; }
}
const connect = () => send('connect', 45000);
const measure = () => send('measure', 30000);
const disconnect = () => (proc ? send('disconnect', 10000) : Promise.resolve({ ok: true }));

function saveLicense(text) {
  const t = String(text || '');
  if (!/options/i.test(t) || !/signature/i.test(t)) throw new Error("That doesn't look like a Nix licence (it needs Options and Signature).");
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.dataDir, 'nix-license.txt'), t);
  if (proc) { try { proc.kill(); } catch { /* restarts on next use */ } }
  return info();
}
function setBridge(exePath) {
  if (exePath && !/NixBridge\.exe$/i.test(exePath)) throw new Error('Pick NixBridge.exe');
  cfg.saveSettings({ nix: { ...(cfg.getSettings().nix || {}), bridgeExe: exePath || '' } });
  if (proc) { try { proc.kill(); } catch { /* restarts */ } }
  return info();
}
function stop() { if (proc) { try { proc.kill(); } catch { /* gone */ } } }
function init(c) { cfg = { ...cfg, ...c }; }

module.exports = { init, info, status, connect, measure, disconnect, saveLicense, setBridge, stop };
