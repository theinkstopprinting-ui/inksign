// Turns an SVG file (Illustrator, CorelDRAW, Inkscape exports) into cut paths in mm.
import svgpath from 'svgpath';
import { flattenCommands, normalize } from './geometry.js';

const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };

function lengthMm(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^([\d.]+)\s*(mm|cm|in|pt|pc|px)?$/i);
  if (!m) return null;
  return parseFloat(m[1]) * UNIT_MM[(m[2] || '').toLowerCase()];
}

const num = (el, a) => parseFloat(el.getAttribute(a) || '0') || 0;

function shapeToD(el) {
  switch (el.tagName.toLowerCase()) {
    case 'path': return el.getAttribute('d') || '';
    case 'rect': {
      const x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
      let rx = num(el, 'rx'), ry = num(el, 'ry');
      if (!rx && ry) rx = ry; if (!ry && rx) ry = rx;
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      if (!rx) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    case 'circle': case 'ellipse': {
      const cx = num(el, 'cx'), cy = num(el, 'cy');
      const rx = el.tagName.toLowerCase() === 'circle' ? num(el, 'r') : num(el, 'rx');
      const ry = el.tagName.toLowerCase() === 'circle' ? rx : num(el, 'ry');
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case 'line': return `M${num(el, 'x1')} ${num(el, 'y1')}L${num(el, 'x2')} ${num(el, 'y2')}`;
    case 'polyline': case 'polygon': {
      const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
      if (pts.length < 4) return '';
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      return el.tagName.toLowerCase() === 'polygon' ? d + 'Z' : d;
    }
    default: return '';
  }
}

function hidden(el) {
  for (let n = el; n && n.getAttribute; n = n.parentNode) {
    if (n.getAttribute('display') === 'none' || /display\s*:\s*none/.test(n.getAttribute('style') || '')) return true;
    const t = n.tagName?.toLowerCase();
    if (t === 'defs' || t === 'clippath' || t === 'mask' || t === 'symbol' || t === 'pattern') return true;
  }
  return false;
}

// svgpath -> {type, ...} absolute commands
function toCommands(d) {
  const cmds = [];
  svgpath(d).abs().unarc().unshort().iterate((seg, _i, x, y) => {
    const t = seg[0];
    if (t === 'M') cmds.push({ type: 'M', x: seg[1], y: seg[2] });
    else if (t === 'L') cmds.push({ type: 'L', x: seg[1], y: seg[2] });
    else if (t === 'H') cmds.push({ type: 'L', x: seg[1], y });
    else if (t === 'V') cmds.push({ type: 'L', x, y: seg[1] });
    else if (t === 'C') cmds.push({ type: 'C', x1: seg[1], y1: seg[2], x2: seg[3], y2: seg[4], x: seg[5], y: seg[6] });
    else if (t === 'Q') cmds.push({ type: 'Q', x1: seg[1], y1: seg[2], x: seg[3], y: seg[4] });
    else if (t === 'Z') cmds.push({ type: 'Z' });
  });
  return cmds;
}

// Illustrator puts colors in a <style> block (.cls-1{fill:#e30613}).
function classColors(doc) {
  const map = {};
  doc.querySelectorAll('style').forEach((st) => {
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(st.textContent))) {
      const decl = m[2];
      const fill = (decl.match(/fill\s*:\s*([^;]+)/) || [])[1];
      const stroke = (decl.match(/stroke\s*:\s*([^;]+)/) || [])[1];
      m[1].split(',').map((x) => x.trim()).filter((x) => x.startsWith('.')).forEach((sel) => {
        map[sel.slice(1)] = { ...(map[sel.slice(1)] || {}), ...(fill ? { fill: fill.trim() } : {}), ...(stroke ? { stroke: stroke.trim() } : {}) };
      });
    }
  });
  return map;
}

function styleProp(el, prop, classes) {
  const st = el.getAttribute('style') || '';
  const m = st.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  if (m) return m[1].trim();
  if (el.getAttribute(prop)) return el.getAttribute(prop).trim();
  for (const c of (el.getAttribute('class') || '').split(/\s+/)) if (classes[c]?.[prop]) return classes[c][prop];
  return null;
}

function colorOf(el, classes) {
  for (let n = el; n && n.getAttribute; n = n.parentNode) {
    const fill = styleProp(n, 'fill', classes);
    if (fill && fill !== 'none' && !fill.startsWith('url')) return normColor(fill);
    const stroke = styleProp(n, 'stroke', classes);
    if (stroke && stroke !== 'none' && !stroke.startsWith('url')) return normColor(stroke);
  }
  return '#000000';
}

function normColor(c) {
  c = c.toLowerCase();
  const named = { black: '#000000', white: '#ffffff', red: '#ff0000', blue: '#0000ff', green: '#008000', yellow: '#ffff00' };
  if (named[c]) return named[c];
  const m3 = c.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
  const rgb = c.match(/rgb\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/);
  if (rgb) return '#' + rgb.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join('');
  return c;
}

export function importSvg(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  if (!svg || doc.querySelector('parsererror')) throw new Error('That file is not a readable SVG.');

  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const wMm = lengthMm(svg.getAttribute('width'));
  let mmPerUnit = 25.4 / 96;
  if (vb.length === 4 && vb[2] > 0 && wMm) mmPerUnit = wMm / vb[2];
  else if (wMm && !(vb.length === 4)) mmPerUnit = UNIT_MM[(String(svg.getAttribute('width')).match(/[a-z]+$/i) || [''])[0].toLowerCase()] || mmPerUnit;

  const classes = classColors(doc);
  const all = [];
  const colors = [];
  svg.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon').forEach((el) => {
    if (hidden(el)) return;
    const d = shapeToD(el);
    if (!d) return;
    // Apply transforms from the element up to the root (innermost first)
    let sp = svgpath(d);
    for (let n = el; n && n !== svg.parentNode; n = n.parentNode) {
      const tr = n.getAttribute && n.getAttribute('transform');
      if (tr) sp = sp.transform(tr);
    }
    if (vb.length === 4) sp = sp.translate(-vb[0], -vb[1]);
    const flat = flattenCommands(toCommands(sp.toString()), mmPerUnit);
    const color = colorOf(el, classes);
    all.push(...flat);
    flat.forEach(() => colors.push(color));
  });
  if (!all.length) throw new Error('No cut lines found. If this came from Illustrator, convert text to outlines first.');
  return { paths: normalize(all), colors };
}
