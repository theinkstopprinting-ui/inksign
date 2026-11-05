// Updates, two ways:
//  1. InkFlow (default, same as InkRIP): the owner posts the new installer on InkFlow → Shop apps → InkSign.
//     InkSign asks InkFlow's public /api/apps/inksign/version and offers "Download" when it's newer.
//  2. Optional fully automatic: an "update address" (any web folder holding latest.yml + the installer).
//     electron-updater downloads it in the background and installs on restart.
const { app, shell } = require('electron');
const inkflow = require('./inkflow');

let updater = null;
let state = { status: 'idle', message: '', version: app.getVersion() };
let notify = () => {};

function set(patch) { state = { ...state, ...patch }; notify(state); }

function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
  return false;
}

function init(onChange) {
  notify = onChange;
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch { updater = null; return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => set({ status: 'checking', message: 'Checking for updates…' }));
  updater.on('update-available', (i) => set({ status: 'downloading', message: `Downloading InkSign ${i.version}…` }));
  updater.on('update-not-available', () => set({ status: 'current', message: 'InkSign is up to date.' }));
  updater.on('download-progress', (p) => set({ status: 'downloading', message: `Downloading update… ${Math.round(p.percent)}%` }));
  updater.on('update-downloaded', (i) => set({ status: 'ready', message: `InkSign ${i.version} is ready — restart to update.`, newVersion: i.version }));
  updater.on('error', (e) => set({ status: 'error', message: `Update check failed: ${String(e.message || e).split('\n')[0]}` }));
}

async function check({ updateUrl, inkflow: ifl } = {}) {
  // Automatic route first, when set up
  if (updateUrl && updater) {
    updater.setFeedURL({ provider: 'generic', url: updateUrl });
    try { await updater.checkForUpdates(); return state; } catch (e) { set({ status: 'error', message: `Update check failed: ${e.message}` }); }
  }
  if (ifl && ifl.url) {
    set({ status: 'checking', message: 'Checking InkFlow for a newer InkSign…' });
    try {
      const v = await inkflow.latestVersion(ifl);
      if (v && newer(v.version, app.getVersion())) {
        set({ status: 'available', message: `InkSign ${v.version} is on InkFlow — click to download.`, newVersion: v.version, notes: v.notes || '', downloadUrl: `${String(ifl.url).replace(/\/+$/, '')}/apps/inksign` });
      } else set({ status: 'current', message: 'InkSign is up to date.' });
    } catch (e) { set({ status: 'error', message: `Couldn't check InkFlow: ${e.message}` }); }
    return state;
  }
  if (!updateUrl) set({ status: 'off', message: 'Connect InkFlow (or set an update address) to get updates.' });
  return state;
}

function install() {
  if (state.status === 'ready' && updater) updater.quitAndInstall();
  else if (state.status === 'available' && state.downloadUrl) shell.openExternal(state.downloadUrl);
}

const getState = () => state;

module.exports = { init, check, install, getState, newer };
