// Outline / offset paths (for shadows, layered vinyl, contour cut lines) using Clipper.
import ClipperLib from 'clipper-lib';
import { isClosed } from './geometry.js';

const SCALE = 1000;
const toClip = (paths) => paths.map((p) => p.map(({ x, y }) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));
const fromClip = (paths) => paths.filter((p) => p.length > 2).map((p) => {
  const out = p.map(({ X, Y }) => ({ x: X / SCALE, y: Y / SCALE }));
  out.push({ ...out[0] });
  return out;
});

// Merge overlapping shapes into clean outer outlines + holes (even-odd).
export function unionPaths(paths) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(toClip(paths.filter(isClosed)), ClipperLib.PolyType.ptSubject, true);
  const sol = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctUnion, sol, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
  return sol;
}

// distanceMm > 0 grows, < 0 shrinks. corners: 'round' | 'square' | 'miter'.
// outerOnly drops the holes (a solid shadow/backer).
export function offsetPaths(paths, distanceMm, { corners = 'round', outerOnly = false } = {}) {
  let base = unionPaths(paths);
  if (outerOnly) base = base.filter((p) => ClipperLib.Clipper.Orientation(p));
  const join = { round: ClipperLib.JoinType.jtRound, square: ClipperLib.JoinType.jtSquare, miter: ClipperLib.JoinType.jtMiter }[corners] ?? ClipperLib.JoinType.jtRound;
  const co = new ClipperLib.ClipperOffset(2, 0.05 * SCALE);
  co.AddPaths(base, join, ClipperLib.EndType.etClosedPolygon);
  const sol = new ClipperLib.Paths();
  co.Execute(sol, distanceMm * SCALE);
  let out = sol;
  if (outerOnly) out = sol.filter((p) => ClipperLib.Clipper.Orientation(p));
  return fromClip(out);
}
