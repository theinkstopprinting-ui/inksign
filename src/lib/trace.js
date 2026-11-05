// Bitmap tracing: turns a mask (inside/outside per pixel) into closed outlines.
// Used for contour-cut lines around printed images and for tracing logos into vinyl cut paths.

// Build a mask from RGBA pixel data.
// mode 'alpha': opaque pixels are inside. mode 'dark': pixels darker than threshold are inside.
// mode 'notbg': pixels that differ from the corner (background) color are inside.
export function makeMask(rgba, w, h, { mode = 'alpha', threshold = 128, tolerance = 40 } = {}) {
  const m = new Uint8Array(w * h);
  let bg = [rgba[0], rgba[1], rgba[2]];
  if (mode === 'notbg') {
    // average the four corners
    const idx = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + w - 1) * 4];
    bg = [0, 1, 2].map((c) => idx.reduce((s, i) => s + rgba[i + c], 0) / 4);
  }
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const a = rgba[p + 3];
    if (mode === 'alpha') m[i] = a >= threshold ? 1 : 0;
    else if (mode === 'dark') m[i] = a > 20 && (rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114) < threshold ? 1 : 0;
    else {
      const d = Math.abs(rgba[p] - bg[0]) + Math.abs(rgba[p + 1] - bg[1]) + Math.abs(rgba[p + 2] - bg[2]);
      m[i] = a > 20 && d > tolerance ? 1 : 0;
    }
  }
  return m;
}

// Trace pixel-boundary loops. Inside is kept on the left of each loop.
export function traceMask(mask, w, h) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0);
  // edges keyed by start vertex "x,y" -> list of [ex, ey]
  const out = new Map();
  const add = (sx, sy, ex, ey) => {
    const k = sy * (w + 1) + sx;
    let l = out.get(k);
    if (!l) out.set(k, (l = []));
    l.push(ey * (w + 1) + ex);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      // Image coords: y down. Walk so the filled pixel is on the left.
      if (!at(x, y - 1)) add(x + 1, y, x, y);         // top edge, right->left
      if (!at(x, y + 1)) add(x, y + 1, x + 1, y + 1); // bottom edge, left->right
      if (!at(x - 1, y)) add(x, y, x, y + 1);         // left edge, down
      if (!at(x + 1, y)) add(x + 1, y + 1, x + 1, y); // right edge, up
    }
  }
  const W1 = w + 1;
  const loops = [];
  for (const [start, list] of out) {
    while (list.length) {
      const loop = [];
      let cur = start, next = list.pop(), prev = start;
      loop.push(cur);
      let guard = 0;
      while (next !== start && guard++ < 1e7) {
        loop.push(next);
        const cand = out.get(next);
        if (!cand || !cand.length) break;
        let pick = 0;
        if (cand.length > 1) {
          // Saddle: turn the same way consistently (prefer left turn) to keep diagonal pixels separate.
          const dx = (next % W1) - (prev % W1), dy = Math.floor(next / W1) - Math.floor(prev / W1);
          let best = -Infinity;
          cand.forEach((c, i) => {
            const cx = (c % W1) - (next % W1), cy = Math.floor(c / W1) - Math.floor(next / W1);
            const cross = dx * cy - dy * cx; // y-down: negative = left turn visually
            const score = -cross;
            if (score > best) { best = score; pick = i; }
          });
        }
        prev = next;
        next = cand.splice(pick, 1)[0];
      }
      if (loop.length > 2) loops.push(loop.map((k) => ({ x: k % W1, y: Math.floor(k / W1) })));
    }
  }
  return loops;
}

export function polygonArea(p) {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j].x + p[i].x) * (p[j].y - p[i].y);
  return a / 2;
}

// Ramer–Douglas–Peucker on a closed loop
export function simplify(points, tol) {
  if (points.length < 4) return points;
  const sqTol = tol * tol;
  const segDist = (p, a, b) => {
    let x = a.x, y = a.y, dx = b.x - x, dy = b.y - y;
    if (dx || dy) {
      const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b.x; y = b.y; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p.x - x; dy = p.y - y;
    return dx * dx + dy * dy;
  };
  const rdp = (pts, first, last, out) => {
    let maxD = sqTol, idx = -1;
    for (let i = first + 1; i < last; i++) { const d = segDist(pts[i], pts[first], pts[last]); if (d > maxD) { maxD = d; idx = i; } }
    if (idx > -1) { rdp(pts, first, idx, out); out.push(pts[idx]); rdp(pts, idx, last, out); }
  };
  // split the loop at the point farthest from the start for a stable result
  let far = 0, fd = -1;
  points.forEach((p, i) => { const d = (p.x - points[0].x) ** 2 + (p.y - points[0].y) ** 2; if (d > fd) { fd = d; far = i; } });
  const a = points.slice(0, far + 1), b = [...points.slice(far), points[0]];
  const outA = [a[0]]; rdp(a, 0, a.length - 1, outA); outA.push(a[a.length - 1]);
  const outB = [b[0]]; rdp(b, 0, b.length - 1, outB);
  return [...outA, ...outB.slice(1)];
}

// Chaikin corner-cutting for smoother curves from pixel staircases
export function smooth(points, iterations = 2) {
  let p = points;
  for (let k = 0; k < iterations; k++) {
    const out = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y }, { x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    p = out;
  }
  return p;
}

// Full pipeline: mask -> closed paths in mm (sized so the image is widthMm wide).
export function traceToPaths(mask, w, h, { widthMm, minAreaPx = 16, tolerancePx = 0.8, smoothing = 2 } = {}) {
  const k = (widthMm || w) / w;
  const loops = traceMask(mask, w, h).filter((l) => Math.abs(polygonArea(l)) >= minAreaPx);
  return loops.map((l) => {
    let p = simplify(l, tolerancePx);
    if (smoothing) p = simplify(smooth(p, smoothing), tolerancePx * 0.35);
    const mm = p.map(({ x, y }) => ({ x: x * k, y: y * k }));
    mm.push({ ...mm[0] });
    return mm;
  });
}
