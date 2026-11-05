// Basic shapes, all in mm, starting at 0,0.
const close = (p) => [...p, { ...p[0] }];

export function rectangle(w, h, r = 0) {
  r = Math.min(r, w / 2, h / 2);
  if (r <= 0) return [close([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }])];
  const pts = [];
  const corner = (cx, cy, a0) => { for (let i = 0; i <= 12; i++) { const a = a0 + (i / 12) * Math.PI / 2; pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); } };
  corner(w - r, r, -Math.PI / 2); corner(w - r, h - r, 0); corner(r, h - r, Math.PI / 2); corner(r, r, Math.PI);
  return [close(pts)];
}

export function ellipse(w, h) {
  const n = Math.max(48, Math.ceil(Math.PI * (w + h) / 2 / 0.5));
  const pts = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push({ x: w / 2 + (w / 2) * Math.cos(a), y: h / 2 + (h / 2) * Math.sin(a) }); }
  return [close(pts)];
}

export function polygon(sides, w, h) {
  const pts = [];
  for (let i = 0; i < sides; i++) { const a = -Math.PI / 2 + (i / sides) * Math.PI * 2; pts.push({ x: Math.cos(a), y: Math.sin(a) }); }
  return [close(fit(pts, w, h))];
}

export function star(points, w, h, inner = 0.45) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i / (points * 2)) * Math.PI * 2, r = i % 2 ? inner : 1;
    pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
  }
  return [close(fit(pts, w, h))];
}

export function arrow(w, h) {
  const head = Math.min(w * 0.4, h);
  return [close([
    { x: 0, y: h * 0.3 }, { x: w - head, y: h * 0.3 }, { x: w - head, y: 0 }, { x: w, y: h / 2 },
    { x: w - head, y: h }, { x: w - head, y: h * 0.7 }, { x: 0, y: h * 0.7 },
  ])];
}

export function heart(w, h) {
  const pts = [];
  for (let i = 0; i < 120; i++) {
    const t = (i / 120) * Math.PI * 2;
    pts.push({ x: 16 * Math.sin(t) ** 3, y: -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) });
  }
  return [close(fit(pts, w, h))];
}

function fit(pts, w, h) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys), sx = w / (Math.max(...xs) - minX), sy = h / (Math.max(...ys) - minY);
  return pts.map(({ x, y }) => ({ x: (x - minX) * sx, y: (y - minY) * sy }));
}

export const SHAPES = [
  { id: 'rect', name: 'Rectangle', make: (w, h) => rectangle(w, h) },
  { id: 'rrect', name: 'Rounded rectangle', make: (w, h, o) => rectangle(w, h, o.radius ?? Math.min(w, h) * 0.15) },
  { id: 'ellipse', name: 'Circle / oval', make: (w, h) => ellipse(w, h) },
  { id: 'triangle', name: 'Triangle', make: (w, h) => polygon(3, w, h) },
  { id: 'hexagon', name: 'Hexagon', make: (w, h) => polygon(6, w, h) },
  { id: 'octagon', name: 'Octagon', make: (w, h) => polygon(8, w, h) },
  { id: 'star', name: 'Star', make: (w, h, o) => star(o.points || 5, w, h) },
  { id: 'arrow', name: 'Arrow', make: (w, h) => arrow(w, h) },
  { id: 'heart', name: 'Heart', make: (w, h) => heart(w, h) },
];
