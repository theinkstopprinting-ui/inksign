// PDF / AI / EPS (after the main process has turned it into PDF) -> editable Design objects:
// every filled or stroked path becomes its own object with its fill color, stroke color and width;
// pictures become image objects; CutContour lines (re-tinted to #FE01FE by electron/lib/artPrep.js,
// or plain 100% magenta strokes) become cut lines. All in mm from the PDF page's top-left.
//
// pdfjs is passed in so this runs both in the app (Vite build) and in node tests (legacy build).
import { flattenCubic, flattenQuad, isClosed, bounds } from './geometry.js';
import { boolean, pointInPoly } from './cuttools.js';
import { shapeFromPaths, imageObject, newId, CUT_COLOR } from './doc.js';

const PT = 25.4 / 72;
const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

export const CUT_MARK = '#fe01fe';
const isCutColor = (c) => c === CUT_MARK || c === '#ff00ff' || c === '#ec008c';

function hex(v) {
  if (typeof v === 'string') return v.toLowerCase();
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return `#${Array.from(v).slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
  return '#000000';
}

/**
 * opts.imageToDataUrl(imgObj) -> dataUrl | null   (browser: draws pdf.js image data to a canvas)
 * opts.cutMagenta: also treat plain 100% magenta strokes as cut lines (default true)
 * Returns { objects, page: {w, h}, pages, notes }
 */
export async function pdfToObjects(pdfjs, bytes, { page: pageNo = 1, imageToDataUrl, cutMagenta = true } = {}) {
  const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: false }).promise;
  const page = await pdf.getPage(Math.min(Math.max(1, pageNo), pdf.numPages));
  const ol = await page.getOperatorList();
  const O = pdfjs.OPS;
  const view = page.view;
  const pageW = (view[2] - view[0]) * PT, pageH = (view[3] - view[1]) * PT;
  const toMm = (p) => ({ x: (p.x - view[0]) * PT, y: (view[3] - p.y) * PT });

  const FILLS = new Set([O.fill, O.eoFill, O.fillStroke, O.eoFillStroke, O.closeFillStroke, O.closeEOFillStroke]);
  const STROKES = new Set([O.stroke, O.closeStroke, O.fillStroke, O.eoFillStroke, O.closeFillStroke, O.closeEOFillStroke]);
  const EO = new Set([O.eoFill, O.eoFillStroke, O.closeEOFillStroke]);

  // clip: the current clipping area (closed paths, mm) or null = the whole page
  let st = { ctm: [1, 0, 0, 1, 0, 0], fill: '#000000', stroke: '#000000', lw: 1, fa: 1, sa: 1, clip: null, fillShade: null };
  let pendingClip = null; // 'nonzero' | 'evenodd' — the next path sets the clip (PDF "W n")
  const pageRect = () => [[{ x: 0, y: 0 }, { x: pageW, y: 0 }, { x: pageW, y: pageH }, { x: 0, y: pageH }, { x: 0, y: 0 }]];
  // Clipped artwork (masks, "Draw Inside", a background trimmed to an arc) is cut to its clip
  // Art past the page edge is trimmed to the page, the way it prints from the PDF
  const offPage = (paths) => { const b = bounds(paths); return b.minX < -0.01 || b.minY < -0.01 || b.maxX > pageW + 0.01 || b.maxY > pageH + 0.01; };
  const clipFill = (paths) => {
    const clip = st.clip || (offPage(paths) ? pageRect() : null);
    if (!clip) return paths;
    const closed = paths.filter(isClosed);
    if (!closed.length) return paths;
    return boolean(closed, clip, 'intersection');
  };
  const clipLines = (paths) => {
    const clipArea = st.clip || (offPage(paths) ? pageRect() : null);
    if (!clipArea) return paths;
    const clip = clipArea;
    const out = [];
    for (const p of paths) {
      let run = [];
      for (let k = 1; k < p.length; k++) {
        const m = { x: (p[k - 1].x + p[k].x) / 2, y: (p[k - 1].y + p[k].y) / 2 };
        const inside = clip.reduce((n, c) => n + (pointInPoly(m, c) ? 1 : 0), 0) % 2 === 1;
        if (inside) { if (!run.length) run.push(p[k - 1]); run.push(p[k]); } else if (run.length) { out.push(run); run = []; }
      }
      if (run.length) out.push(run);
    }
    return out;
  };
  // pdf.js shading IR -> our gradient fill
  const shadeFill = (ir, ctm) => {
    if (!Array.isArray(ir) || ir[0] !== 'RadialAxial') return null;
    const [, kind, , stops, p0, p1] = ir;
    const cols = (stops || []).map((x) => hex(x[1]));
    if (!cols.length) return null;
    const a = toMm(apply(ctm, p0[0], p0[1])), b = toMm(apply(ctm, p1[0], p1[1]));
    const angle = Math.round((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI);
    return kind === 'radial' ? { type: 'radial', color: cols[0], color2: cols[cols.length - 1] }
      : { type: 'linear', color: cols[0], color2: cols[cols.length - 1], angle: ((angle % 360) + 360) % 360 };
  };
  const stack = [];
  const objects = [];
  const notes = new Set();
  let skippedShading = 0, skippedImages = 0;

  const pathFrom = (dataList, ctm) => {
    const out = [];
    for (const data of dataList || []) {
      const d = Array.from(data || []);
      let cur = null, pt = null, start = null;
      const flush = () => { if (cur && cur.length > 1) out.push(cur.map(toMm)); cur = null; };
      for (let k = 0; k < d.length;) {
        const op = d[k++];
        if (op === 0) { flush(); pt = apply(ctm, d[k++], d[k++]); start = pt; cur = [pt]; }
        else if (op === 1) { pt = apply(ctm, d[k++], d[k++]); (cur || (cur = [start || pt])).push(pt); }
        else if (op === 2) {
          const c1 = apply(ctm, d[k++], d[k++]), c2 = apply(ctm, d[k++], d[k++]), e = apply(ctm, d[k++], d[k++]);
          if (!cur) cur = [pt];
          cur.push(...flattenCubic(pt, c1, c2, e, 0.25 / PT)); pt = e;
        } else if (op === 3) {
          const c1 = apply(ctm, d[k++], d[k++]), e = apply(ctm, d[k++], d[k++]);
          if (!cur) cur = [pt];
          cur.push(...flattenQuad(pt, c1, e, 0.25 / PT)); pt = e;
        } else if (op === 4) {
          if (cur && start) { const l = cur[cur.length - 1]; if (l.x !== start.x || l.y !== start.y) cur.push({ ...start }); }
          flush(); pt = start;
        } else break;
      }
      flush();
    }
    return out;
  };

  const imageAt = async (img, ctm) => {
    // An image fills the unit square mapped by the CTM
    const corners = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 1, 1), apply(ctm, 0, 1)].map(toMm);
    const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
    const wv = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
    const hv = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
    const ang = (Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x) * 180) / Math.PI;
    const src = imageToDataUrl ? await imageToDataUrl(img) : null;
    if (!src) { skippedImages++; return; }
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    // PDF images are drawn upside-down in the unit square (y up); after the page flip they're upright
    const det = ctm[0] * ctm[3] - ctm[1] * ctm[2];
    const o = imageObject({ src, natW: wv, natH: hv, x: cx - wv / 2, y: cy - hv / 2, w: wv, h: hv, name: 'Image' });
    o.rot = Math.round(((ang % 360) + 360) % 360 * 100) / 100;
    o.flipY = det < 0;
    objects.push(o);
  };

  const getObj = (id) => new Promise((resolve) => {
    const objs = id.startsWith('g_') ? page.commonObjs : page.objs;
    try { objs.get(id, resolve); } catch { resolve(null); }
    setTimeout(() => resolve(null), 5000);
  });

  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], args = ol.argsArray[i];
    if (fn === O.save) stack.push({ ...st });
    else if (fn === O.restore) { const s = stack.pop(); if (s) st = s; }
    else if (fn === O.transform) st = { ...st, ctm: mul(st.ctm, args) };
    else if (fn === O.paintFormXObjectBegin) { stack.push({ ...st }); if (args && args[0]) st = { ...st, ctm: mul(st.ctm, args[0]) }; }
    else if (fn === O.paintFormXObjectEnd) { const s = stack.pop(); if (s) st = s; }
    else if (fn === O.setFillRGBColor) st = { ...st, fill: hex(args[0]), fillShade: null };
    else if (fn === O.setStrokeRGBColor) st = { ...st, stroke: hex(args[0]) };
    else if (fn === O.setLineWidth) st = { ...st, lw: Number(args[0]) || 0 };
    else if (fn === O.setGState) {
      for (const [k, v] of args[0] || []) {
        if (k === 'LW') st = { ...st, lw: Number(v) || 0 };
        if (k === 'ca') st = { ...st, fa: Number(v) };
        if (k === 'CA') st = { ...st, sa: Number(v) };
      }
    } else if (fn === O.clip) pendingClip = 'nonzero';
    else if (fn === O.eoClip) pendingClip = 'evenodd';
    else if (fn === O.setFillColorN || fn === O.setFillColor) {
      // a shading pattern used as a fill color: ["Shading", objId, patternMatrix] — the pattern matrix
      // maps pattern space to the page's default space (not the current transform)
      let f = null;
      if (Array.isArray(args) && args[0] === 'Shading') {
        const ir = typeof args[1] === 'string' ? await getObj(args[1]) : args[1];
        f = shadeFill(ir, args[2] || [1, 0, 0, 1, 0, 0]);
      }
      st = { ...st, fillShade: f };
    } else if (fn === O.shadingFill) {
      // "sh": paint a gradient over the clip area (or the page)
      const ir = typeof args[0] === 'string' ? await getObj(args[0]) : args[0];
      const f = shadeFill(ir, st.ctm);
      const area = st.clip || pageRect();
      if (f && area.length) {
        const o = shapeFromPaths(area, { name: 'Gradient', fill: f, stroke: { color: null, width: 0 }, fillRule: 'evenodd' });
        if (st.fa < 1) o.opacity = st.fa;
        objects.push(o);
      } else skippedShading++;
    }
    else if (fn === O.paintImageXObject || fn === O.paintImageXObjectRepeat) {
      const img = await getObj(args[0]);
      if (img) await imageAt(img, st.ctm); else skippedImages++;
    } else if (fn === O.paintInlineImageXObject) await imageAt(args[0], st.ctm);
    else if (fn === O.constructPath) {
      const [paintOp, dataList] = args;
      const doFill = FILLS.has(paintOp), doStroke = STROKES.has(paintOp);
      if (pendingClip) {
        const cp = pathFrom(dataList, st.ctm).map((p) => (isClosed(p) ? p : [...p, { ...p[0] }])).filter((p) => p.length > 3);
        const own = pendingClip === 'evenodd' ? cp : boolean(cp, [], 'union');
        st = { ...st, clip: st.clip ? boolean(st.clip, own, 'intersection') : own };
        pendingClip = null;
        // a clip that covers the whole page clips nothing
        if (st.clip && st.clip.length) {
          const b = bounds(st.clip);
          if (b.minX <= 0.01 && b.minY <= 0.01 && b.maxX >= pageW - 0.01 && b.maxY >= pageH - 0.01 && st.clip.length === 1 && st.clip[0].length <= 6) st = { ...st, clip: null };
        }
      }
      if (!doFill && !doStroke) continue; // endPath (after W)
      const raw = pathFrom(dataList, st.ctm);
      if (!raw.length) continue;
      const paths = doFill ? clipFill(raw) : clipLines(raw);
      if (!paths.length) continue;
      const strokeW = st.lw * scaleOf(st.ctm) * PT;
      const cutStroke = doStroke && (st.stroke === CUT_MARK || (cutMagenta && isCutColor(st.stroke)));
      const cutFill = doFill && st.fill === CUT_MARK;
      if (cutStroke || cutFill) {
        const o = shapeFromPaths(paths, { name: 'CutContour', fill: { type: 'none' }, stroke: { color: CUT_COLOR, width: 0 }, cut: true });
        objects.push(o);
        if (doFill && !cutFill) objects.splice(objects.length - 1, 0, shapeFromPaths(paths, { name: 'Shape', fill: { type: 'solid', color: st.fill }, stroke: { color: null, width: 0 } }));
        continue;
      }
      const o = shapeFromPaths(paths, {
        name: doFill ? 'Shape' : 'Line',
        fill: doFill ? (st.fillShade || { type: 'solid', color: st.fill }) : { type: 'none' },
        stroke: doStroke ? { color: st.stroke, width: Math.max(0.05, strokeW) } : { color: null, width: 0 },
        fillRule: EO.has(paintOp) ? 'evenodd' : 'nonzero',
      });
      if (st.fa < 1 || st.sa < 1) o.opacity = Math.min(st.fa, st.sa);
      objects.push(o);
    }
  }
  if (skippedShading) notes.add(`${skippedShading} gradient fill${skippedShading > 1 ? 's' : ''} came in without the gradient`);
  if (skippedImages) notes.add(`${skippedImages} picture${skippedImages > 1 ? 's' : ''} couldn't be read`);
  // a white page-size background rectangle (common in exports) is kept but locked out of the way? -> leave as is
  return { objects, page: { w: pageW, h: pageH }, pages: pdf.numPages, notes: [...notes] };
}

/** Put imported objects into one group so they move together (ungroup to edit pieces) */
export function asGroup(objects) {
  if (objects.length < 2) return objects;
  const gid = newId();
  return objects.map((o) => ({ ...o, groupId: gid }));
}
