// The Design workspace document (Flexi-style): a page with objects. Units: mm, origin at the page's
// top-left, y down (like SVG). Pure functions — no React, no DOM — so they can be tested.
//
// Every object keeps its outline in its own box (0..bw × 0..bh) and a placement: x, y, w, h, rot (degrees,
// about the box centre), flipX, flipY. Shapes, text and traced art are polylines (curves are flattened finely),
// which every tool — weld, offset, contour cut, the cutter — already works with.
import { bounds, isClosed } from './geometry.js';

export const MM = 25.4;
let seq = 1;
export const newId = () => `o${Date.now().toString(36)}${(seq++).toString(36)}`;

export const CUT_COLOR = '#ff00ff'; // shown magenta, like Flexi's CutContour
export const DEFAULT_FILL = { type: 'solid', color: '#000000' };
export const NO_FILL = { type: 'none' };
export const DEFAULT_STROKE = { color: null, width: 0 };

export function newDoc({ widthIn = 24, heightIn = 12, name = 'Untitled' } = {}) {
  return { version: 1, name, page: { w: widthIn * MM, h: heightIn * MM, color: '#ffffff' }, guides: { x: [], y: [] }, objects: [] };
}

// ---- objects ----
export function shapeFromPaths(paths, { x, y, w, h, fill = DEFAULT_FILL, stroke = DEFAULT_STROKE, name = 'Shape', ...rest } = {}) {
  const b = bounds(paths);
  const bw = Math.max(b.w, 0.001), bh = Math.max(b.h, 0.001);
  const base = paths.map((p) => p.map((q) => ({ x: q.x - b.minX, y: q.y - b.minY })));
  return {
    id: newId(), type: 'shape', name, paths: base, bw, bh,
    x: x ?? b.minX, y: y ?? b.minY, w: w ?? bw, h: h ?? bh, rot: 0, flipX: false, flipY: false,
    fill, stroke, locked: false, hidden: false, cut: false, groupId: null, ...rest,
  };
}

export function imageObject({ src, natW, natH, x = 0, y = 0, w, h, name = 'Image' }) {
  const ww = w ?? natW, hh = h ?? natH;
  return {
    id: newId(), type: 'image', name, src, natW, natH,
    paths: [[{ x: 0, y: 0 }, { x: ww, y: 0 }, { x: ww, y: hh }, { x: 0, y: hh }, { x: 0, y: 0 }]], bw: ww, bh: hh,
    x, y, w: ww, h: hh, rot: 0, flipX: false, flipY: false, fill: NO_FILL, stroke: DEFAULT_STROKE,
    locked: false, hidden: false, cut: false, groupId: null,
  };
}

// Point from an object's own box onto the page
export function placePoint(o, p) {
  const sx = o.bw ? o.w / o.bw : 1, sy = o.bh ? o.h / o.bh : 1;
  let lx = p.x * sx, ly = p.y * sy;
  if (o.flipX) lx = o.w - lx;
  if (o.flipY) ly = o.h - ly;
  if (o.rot) {
    const a = (o.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const cx = o.w / 2, cy = o.h / 2, dx = lx - cx, dy = ly - cy;
    lx = cx + dx * c - dy * s; ly = cy + dx * s + dy * c;
  }
  return { x: o.x + lx, y: o.y + ly };
}
// Page point back into the object's own box (node editing)
export function unplacePoint(o, p) {
  let lx = p.x - o.x, ly = p.y - o.y;
  if (o.rot) {
    const a = (-o.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const cx = o.w / 2, cy = o.h / 2, dx = lx - cx, dy = ly - cy;
    lx = cx + dx * c - dy * s; ly = cy + dx * s + dy * c;
  }
  if (o.flipX) lx = o.w - lx;
  if (o.flipY) ly = o.h - ly;
  const sx = o.bw ? o.w / o.bw : 1, sy = o.bh ? o.h / o.bh : 1;
  return { x: lx / (sx || 1), y: ly / (sy || 1) };
}

export const placedPaths = (o) => (o.paths || []).map((p) => p.map((q) => placePoint(o, q)));

export function objBounds(o) {
  const pts = [[0, 0], [o.w, 0], [o.w, o.h], [0, o.h]].map(([lx, ly]) => {
    if (!o.rot) return { x: o.x + lx, y: o.y + ly };
    const a = (o.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), cx = o.w / 2, cy = o.h / 2, dx = lx - cx, dy = ly - cy;
    return { x: o.x + cx + dx * c - dy * s, y: o.y + cy + dx * s + dy * c };
  });
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs), maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}
export function selBounds(objs) {
  if (!objs.length) return null;
  const bs = objs.map(objBounds);
  const minX = Math.min(...bs.map((b) => b.minX)), minY = Math.min(...bs.map((b) => b.minY));
  const maxX = Math.max(...bs.map((b) => b.maxX)), maxY = Math.max(...bs.map((b) => b.maxY));
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// Bake the placement into the outline (after weld etc. the result is a plain upright shape)
export function bake(o) {
  const paths = placedPaths(o);
  return shapeFromPaths(paths, { fill: o.fill, stroke: o.stroke, name: o.name, cut: o.cut, groupId: o.groupId });
}

// ---- SVG path text ----
export function pathD(paths, digits = 3) {
  const f = (v) => +v.toFixed(digits);
  return paths.filter((p) => p.length > 1).map((p) => `M${p.map((q) => `${f(q.x)} ${f(q.y)}`).join('L')}${isClosed(p) ? 'Z' : ''}`).join('');
}

// ---- hit testing ----
function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
/** Topmost object under a page point. tol = mm (a few screen pixels). */
export function hitTest(objects, pt, tol = 1) {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.hidden) continue;
    const b = objBounds(o);
    if (pt.x < b.minX - tol || pt.x > b.maxX + tol || pt.y < b.minY - tol || pt.y > b.maxY + tol) continue;
    if (o.type === 'image') return o;
    const pp = placedPaths(o);
    const filled = o.fill && o.fill.type !== 'none';
    if (filled) {
      let n = 0;
      for (const p of pp) if (p.length > 2 && pointInPoly(pt, p)) n++;
      if (n % 2 === 1) return o; // even-odd, like the fill
    }
    for (const p of pp) for (let k = 1; k < p.length; k++) if (distToSeg(pt, p[k - 1], p[k]) <= tol + (o.stroke?.width || 0) / 2) return o;
  }
  return null;
}
export function objectsInRect(objects, r) {
  return objects.filter((o) => {
    if (o.hidden || o.locked) return false;
    const b = objBounds(o);
    return b.minX >= r.minX && b.maxX <= r.maxX && b.minY >= r.minY && b.maxY <= r.maxY;
  });
}

// ---- transforms on a selection (ids) ----
const mapSel = (doc, ids, fn) => ({ ...doc, objects: doc.objects.map((o) => (ids.includes(o.id) && !o.locked ? fn(o) : o)) });

export const move = (doc, ids, dx, dy) => mapSel(doc, ids, (o) => ({ ...o, x: o.x + dx, y: o.y + dy }));

/** Scale the selection from an anchor point (page coords) by sx, sy. */
export function scaleSel(doc, ids, sx, sy, anchor) {
  return mapSel(doc, ids, (o) => {
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    // rotated objects: scale in their own frame by the larger-axis factor when non-uniform, to keep them sane
    let fw = sx, fh = sy;
    if (o.rot % 180 === 90 || o.rot % 180 === -90) [fw, fh] = [sy, sx];
    else if (o.rot % 90) fw = fh = Math.sqrt(Math.abs(sx * sy));
    const w = Math.max(0.01, o.w * Math.abs(fw)), h = Math.max(0.01, o.h * Math.abs(fh));
    const ncx = anchor.x + (cx - anchor.x) * sx, ncy = anchor.y + (cy - anchor.y) * sy;
    return { ...o, w, h, x: ncx - w / 2, y: ncy - h / 2, flipX: sx < 0 ? !o.flipX : o.flipX, flipY: sy < 0 ? !o.flipY : o.flipY };
  });
}

/** Rotate the selection by deg about a page point */
export function rotateSel(doc, ids, deg, center) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return mapSel(doc, ids, (o) => {
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2, dx = cx - center.x, dy = cy - center.y;
    const ncx = center.x + dx * c - dy * s, ncy = center.y + dx * s + dy * c;
    return { ...o, rot: (((o.rot || 0) + deg) % 360 + 360) % 360, x: ncx - o.w / 2, y: ncy - o.h / 2 };
  });
}

export const mirror = (doc, ids, axis) => {
  const b = selBounds(doc.objects.filter((o) => ids.includes(o.id)));
  if (!b) return doc;
  return mapSel(doc, ids, (o) => {
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    if (axis === 'h') return { ...o, flipX: !o.flipX, rot: (360 - (o.rot || 0)) % 360, x: 2 * b.cx - cx - o.w / 2 };
    return { ...o, flipY: !o.flipY, rot: (360 - (o.rot || 0)) % 360, y: 2 * b.cy - cy - o.h / 2 };
  });
};

/** Set the selection's overall position / size (the property bar) */
export function setSelBox(doc, ids, { x, y, w, h }, keepRatio = false) {
  const sel = doc.objects.filter((o) => ids.includes(o.id));
  const b = selBounds(sel);
  if (!b) return doc;
  let out = doc;
  let sx = w != null && b.w ? w / b.w : 1, sy = h != null && b.h ? h / b.h : 1;
  if (keepRatio) { if (w != null && h == null) sy = sx; if (h != null && w == null) sx = sy; }
  if (sx !== 1 || sy !== 1) out = scaleSel(out, ids, sx, sy, { x: b.minX, y: b.minY });
  const nb = selBounds(out.objects.filter((o) => ids.includes(o.id)));
  return move(out, ids, x != null ? x - nb.minX : 0, y != null ? y - nb.minY : 0);
}

// ---- arrange ----
export function align(doc, ids, how, toPage = false) {
  const sel = doc.objects.filter((o) => ids.includes(o.id));
  const ref = toPage || sel.length === 1 ? { minX: 0, minY: 0, maxX: doc.page.w, maxY: doc.page.h } : selBounds(sel);
  if (!ref) return doc;
  // groups move together
  const units = unitsOf(sel);
  let out = doc;
  for (const u of units) {
    const b = selBounds(u);
    let dx = 0, dy = 0;
    if (how === 'left') dx = ref.minX - b.minX;
    if (how === 'right') dx = ref.maxX - b.maxX;
    if (how === 'hcenter') dx = (ref.minX + ref.maxX) / 2 - (b.minX + b.maxX) / 2;
    if (how === 'top') dy = ref.minY - b.minY;
    if (how === 'bottom') dy = ref.maxY - b.maxY;
    if (how === 'vcenter') dy = (ref.minY + ref.maxY) / 2 - (b.minY + b.maxY) / 2;
    out = move(out, u.map((o) => o.id), dx, dy);
  }
  return out;
}
function unitsOf(sel) {
  const groups = new Map(), units = [];
  for (const o of sel) {
    if (!o.groupId) { units.push([o]); continue; }
    if (!groups.has(o.groupId)) { groups.set(o.groupId, []); units.push(groups.get(o.groupId)); }
    groups.get(o.groupId).push(o);
  }
  return units;
}
export function distribute(doc, ids, axis, gapMm = null) {
  const units = unitsOf(doc.objects.filter((o) => ids.includes(o.id))).map((u) => ({ u, b: selBounds(u) }));
  if (units.length < 2) return doc;
  const k = axis === 'h' ? 'minX' : 'minY', size = axis === 'h' ? 'w' : 'h';
  units.sort((a, b) => a.b[k] - b.b[k]);
  const first = units[0].b, last = units[units.length - 1].b;
  const total = units.reduce((s, x) => s + x.b[size], 0);
  const span = (axis === 'h' ? last.maxX - first.minX : last.maxY - first.minY);
  const gap = gapMm != null ? gapMm : (span - total) / (units.length - 1);
  let pos = first[k];
  let out = doc;
  for (const { u, b } of units) {
    const d = pos - b[k];
    out = move(out, u.map((o) => o.id), axis === 'h' ? d : 0, axis === 'h' ? 0 : d);
    pos += b[size] + gap;
  }
  return out;
}

export function reorder(doc, ids, how) {
  const objs = doc.objects.slice();
  const isSel = (o) => ids.includes(o.id);
  if (how === 'front') return { ...doc, objects: [...objs.filter((o) => !isSel(o)), ...objs.filter(isSel)] };
  if (how === 'back') return { ...doc, objects: [...objs.filter(isSel), ...objs.filter((o) => !isSel(o))] };
  if (how === 'forward') {
    for (let i = objs.length - 2; i >= 0; i--) if (isSel(objs[i]) && !isSel(objs[i + 1])) [objs[i], objs[i + 1]] = [objs[i + 1], objs[i]];
  } else if (how === 'backward') {
    for (let i = 1; i < objs.length; i++) if (isSel(objs[i]) && !isSel(objs[i - 1])) [objs[i], objs[i - 1]] = [objs[i - 1], objs[i]];
  }
  return { ...doc, objects: objs };
}

export function group(doc, ids) {
  const gid = newId();
  // keep the group's objects together in the stacking order, at the topmost member's place
  const objs = doc.objects;
  const members = objs.filter((o) => ids.includes(o.id)).map((o) => ({ ...o, groupId: gid }));
  const lastIdx = Math.max(...objs.map((o, i) => (ids.includes(o.id) ? i : -1)));
  const rest = objs.filter((o) => !ids.includes(o.id));
  const insertAt = rest.filter((o) => objs.indexOf(o) < lastIdx).length;
  return { ...doc, objects: [...rest.slice(0, insertAt), ...members, ...rest.slice(insertAt)] };
}
export const ungroup = (doc, ids) => ({ ...doc, objects: doc.objects.map((o) => (ids.includes(o.id) ? { ...o, groupId: null } : o)) });
/** Clicking one member of a group selects all of it */
export function expandGroups(doc, ids) {
  const gids = new Set(doc.objects.filter((o) => ids.includes(o.id) && o.groupId).map((o) => o.groupId));
  return doc.objects.filter((o) => ids.includes(o.id) || (o.groupId && gids.has(o.groupId))).map((o) => o.id);
}

export function duplicate(doc, ids, dx = 6.35, dy = 6.35) {
  const gmap = new Map();
  const copies = doc.objects.filter((o) => ids.includes(o.id)).map((o) => {
    let groupId = o.groupId;
    if (groupId) { if (!gmap.has(groupId)) gmap.set(groupId, newId()); groupId = gmap.get(groupId); }
    return { ...structuredCopy(o), id: newId(), x: o.x + dx, y: o.y + dy, groupId };
  });
  return { doc: { ...doc, objects: [...doc.objects, ...copies] }, ids: copies.map((o) => o.id) };
}
const structuredCopy = (o) => JSON.parse(JSON.stringify(o));

export const remove = (doc, ids) => ({ ...doc, objects: doc.objects.filter((o) => !ids.includes(o.id) || o.locked) });
export const update = (doc, ids, patch) => mapSel(doc, ids, (o) => ({ ...o, ...(typeof patch === 'function' ? patch(o) : patch) }));
export const setAll = (doc, ids, patch) => ({ ...doc, objects: doc.objects.map((o) => (ids.includes(o.id) ? { ...o, ...patch } : o)) }); // even locked (lock / unlock)

/** Step and repeat: copies in rows × columns with a gap (mm) — Flexi's Arrange > Step and Repeat */
export function stepRepeat(doc, ids, { cols = 2, rows = 1, gapX = 6.35, gapY = 6.35 }) {
  const sel = doc.objects.filter((o) => ids.includes(o.id));
  const b = selBounds(sel);
  if (!b) return { doc, ids };
  let out = doc;
  const all = [...ids];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!r && !c) continue;
    const d = duplicate(doc, ids, c * (b.w + gapX), r * (b.h + gapY));
    const copies = d.doc.objects.slice(doc.objects.length);
    out = { ...out, objects: [...out.objects, ...copies] };
    all.push(...copies.map((o) => o.id));
  }
  return { doc: out, ids: all };
}

/** Fill the page with copies of the selection (as many as fit, gap between) */
export function fillPage(doc, ids, gap = 6.35, margin = 6.35) {
  const b = selBounds(doc.objects.filter((o) => ids.includes(o.id)));
  if (!b) return { doc, ids };
  const cols = Math.max(1, Math.floor((doc.page.w - 2 * margin + gap) / (b.w + gap)));
  const rows = Math.max(1, Math.floor((doc.page.h - 2 * margin + gap) / (b.h + gap)));
  const start = move(doc, ids, margin - b.minX, margin - b.minY);
  return stepRepeat(start, ids, { cols, rows, gapX: gap, gapY: gap });
}

// ---- history ----
export function history(limit = 100) {
  const past = [], future = [];
  return {
    push(doc) { past.push(JSON.stringify(doc)); if (past.length > limit) past.shift(); future.length = 0; },
    undo(doc) { if (!past.length) return null; future.push(JSON.stringify(doc)); return JSON.parse(past.pop()); },
    redo(doc) { if (!future.length) return null; past.push(JSON.stringify(doc)); return JSON.parse(future.pop()); },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
  };
}

// ---- job info (Flexi's Edit > Job Info / Job Statistics) ----
export function jobStats(doc) {
  let cutMm = 0, nodes = 0;
  const colors = new Map();
  for (const o of doc.objects) {
    if (o.hidden) continue;
    const pp = placedPaths(o);
    for (const p of pp) { nodes += p.length; for (let i = 1; i < p.length; i++) cutMm += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y); }
    const key = o.cut ? 'CutContour' : o.fill?.type === 'solid' ? o.fill.color : o.type === 'image' ? 'Image' : o.stroke?.color || 'none';
    const b = objBounds(o);
    colors.set(key, (colors.get(key) || 0) + (o.type === 'image' || o.fill?.type !== 'none' ? b.w * b.h : 0));
  }
  return { objects: doc.objects.length, nodes, cutMm, colors: [...colors.entries()].map(([color, areaMm2]) => ({ color, areaMm2 })) };
}
