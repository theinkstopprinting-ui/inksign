// Cutting tools that change shapes: stencil bridges, knockout (reverse), rhinestones,
// weed boxes, and shape math (weld / subtract / intersect / trim).
// Units: mm. Paths: arrays of {x, y}. Closed paths repeat the first point at the end.
import ClipperLib from 'clipper-lib';
import { bounds, isClosed } from './geometry.js';
import { ellipse } from './shapes.js';

const SCALE = 1000;
const toClip = (paths) => paths.map((p) => p.map(({ x, y }) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));
const fromClip = (paths) => paths.filter((p) => p.length > 2).map((p) => {
  const out = p.map(({ X, Y }) => ({ x: X / SCALE, y: Y / SCALE }));
  out.push({ ...out[0] });
  return out;
});

function rect(x0, y0, x1, y1) {
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }];
}

// Boolean op between two sets of closed shapes (each set read even-odd, so letter holes stay holes).
export function boolean(subject, clip, op) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(toClip(subject.filter(isClosed)), ClipperLib.PolyType.ptSubject, true);
  if (clip && clip.length) c.AddPaths(toClip(clip.filter(isClosed)), ClipperLib.PolyType.ptClip, true);
  const type = { union: ClipperLib.ClipType.ctUnion, difference: ClipperLib.ClipType.ctDifference, intersection: ClipperLib.ClipType.ctIntersection, xor: ClipperLib.ClipType.ctXor }[op];
  const sol = new ClipperLib.Paths();
  c.Execute(type, sol, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
  return fromClip(sol);
}

// Weld: overlapping shapes become one outline (script letters that touch, a logo and its backer).
export function weld(paths) {
  const closed = paths.filter(isClosed);
  // Each shape on its own first (even-odd keeps its holes), then union with nonzero so overlaps merge.
  const c = new ClipperLib.Clipper();
  for (const shape of groupShapes(closed)) {
    const solo = boolean(shape, [], 'union');
    c.AddPaths(toClip(solo), ClipperLib.PolyType.ptSubject, true);
  }
  const sol = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctUnion, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  // Orientation decides holes vs outlines after a nonzero union
  const fixed = sol.map((p) => p);
  return [...fromClip(fixed), ...paths.filter((p) => !isClosed(p))];
}

// Groups outer outlines with the holes inside them (so "O" stays one shape).
export function groupShapes(closed) {
  const items = closed.map((p) => ({ p, b: bounds([p]), area: Math.abs(area(p)) })).sort((a, b) => b.area - a.area);
  const groups = [];
  for (const it of items) {
    const parent = groups.find((g) => contains(g.outer.b, it.b) && pointInPoly(it.p[0], g.outer.p) && g.depthOk);
    if (parent && !parent.holes.some((h) => contains(h.b, it.b) && pointInPoly(it.p[0], h.p))) parent.holes.push(it);
    else groups.push({ outer: it, holes: [], depthOk: true });
  }
  return groups.map((g) => [g.outer.p, ...g.holes.map((h) => h.p)]);
}

export function area(p) {
  let a = 0;
  for (let i = 1; i < p.length; i++) a += p[i - 1].x * p[i].y - p[i].x * p[i - 1].y;
  return a / 2;
}
function contains(a, b) { return b.minX >= a.minX - 0.01 && b.maxX <= a.maxX + 0.01 && b.minY >= a.minY - 0.01 && b.maxY <= a.maxY + 0.01; }

export function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Even-odd inside test against a whole set of closed paths.
export function insideShapes(pt, paths) {
  let n = 0;
  for (const p of paths) if (isClosed(p) && pointInPoly(pt, p)) n++;
  return n % 2 === 1;
}

// Distance from a point to the nearest edge of any path.
function edgeDistance(pt, paths) {
  let best = Infinity;
  for (const p of paths) {
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i];
      const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / L)) : 0;
      const d = Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
      if (d < best) best = d;
    }
  }
  return best;
}

// ---- Stencil bridges -----------------------------------------------------
// For every island (the middle of O, A, R, B, D…), cut a strip through the letter above and below it,
// so the island stays joined to the stencil. direction 'vertical' = strips up/down, 'horizontal' = left/right.
export function stencilBridges(paths, { widthMm = 3, direction = 'vertical' } = {}) {
  const closed = paths.filter(isClosed);
  const groups = groupShapes(closed);
  const out = [];
  let bridged = 0;
  for (const g of groups) {
    const [outer, ...holes] = g;
    if (!holes.length) { out.push(...g); continue; }
    const ob = bounds([outer]);
    const strips = [];
    for (const h of holes) {
      const hb = bounds([h]);
      if (direction === 'horizontal') {
        const cy = (hb.minY + hb.maxY) / 2;
        strips.push(rect(ob.minX - 1, cy - widthMm / 2, ob.maxX + 1, cy + widthMm / 2));
      } else {
        const cx = (hb.minX + hb.maxX) / 2;
        strips.push(rect(cx - widthMm / 2, ob.minY - 1, cx + widthMm / 2, ob.maxY + 1));
      }
      bridged++;
    }
    out.push(...boolean(g, strips, 'difference'));
  }
  return { paths: [...out, ...paths.filter((p) => !isClosed(p))], bridged };
}

// ---- Knockout / reverse ----------------------------------------------------
// A solid block (rectangle or rounded, with a margin) with the design cut out of it as holes.
export function knockout(paths, { marginMm = 12.7, radiusMm = 0 } = {}) {
  const b = bounds(paths);
  const x0 = b.minX - marginMm, y0 = b.minY - marginMm, x1 = b.maxX + marginMm, y1 = b.maxY + marginMm;
  let block;
  if (radiusMm > 0) {
    const r = Math.min(radiusMm, (x1 - x0) / 2, (y1 - y0) / 2), pts = [];
    const corner = (cx, cy, a0) => { for (let i = 0; i <= 10; i++) { const a = a0 + (i / 10) * Math.PI / 2; pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); } };
    corner(x1 - r, y0 + r, -Math.PI / 2); corner(x1 - r, y1 - r, 0); corner(x0 + r, y1 - r, Math.PI / 2); corner(x0 + r, y0 + r, Math.PI);
    block = [...pts, { ...pts[0] }];
  } else block = rect(x0, y0, x1, y1);
  return boolean([block], paths.filter(isClosed), 'difference');
}

// ---- Weed boxes --------------------------------------------------------------
// A rectangle around each piece (lines of text, separate logos) instead of only one around the job.
export function weedBoxes(pieces, marginMm) {
  return pieces.filter((p) => p.length).map((paths) => {
    const b = bounds(paths);
    return rect(b.minX - marginMm, b.minY - marginMm, b.maxX + marginMm, b.maxY + marginMm);
  });
}

// ---- Rhinestones -------------------------------------------------------------
// Stone sizes (SS) and their usual template hole diameters in mm.
export const STONES = [
  { id: 'ss6', name: 'SS6 (2.0 mm)', stone: 2.0, hole: 2.3 },
  { id: 'ss10', name: 'SS10 (2.8 mm)', stone: 2.8, hole: 3.1 },
  { id: 'ss16', name: 'SS16 (3.9 mm)', stone: 3.9, hole: 4.2 },
  { id: 'ss20', name: 'SS20 (4.7 mm)', stone: 4.7, hole: 5.0 },
  { id: 'ss30', name: 'SS30 (6.4 mm)', stone: 6.4, hole: 6.8 },
];

function walk(p, step, offset = 0) {
  const pts = [];
  let carry = offset;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    let d = carry;
    while (d <= L) { const t = L ? d / L : 0; pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); d += step; }
    carry = d - L;
  }
  return pts;
}

// mode 'outline' = stones along the edges (inset by half a stone), 'fill' = honeycomb inside, 'both'.
export function rhinestones(paths, { holeMm = 3.1, gapMm = 0.8, mode = 'outline' } = {}) {
  const closed = paths.filter(isClosed);
  const pitch = holeMm + gapMm;
  const centers = [];
  const ok = (c) => centers.every((q) => Math.hypot(q.x - c.x, q.y - c.y) >= pitch * 0.95);
  if (mode === 'outline' || mode === 'both') {
    // inset the outline so stones sit inside the art
    const c = new ClipperLib.ClipperOffset(2, 0.05 * SCALE);
    c.AddPaths(toClip(closed), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    const sol = new ClipperLib.Paths();
    c.Execute(sol, (-holeMm / 2) * SCALE);
    for (const p of fromClip(sol)) {
      const L = p.reduce((s, q, i) => (i ? s + Math.hypot(q.x - p[i - 1].x, q.y - p[i - 1].y) : 0), 0);
      if (L < pitch) continue;
      const n = Math.max(1, Math.round(L / pitch));
      for (const pt of walk(p, L / n).slice(0, n)) if (ok(pt)) centers.push(pt);
    }
  }
  if (mode === 'fill' || mode === 'both') {
    const b = bounds(closed);
    const rowH = pitch * Math.sqrt(3) / 2;
    let row = 0;
    for (let y = b.minY + holeMm / 2; y <= b.maxY; y += rowH, row++) {
      for (let x = b.minX + holeMm / 2 + (row % 2 ? pitch / 2 : 0); x <= b.maxX; x += pitch) {
        const c = { x, y };
        if (insideShapes(c, closed) && edgeDistance(c, closed) >= holeMm / 2 + (mode === 'both' ? gapMm : 0) && ok(c)) centers.push(c);
      }
    }
  }
  const circles = centers.map((c) => ellipse(holeMm, holeMm)[0].map((q) => ({ x: q.x + c.x - holeMm / 2, y: q.y + c.y - holeMm / 2 })));
  return { paths: circles, count: centers.length };
}
