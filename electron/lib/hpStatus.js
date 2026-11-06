// Asks an HP Latex what's loaded — the same thing Flexi's "get media from printer" button does.
// Flexi's HP driver (UniLib, LEDMWebServices) reads the printer's LEDM web pages over plain HTTP:
//   /DevMgmt/MediaHandlingDyn.xml  → the loaded roll: media preset (MediaKey), name, width, length
//   /DevMgmt/ProductStatusDyn.xml  → status and alerts (ready, printhead problems, out of media…)
//   /DevMgmt/ConsumableConfigDyn.xml → ink levels
// Checked against the shop's Latex 335 (10.1.1.23) on 6 Nov 2026: MediaKey 150100,
// "Generic Self-Adhesive Vinyl", Width 1371 mm, Length 0 (unknown), roll.
const http = require('http');

function get(host, path, { port = 80, timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, timeout: timeoutMs, headers: { Accept: 'text/xml, application/xml' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) reject(Object.assign(new Error(`HTTP ${res.statusCode} for ${path}`), { status: res.statusCode }));
        else resolve(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`The printer at ${host} didn't answer`)));
    req.on('error', reject);
  });
}

// Tiny namespace-blind XML helpers (the LEDM pages are small and flat)
const tag = (xml, name) => { const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`)); return m ? m[1].trim() : null; };
const all = (xml, name) => [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'g'))].map((m) => m[1]);
const unesc = (s) => (s == null ? s : s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
const UNIT_MM = { millimeters: 1, mm: 1, inches: 25.4, in: 25.4, tenthsofmillimeters: 0.1, hundredthsofinches: 0.254, thousandthsofinches: 0.0254, micrometers: 0.001, centimeters: 10, meters: 1000 };

/** MediaHandlingDyn.xml → [{ bin, mediaKey, mediaType, widthMm, lengthMm, trayType, state }] */
function parseMediaHandling(xml) {
  return all(xml, 'InputTray').map((t) => {
    const dims = tag(t, 'MediaSizeDimensions') || '';
    const unit = (tag(dims, 'Unit') || 'millimeters').toLowerCase();
    const k = UNIT_MM[unit] ?? 1;
    const w = Number(tag(dims, 'Width')), l = Number(tag(dims, 'Length'));
    return {
      bin: tag(t, 'InputBin') || '',
      mediaKey: tag(t, 'MediaKey') || '',
      mediaType: unesc(tag(t, 'MediaType') || ''),
      widthMm: Number.isFinite(w) && w > 0 ? w * k : null,
      lengthMm: Number.isFinite(l) && l > 0 ? l * k : null,
      trayType: (tag(t, 'TrayType') || '').toLowerCase(),
      state: tag(t, 'TrayState') || tag(t, 'State') || '',
    };
  });
}

const ALERT_TEXT = {
  ready: 'Ready', missingPrintHead: 'A printhead is missing or not seated', incorrectPrintHead: 'A printhead is the wrong type or not recognized',
  printHeadFailure: 'Printhead problem', mediaOut: 'Out of media', noMedia: 'No media loaded', mediaJam: 'Media jam', coverOpen: 'A cover is open',
  inkCartridgeMissing: 'An ink cartridge is missing', inkCartridgeLow: 'Ink is low', inkCartridgeVeryLow: 'Ink is very low', inkCartridgeEmpty: 'An ink cartridge is empty',
  sleepMode: 'Asleep (wakes up when a job arrives)', busy: 'Busy', printing: 'Printing', processing: 'Processing', paused: 'Paused',
};
const COLOR = { C: 'cyan', M: 'magenta', Y: 'yellow', K: 'black', LC: 'light cyan', LM: 'light magenta', MY: 'magenta/yellow', CK: 'cyan/black', LCLM: 'light cyan/light magenta', OP: 'optimizer' };

/** ProductStatusDyn.xml → { status, alerts: [{ id, severity, text }] } */
function parseProductStatus(xml) {
  const status = tag(xml, 'StatusCategory') || '';
  const seen = new Set();
  const alerts = [];
  for (const a of all(xml, 'Alert')) {
    const id = tag(a, 'ProductStatusAlertID') || '';
    const color = tag(a, 'AlertDetailsMarkerColor');
    const key = `${id}|${color || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const base = ALERT_TEXT[id] || id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
    alerts.push({ id, severity: tag(a, 'Severity') || 'Info', text: color ? `${base} (${COLOR[color] || color})` : base });
  }
  return { status, statusText: ALERT_TEXT[status] || status, alerts };
}

// HP 831 (Latex 300 series) cartridges. Refilled / non-HP cartridges often report no colour code, so the
// colour comes from the product number, or failing that from the slot (the 300 series' slots, left to
// right: M, LM, LC, C, Optimizer, Y, K — checked against the shop's 335 on 6 Nov 2026).
const INK_BY_PRODUCT = {
  CZ682A: 'K', CZ683A: 'C', CZ684A: 'M', CZ685A: 'Y', CZ686A: 'LC', CZ687A: 'LM', CZ688A: 'K', CZ689A: 'C', CZ690A: 'M', CZ691A: 'Y',
  CZ692A: 'LC', CZ693A: 'LM', CZ694A: 'K', CZ695A: 'C', CZ696A: 'M', CZ697A: 'Y', CZ698A: 'LC', CZ699A: 'LM', CZ706A: 'OP', CZ707A: 'OP',
};
const INK_BY_SLOT_300 = { 1: 'M', 2: 'LM', 3: 'LC', 4: 'C', 5: 'OP', 6: 'Y', 7: 'K' };
const INK_NAME = { K: 'Black', C: 'Cyan', M: 'Magenta', Y: 'Yellow', LC: 'Light cyan', LM: 'Light magenta', OP: 'Optimizer' };
const INK_ORDER = ['M', 'LM', 'LC', 'C', 'OP', 'Y', 'K'];
const INK_CSS = { K: '#3a3a3a', C: '#00a3e0', M: '#e10098', Y: '#ffd400', LC: '#7fd3f2', LM: '#f49ad1', OP: '#d9dde3' };

/** ConsumableConfigDyn.xml → { ink: [{ code, name, css, percent, slot, product, state }], heads: [{ slot, product, label, state, installed }] } */
function parseConsumables(xml) {
  const ink = [], heads = [];
  for (const c of all(xml, 'ConsumableInfo')) {
    const type = (tag(c, 'ConsumableTypeEnum') || '').toLowerCase();
    const slot = Number(tag(c, 'ConsumableStation')) || null;
    const product = tag(c, 'ProductNumber') || '';
    const label = tag(c, 'ConsumableLabelCode') || '';
    const state = tag(c, 'ConsumableState') || '';
    if (type === 'ink') {
      const code = INK_BY_PRODUCT[product] || (label && INK_NAME[label] ? label : null) || INK_BY_SLOT_300[slot] || label || `Slot ${slot}`;
      const percent = Number(tag(c, 'ConsumablePercentageLevelRemaining'));
      ink.push({ code, name: INK_NAME[code] || code, css: INK_CSS[code] || '#999', percent: Number.isFinite(percent) ? percent : null, slot, product, state });
    } else if (type === 'printhead') {
      heads.push({ slot, product, label, state, installed: tag(tag(c, 'Installation') || '', 'Date') || '' });
    }
  }
  ink.sort((a, b) => (INK_ORDER.indexOf(a.code) + 1 || 99) - (INK_ORDER.indexOf(b.code) + 1 || 99) || (a.slot || 0) - (b.slot || 0));
  heads.sort((a, b) => (a.slot || 0) - (b.slot || 0));
  return { ink, heads };
}
const parseInk = (xml) => parseConsumables(xml).ink;

/**
 * Everything the Print window shows about the printer. Media is required; status and ink are best-effort.
 * Returns { media: { ...loaded roll }, trays: [...], status, alerts, ink, at }
 */
async function printerState(host, opts = {}) {
  const hp = String(host).match(/^\[?([^\]]+?)\]?:(\d+)$/);
  if (hp && !opts.port) { host = hp[1]; opts = { ...opts, port: Number(hp[2]) }; }
  const xml = await get(host, '/DevMgmt/MediaHandlingDyn.xml', opts);
  const trays = parseMediaHandling(xml);
  const loaded = trays.find((t) => t.widthMm) || trays[0] || null;
  let st = { status: '', statusText: '', alerts: [] };
  try { st = parseProductStatus(await get(host, '/DevMgmt/ProductStatusDyn.xml', opts)); } catch { /* older firmware */ }
  let cons = { ink: [], heads: [] };
  try { cons = parseConsumables(await get(host, '/DevMgmt/ConsumableConfigDyn.xml', opts)); } catch { /* optional */ }
  return { media: loaded, trays, ...st, ink: cons.ink, heads: cons.heads, at: new Date().toISOString() };
}

module.exports = { printerState, parseMediaHandling, parseProductStatus, parseConsumables, parseInk, get };
