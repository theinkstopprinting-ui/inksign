// Text objects for the Design workspace: live, editable text in an installed font. The outline is
// rebuilt whenever the words, font, size or spacing change, so a text object is always ready to
// print or cut. "Convert to outlines" turns it into a plain shape.
import { loadFont, textToPaths, textOnArc } from './text.js';
import { bounds } from './geometry.js';
import { newId, DEFAULT_STROKE } from './doc.js';

export const TEXT_DEFAULTS = { text: 'Text', sizeMm: 25.4, tracking: 0, lineSpacing: 1.2, align: 'left', arc: null };

async function outlineFor(o) {
  const font = await loadFont(o.font);
  const opts = { heightMm: o.sizeMm, letterSpacing: o.tracking || 0, lineSpacing: o.lineSpacing || 1.2, align: o.align || 'left' };
  let paths = o.arc && o.arc.on
    ? textOnArc(font, o.text, { heightMm: o.sizeMm, radiusMm: o.arc.radiusMm || 150, position: o.arc.position || 'top', letterSpacing: o.tracking || 0 })
    : textToPaths(font, o.text, opts);
  if (!paths.length) paths = [[{ x: 0, y: 0 }, { x: 0.01, y: 0 }]]; // blank text stays selectable
  const b = bounds(paths);
  return { paths: paths.map((p) => p.map((q) => ({ x: q.x - b.minX, y: q.y - b.minY }))), bw: Math.max(b.w, 0.01), bh: Math.max(b.h, 0.01) };
}

/** New text object at (x, y) */
export async function makeText({ x = 0, y = 0, font, fontName, fill = { type: 'solid', color: '#000000' }, ...props }) {
  const o = {
    id: newId(), type: 'text', name: 'Text', ...TEXT_DEFAULTS, ...props, font, fontName,
    x, y, w: 0, h: 0, rot: 0, flipX: false, flipY: false, fill, stroke: DEFAULT_STROKE,
    locked: false, hidden: false, cut: false, groupId: null, fillRule: 'nonzero',
  };
  const out = await outlineFor(o);
  return { ...o, ...out, w: out.bw, h: out.bh, name: shortName(o.text) };
}

/**
 * Apply text property changes and rebuild the outline. Keeps any stretch the object had
 * (its width/height scale) and keeps its top-left in place.
 */
export async function retext(o, patch) {
  const next = { ...o, ...patch };
  const sx = o.bw ? o.w / o.bw : 1, sy = o.bh ? o.h / o.bh : 1;
  const resetScale = 'sizeMm' in patch; // a new size means "this tall", so drop any stretch
  const out = await outlineFor(next);
  const w = out.bw * (resetScale ? 1 : sx), h = out.bh * (resetScale ? 1 : sy);
  return { ...next, ...out, w, h, name: o.name === shortName(o.text) || o.name === 'Text' ? shortName(next.text) : o.name };
}

export function toOutlines(o) {
  const { text, font, fontName, sizeMm, tracking, lineSpacing, align, arc, ...rest } = o;
  return { ...rest, type: 'shape', name: o.name || 'Text outlines' };
}

export const shortName = (t) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s ? (s.length > 24 ? `${s.slice(0, 22)}…` : s) : 'Text';
};

/** Case changes (Text > Case) */
export function changeCase(text, mode) {
  if (mode === 'upper') return text.toUpperCase();
  if (mode === 'lower') return text.toLowerCase();
  if (mode === 'title') return text.toLowerCase().replace(/(^|\s|[-/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  if (mode === 'sentence') return text.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  return text;
}

/** Auto serialize: the text for copy i */
export function serialText(template, { start = 1, step = 1, pad = 0, prefix = '', suffix = '' }, i) {
  const v = String(start + i * step);
  if (template && template.includes('#')) return template.replace(/#+/, (m) => v.padStart(Math.max(pad, m.length), '0'));
  return `${prefix}${v.padStart(pad, '0')}${suffix}`;
}
