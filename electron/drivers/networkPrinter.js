// Driver for office/production printers that take PDF/PostScript/PCL over the network
// (Xerox 7845 and similar), sent to raw port 9100 with a PJL job header.
const fs = require('fs');
const path = require('path');
const T = require('../transports');
const { makeTestPdf } = require('../lib/testPdf');

const PAPER = { Letter: [8.5, 11], Legal: [8.5, 14], Tabloid: [11, 17], '12x18': [12, 18] };

const fields = [
  { key: 'host', label: 'IP address', type: 'text', required: true },
  { key: 'port', label: 'Port', type: 'number', default: 9100 },
  { key: 'usePjl', label: 'Wrap jobs in PJL header', type: 'bool', default: true, help: 'Tells the printer the language, job name and copies. Turn off only if jobs print as garbage text.' },
  { key: 'testPaper', label: 'Test page size', type: 'select', default: 'Letter', options: Object.keys(PAPER).map((v) => ({ value: v, label: v })) },
  { key: 'copies', label: 'Default copies', type: 'number', default: 1 },
  { key: 'trays', label: 'Trays (PJL names, comma separated)', type: 'text', default: 'AUTO,TRAY1,TRAY2,TRAY3,TRAY4,MANUALFEED',
    help: 'MANUALFEED is the bypass tray. These are sent as @PJL SET MEDIASOURCE — confirm on a test print.' },
  { key: 'paperTypes', label: 'Paper types (comma separated)', type: 'text', default: 'Plain,Heavyweight,Extra Heavyweight,Cardstock,Glossy',
    help: 'Sent as @PJL SET MEDIATYPE. Leave the job set to "Printer default" if unsure.' },
];

function missing(cfg) { return cfg.host ? [] : ['IP address']; }

async function checkStatus(cfg) {
  const miss = missing(cfg);
  if (miss.length) return { state: 'setup', message: `Needs setup: ${miss.join(', ')}` };
  const ok = await T.tcpReachable(cfg.host, cfg.port || 9100);
  return ok ? { state: 'ok', message: `Online at ${cfg.host}` } : { state: 'error', message: `No answer from ${cfg.host}:${cfg.port || 9100}` };
}

const LANG = { '.pdf': 'PDF', '.ps': 'POSTSCRIPT', '.eps': 'POSTSCRIPT', '.pcl': 'PCL', '.prn': 'PCL' };

function wrapPjl(data, { lang, jobName, copies, options = {} }) {
  const UEL = '\x1B%-12345X';
  const name = String(jobName || 'InkSign').replace(/"/g, '').slice(0, 60);
  const lines = [`@PJL JOB NAME="${name}"`, `@PJL SET COPIES=${Math.max(1, Number(copies) || 1)}`];
  if (options.duplex === 'long' || options.duplex === 'short') {
    lines.push('@PJL SET DUPLEX=ON', `@PJL SET BINDING=${options.duplex === 'short' ? 'SHORTEDGE' : 'LONGEDGE'}`);
  } else if (options.duplex === 'none') lines.push('@PJL SET DUPLEX=OFF');
  if (options.tray && options.tray !== 'AUTO') lines.push(`@PJL SET MEDIASOURCE=${String(options.tray).replace(/[^A-Z0-9_]/gi, '')}`);
  if (options.paperType) lines.push(`@PJL SET MEDIATYPE=${String(options.paperType).replace(/["\r\n]/g, '')}`);
  if (options.color === 'gray') lines.push('@PJL SET RENDERMODE=GRAYSCALE');
  lines.push(`@PJL ENTER LANGUAGE=${lang}`);
  const head = `${UEL}${lines.join('\r\n')}\r\n`;
  const tail = `${UEL}@PJL EOJ NAME="${name}"\r\n${UEL}`;
  return Buffer.concat([Buffer.from(head, 'latin1'), data, Buffer.from(tail, 'latin1')]);
}

async function send(cfg, data, lang, jobName, copies, options) {
  const payload = cfg.usePjl === false ? data : wrapPjl(data, { lang, jobName, copies: copies || cfg.copies, options });
  await T.sendToTcp(cfg.host, cfg.port || 9100, payload, 120000);
  return { message: `Sent ${jobName} to ${cfg.host}` };
}

async function sendTest(cfg, { jobName = 'InkSign test page', deviceName = 'Xerox' } = {}) {
  const [w, h] = PAPER[cfg.testPaper] || PAPER.Letter;
  const pdf = await makeTestPdf({ widthIn: w, heightIn: h, title: `InkSign test — ${deviceName}` });
  return send(cfg, pdf, 'PDF', jobName, 1);
}

async function sendFile(cfg, filePath, { jobName, copies, options } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const lang = LANG[ext];
  if (!lang) throw new Error(`This printer takes ${Object.keys(LANG).join(', ')}`);
  return send(cfg, fs.readFileSync(filePath), lang, jobName || path.basename(filePath), copies, options);
}

module.exports = {
  id: 'network-printer', name: 'Network printer (PDF / PostScript / PCL)', kind: 'printer',
  fields, fileTypes: Object.keys(LANG), missing, checkStatus, sendTest, sendFile, wrapPjl,
};
