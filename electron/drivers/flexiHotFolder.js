// Driver for printers that must be ripped by a certified RIP (HP Latex 115 / 335).
// InkSign prepares the job and drops it in a Flexi Production Manager hot folder.
const fs = require('fs');
const path = require('path');
const T = require('../transports');
const { makeTestPdf } = require('../lib/testPdf');

const fields = [
  { key: 'hotFolder', label: 'Flexi hot folder', type: 'folder', required: true,
    help: 'In Flexi Production Manager 22, set up a hot folder for this printer and point it at a folder here. Can be a network path like \\\\RIP-PC\\HotFolders\\Latex335.' },
  { key: 'mediaFolders', label: 'Hot folder per media (optional)', type: 'text',
    help: 'One Flexi hot folder per media/print mode, e.g.  Banner 13oz = C:\\HotFolders\\335-Banner ; Adhesive vinyl = C:\\HotFolders\\335-Vinyl  — names must match the media list in Wide Format.' },
  { key: 'printerHost', label: 'Printer IP address', type: 'text', help: 'Used only to show whether the printer is online.' },
  { key: 'mediaWidthIn', label: 'Max print width (in)', type: 'number', default: 64 },
  { key: 'pickupTimeoutSec', label: 'Wait for Flexi to pick up (seconds)', type: 'number', default: 60 },
];

function missing(cfg) { return cfg.hotFolder ? [] : ['Flexi hot folder']; }

function parseMediaFolders(text) {
  const out = {};
  for (const part of String(text || '').split(/[;\n]+/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}
function folderFor(cfg, media) {
  if (media) {
    const f = parseMediaFolders(cfg.mediaFolders)[String(media).toLowerCase()];
    if (f) return f;
  }
  return cfg.hotFolder;
}

async function checkStatus(cfg) {
  const miss = missing(cfg);
  if (miss.length) return { state: 'setup', message: `Needs setup: ${miss.join(', ')}` };
  if (!fs.existsSync(cfg.hotFolder)) return { state: 'error', message: 'Hot folder not found' };
  if (cfg.printerHost) {
    const online = (await T.tcpReachable(cfg.printerHost, 80)) || (await T.tcpReachable(cfg.printerHost, 443));
    if (!online) return { state: 'warn', message: `Hot folder OK, printer at ${cfg.printerHost} not answering` };
    return { state: 'ok', message: `Hot folder OK, printer online at ${cfg.printerHost}` };
  }
  return { state: 'ok', message: 'Hot folder OK' };
}

async function drop(cfg, fileName, data, media) {
  const dest = T.dropInHotFolder(folderFor(cfg, media), fileName, data);
  const picked = await T.waitForPickup(dest, Number(cfg.pickupTimeoutSec) || 60);
  if (picked) return { message: `Flexi picked up ${fileName}${media ? ` (${media})` : ''}` };
  return { warning: true, message: `${fileName} is in the hot folder but Flexi hasn't taken it yet — check Production Manager's hot folder is running.` };
}

function safeName(s) { return s.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80); }

async function sendTest(cfg, { jobName = 'InkSign test', deviceName = 'HP Latex' } = {}) {
  const w = Math.min(12, Number(cfg.mediaWidthIn) || 12);
  const pdf = await makeTestPdf({ widthIn: w, heightIn: 8, title: `InkSign test — ${deviceName}`, subtitle: `Sent via Flexi hot folder · ${new Date().toLocaleString()}` });
  return drop(cfg, safeName(`InkSign-Test-${Date.now()}.pdf`), pdf);
}

const TYPES = ['.pdf', '.eps', '.ps', '.tif', '.tiff', '.jpg', '.jpeg', '.png'];
async function sendFile(cfg, filePath, ctx = {}) {
  const ext = path.extname(filePath).toLowerCase();
  if (!TYPES.includes(ext)) throw new Error(`Flexi hot folders take ${TYPES.join(', ')}`);
  return drop(cfg, safeName(path.basename(filePath)), fs.readFileSync(filePath), ctx.options && ctx.options.media);
}

module.exports = {
  id: 'flexi-hotfolder', name: 'Printer via Flexi hot folder (certified RIP)', kind: 'printer',
  fields, fileTypes: TYPES, missing, checkStatus, sendTest, sendFile, parseMediaFolders,
};
