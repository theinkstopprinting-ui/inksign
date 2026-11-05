// Driver for vinyl / contour cutters that speak HP-GL or Graphtec GP-GL.
const fs = require('fs');
const path = require('path');
const T = require('../transports');
const { generate, testPattern, jobExtent, moveTo } = require('../lib/cutterLang');

const fields = [
  { key: 'connection', label: 'Connected by', type: 'select', default: 'printer',
    options: [{ value: 'printer', label: 'USB (Windows printer)' }, { value: 'serial', label: 'COM / serial port' }, { value: 'tcp', label: 'Network (IP address)' }],
    help: 'USB cutters show up as a Windows printer once the maker\'s driver is installed.' },
  { key: 'printerName', label: 'Windows printer', type: 'printer', required: true, showIf: { connection: 'printer' } },
  { key: 'comPort', label: 'COM port', type: 'comport', required: true, showIf: { connection: 'serial' } },
  { key: 'baud', label: 'Baud rate', type: 'select', default: '9600', showIf: { connection: 'serial' },
    options: ['9600', '19200', '38400', '57600', '115200'].map((v) => ({ value: v, label: v })) },
  { key: 'handshake', label: 'Handshake', type: 'select', default: 'RequestToSend', showIf: { connection: 'serial' },
    options: [{ value: 'RequestToSend', label: 'Hardware (RTS/CTS)' }, { value: 'XOnXOff', label: 'XON/XOFF' }, { value: 'None', label: 'None' }] },
  { key: 'tcpHost', label: 'IP address', type: 'text', required: true, showIf: { connection: 'tcp' } },
  { key: 'tcpPort', label: 'Port', type: 'number', default: 9100, showIf: { connection: 'tcp' } },
  { key: 'language', label: 'Cutter language', type: 'select', default: 'hpgl',
    options: [{ value: 'hpgl', label: 'HP-GL' }, { value: 'gpgl', label: 'GP-GL (Graphtec)' }],
    help: 'Must match the COMMAND setting on the cutter panel (AUTO works for both on Graphtec).' },
  { key: 'unitsPerMm', label: 'HP-GL units per mm', type: 'number', default: 40, showIf: { language: 'hpgl' },
    help: 'Standard is 40. If the 1-inch test square cuts the wrong size, adjust this.' },
  { key: 'gpglStepMm', label: 'GP-GL step size (mm)', type: 'select', default: '0.1', showIf: { language: 'gpgl' },
    options: ['0.1', '0.05', '0.025', '0.01'].map((v) => ({ value: v, label: v })) },
  { key: 'mediaWidthIn', label: 'Max cut width (in)', type: 'number', default: 24 },
  { key: 'speed', label: 'Speed override', type: 'number', default: '', help: 'Leave blank to use the cutter panel setting.' },
  { key: 'force', label: 'Force override', type: 'number', default: '', help: 'Leave blank to use the cutter panel setting.' },
  { key: 'overcutMm', label: 'Overcut (mm)', type: 'number', default: 0.5 },
  { key: 'advanceMm', label: 'Feed past job when done (mm)', type: 'number', default: 25 },
  { key: 'rotate', label: 'Rotate output', type: 'select', default: '0',
    options: ['0', '90', '180', '270'].map((v) => ({ value: v, label: `${v}°` })) },
  { key: 'mirror', label: 'Mirror output', type: 'bool', default: false },
  // ---- Print & cut (registration marks) ----
  { key: 'regRotate', label: 'Print & cut: rotate cut to marks', type: 'select', default: '0', section: 'Print & cut (registration marks)',
    options: ['0', '90', '180', '270'].map((v) => ({ value: v, label: `${v}°` })),
    help: 'Set with the alignment test in Print & Cut if the test squares cut sideways or upside down.' },
  { key: 'regOffsetXmm', label: 'Print & cut: X correction (mm)', type: 'number', default: 0,
    help: 'Filled in by the alignment test. Positive moves the cut to the right on the sheet.' },
  { key: 'regOffsetYmm', label: 'Print & cut: Y correction (mm)', type: 'number', default: 0,
    help: 'Filled in by the alignment test. Positive moves the cut up the sheet (toward the top).' },
  { key: 'regCommands', label: 'Mark-reading commands (advanced)', type: 'textarea', default: '',
    help: 'Empty = start the mark scan from the cutter panel. Otherwise these commands are sent first so the cutter finds the marks on its own (copied from a Flexi capture). {DX_MM} {DY_MM} {DX} {DY} = mark distances, {CUT} = where the cut goes, <ETX> = end of a GP-GL command.' },
];

function missing(cfg) {
  const out = [];
  if ((cfg.connection || 'printer') === 'printer' && !cfg.printerName) out.push('Windows printer');
  if (cfg.connection === 'serial' && !cfg.comPort) out.push('COM port');
  if (cfg.connection === 'tcp' && !cfg.tcpHost) out.push('IP address');
  return out;
}

async function checkStatus(cfg) {
  const miss = missing(cfg);
  if (miss.length) return { state: 'setup', message: `Needs setup: ${miss.join(', ')}` };
  const conn = cfg.connection || 'printer';
  if (conn === 'printer') {
    const printers = await T.listPrinters();
    if (!printers.length) return { state: 'warn', message: 'Could not read the Windows printer list' };
    const p = printers.find((x) => x.name === cfg.printerName);
    return p ? { state: 'ok', message: `Ready on ${p.port || cfg.printerName}` } : { state: 'error', message: `Printer "${cfg.printerName}" not found` };
  }
  if (conn === 'serial') {
    const ports = await T.listComPorts();
    return ports.includes(cfg.comPort) ? { state: 'ok', message: `Ready on ${cfg.comPort}` } : { state: 'error', message: `${cfg.comPort} not found` };
  }
  const ok = await T.tcpReachable(cfg.tcpHost, cfg.tcpPort || 9100);
  return ok ? { state: 'ok', message: `Online at ${cfg.tcpHost}` } : { state: 'error', message: `No answer from ${cfg.tcpHost}` };
}

async function sendPaths(cfg, paths, jobName) {
  const data = Buffer.from(generate(paths, cfg), 'latin1');
  await T.sendViaConnection(cfg, data, jobName);
  return { message: `Sent ${data.length.toLocaleString()} bytes (${cfg.language === 'gpgl' ? 'GP-GL' : 'HP-GL'})`, extentXmm: cfg.keepOrigin ? null : jobExtent(paths, cfg) };
}

// Blade up, move to x,y mm from the origin set on the cutter.
async function jog(cfg, x, y) {
  const data = Buffer.from(moveTo(x, y, cfg), 'latin1');
  await T.sendViaConnection(cfg, data, 'InkSign jog');
}

// Clear anything still waiting in Windows' queue for this cutter.
async function cancelSpool(cfg) {
  if ((cfg.connection || 'printer') !== 'printer' || !cfg.printerName) return 0;
  return T.clearPrinterQueue(cfg.printerName);
}

async function sendTest(cfg, { jobName = 'InkSign test cut' } = {}) {
  const r = await sendPaths(cfg, testPattern(), jobName);
  return { message: `${r.message}. Measure the square — it should be exactly 1 inch. The triangle points along the cutter's +X.` };
}

const PASSTHROUGH = ['.plt', '.hpgl', '.hpg', '.gpgl', '.cut'];
async function sendFile(cfg, filePath, { jobName } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  if (!PASSTHROUGH.includes(ext)) throw new Error(`Cutters take ready-made cut files (${PASSTHROUGH.join(', ')}). SVG/PDF/EPS import comes in Phase 2.`);
  const data = fs.readFileSync(filePath);
  await T.sendViaConnection(cfg, data, jobName || path.basename(filePath));
  return { message: `Sent ${path.basename(filePath)} (${data.length.toLocaleString()} bytes)` };
}

module.exports = {
  id: 'cutter', name: 'Vinyl / contour cutter (HP-GL / GP-GL)', kind: 'cutter',
  fields, fileTypes: PASSTHROUGH, missing, checkStatus, sendTest, sendFile, sendPaths, jog, cancelSpool,
};
