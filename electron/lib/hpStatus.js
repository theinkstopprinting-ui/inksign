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

/** ConsumableConfigDyn.xml → [{ color, percent }] (tolerant: any consumable with a percentage) */
function parseInk(xml) {
  return all(xml, 'ConsumableInfo').map((c) => ({
    color: tag(c, 'MarkerColor') || tag(c, 'ConsumableLabelCode') || '',
    type: tag(c, 'ConsumableTypeEnum') || '',
    percent: Number(tag(c, 'ConsumablePercentageLevelRemaining')),
  })).filter((c) => c.color && Number.isFinite(c.percent) && /ink/i.test(c.type || 'ink'));
}

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
  let ink = [];
  try { ink = parseInk(await get(host, '/DevMgmt/ConsumableConfigDyn.xml', opts)); } catch { /* optional */ }
  return { media: loaded, trays, ...st, ink, at: new Date().toISOString() };
}

module.exports = { printerState, parseMediaHandling, parseProductStatus, parseInk, get };
