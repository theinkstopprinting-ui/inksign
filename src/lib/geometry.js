// Shared cut geometry. Units: millimetres. A path is an array of {x, y}.
// X = along the roll (feed direction), Y = across the roll (cutter width).

export const MM = 25.4;

export function bounds(paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) for (const { x, y } of p) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

export const mapPaths = (paths, fn) => paths.map((p) => p.map(fn));
export const translate = (paths, dx, dy) => mapPaths(paths, ({ x, y }) => ({ x: x + dx, y: y + dy }));
export const scale = (paths, sx, sy = sx) => mapPaths(paths, ({ x, y }) => ({ x: x * sx, y: y * sy }));

export function normalize(paths) {
  const b = bounds(paths);
  return translate(paths, -b.minX, -b.minY);
}

export function isClosed(p) {
  if (p.length < 3) return false;
  const a = p[0], b = p[p.length - 1];
  return Math.hypot(a.x - b.x, a.y - b.y) < 0.05;
}

// ---- Curve flattening --------------------------------------------------
function segCount(len, tolMm = 0.25) { return Math.max(4, Math.min(256, Math.ceil(len / tolMm))); }

export function flattenCubic(p0, p1, p2, p3, mmPerUnit = 1) {
  const len = (Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y) + Math.hypot(p3.x - p2.x, p3.y - p2.y)) * mmPerUnit;
  const n = segCount(len), out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return out;
}

export function flattenQuad(p0, p1, p2, mmPerUnit = 1) {
  const len = (Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y)) * mmPerUnit;
  const n = segCount(len), out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({ x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y });
  }
  return out;
}

// Commands: [{type:'M'|'L'|'C'|'Q'|'Z', x, y, x1, y1, x2, y2}] in absolute coords.
export function flattenCommands(cmds, mmPerUnit = 1) {
  const paths = [];
  let cur = null, start = null, pt = { x: 0, y: 0 };
  const flush = () => { if (cur && cur.length > 1) paths.push(cur); cur = null; };
  for (const c of cmds) {
    if (c.type === 'M') { flush(); pt = { x: c.x, y: c.y }; start = pt; cur = [pt]; continue; }
    if (!cur) { cur = [pt]; start = pt; }
    if (c.type === 'L') { pt = { x: c.x, y: c.y }; cur.push(pt); }
    else if (c.type === 'C') { const e = { x: c.x, y: c.y }; cur.push(...flattenCubic(pt, { x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 }, e, mmPerUnit)); pt = e; }
    else if (c.type === 'Q') { const e = { x: c.x, y: c.y }; cur.push(...flattenQuad(pt, { x: c.x1, y: c.y1 }, e, mmPerUnit)); pt = e; }
    else if (c.type === 'Z') {
      if (start && (pt.x !== start.x || pt.y !== start.y)) cur.push({ ...start });
      flush(); pt = start;
    }
  }
  flush();
  return paths.map((p) => p.map(({ x, y }) => ({ x: x * mmPerUnit, y: y * mmPerUnit })));
}

// ---- Cut order: holes before outlines, then shortest travel -----------
function bboxOf(p) { return bounds([p]); }
function inside(a, b) { return a.minX >= b.minX && a.maxX <= b.maxX && a.minY >= b.minY && a.maxY <= b.maxY && (a.w < b.w || a.h < b.h); }

export function sortCutOrder(paths) {
  const items = paths.map((p) => ({ p, b: bboxOf(p) }));
  for (const it of items) it.depth = items.filter((o) => o !== it && isClosed(o.p) && inside(it.b, o.b)).length;
  const maxD = Math.max(0, ...items.map((i) => i.depth));
  const out = [];
  let pos = { x: 0, y: 0 };
  // Work left-to-right in bands so the cutter doesn't run back and forth along the roll.
  for (let d = maxD; d >= 0; d--) {
    const pool = items.filter((i) => i.depth === d);
    while (pool.length) {
      let best = 0, bestD = Infinity;
      pool.forEach((it, i) => {
        const s = it.p[0];
        const dist = Math.hypot(s.x - pos.x, (s.y - pos.y) * 0.5) + (s.x < pos.x - 50 ? 1e4 : 0);
        if (dist < bestD) { bestD = dist; best = i; }
      });
      const [it] = pool.splice(best, 1);
      out.push(it.p);
      pos = it.p[it.p.length - 1];
    }
  }
  return out;
}

// ---- Weeding ----------------------------------------------------------
export function weedBorder(paths, marginMm) {
  const b = bounds(paths);
  const m = Number(marginMm) || 0;
  return [
    { x: b.minX - m, y: b.minY - m }, { x: b.maxX + m, y: b.minY - m },
    { x: b.maxX + m, y: b.maxY + m }, { x: b.minX - m, y: b.maxY + m }, { x: b.minX - m, y: b.minY - m },
  ];
}

// Where a line x=c (axis 'x') or y=c (axis 'y') crosses closed shapes.
function crossings(paths, axis, c) {
  const hits = [];
  for (const p of paths) {
    if (!isClosed(p)) continue;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i];
      const av = axis === 'x' ? a.x : a.y, bv = axis === 'x' ? b.x : b.y;
      if ((av <= c && bv > c) || (bv <= c && av > c)) {
        const t = (c - av) / (bv - av);
        hits.push(axis === 'x' ? a.y + (b.y - a.y) * t : a.x + (b.x - a.x) * t);
      }
    }
  }
  return hits.sort((m, n) => m - n);
}

// Lines through the weed border that stop short of the letters (gapMm clearance).
export function weedLines(paths, { marginMm = 6, spacingMm = 75, gapMm = 1.5, direction = 'vertical' } = {}) {
  const closed = paths.filter(isClosed);
  const b = bounds(paths);
  const m = Number(marginMm) || 0;
  const out = [];
  const axis = direction === 'vertical' ? 'x' : 'y';
  const lo = axis === 'x' ? b.minX : b.minY, hi = axis === 'x' ? b.maxX : b.maxY;
  const runLo = (axis === 'x' ? b.minY : b.minX) - m, runHi = (axis === 'x' ? b.maxY : b.maxX) + m;
  const span = hi - lo;
  const count = Math.max(1, Math.floor(span / (Number(spacingMm) || 75)));
  for (let k = 1; k <= count; k++) {
    let c = lo + (span * k) / (count + 1);
    // Nudge off a vertex so crossings are clean
    c += 0.013;
    const hits = crossings(closed, axis, c);
    const edges = [runLo, ...hits, runHi];
    // Outside segments are every other gap (even-odd)
    for (let i = 0; i + 1 < edges.length; i += 2) {
      let s = edges[i] + (i === 0 ? 0 : gapMm), e = edges[i + 1] - (i + 1 === edges.length - 1 ? 0 : gapMm);
      if (e - s < 1) continue;
      out.push(axis === 'x' ? [{ x: c, y: s }, { x: c, y: e }] : [{ x: s, y: c }, { x: e, y: c }]);
    }
  }
  return out;
}

// ---- Tiling -------------------------------------------------------------
// Clip polylines to lo <= v <= hi on one axis. Closed shapes that cross the
// edge become open cuts, which is what you want for overlapping panels.
export function clipToRange(paths, axis, lo, hi) {
  const out = [];
  const val = (p) => (axis === 'x' ? p.x : p.y);
  const lerp = (a, b, v) => {
    const t = (v - val(a)) / (val(b) - val(a));
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  for (const p of paths) {
    let cur = [];
    for (let i = 0; i < p.length; i++) {
      const pt = p[i], inP = val(pt) >= lo && val(pt) <= hi;
      if (i === 0) { if (inP) cur.push(pt); continue; }
      const prev = p[i - 1], inPrev = val(prev) >= lo && val(prev) <= hi;
      if (inPrev && inP) cur.push(pt);
      else if (inPrev && !inP) { cur.push(lerp(prev, pt, val(pt) > hi ? hi : lo)); if (cur.length > 1) out.push(cur); cur = []; }
      else if (!inPrev && inP) { cur = [lerp(prev, pt, val(prev) > hi ? hi : lo), pt]; }
      else {
        // Segment jumps over the whole range
        const a = val(prev), b = val(pt);
        if ((a < lo && b > hi) || (a > hi && b < lo)) {
          const s = lerp(prev, pt, a < lo ? lo : hi), e = lerp(prev, pt, a < lo ? hi : lo);
          out.push([s, e]);
        }
      }
    }
    if (cur.length > 1) {
      // Re-join a closed shape that was cut open at its start point
      if (isClosed(p) && out.length && cur[cur.length - 1] === p[p.length - 1] && val(p[0]) >= lo && val(p[0]) <= hi) {
        const first = out.findIndex((q) => q[0] === p[0]);
        if (first >= 0) { out[first] = [...cur, ...out[first].slice(1)]; continue; }
      }
      out.push(cur);
    }
  }
  return out;
}

// Split a job into panels. maxAcross = usable cutter width (Y), maxAlong = panel length (X, 0 = no limit).
export function tileJob(paths, { maxAcrossMm, maxAlongMm = 0, overlapMm = 12.7 }) {
  const b = bounds(paths);
  const ov = Math.max(0, Number(overlapMm) || 0);
  const ranges = (lo, hi, size) => {
    if (!size || hi - lo <= size) return [[lo, hi]];
    const step = size - ov;
    if (step <= 0) return [[lo, hi]];
    const out = [];
    for (let s = lo; s < hi - ov; s += step) out.push([s, Math.min(s + size, hi)]);
    return out;
  };
  const rows = ranges(b.minY, b.maxY, Number(maxAcrossMm) || 0);
  const cols = ranges(b.minX, b.maxX, Number(maxAlongMm) || 0);
  const panels = [];
  rows.forEach(([y0, y1], r) => cols.forEach(([x0, x1], c) => {
    const clipped = clipToRange(clipToRange(paths, 'y', y0, y1), 'x', x0, x1);
    if (!clipped.length) return;
    panels.push({
      name: rows.length * cols.length > 1 ? `Panel ${String.fromCharCode(65 + r)}${c + 1}` : 'Full job',
      rect: { x0, y0, x1, y1 },
      paths: translate(clipped, -x0, -y0),
    });
  }));
  return panels;
}

export function totalLength(paths) {
  let L = 0;
  for (const p of paths) for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return L;
}
