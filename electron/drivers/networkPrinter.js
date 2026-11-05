// Driver for office/production printers that take PDF/PostScript/PCL over the network, sent to
// raw port 9100. For the Xerox WorkCentre 7845 (model 'xerox-7845') PDFs are turned into PostScript
// with Xerox's own driver commands from its PPD (tray, paper type, 2-sided, staple, booklet…) — the
// same path the InkSign Print Server uses. Other printers get a plain PJL header.
const fs = require('fs');
const path = require('path');
const T = require('../transports');
const { makeTestPdf } = require('../lib/testPdf');

const PAPER = { Letter: [8.5, 11], Legal: [8.5, 14], Tabloid: [11, 17], '12x18': [12, 18] };
const MODELS = { 'xerox-7845': 'Xerox WorkCentre 7845 (Xerox driver commands)', '': 'Other printer (generic PJL)' };

const fields = [
  { key: 'host', label: 'IP address', type: 'text', required: true },
  { key: 'port', label: 'Port', type: 'number', default: 9100 },
  { key: 'model', label: 'Printer model', type: 'select', default: '', options: Object.entries(MODELS).map(([value, label]) => ({ value, label })),
    help: 'Xerox WorkCentre 7845 uses the exact tray, paper and finisher commands from Xerox\'s own 7845 driver (PPD 5.482).' },
  { key: 'usePjl', label: 'Wrap jobs in PJL header', type: 'bool', default: true, help: 'Tells the printer the language, job name and copies. Turn off only if jobs print as garbage text.' },
  { key: 'testPaper', label: 'Test page size', type: 'select', default: 'Letter', options: Object.keys(PAPER).map((v) => ({ value: v, label: v })) },
  { key: 'copies', label: 'Default copies', type: 'number', default: 1 },
];

function missing(cfg) { return cfg.host ? [] : ['IP address']; }

async function checkStatus(cfg) {
  const miss = missing(cfg);
  if (miss.length) return { state: 'setup', message: `Needs setup: ${miss.join(', ')}` };
  const ok = await T.tcpReachable(cfg.host, cfg.port || 9100);
  return ok ? { state: 'ok', message: `Online at ${cfg.host}` } : { state: 'error', message: `No answer from ${cfg.host}:${cfg.port || 9100}` };
}

const LANG = { '.pdf': 'PDF', '.ps': 'POSTSCRIPT', '.eps': 'POSTSCRIPT', '.pcl': 'PCL', '.prn': 'PCL' };

function wrapPjl(data, { lang, jobName, copies }) {
  const UEL = '\x1B%-12345X';
  const name = String(jobName || 'InkSign').replace(/"/g, '').slice(0, 60);
  const lines = [`@PJL JOB NAME="${name}"`, `@PJL SET COPIES=${Math.max(1, Number(copies) || 1)}`, `@PJL ENTER LANGUAGE=${lang}`];
  const head = `${UEL}${lines.join('\r\n')}\r\n`;
  const tail = `${UEL}@PJL EOJ NAME="${name}"\r\n${UEL}`;
  return Buffer.concat([Buffer.from(head, 'latin1'), data, Buffer.from(tail, 'latin1')]);
}

// Old-style job options (from watch folders / reprints) -> print server job properties
function optionsToProps(options = {}, copies, sizeName) {
  const trayMap = { TRAY1: 'Tray1', TRAY2: 'Tray2', TRAY3: 'Tray3', TRAY4: 'Tray4', TRAY5: 'Tray5', TRAY6: 'Tray6', MANUALFEED: 'Tray5', BYPASS: 'Tray5' };
  const tray = String(options.tray || 'auto');
  return {
    copies: Math.max(1, Number(copies) || 1),
    media: { size: sizeName || options.size || 'Letter', type: options.paperType || 'PrinterDefault', color: 'White', tray: trayMap[tray.toUpperCase()] || (/^Tray\d$/.test(tray) ? tray : 'auto') },
    sides: options.duplex === 'long' || options.duplex === 'short' ? 'two' : 'one', binding: options.duplex === 'short' ? 'short' : 'long',
    scale: 'none', color: { mode: options.color === 'gray' ? 'gray' : 'color' },
    finishing: { staple: options.staple || 'None', fold: options.fold || 'None', punch: options.punch || 'None' },
    ...(options.props || {}),
  };
}

// Xerox path: PDF -> PostScript with the PPD's commands
async function xeroxStream(cfg, pdf, { jobName, copies, options, sizeName }) {
  const ticket = require('../server/ticket');
  const ppd = require('../lib/ppd').loadPpd(cfg.model);
  const gs = require('../lib/ghostscript');
  let size = sizeName;
  if (!size) {
    // Use the PDF's own page size when it's one the printer knows
    const { PDFDocument } = require('pdf-lib');
    const d = await PDFDocument.load(pdf, { ignoreEncryption: true });
    const p = d.getPage(0);
    const w = Math.min(p.getWidth(), p.getHeight()), h = Math.max(p.getWidth(), p.getHeight());
    size = Object.entries(ppd.sizes).find(([, s]) => Math.abs(s.w - w) < 3 && Math.abs(s.h - h) < 3)?.[0] || 'Letter';
  }
  const props = optionsToProps(options, copies, size);
  const problems = ticket.check(ppd, props, [], {});
  if (problems.length) throw new Error(problems.join(' · '));
  const prep = await ticket.preparePdf(pdf, props, { ppd, catalog: [] });
  return ticket.buildStream(prep, { ppd, gs, trays: {}, jobName, user: '' });
}

async function send(cfg, data, lang, jobName, copies, options, sizeName) {
  let payload;
  if (cfg.model && lang === 'PDF') payload = await xeroxStream(cfg, data, { jobName, copies: copies || cfg.copies, options, sizeName });
  else payload = cfg.usePjl === false ? data : wrapPjl(data, { lang, jobName, copies: copies || cfg.copies });
  await T.sendToTcp(cfg.host, cfg.port || 9100, payload, 10 * 60 * 1000);
  return { message: `Sent ${jobName} to ${cfg.host}` };
}

async function sendTest(cfg, { jobName = 'InkSign test page', deviceName = 'Xerox' } = {}) {
  const [w, h] = PAPER[cfg.testPaper] || PAPER.Letter;
  const pdf = await makeTestPdf({ widthIn: w, heightIn: h, title: `InkSign test — ${deviceName}` });
  return send(cfg, pdf, 'PDF', jobName, 1, {}, cfg.testPaper === '12x18' ? '12x18' : cfg.testPaper);
}

async function sendFile(cfg, filePath, { jobName, copies, options } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const lang = LANG[ext];
  if (!lang) throw new Error(`This printer takes ${Object.keys(LANG).join(', ')}`);
  return send(cfg, fs.readFileSync(filePath), lang, jobName || path.basename(filePath), copies, options);
}

module.exports = {
  id: 'network-printer', name: 'Network printer (PDF / PostScript / PCL)', kind: 'printer',
  fields, fileTypes: Object.keys(LANG), missing, checkStatus, sendTest, sendFile, wrapPjl, optionsToProps, xeroxStream,
};
