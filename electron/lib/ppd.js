// Reads a PostScript Printer Description (PPD) file — the same file the Windows/Mac driver uses —
// and turns it into data: every option with its exact PostScript code, the order the codes must be
// sent in, the option conflicts (UIConstraints), the PJL job header, paper sizes and printable areas.
// InkSign ships Xerox's own xrx7845.ppd (WorkCentre 7845, driver 5.482.0.0), so the tray, paper and
// finishing commands sent to the printer are exactly the ones Xerox's driver sends.
const fs = require('fs');
const path = require('path');

// <1B> style hex escapes in PPD strings (JCL, invocation values)
function unhex(s) {
  return String(s).replace(/<([0-9A-Fa-f\s]+)>/g, (_m, hex) => {
    const clean = hex.replace(/\s+/g, '');
    if (clean.length % 2) return _m;
    let out = '';
    for (let i = 0; i < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
    return out;
  });
}

// Split the file into main-keyword statements, joining multi-line quoted values ("..." up to *End)
function statements(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('*') || line.startsWith('*%')) continue;
    const m = line.match(/^\*([^\s:]+)(?:\s+([^:]*?))?\s*:\s*(.*)$/);
    if (!m) continue;
    let [, keyword, option = '', value] = m;
    // Quoted value that continues on following lines
    if (value.startsWith('"') && (value.length === 1 || !value.trimEnd().endsWith('"') || value.trim() === '"')) {
      const parts = [value.slice(1)];
      while (++i < lines.length) {
        const l = lines[i];
        const end = l.lastIndexOf('"');
        if (end >= 0 && l.slice(end + 1).trim() === '') { parts.push(l.slice(0, end)); break; }
        parts.push(l);
      }
      if (lines[i + 1] && lines[i + 1].startsWith('*End')) i++;
      value = { quoted: parts.join('\n') };
    } else if (value.startsWith('"') && value.trimEnd().endsWith('"')) {
      value = { quoted: value.trim().slice(1, -1) };
    } else value = value.trim();
    out.push({ keyword, option: option.trim(), value });
  }
  return out;
}

const splitTrans = (s) => {
  const i = s.indexOf('/');
  return i < 0 ? { key: s.trim(), label: s.trim() } : { key: s.slice(0, i).trim(), label: s.slice(i + 1).trim() };
};
const val = (v) => (typeof v === 'object' && v ? v.quoted : v);

function parsePpd(text) {
  const st = statements(text);
  const ppd = {
    manufacturer: '', model: '', nickName: '', fileVersion: '', languageLevel: '', colorDevice: false,
    options: {}, // key -> { key, label, type, group, order, section, default, choices: [{ key, label, code }] }
    order: [], // option keys in file order (UI order)
    constraints: [], // [{ a, aChoice, b, bChoice }]
    sizes: {}, // size key -> { label, w, h (pt), imageable: [llx, lly, urx, ury] }
    custom: null, // { minW, maxW, minH, maxH, code }
    hwMargins: [0, 0, 0, 0],
    jcl: { begin: '', toPs: '', end: '' },
  };
  let group = '', current = null;
  const ensure = (key, label = key, type = 'PickOne', isJcl = false) => {
    if (!ppd.options[key]) {
      ppd.options[key] = { key, label, type, group, order: 0, section: isJcl ? 'JCLSetup' : 'AnySetup', jcl: isJcl, default: null, choices: [] };
      ppd.order.push(key);
    }
    return ppd.options[key];
  };
  for (const s of st) {
    const k = s.keyword;
    switch (k) {
      case 'Manufacturer': ppd.manufacturer = val(s.value); break;
      case 'ModelName': ppd.model = val(s.value); break;
      case 'NickName': ppd.nickName = val(s.value); break;
      case 'FileVersion': ppd.fileVersion = val(s.value); break;
      case 'LanguageLevel': ppd.languageLevel = val(s.value); break;
      case 'ColorDevice': ppd.colorDevice = /true/i.test(val(s.value)); break;
      case 'OpenGroup': group = splitTrans(String(val(s.value)).trim()).label; break;
      case 'CloseGroup': group = ''; break;
      case 'OpenUI': case 'JCLOpenUI': {
        const name = s.option.replace(/^\*/, '');
        const t = splitTrans(name);
        current = ensure(t.key, t.label, String(val(s.value)).trim(), k === 'JCLOpenUI');
        current.label = t.label; current.type = String(val(s.value)).trim(); current.group = group;
        break;
      }
      case 'CloseUI': case 'JCLCloseUI': current = null; break;
      case 'OrderDependency': {
        const parts = String(val(s.value)).trim().split(/\s+/);
        const key = (parts[2] || '').replace(/^\*/, '');
        const o = ensure(key);
        o.order = Number(parts[0]) || 0; o.section = parts[1] || o.section;
        break;
      }
      case 'NonUIOrderDependency': break;
      case 'UIConstraints': {
        const p = String(val(s.value)).trim().split(/\s+/);
        // *A [choice] *B [choice]
        const res = []; let i = 0;
        while (i < p.length) {
          if (p[i].startsWith('*')) {
            const opt = p[i].slice(1); let choice = null;
            if (p[i + 1] && !p[i + 1].startsWith('*')) { choice = p[i + 1]; i++; }
            res.push([opt, choice]);
          }
          i++;
        }
        if (res.length === 2) ppd.constraints.push({ a: res[0][0], aChoice: res[0][1], b: res[1][0], bChoice: res[1][1] });
        break;
      }
      case 'JCLBegin': ppd.jcl.begin = unhex(val(s.value)); break;
      case 'JCLToPSInterpreter': ppd.jcl.toPs = unhex(val(s.value)); break;
      case 'JCLEnd': ppd.jcl.end = unhex(val(s.value)); break;
      case 'HWMargins': ppd.hwMargins = String(val(s.value)).trim().split(/\s+/).map(Number); break;
      case 'ImageableArea': {
        const t = splitTrans(s.option);
        const sz = ppd.sizes[t.key] || (ppd.sizes[t.key] = { label: t.label });
        sz.imageable = String(val(s.value)).trim().split(/\s+/).map(Number);
        break;
      }
      case 'PaperDimension': {
        const t = splitTrans(s.option);
        const sz = ppd.sizes[t.key] || (ppd.sizes[t.key] = { label: t.label });
        const [w, h] = String(val(s.value)).trim().split(/\s+/).map(Number);
        Object.assign(sz, { w, h, label: sz.label || t.label });
        break;
      }
      case 'ParamCustomPageSize': {
        ppd.custom = ppd.custom || {};
        const p = String(val(s.value)).trim().split(/\s+/);
        const which = splitTrans(s.option).key;
        if (which === 'Width') { ppd.custom.minW = Number(p[2]); ppd.custom.maxW = Number(p[3]); }
        if (which === 'Height') { ppd.custom.minH = Number(p[2]); ppd.custom.maxH = Number(p[3]); }
        break;
      }
      case 'CustomPageSize': ppd.custom = { ...(ppd.custom || {}), code: unhex(val(s.value)) }; break;
      default: {
        // *DefaultX: value
        if (k.startsWith('Default') && k.length > 7) {
          const key = k.slice(7);
          if (ppd.options[key] || current?.key === key) ensure(key).default = String(val(s.value)).trim();
          else (ppd.defaults || (ppd.defaults = {}))[key] = String(val(s.value)).trim();
          break;
        }
        // A choice of the open UI option: *Key Choice/Label: "code"
        if (current && k === current.key && s.option) {
          const t = splitTrans(s.option);
          current.choices.push({ key: t.key, label: t.label, code: unhex(val(s.value) || '') });
        }
      }
    }
  }
  // Defaults found before their OpenUI
  for (const [key, d] of Object.entries(ppd.defaults || {})) if (ppd.options[key] && !ppd.options[key].default) ppd.options[key].default = d;
  delete ppd.defaults;
  // Drop pseudo-options created only by an OrderDependency without choices (e.g. CustomPageSize)
  for (const key of Object.keys(ppd.options)) if (!ppd.options[key].choices.length) { delete ppd.options[key]; ppd.order = ppd.order.filter((x) => x !== key); }
  return ppd;
}

const cache = new Map();
const BUNDLED = { 'xerox-7845': 'xerox-7845-ppd-driver/xrx7845.ppd' };
function bundledPath(model) { return BUNDLED[model] ? path.join(__dirname, '..', 'printers', BUNDLED[model]) : null; }
function loadPpd(modelOrPath) {
  const file = bundledPath(modelOrPath) || modelOrPath;
  if (!file) throw new Error('No printer description (PPD) for this printer');
  if (!cache.has(file)) cache.set(file, parsePpd(fs.readFileSync(file, 'latin1')));
  return cache.get(file);
}

// Every conflict between the chosen options, as readable messages.
function conflicts(ppd, picks) {
  const out = [];
  const seen = new Set();
  for (const c of ppd.constraints) {
    const a = picks[c.a], b = picks[c.b];
    if (a == null || b == null) continue;
    const aHit = c.aChoice ? a === c.aChoice : !/^(none|false|off)$/i.test(a);
    const bHit = c.bChoice ? b === c.bChoice : !/^(none|false|off)$/i.test(b);
    if (!aHit || !bHit) continue;
    const id = [c.a, a, c.b, b].sort().join('|');
    if (seen.has(id)) continue;
    seen.add(id);
    const lbl = (opt, ch) => {
      const o = ppd.options[opt];
      return `${o?.label || opt}: ${o?.choices.find((x) => x.key === ch)?.label || ch}`;
    };
    out.push({ a: c.a, b: c.b, message: `${lbl(c.a, a)} can't be used with ${lbl(c.b, b)}` });
  }
  return out;
}

// The choices of option `key` that are allowed with everything else picked.
function allowedChoices(ppd, picks, key) {
  const o = ppd.options[key];
  if (!o) return [];
  return o.choices.filter((ch) => !conflicts(ppd, { ...picks, [key]: ch.key }).some((c) => c.a === key || c.b === key)).map((c) => c.key);
}

// PostScript feature code for the chosen options, in the PPD's order, each wrapped so a printer that
// rejects one feature still prints the job (the way Adobe/Windows PS drivers send them).
function featureCode(ppd, picks, { section = 'AnySetup', sizeOverride } = {}) {
  const parts = [];
  const keys = Object.keys(ppd.options)
    .filter((k) => !ppd.options[k].jcl && (ppd.options[k].section === section || ppd.options[k].section === 'AnySetup' || section === 'any'))
    .sort((a, b) => ppd.options[a].order - ppd.options[b].order);
  for (const key of keys) {
    if (key === 'PageRegion') continue; // PageSize is used instead
    const o = ppd.options[key];
    let choice = picks[key];
    if (key === 'PageSize' && sizeOverride) {
      const { w, h } = sizeOverride;
      parts.push(`[{\n%%BeginFeature: *CustomPageSize True\n${w.toFixed(2)} ${h.toFixed(2)} 0 0 0\n${(ppd.custom?.code || '').trim()}\n%%EndFeature\n} stopped cleartomark`);
      continue;
    }
    if (choice == null) {
      if (key !== 'SetPageDevice') continue;
      choice = o.default;
    }
    const ch = o.choices.find((c) => c.key === choice);
    if (!ch) continue;
    if (!ch.code.trim()) continue;
    parts.push(`[{\n%%BeginFeature: *${key} ${ch.key}\n${ch.code.trim()}\n%%EndFeature\n} stopped cleartomark`);
  }
  return parts.join('\n');
}

// JCL (PJL) options from the PPD, e.g. banner sheet
function jclCode(ppd, picks) {
  return Object.values(ppd.options).filter((o) => o.jcl).sort((a, b) => a.order - b.order).map((o) => {
    const ch = o.choices.find((c) => c.key === (picks[o.key] ?? o.default));
    return ch ? ch.code : '';
  }).join('');
}

module.exports = { parsePpd, loadPpd, conflicts, allowedChoices, featureCode, jclCode, unhex, BUNDLED };
