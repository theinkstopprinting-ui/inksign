// Design document -> what leaves the page: a flat "scene" for the PDF writer in the main process
// (electron/lib/designPdf.js), SVG text, and cut paths for the cutter.
import { placedPaths, placePoint, pathD, objBounds } from './doc.js';
import { gradientBands } from './docEffects.js';
import { isClosed, bounds, sortCutOrder } from './geometry.js';

const visible = (doc) => doc.objects.filter((o) => !o.hidden);

export function imageMatrix(o) {
  const p0 = placePoint(o, { x: 0, y: 0 }), px = placePoint(o, { x: o.bw, y: 0 }), py = placePoint(o, { x: 0, y: o.bh });
  return [px.x - p0.x, px.y - p0.y, py.x - p0.x, py.y - p0.y, p0.x, p0.y];
}

/** opts.marks: print & cut registration marks { margin, size, thickness } */
export function toScene(doc, { marks = null, only = null } = {}) {
  const items = [];
  for (const o of visible(doc)) {
    if (only && !only.includes(o.id)) continue;
    const opacity = o.opacity != null && o.opacity < 1 ? o.opacity : undefined;
    if (o.type === 'image') { items.push({ kind: 'image', dataUrl: o.src, m: imageMatrix(o), opacity }); continue; }
    const paths = placedPaths(o);
    if (!paths.length) continue;
    if (o.cut) { items.push({ kind: 'path', paths, cut: true }); continue; }
    const f = o.fill || { type: 'none' };
    const strokeOn = o.stroke && o.stroke.color && o.stroke.width > 0;
    if (f.type === 'linear' || f.type === 'radial') {
      for (const band of gradientBands(paths, f)) items.push({ kind: 'path', paths: band.paths, fill: band.color, fillRule: 'evenodd', opacity });
      if (strokeOn) items.push({ kind: 'path', paths, stroke: o.stroke.color, strokeMm: o.stroke.width, opacity });
      continue;
    }
    items.push({
      kind: 'path', paths, fillRule: o.fillRule || 'evenodd', opacity,
      fill: f.type === 'solid' ? f.color : null,
      stroke: strokeOn ? o.stroke.color : null, strokeMm: strokeOn ? o.stroke.width : 0,
    });
  }
  return { w: doc.page.w, h: doc.page.h, name: doc.name, items, marks };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const f3 = (v) => +v.toFixed(3);

export function toSvg(doc) {
  const defs = [];
  const body = [];
  if (doc.page.color && doc.page.color !== '#ffffff') body.push(`<rect width="${f3(doc.page.w)}" height="${f3(doc.page.h)}" fill="${doc.page.color}"/>`);
  let g = 0;
  for (const o of visible(doc)) {
    const op = o.opacity != null && o.opacity < 1 ? ` opacity="${o.opacity}"` : '';
    if (o.type === 'image') {
      const m = imageMatrix(o).map(f3).join(' ');
      body.push(`<image href="${o.src}" x="0" y="0" width="1" height="1" preserveAspectRatio="none" transform="matrix(${m})"${op}/>`);
      continue;
    }
    const d = pathD(placedPaths(o));
    if (!d) continue;
    if (o.cut) { body.push(`<path id="CutContour-${o.id}" class="CutContour" d="${d}" fill="none" stroke="#ff00ff" stroke-width="0.25"/>`); continue; }
    const f = o.fill || { type: 'none' };
    let fill = 'none';
    if (f.type === 'solid') fill = f.color;
    else if (f.type === 'linear' || f.type === 'radial') {
      const id = `g${g++}`;
      const b = objBounds(o);
      if (f.type === 'linear') {
        const a = ((f.angle || 0) * Math.PI) / 180, cx = b.minX + b.w / 2, cy = b.minY + b.h / 2, r = Math.hypot(b.w, b.h) / 2;
        defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f3(cx - Math.cos(a) * r)}" y1="${f3(cy - Math.sin(a) * r)}" x2="${f3(cx + Math.cos(a) * r)}" y2="${f3(cy + Math.sin(a) * r)}"><stop offset="0" stop-color="${f.color}"/><stop offset="1" stop-color="${f.color2 || '#ffffff'}"/></linearGradient>`);
      } else defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${f3(b.minX + b.w / 2)}" cy="${f3(b.minY + b.h / 2)}" r="${f3(Math.hypot(b.w, b.h) / 2)}"><stop offset="0" stop-color="${f.color}"/><stop offset="1" stop-color="${f.color2 || '#ffffff'}"/></radialGradient>`);
      fill = `url(#${id})`;
    }
    const s = o.stroke && o.stroke.color && o.stroke.width > 0 ? ` stroke="${o.stroke.color}" stroke-width="${f3(o.stroke.width)}" stroke-linejoin="round"` : '';
    body.push(`<path d="${d}" fill="${fill}" fill-rule="${o.fillRule === 'nonzero' ? 'nonzero' : 'evenodd'}"${s}${op}><title>${esc(o.name || '')}</title></path>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${f3(doc.page.w)}mm" height="${f3(doc.page.h)}mm" viewBox="0 0 ${f3(doc.page.w)} ${f3(doc.page.h)}">\n${defs.length ? `<defs>${defs.join('')}</defs>\n` : ''}${body.join('\n')}\n</svg>\n`;
}

/**
 * Paths for the cutter.
 * what: 'cut' = only CutContour lines, 'all' = every vector shape's outline, 'color' = grouped by fill color
 * Returns [{ name, color, paths }] in page mm (y down).
 */
export function cutGroups(doc, what = 'auto', ids = null) {
  const objs = visible(doc).filter((o) => o.type !== 'image' && (!ids || ids.includes(o.id)));
  const cuts = objs.filter((o) => o.cut);
  const mode = what === 'auto' ? (cuts.length ? 'cut' : 'color') : what;
  if (mode === 'cut') return cuts.length ? [{ name: 'Contour cut', color: null, paths: cuts.flatMap(placedPaths) }] : [];
  const art = objs.filter((o) => !o.cut);
  if (mode === 'all') return [{ name: 'All shapes', color: null, paths: art.flatMap(placedPaths) }];
  const m = new Map();
  for (const o of art) {
    const c = o.fill?.type === 'solid' ? o.fill.color : o.fill?.type !== 'none' && o.fill ? o.fill.color : o.stroke?.color || '#000000';
    if (!m.has(c)) m.set(c, []);
    m.get(c).push(...placedPaths(o));
  }
  return [...m.entries()].map(([color, paths]) => ({ name: color, color, paths }));
}

/** One cutter panel per group, moved to the origin, in cut order (what jobs:sendCut takes) */
export function cutPanels(groups, { weedMm = 0, mirror = false } = {}) {
  return groups.filter((g) => g.paths.length).map((g) => {
    let paths = g.paths;
    if (mirror) { const b = bounds(paths); paths = paths.map((p) => p.map((q) => ({ x: b.maxX - (q.x - b.minX), y: q.y }))); }
    if (weedMm > 0) {
      const b = bounds(paths);
      const box = [{ x: b.minX - weedMm, y: b.minY - weedMm }, { x: b.maxX + weedMm, y: b.minY - weedMm }, { x: b.maxX + weedMm, y: b.maxY + weedMm }, { x: b.minX - weedMm, y: b.maxY + weedMm }];
      box.push({ ...box[0] });
      paths = [...paths, box];
    }
    const b = bounds(paths);
    const moved = paths.map((p) => p.map((q) => ({ x: q.x - b.minX, y: q.y - b.minY })));
    return { name: g.name, paths: sortCutOrder(moved), color: g.color };
  });
}

export const closedCount = (paths) => paths.filter(isClosed).length;

/** A scene cut down to a box (mm on the page) — Flexi prints the art's bounding box, not the whole page */
export function cropScene(scene, b) {
  const dx = -b.minX, dy = -b.minY;
  const items = scene.items.map((it) => (it.kind === 'image'
    ? { ...it, m: [it.m[0], it.m[1], it.m[2], it.m[3], it.m[4] + dx, it.m[5] + dy] }
    : { ...it, paths: it.paths.map((p) => p.map((q) => ({ x: q.x + dx, y: q.y + dy }))) }));
  return { ...scene, w: b.maxX - b.minX, h: b.maxY - b.minY, items };
}
