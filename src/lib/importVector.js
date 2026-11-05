// PDF / Illustrator (.ai, PDF-compatible) and DXF import -> cut paths in mm, with colors.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import DxfParser from 'dxf-parser';
import { flattenCubic, flattenQuad, normalize } from './geometry.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const PT = 25.4 / 72;

const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

export async function importPdf(bytes, pageNo = 1) {
  const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const page = await pdf.getPage(Math.min(pageNo, pdf.numPages));
  const ol = await page.getOperatorList();
  const O = pdfjs.OPS;
  const PAINT = new Set([O.stroke, O.closeStroke, O.fill, O.eoFill, O.fillStroke, O.eoFillStroke, O.closeFillStroke, O.closeEOFillStroke]);
  const view = page.view; // [x0, y0, x1, y1] in points
  let ctm = [1, 0, 0, 1, 0, 0];
  let fill = '#000000', stroke = '#000000';
  const stack = [];
  const paths = [], colors = [];

  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], args = ol.argsArray[i];
    if (fn === O.save) stack.push({ ctm, fill, stroke });
    else if (fn === O.restore) { const s = stack.pop(); if (s) ({ ctm, fill, stroke } = s); }
    else if (fn === O.transform) ctm = mul(ctm, args);
    else if (fn === O.paintFormXObjectBegin) { stack.push({ ctm, fill, stroke }); if (args && args[0]) ctm = mul(ctm, args[0]); }
    else if (fn === O.paintFormXObjectEnd) { const s = stack.pop(); if (s) ({ ctm, fill, stroke } = s); }
    else if (fn === O.setFillRGBColor) fill = String(args[0]).toLowerCase();
    else if (fn === O.setStrokeRGBColor) stroke = String(args[0]).toLowerCase();
    else if (fn === O.constructPath) {
      const [paintOp, dataList] = args;
      if (!PAINT.has(paintOp)) continue; // clipping paths etc.
      const isFill = paintOp !== O.stroke && paintOp !== O.closeStroke;
      const color = isFill ? fill : stroke;
      const toMm = (p) => ({ x: (p.x - view[0]) * PT, y: (view[3] - p.y) * PT });
      for (const data of dataList || []) {
        const d = Array.from(data || []);
        let cur = null, pt = null, start = null;
        const flush = () => { if (cur && cur.length > 1) { paths.push(cur.map(toMm)); colors.push(color); } cur = null; };
        for (let k = 0; k < d.length;) {
          const op = d[k++];
          if (op === 0) { flush(); pt = apply(ctm, d[k++], d[k++]); start = pt; cur = [pt]; }
          else if (op === 1) { pt = apply(ctm, d[k++], d[k++]); (cur || (cur = [start || pt])).push(pt); }
          else if (op === 2) {
            const c1 = apply(ctm, d[k++], d[k++]), c2 = apply(ctm, d[k++], d[k++]), e = apply(ctm, d[k++], d[k++]);
            if (!cur) cur = [pt];
            cur.push(...flattenCubic(pt, c1, c2, e, PT)); pt = e;
          } else if (op === 3) {
            const c1 = apply(ctm, d[k++], d[k++]), e = apply(ctm, d[k++], d[k++]);
            if (!cur) cur = [pt];
            cur.push(...flattenQuad(pt, c1, e, PT)); pt = e;
          } else if (op === 4) {
            if (cur && start) cur.push({ ...start });
            flush(); pt = start;
          } else break; // unknown op: stop this path safely
        }
        flush();
      }
    }
  }
  if (!paths.length) throw new Error('No vector shapes found. Text must be converted to outlines, and scanned/photo PDFs need tracing instead.');
  return { paths: normalize(paths), colors };
}

// ---- DXF ----
const DXF_UNITS = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 };

function arcPoints(cx, cy, r, a0, a1, ccw = true) {
  let sweep = a1 - a0;
  if (ccw && sweep <= 0) sweep += Math.PI * 2;
  if (!ccw && sweep >= 0) sweep -= Math.PI * 2;
  const n = Math.max(8, Math.ceil(Math.abs(sweep) * r / 0.5));
  const out = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (sweep * i) / n; out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
  return out;
}

function bulgeArc(p1, p2, b) {
  const theta = 4 * Math.atan(b);
  const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (!chord) return [];
  const r = chord / (2 * Math.sin(theta / 2));
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2)) * Math.sign(b) * (Math.abs(theta) > Math.PI ? -1 : 1);
  const nx = -(p2.y - p1.y) / chord, ny = (p2.x - p1.x) / chord;
  const cx = mx + nx * h, cy = my + ny * h;
  const a0 = Math.atan2(p1.y - cy, p1.x - cx), a1 = Math.atan2(p2.y - cy, p2.x - cx);
  return arcPoints(cx, cy, Math.abs(r), a0, a1, b > 0).slice(1);
}

function bspline(ctrl, degree, samples = 200) {
  const n = ctrl.length;
  if (n <= degree) return ctrl;
  const knots = [];
  for (let i = 0; i <= n + degree; i++) knots.push(i < degree + 1 ? 0 : i > n - 1 ? n - degree : i - degree);
  const maxT = n - degree, out = [];
  for (let s = 0; s <= samples; s++) {
    const t = Math.min((s / samples) * maxT, maxT - 1e-9);
    let k = degree;
    while (k < n - 1 && knots[k + 1] <= t) k++;
    const d = [];
    for (let j = 0; j <= degree; j++) d.push({ ...ctrl[k - degree + j] });
    for (let r = 1; r <= degree; r++) for (let j = degree; j >= r; j--) {
      const i = k - degree + j, a = (t - knots[i]) / (knots[i + degree + 1 - r] - knots[i] || 1);
      d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y };
    }
    out.push(d[degree]);
  }
  return out;
}

function entityPaths(e, blocks, depth = 0) {
  const P = (v) => ({ x: v.x, y: v.y });
  switch (e.type) {
    case 'LINE': return [[P(e.vertices[0]), P(e.vertices[1])]];
    case 'LWPOLYLINE': case 'POLYLINE': {
      const v = e.vertices || [];
      if (v.length < 2) return [];
      const closed = e.shape || e.closed;
      const pts = [P(v[0])];
      const n = closed ? v.length : v.length - 1;
      for (let i = 0; i < n; i++) {
        const a = v[i], b = v[(i + 1) % v.length];
        if (a.bulge) pts.push(...bulgeArc(P(a), P(b), a.bulge)); else pts.push(P(b));
      }
      return [pts];
    }
    case 'CIRCLE': { const p = arcPoints(e.center.x, e.center.y, e.radius, 0, Math.PI * 2); p[p.length - 1] = { ...p[0] }; return [p]; }
    case 'ARC': return [arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle)];
    case 'ELLIPSE': {
      const mx = e.majorAxisEndPoint.x, my = e.majorAxisEndPoint.y, R = Math.hypot(mx, my), rot = Math.atan2(my, mx), r2 = R * e.axisRatio;
      let a0 = e.startAngle ?? 0, a1 = e.endAngle ?? Math.PI * 2;
      if (a1 <= a0) a1 += Math.PI * 2;
      const n = Math.max(48, Math.ceil((a1 - a0) * R / 0.5)), out = [];
      for (let i = 0; i <= n; i++) {
        const t = a0 + ((a1 - a0) * i) / n, x = R * Math.cos(t), y = r2 * Math.sin(t);
        out.push({ x: e.center.x + x * Math.cos(rot) - y * Math.sin(rot), y: e.center.y + x * Math.sin(rot) + y * Math.cos(rot) });
      }
      return [out];
    }
    case 'SPLINE': {
      if (e.controlPoints && e.controlPoints.length) return [bspline(e.controlPoints.map(P), e.degreeOfSplineCurve || 3)];
      if (e.fitPoints && e.fitPoints.length) return [e.fitPoints.map(P)];
      return [];
    }
    case 'INSERT': {
      const b = blocks[e.name];
      if (!b || depth > 8) return [];
      const sx = e.xScale ?? 1, sy = e.yScale ?? 1, rot = ((e.rotation || 0) * Math.PI) / 180;
      const bx = b.position?.x || 0, by = b.position?.y || 0;
      const c = Math.cos(rot), s = Math.sin(rot);
      return (b.entities || []).flatMap((child) => entityPaths(child, blocks, depth + 1)).map((p) => p.map(({ x, y }) => {
        const X = (x - bx) * sx, Y = (y - by) * sy;
        return { x: e.position.x + X * c - Y * s, y: e.position.y + X * s + Y * c };
      }));
    }
    default: return [];
  }
}

export function importDxf(text) {
  const dxf = new DxfParser().parseSync(text);
  const unit = DXF_UNITS[dxf.header?.$INSUNITS] ?? 25.4; // unknown units: assume inches (common for sign files)
  const paths = (dxf.entities || []).flatMap((e) => entityPaths(e, dxf.blocks || {})).filter((p) => p.length > 1)
    .map((p) => p.map(({ x, y }) => ({ x: x * unit, y: -y * unit })));
  if (!paths.length) throw new Error('No supported shapes found in the DXF (lines, polylines, arcs, circles, ellipses, splines, blocks).');
  return { paths: normalize(paths), colors: paths.map(() => '#000000'), assumedInches: dxf.header?.$INSUNITS == null };
}
