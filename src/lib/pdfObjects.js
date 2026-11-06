// PDF / AI / EPS (after the main process has turned it into PDF) -> editable Design objects:
// every filled or stroked path becomes its own object with its fill color, stroke color and width;
// pictures become image objects; CutContour lines (re-tinted to #FE01FE by electron/lib/artPrep.js,
// or plain 100% magenta strokes) become cut lines. All in mm from the PDF page's top-left.
//
// pdfjs is passed in so this runs both in the app (Vite build) and in node tests (legacy build).
import { flattenCubic, flattenQuad } from './geometry.js';
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

  let st = { ctm: [1, 0, 0, 1, 0, 0], fill: '#000000', stroke: '#000000', lw: 1, fa: 1, sa: 1 };
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
    else if (fn === O.setFillRGBColor) st = { ...st, fill: hex(args[0]) };
    else if (fn === O.setStrokeRGBColor) st = { ...st, stroke: hex(args[0]) };
    else if (fn === O.setLineWidth) st = { ...st, lw: Number(args[0]) || 0 };
    else if (fn === O.setGState) {
      for (const [k, v] of args[0] || []) {
        if (k === 'LW') st = { ...st, lw: Number(v) || 0 };
        if (k === 'ca') st = { ...st, fa: Number(v) };
        if (k === 'CA') st = { ...st, sa: Number(v) };
      }
    } else if (fn === O.shadingFill) skippedShading++;
    else if (fn === O.paintImageXObject || fn === O.paintImageXObjectRepeat) {
      const img = await getObj(args[0]);
      if (img) await imageAt(img, st.ctm); else skippedImages++;
    } else if (fn === O.paintInlineImageXObject) await imageAt(args[0], st.ctm);
    else if (fn === O.constructPath) {
      const [paintOp, dataList] = args;
      const doFill = FILLS.has(paintOp), doStroke = STROKES.has(paintOp);
      if (!doFill && !doStroke) continue; // clip / endPath
      const paths = pathFrom(dataList, st.ctm);
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
        fill: doFill ? { type: 'solid', color: st.fill } : { type: 'none' },
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
