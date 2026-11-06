// Flexi's Effects menu, on Design objects: Combine (weld, weld by color, cut out, remove overlap,
// common, exclude common, fuse, separate overlap), Outline, Contour Cut, Shadow, Blend, Distort,
// Stripe, Rhinestone Fill, Finisher (grommets), Trim Marks, Page Contour Cut, Break Apart.
// Each takes (doc, ids, options) and returns { doc, ids } — the new selection.
import { isClosed, bounds } from './geometry.js';
import { boolean, weld, groupShapes, rhinestones } from './cuttools.js';
import { offsetPaths } from './offset.js';
import { envelope } from './design.js';
import { ellipse, rectangle } from './shapes.js';
import { placedPaths, shapeFromPaths, newId, CUT_COLOR } from './doc.js';

const sel = (doc, ids) => doc.objects.filter((o) => ids.includes(o.id) && !o.hidden);
const isVector = (o) => o.type !== 'image';
const fillOf = (o) => (o.fill && o.fill.type !== 'none' ? o.fill : { type: 'solid', color: o.stroke?.color || '#000000' });

// Replace the selected objects with new ones, at the bottom-most selected object's place in the stack
function replace(doc, ids, made) {
  const idx = doc.objects.findIndex((o) => ids.includes(o.id));
  const rest = doc.objects.filter((o) => !ids.includes(o.id));
  const at = idx < 0 ? rest.length : doc.objects.slice(0, idx).filter((o) => !ids.includes(o.id)).length;
  return { doc: { ...doc, objects: [...rest.slice(0, at), ...made, ...rest.slice(at)] }, ids: made.map((o) => o.id) };
}
// Add new objects just below (behind) or above the selection
function insert(doc, ids, made, where = 'below') {
  const idxs = doc.objects.map((o, i) => (ids.includes(o.id) ? i : -1)).filter((i) => i >= 0);
  const at = where === 'below' ? Math.min(...idxs) : Math.max(...idxs) + 1;
  const objs = doc.objects.slice();
  objs.splice(at, 0, ...made);
  return { doc: { ...doc, objects: objs }, ids: made.map((o) => o.id) };
}
const closedOf = (o) => placedPaths(o).filter(isClosed);
// The solid area of several objects: each object read on its own (letter holes stay holes), then merged —
// so a background box with lettering on top counts as the whole box, not box-minus-letters.
function solidOf(objs) {
  const art = objs.filter((o) => !o.cut);
  const use = art.length ? art : objs;
  const parts = use.flatMap((o) => weld(o.type === 'image' ? placedPaths(o) : closedOf(o)));
  return parts.length ? weld(parts) : [];
}
const mk = (paths, like, extra = {}) => shapeFromPaths(paths, { fill: like.fill, stroke: like.stroke, name: like.name, fillRule: 'evenodd', ...extra });

// ---------- Combine ----------
export const COMBINE = [
  { id: 'weld', name: 'Weld', help: 'Merge overlapping shapes into one outline' },
  { id: 'weldColor', name: 'Weld by color', help: 'Weld the shapes that share a fill color' },
  { id: 'cutout', name: 'Cut out', help: 'The top shape cuts a hole through everything under it' },
  { id: 'removeOverlap', name: 'Remove overlap', help: 'Each shape loses the parts covered by shapes above it (no vinyl stacking)' },
  { id: 'common', name: 'Common', help: 'Keep only the area all shapes share' },
  { id: 'exclude', name: 'Exclude common', help: 'Keep everything except where shapes overlap' },
  { id: 'fuse', name: 'Fuse', help: 'Remove overlap, then weld touching shapes of the same color' },
  { id: 'separate', name: 'Separate overlap', help: 'Split overlaps into their own pieces' },
];

export function combine(doc, ids, mode) {
  const objs = sel(doc, ids).filter(isVector);
  if (objs.length < (mode === 'weld' || mode === 'weldColor' || mode === 'fuse' ? 1 : 2)) throw new Error(mode === 'weld' ? 'Select the shapes to weld' : 'Select two or more shapes');
  const allIds = objs.map((o) => o.id);
  if (mode === 'weld') {
    const out = weld(objs.flatMap(closedOf));
    return replace(doc, allIds, [mk(out, objs[0], { name: 'Welded' })]);
  }
  if (mode === 'weldColor' || mode === 'fuse') {
    let pieces = objs.map((o) => ({ o, paths: closedOf(o) }));
    if (mode === 'fuse') pieces = removeOverlapPieces(pieces);
    const byColor = new Map();
    for (const p of pieces) { const k = JSON.stringify(fillOf(p.o)); if (!byColor.has(k)) byColor.set(k, []); byColor.get(k).push(p); }
    const made = [...byColor.values()].map((g) => mk(weld(g.flatMap((p) => p.paths)), g[0].o));
    return replace(doc, allIds, made.filter((o) => o.paths.length));
  }
  if (mode === 'cutout') {
    const top = objs[objs.length - 1];
    const hole = closedOf(top);
    const made = objs.slice(0, -1).map((o) => mk(boolean(closedOf(o), hole, 'difference'), o)).filter((o) => o.paths.length);
    return replace(doc, allIds, made);
  }
  if (mode === 'removeOverlap') {
    const made = removeOverlapPieces(objs.map((o) => ({ o, paths: closedOf(o) }))).map((p) => mk(p.paths, p.o)).filter((o) => o.paths.length);
    return replace(doc, allIds, made);
  }
  if (mode === 'common') {
    let acc = closedOf(objs[0]);
    for (const o of objs.slice(1)) acc = boolean(acc, closedOf(o), 'intersection');
    if (!acc.length) throw new Error('These shapes don\'t overlap');
    return replace(doc, allIds, [mk(acc, objs[objs.length - 1], { name: 'Common' })]);
  }
  if (mode === 'exclude') {
    let acc = closedOf(objs[0]);
    for (const o of objs.slice(1)) acc = boolean(acc, closedOf(o), 'xor');
    return replace(doc, allIds, [mk(acc, objs[0], { name: 'Exclude common' })]);
  }
  if (mode === 'separate') {
    const made = [];
    const pieces = objs.map((o) => ({ o, paths: closedOf(o) }));
    for (let i = 0; i < pieces.length; i++) {
      let own = pieces[i].paths;
      for (let j = 0; j < pieces.length; j++) if (j !== i) own = boolean(own, pieces[j].paths, 'difference');
      if (own.length) made.push(mk(own, pieces[i].o));
    }
    for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
      const common = boolean(pieces[i].paths, pieces[j].paths, 'intersection');
      if (common.length) made.push(mk(common, pieces[j].o, { name: 'Overlap' }));
    }
    return replace(doc, allIds, made);
  }
  throw new Error('Unknown combine');
}
function removeOverlapPieces(pieces) {
  return pieces.map((p, i) => {
    const above = pieces.slice(i + 1).flatMap((q) => q.paths);
    return { o: p.o, paths: above.length ? boolean(p.paths, above, 'difference') : p.paths };
  });
}

/** Break apart: a compound shape becomes one object per piece (letters keep their holes) */
export function breakApart(doc, ids) {
  const made = [];
  const keep = [];
  for (const o of sel(doc, ids)) {
    if (!isVector(o)) { keep.push(o.id); continue; }
    const pp = placedPaths(o);
    const open = pp.filter((p) => !isClosed(p));
    const groups = groupShapes(pp.filter(isClosed));
    for (const g of groups) made.push(mk(g, o, { cut: o.cut, groupId: null }));
    for (const p of open) made.push(mk([p], o, { cut: o.cut, groupId: null }));
  }
  return replace(doc, ids.filter((id) => !keep.includes(id)), made);
}

/** Combine into one compound object (Arrange > Compound) */
export function compound(doc, ids) {
  const objs = sel(doc, ids).filter(isVector);
  if (objs.length < 2) throw new Error('Select two or more shapes');
  return replace(doc, objs.map((o) => o.id), [mk(objs.flatMap(placedPaths), objs[0], { name: 'Compound', cut: objs[0].cut })]);
}

// ---------- Outline / contour cut ----------
/** Outline: a new shape this far outside (or inside, negative) the selection, behind it */
export function outline(doc, ids, { distMm = 3, corners = 'round', outerOnly = true, color = '#ffffff', stroke = null } = {}) {
  const src = solidOf(sel(doc, ids).filter(isVector));
  if (!src.length) throw new Error('Select closed shapes');
  const out = offsetPaths(src, distMm, { corners, outerOnly });
  const o = shapeFromPaths(out, { name: 'Outline', fill: { type: 'solid', color }, stroke: stroke || { color: null, width: 0 }, fillRule: 'evenodd' });
  return insert(doc, ids, [o], distMm >= 0 ? 'below' : 'above');
}

/**
 * Contour cut: a CutContour line around the selection (art, text, or pictures — a picture uses its
 * frame unless traced paths are passed in `paths`).
 */
export function contourCut(doc, ids, { offsetMm = 1.5, corners = 'round', outerOnly = true, paths = null } = {}) {
  const src = paths || solidOf(sel(doc, ids));
  if (!src.length) throw new Error('Select the art to cut around');
  const out = offsetPaths(src, offsetMm, { corners, outerOnly });
  const o = shapeFromPaths(out, { name: 'CutContour', fill: { type: 'none' }, stroke: { color: CUT_COLOR, width: 0 }, cut: true });
  return insert(doc, ids, [o], 'above');
}

/** Page contour cut mark: a cut line around the whole page (or inset by marginMm) */
export function pageContourCut(doc, { marginMm = 0, radiusMm = 0 } = {}) {
  const r = rectangle(doc.page.w - 2 * marginMm, doc.page.h - 2 * marginMm, radiusMm);
  const o = shapeFromPaths(r, { x: marginMm, y: marginMm, name: 'Page contour cut', fill: { type: 'none' }, stroke: { color: CUT_COLOR, width: 0 }, cut: true });
  return { doc: { ...doc, objects: [...doc.objects, o] }, ids: [o.id] };
}

/** Rectangle contour cut around the selection's box (Flexi: Rectangle to Contour Cut Mark) */
export function rectContourCut(doc, ids, { marginMm = 3, radiusMm = 0 } = {}) {
  const b = bounds(sel(doc, ids).flatMap(placedPaths));
  const r = rectangle(b.w + 2 * marginMm, b.h + 2 * marginMm, radiusMm);
  const o = shapeFromPaths(r, { x: b.minX - marginMm, y: b.minY - marginMm, name: 'CutContour', fill: { type: 'none' }, stroke: { color: CUT_COLOR, width: 0 }, cut: true });
  return insert(doc, ids, [o], 'above');
}

// ---------- Shadow ----------
/** kind 'drop' = a copy pushed down/right; 'block' = solid extrusion to that offset; 'cast' = slanted, squashed */
export function shadow(doc, ids, { kind = 'drop', dxMm = 3, dyMm = 3, color = '#555555', angle = 45 } = {}) {
  const src = solidOf(sel(doc, ids).filter(isVector));
  if (!src.length) throw new Error('Select closed shapes');
  let out;
  if (kind === 'block') {
    const steps = Math.max(2, Math.ceil(Math.hypot(dxMm, dyMm) / 0.5));
    const copies = [];
    for (let i = 1; i <= steps; i++) copies.push(...src.map((p) => p.map((q) => ({ x: q.x + (dxMm * i) / steps, y: q.y + (dyMm * i) / steps }))));
    out = weld([...src, ...copies]);
  } else if (kind === 'cast') {
    const b = bounds(src);
    const t = Math.tan(((90 - angle) * Math.PI) / 180);
    out = src.map((p) => p.map((q) => { const up = b.maxY - q.y; return { x: q.x + up * t * 0.8 + dxMm, y: b.maxY - up * 0.45 + dyMm }; }));
    out = weld(out);
  } else out = weld(src.map((p) => p.map((q) => ({ x: q.x + dxMm, y: q.y + dyMm }))));
  const o = shapeFromPaths(out, { name: 'Shadow', fill: { type: 'solid', color }, stroke: { color: null, width: 0 }, fillRule: 'evenodd' });
  return insert(doc, ids, [o], 'below');
}

// ---------- Blend ----------
function resample(p, n) {
  const L = [0];
  for (let i = 1; i < p.length; i++) L.push(L[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y));
  const total = L[L.length - 1] || 1;
  const out = [];
  let k = 1;
  for (let i = 0; i < n; i++) {
    const d = (total * i) / (n - 1);
    while (k < p.length - 1 && L[k] < d) k++;
    const t = (d - L[k - 1]) / ((L[k] - L[k - 1]) || 1);
    out.push({ x: p[k - 1].x + (p[k].x - p[k - 1].x) * t, y: p[k - 1].y + (p[k].y - p[k - 1].y) * t });
  }
  return out;
}
const mixHex = (a, b, t) => {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16)), pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
};
/** Blend: steps in-between shapes morphing from the first selected shape to the second */
export function blend(doc, ids, { steps = 5 } = {}) {
  const objs = sel(doc, ids).filter(isVector);
  if (objs.length !== 2) throw new Error('Select exactly two shapes to blend');
  const [A, B] = objs;
  const pa = placedPaths(A).filter(isClosed).sort((x, y) => y.length - x.length)[0];
  const pb = placedPaths(B).filter(isClosed).sort((x, y) => y.length - x.length)[0];
  if (!pa || !pb) throw new Error('Both shapes need a closed outline');
  const N = 240;
  const ra = resample(pa, N), rb0 = resample(pb, N);
  // line the start points up so the morph doesn't twist
  let best = 0, bestD = Infinity;
  for (let s = 0; s < N; s += 4) { let d = 0; for (let i = 0; i < N; i += 12) d += Math.hypot(ra[i].x - rb0[(i + s) % N].x, ra[i].y - rb0[(i + s) % N].y); if (d < bestD) { bestD = d; best = s; } }
  const rb = ra.map((_, i) => rb0[(i + best) % N]);
  const ca = fillOf(A).color || '#000000', cb = fillOf(B).color || '#000000';
  const made = [];
  for (let s = 1; s <= steps; s++) {
    const t = s / (steps + 1);
    const p = ra.map((q, i) => ({ x: q.x + (rb[i].x - q.x) * t, y: q.y + (rb[i].y - q.y) * t }));
    p.push({ ...p[0] });
    made.push(shapeFromPaths([p], { name: 'Blend', fill: { type: 'solid', color: mixHex(ca, cb, t) }, stroke: { color: null, width: 0 } }));
  }
  // between the two in the stack
  const iB = doc.objects.findIndex((o) => o.id === B.id);
  const objsOut = doc.objects.slice();
  objsOut.splice(iB, 0, ...made);
  return { doc: { ...doc, objects: objsOut }, ids: made.map((o) => o.id) };
}

// ---------- Distort ----------
export function distort(doc, ids, kind, amount = 30) {
  let out = doc;
  const newIds = [];
  for (const o of sel(doc, ids).filter(isVector)) {
    const paths = envelope(placedPaths(o), kind, amount);
    const n = shapeFromPaths(paths, { fill: o.fill, stroke: o.stroke, name: o.name, cut: o.cut, groupId: o.groupId, fillRule: o.fillRule });
    out = { ...out, objects: out.objects.map((x) => (x.id === o.id ? n : x)) };
    newIds.push(n.id);
  }
  return { doc: out, ids: newIds };
}

// ---------- Stripe ----------
/** Stripes across the shape in a second color (Flexi: Effects > Stripe) */
export function stripe(doc, ids, { count = 3, gapMm = 3, color = '#ffffff', direction = 'h' } = {}) {
  const src = solidOf(sel(doc, ids).filter(isVector));
  if (!src.length) throw new Error('Select closed shapes');
  const b = bounds(src);
  const bands = [];
  if (direction === 'h') {
    const pitch = b.h / count;
    for (let i = 0; i < count; i++) { const y = b.minY + pitch * (i + 0.5) - gapMm / 2; bands.push(rectangle(b.w + 2, gapMm)[0].map((q) => ({ x: q.x + b.minX - 1, y: q.y + y }))); }
  } else {
    const pitch = b.w / count;
    for (let i = 0; i < count; i++) { const x = b.minX + pitch * (i + 0.5) - gapMm / 2; bands.push(rectangle(gapMm, b.h + 2)[0].map((q) => ({ x: q.x + x, y: q.y + b.minY - 1 }))); }
  }
  const cut = boolean(src, bands, 'intersection');
  const o = shapeFromPaths(cut, { name: 'Stripe', fill: { type: 'solid', color }, stroke: { color: null, width: 0 } });
  return insert(doc, ids, [o], 'above');
}

// ---------- Rhinestones ----------
export function rhinestoneFill(doc, ids, opts = {}) {
  const src = solidOf(sel(doc, ids).filter(isVector));
  const r = rhinestones(src, opts);
  if (!r.count) throw new Error('No stones fit — try a smaller stone size');
  const o = shapeFromPaths(r.paths, { name: `Rhinestones (${r.count})`, fill: { type: 'solid', color: '#c0c0c0' }, stroke: { color: null, width: 0 } });
  return { ...insert(doc, ids, [o], 'above'), count: r.count };
}

// ---------- Finisher: grommets ----------
/** Rectangle finisher: grommet marks around the selection's box (or the page) — corners plus every spacingMm */
export function rectFinisher(doc, ids, { insetMm = 19, spacingMm = 609.6, diaMm = 9.5, usePage = false, color = '#000000' } = {}) {
  const b = usePage || !ids.length ? { minX: 0, minY: 0, maxX: doc.page.w, maxY: doc.page.h, w: doc.page.w, h: doc.page.h } : bounds(sel(doc, ids).flatMap(placedPaths));
  const x0 = b.minX + insetMm, y0 = b.minY + insetMm, x1 = b.maxX - insetMm, y1 = b.maxY - insetMm;
  const pts = [];
  const along = (a, c) => { const L = Math.hypot(c.x - a.x, c.y - a.y); const n = Math.max(1, Math.round(L / spacingMm)); for (let i = 0; i < n; i++) pts.push({ x: a.x + ((c.x - a.x) * i) / n, y: a.y + ((c.y - a.y) * i) / n }); };
  along({ x: x0, y: y0 }, { x: x1, y: y0 }); along({ x: x1, y: y0 }, { x: x1, y: y1 }); along({ x: x1, y: y1 }, { x: x0, y: y1 }); along({ x: x0, y: y1 }, { x: x0, y: y0 });
  return grommets(doc, ids, pts, diaMm, color);
}
/** Shape finisher: grommets along the selected shape's outline */
export function shapeFinisher(doc, ids, { insetMm = 19, spacingMm = 304.8, diaMm = 9.5, color = '#000000' } = {}) {
  const src = solidOf(sel(doc, ids).filter(isVector));
  if (!src.length) throw new Error('Select a closed shape');
  const inner = insetMm ? offsetPaths(src, -insetMm, { outerOnly: true }) : src;
  const pts = [];
  for (const p of inner) {
    const r = resample(p, Math.max(4, Math.round(p.reduce((s, q, i) => (i ? s + Math.hypot(q.x - p[i - 1].x, q.y - p[i - 1].y) : 0), 0) / spacingMm) + 1));
    pts.push(...r.slice(0, -1));
  }
  return grommets(doc, ids, pts, diaMm, color);
}
function grommets(doc, ids, pts, diaMm, color) {
  const c = ellipse(diaMm, diaMm)[0];
  const paths = pts.map((pt) => c.map((q) => ({ x: q.x + pt.x - diaMm / 2, y: q.y + pt.y - diaMm / 2 })));
  const o = shapeFromPaths(paths, { name: `Grommets (${pts.length})`, fill: { type: 'none' }, stroke: { color, width: 0.35 } });
  return { doc: { ...doc, objects: [...doc.objects, o] }, ids: [o.id], count: pts.length };
}

// ---------- Trim marks ----------
export function trimMarks(doc, ids, { offsetMm = 3, lengthMm = 6, usePage = false } = {}) {
  const b = usePage || !ids.length ? { minX: 0, minY: 0, maxX: doc.page.w, maxY: doc.page.h } : bounds(sel(doc, ids).flatMap(placedPaths));
  const L = lengthMm, d = offsetMm, lines = [];
  for (const [x, sx] of [[b.minX, -1], [b.maxX, 1]]) for (const [y, sy] of [[b.minY, -1], [b.maxY, 1]]) {
    lines.push([{ x: x + sx * d, y }, { x: x + sx * (d + L), y }]);
    lines.push([{ x, y: y + sy * d }, { x, y: y + sy * (d + L) }]);
  }
  const o = shapeFromPaths(lines, { name: 'Trim marks', fill: { type: 'none' }, stroke: { color: '#000000', width: 0.25 } });
  return { doc: { ...doc, objects: [...doc.objects, o] }, ids: [o.id] };
}

// ---------- Gradient -> bands (for PDF output, where pdf-lib has no shadings) ----------
export function gradientBands(paths, fill, n = 48) {
  const b = bounds(paths);
  const out = [];
  const ang = ((fill.angle || 0) * Math.PI) / 180;
  const c1 = fill.color || '#000000', c2 = fill.color2 || '#ffffff';
  const closed = paths.filter(isClosed);
  if (fill.type === 'radial') {
    const cx = b.minX + b.w / 2, cy = b.minY + b.h / 2, R = Math.hypot(b.w, b.h) / 2;
    for (let i = n; i >= 1; i--) {
      const r = (R * i) / n;
      const disc = ellipse(2 * r, 2 * r)[0].map((q) => ({ x: q.x + cx - r, y: q.y + cy - r }));
      const inner = i > 1 ? [ellipse(2 * (R * (i - 1)) / n, 2 * (R * (i - 1)) / n)[0].map((q) => ({ x: q.x + cx - (R * (i - 1)) / n, y: q.y + cy - (R * (i - 1)) / n }))] : [];
      const ring = boolean(boolean(closed, [disc], 'intersection'), inner, 'difference');
      if (ring.length) out.push({ paths: ring, color: mixHex(c1, c2, (i - 0.5) / n) });
    }
    return out;
  }
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const corners = [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]].map(([x, y]) => x * dx + y * dy);
  const lo = Math.min(...corners), hi = Math.max(...corners);
  const span = hi - lo || 1, big = Math.hypot(b.w, b.h) + 10;
  const cx = b.minX + b.w / 2, cy = b.minY + b.h / 2, c0 = cx * dx + cy * dy;
  for (let i = 0; i < n; i++) {
    const s0 = lo + (span * i) / n - 0.02, s1 = lo + (span * (i + 1)) / n + 0.02;
    const band = [[s0, -big], [s1, -big], [s1, big], [s0, big], [s0, -big]].map(([s, t]) => {
      const u = s - c0;
      return { x: cx + u * dx - t * dy, y: cy + u * dy + t * dx };
    });
    const piece = boolean(closed, [band], 'intersection');
    if (piece.length) out.push({ paths: piece, color: mixHex(c1, c2, (i + 0.5) / n) });
  }
  return out;
}

export { mixHex, newId };
