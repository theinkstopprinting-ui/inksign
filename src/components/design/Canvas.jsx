// The Design workspace's drawing area: page, rulers, guides, grid, objects, selection handles and the
// drawing tools (select, nodes, text, shapes, line, pen, zoom, pan, eyedropper). Units are mm on the
// page; the view is z pixels per mm, offset by (vx, vy) pixels.
import React, { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import * as D from '../../lib/doc.js';
import { SHAPES } from '../../lib/shapes.js';
import { flattenCubic, isClosed } from '../../lib/geometry.js';

const MM = 25.4;
const RULER = 22;
const dCache = new WeakMap();
function baseD(paths) {
  let d = dCache.get(paths);
  if (d == null) { d = D.pathD(paths, 3); dCache.set(paths, d); }
  return d;
}
export function objTransform(o) {
  const sx = (o.bw ? o.w / o.bw : 1) * (o.flipX ? -1 : 1), sy = (o.bh ? o.h / o.bh : 1) * (o.flipY ? -1 : 1);
  return `translate(${o.x} ${o.y}) rotate(${o.rot || 0} ${o.w / 2} ${o.h / 2}) translate(${o.flipX ? o.w : 0} ${o.flipY ? o.h : 0}) scale(${sx} ${sy})`;
}

// One object, drawn in its own box with an SVG transform (moving it doesn't rebuild the path)
const ObjView = memo(function ObjView({ o, z, wire }) {
  if (o.hidden) return null;
  const tf = objTransform(o);
  if (o.type === 'image') {
    return (
      <g transform={tf} opacity={o.opacity ?? 1}>
        {wire ? <rect width={o.bw} height={o.bh} fill="none" stroke="#000" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          : <image href={o.src} x={0} y={0} width={o.bw} height={o.bh} preserveAspectRatio="none" />}
      </g>
    );
  }
  const d = baseD(o.paths);
  if (o.cut) return <path d={d} transform={tf} fill="none" stroke={D.CUT_COLOR} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />;
  if (wire) return <path d={d} transform={tf} fill="none" stroke="#111" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
  const f = o.fill || { type: 'none' };
  const gid = `gr-${o.id}`;
  let fill = 'none';
  let defs = null;
  if (f.type === 'solid') fill = f.color;
  else if (f.type === 'linear') {
    fill = `url(#${gid})`;
    defs = (
      <linearGradient id={gid} gradientTransform={`rotate(${f.angle || 0} .5 .5)`}>
        <stop offset="0" stopColor={f.color} /><stop offset="1" stopColor={f.color2 || '#ffffff'} />
      </linearGradient>
    );
  } else if (f.type === 'radial') {
    fill = `url(#${gid})`;
    defs = <radialGradient id={gid}><stop offset="0" stopColor={f.color} /><stop offset="1" stopColor={f.color2 || '#ffffff'} /></radialGradient>;
  }
  const sw = o.stroke && o.stroke.color && o.stroke.width > 0 ? o.stroke.width * z : 0;
  return (
    <g opacity={o.opacity ?? 1}>
      {defs && <defs>{defs}</defs>}
      <path d={d} transform={tf} fill={fill} fillRule={o.fillRule === 'nonzero' ? 'nonzero' : 'evenodd'}
        stroke={sw ? o.stroke.color : 'none'} strokeWidth={sw} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </g>
  );
});

function rulerStep(z) {
  const steps = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 6, 12, 24, 48, 120];
  const minor = steps.find((s) => s * MM * z >= 7) || 120;
  const major = steps.find((s) => s * MM * z >= 60 && s >= minor) || 120;
  return { minor, major };
}
const fmtIn = (v) => (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(2).replace(/0+$/, ''));

function Ruler({ axis, view, size, onGuideStart, cursor }) {
  const { z } = view;
  const { minor, major } = rulerStep(z);
  const off = axis === 'x' ? view.vx : view.vy;
  const len = axis === 'x' ? size.w : size.h;
  const from = Math.floor((-off / z / MM) / minor) * minor, to = ((len - off) / z / MM);
  const ticks = [];
  for (let v = from; v <= to; v += minor) {
    const px = off + v * MM * z;
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
    const half = !isMajor && Math.abs((v * 2) / major - Math.round((v * 2) / major)) < 1e-6;
    const L = isMajor ? RULER : half ? 9 : 5;
    ticks.push(axis === 'x'
      ? <line key={v} x1={px} x2={px} y1={RULER - L} y2={RULER} />
      : <line key={v} y1={px} y2={px} x1={RULER - L} x2={RULER} />);
    if (isMajor) ticks.push(axis === 'x'
      ? <text key={`t${v}`} x={px + 3} y={10}>{fmtIn(v)}</text>
      : <text key={`t${v}`} x={10} y={px + 3} transform={`rotate(-90 10 ${px + 3})`}>{fmtIn(v)}</text>);
  }
  const cur = cursor ? off + (axis === 'x' ? cursor.x : cursor.y) * z : null;
  return (
    <svg className={`dz-ruler dz-ruler-${axis}`} width={axis === 'x' ? len : RULER} height={axis === 'x' ? RULER : len}
      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); onGuideStart(axis === 'x' ? 'y' : 'x', e); }}>
      <g stroke="#6b7383" fontSize="9" fill="#9aa2b1">{ticks}</g>
      {cur != null && (axis === 'x' ? <line x1={cur} x2={cur} y1={0} y2={RULER} stroke="#ff7a1a" /> : <line y1={cur} y2={cur} x1={0} x2={RULER} stroke="#ff7a1a" />)}
    </svg>
  );
}

const HANDLES = [['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5], ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5]];
const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

const Canvas = forwardRef(function Canvas(props, ref) {
  const {
    doc, sel, setSel, tool, setTool, view, setView, opts, shapeKind,
    live, begin, commit, onCursor, onTextAt, onEditText, onPick, wire, active,
  } = props;
  const wrap = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [drag, setDrag] = useState(null); // current gesture
  const [cursor, setCursor] = useState(null);
  const [pen, setPen] = useState(null); // { pts: [{x,y,h?:{x,y}}] }
  const [nodeSel, setNodeSel] = useState(null); // { id, pi, ki }
  const [space, setSpace] = useState(false);
  const z = view.z;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = (b = { minX: 0, minY: 0, w: doc.page.w, h: doc.page.h }) => {
    const W = size.w - RULER - 40, H = size.h - RULER - 40;
    const nz = Math.max(0.02, Math.min(60, Math.min(W / (b.w || 1), H / (b.h || 1))));
    setView({ z: nz, vx: RULER + 20 + (W - b.w * nz) / 2 - b.minX * nz, vy: RULER + 20 + (H - b.h * nz) / 2 - b.minY * nz });
  };
  const fitRef = useRef(false);
  useEffect(() => { if (!fitRef.current && size.w > 100) { fitRef.current = true; fit(); } }, [size.w]);

  useImperativeHandle(ref, () => ({
    fit: () => fit(),
    fitSelection: () => { const b = D.selBounds(doc.objects.filter((o) => sel.includes(o.id))); if (b) fit({ minX: b.minX - 5, minY: b.minY - 5, w: b.w + 10, h: b.h + 10 }); },
    zoomBy: (k) => zoomAt(size.w / 2, size.h / 2, k),
    actual: () => { const k = (96 / MM) / z; zoomAt(size.w / 2, size.h / 2, k); },
    deleteNode: () => deleteNode(),
    finishPen: (close) => finishPen(close),
    cancelPen: () => setPen(null),
    hasPen: () => !!pen,
    hasNode: () => !!nodeSel,
  }));

  const toPage = (e) => {
    const r = wrap.current.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.vx) / z, y: (e.clientY - r.top - view.vy) / z };
  };
  function zoomAt(px, py, k) {
    setView((v) => {
      const nz = Math.max(0.02, Math.min(80, v.z * k));
      const kk = nz / v.z;
      return { z: nz, vx: px - (px - v.vx) * kk, vy: py - (py - v.vy) * kk };
    });
  }

  // wheel: zoom at the cursor (Ctrl or plain), Shift = scroll sideways
  useEffect(() => {
    const el = wrap.current;
    if (!el) return undefined;
    const h = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.shiftKey) setView((v) => ({ ...v, vx: v.vx - e.deltaY }));
      else if (e.altKey) setView((v) => ({ ...v, vy: v.vy - e.deltaY }));
      else zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, []);
  useEffect(() => {
    if (!active) return undefined;
    const dn = (e) => { if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) { setSpace(true); e.preventDefault(); } };
    const up = (e) => { if (e.code === 'Space') setSpace(false); };
    window.addEventListener('keydown', dn);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', dn); window.removeEventListener('keyup', up); };
  }, [active]);

  const selObjs = useMemo(() => doc.objects.filter((o) => sel.includes(o.id) && !o.hidden), [doc, sel]);
  const sb = useMemo(() => D.selBounds(selObjs), [selObjs]);

  // ---- snapping ----
  const snapTargets = useMemo(() => {
    const xs = [0, doc.page.w / 2, doc.page.w, ...(opts.snapGuides ? doc.guides.x : [])];
    const ys = [0, doc.page.h / 2, doc.page.h, ...(opts.snapGuides ? doc.guides.y : [])];
    if (opts.snapObjects) {
      for (const o of doc.objects) {
        if (sel.includes(o.id) || o.hidden) continue;
        const b = D.objBounds(o);
        xs.push(b.minX, (b.minX + b.maxX) / 2, b.maxX);
        ys.push(b.minY, (b.minY + b.maxY) / 2, b.maxY);
      }
    }
    return { xs, ys };
  }, [doc, sel, opts.snapGuides, opts.snapObjects]);
  const grid = (opts.gridIn || 0.25) * MM;
  const snapVal = (v, list) => {
    const tol = 6 / z;
    let best = null;
    for (const t of list) if (Math.abs(t - v) <= tol && (best == null || Math.abs(t - v) < Math.abs(best - v))) best = t;
    return best;
  };
  const snapPoint = (p) => {
    let { x, y } = p;
    if (opts.snapGrid) { x = Math.round(x / grid) * grid; y = Math.round(y / grid) * grid; }
    const sx = snapVal(p.x, snapTargets.xs), sy = snapVal(p.y, snapTargets.ys);
    if (sx != null) x = sx;
    if (sy != null) y = sy;
    return { x, y };
  };
  // Snap a moving box: returns the extra (dx, dy) to apply
  const snapBox = (b) => {
    let dx = 0, dy = 0;
    const tryAxis = (vals, list) => {
      let best = null;
      for (const v of vals) { const s = snapVal(v, list); if (s != null && (best == null || Math.abs(s - v) < Math.abs(best))) best = s - v; }
      return best;
    };
    const ex = tryAxis([b.minX, (b.minX + b.maxX) / 2, b.maxX], snapTargets.xs);
    const ey = tryAxis([b.minY, (b.minY + b.maxY) / 2, b.maxY], snapTargets.ys);
    if (ex != null) dx = ex; else if (opts.snapGrid) dx = Math.round(b.minX / grid) * grid - b.minX;
    if (ey != null) dy = ey; else if (opts.snapGrid) dy = Math.round(b.minY / grid) * grid - b.minY;
    return { dx, dy };
  };

  // ---- gestures ----
  const capture = (e) => { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ok */ } };
  const hitTol = 4 / z;

  const guideAt = (p) => {
    const tol = 4 / z;
    const gx = doc.guides.x.findIndex((g) => Math.abs(g - p.x) < tol);
    if (gx >= 0) return { axis: 'x', i: gx };
    const gy = doc.guides.y.findIndex((g) => Math.abs(g - p.y) < tol);
    if (gy >= 0) return { axis: 'y', i: gy };
    return null;
  };

  const startGuide = (axis, e) => {
    begin();
    const p = toPage(e);
    const guides = { ...doc.guides, [axis]: [...doc.guides[axis], axis === 'x' ? p.x : p.y] };
    const base = { ...doc, guides };
    live(base);
    setDrag({ kind: 'guide', axis, i: guides[axis].length - 1, base });
    wrap.current.setPointerCapture?.(e.pointerId);
  };

  const onDown = (e) => {
    if (e.button === 2) return;
    const p = toPage(e);
    const t = space || e.button === 1 ? 'pan' : tool;
    capture(e);
    if (t === 'pan') { setDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, v: view }); return; }
    if (t === 'zoom') { setDrag({ kind: 'zoomrect', a: p, b: p, out: e.altKey }); return; }
    if (t === 'text') { e.preventDefault(); onTextAt(snapPoint(p)); return; }
    if (t === 'eyedropper') { const o = D.hitTest(doc.objects, p, hitTol); if (o) onPick(o); return; }
    if (t === 'rect' || t === 'ellipse' || t === 'shape' || t === 'line') { const a = snapPoint(p); setDrag({ kind: 'draw', a, b: a, t }); return; }
    if (t === 'pen') { penDown(snapPoint(p), e); return; }
    if (t === 'node') { nodeDown(p, e); return; }
    // select tool
    const g = guideAt(p);
    if (g && !D.hitTest(doc.objects.filter((o) => sel.includes(o.id)), p, hitTol)) {
      begin();
      setDrag({ kind: 'guide', axis: g.axis, i: g.i, base: doc });
      return;
    }
    const hit = D.hitTest(doc.objects.filter((o) => !o.locked), p, hitTol);
    if (!hit) {
      if (!e.shiftKey) setSel([]);
      setDrag({ kind: 'marquee', a: p, b: p, add: e.shiftKey });
      return;
    }
    let ids = sel;
    const unit = D.expandGroups(doc, [hit.id]);
    if (e.shiftKey) ids = sel.includes(hit.id) ? sel.filter((id) => !unit.includes(id)) : [...sel, ...unit];
    else if (!sel.includes(hit.id)) ids = unit;
    setSel(ids);
    if (e.detail === 2 && hit.type === 'text') { onEditText(hit); return; }
    begin();
    let base = doc;
    let moveIds = ids;
    if (e.ctrlKey || e.metaKey) { const dup = D.duplicate(doc, ids, 0, 0); base = dup.doc; moveIds = dup.ids; setSel(moveIds); live(base); }
    setDrag({ kind: 'move', start: p, base, ids: moveIds, box: D.selBounds(base.objects.filter((o) => moveIds.includes(o.id))) });
  };

  const handleDown = (h, e) => {
    e.stopPropagation();
    capture(e);
    begin();
    const p = toPage(e);
    if (h === 'rot') {
      const c = { x: sb.cx, y: sb.cy };
      setDrag({ kind: 'rotate', base: doc, ids: sel, c, a0: Math.atan2(p.y - c.y, p.x - c.x) });
      return;
    }
    setDrag({ kind: 'scale', h, base: doc, ids: sel, box: sb, start: p });
  };

  const onMove = (e) => {
    const p = toPage(e);
    setCursor(p);
    onCursor(p);
    if (!drag) { if (pen) setPen((q) => ({ ...q, hover: snapPoint(p) })); return; }
    if (drag.kind === 'pan') { setView({ ...drag.v, vx: drag.v.vx + e.clientX - drag.sx, vy: drag.v.vy + e.clientY - drag.sy }); return; }
    if (drag.kind === 'zoomrect' || drag.kind === 'marquee') { setDrag({ ...drag, b: p }); return; }
    if (drag.kind === 'draw') { setDrag({ ...drag, b: snapPoint(p), shift: e.shiftKey, alt: e.altKey }); return; }
    if (drag.kind === 'guide') {
      const guides = { ...drag.base.guides, [drag.axis]: drag.base.guides[drag.axis].map((g, i) => (i === drag.i ? (drag.axis === 'x' ? p.x : p.y) : g)) };
      live({ ...drag.base, guides });
      return;
    }
    if (drag.kind === 'move') {
      let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const nb = { minX: drag.box.minX + dx, maxX: drag.box.maxX + dx, minY: drag.box.minY + dy, maxY: drag.box.maxY + dy };
      const s = e.altKey ? { dx: 0, dy: 0 } : snapBox(nb);
      live(D.move(drag.base, drag.ids, dx + s.dx, dy + s.dy));
      return;
    }
    if (drag.kind === 'rotate') {
      let a = ((Math.atan2(p.y - drag.c.y, p.x - drag.c.x) - drag.a0) * 180) / Math.PI;
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      live(D.rotateSel(drag.base, drag.ids, a, drag.c));
      return;
    }
    if (drag.kind === 'scale') {
      const b = drag.box, h = drag.h;
      const fromCenter = e.altKey;
      const ax = h.includes('w') ? b.maxX : h.includes('e') ? b.minX : b.cx;
      const ay = h.includes('n') ? b.maxY : h.includes('s') ? b.minY : b.cy;
      const anchor = fromCenter ? { x: b.cx, y: b.cy } : { x: ax, y: ay };
      const q = opts.snapGrid || opts.snapGuides || opts.snapObjects ? snapPoint(p) : p;
      let sx = 1, sy = 1;
      if (h.includes('e') || h.includes('w')) sx = (q.x - anchor.x) / ((h.includes('e') ? b.maxX : b.minX) - anchor.x || 1);
      if (h.includes('n') || h.includes('s')) sy = (q.y - anchor.y) / ((h.includes('s') ? b.maxY : b.minY) - anchor.y || 1);
      const corner = h.length === 2;
      if (corner && !e.shiftKey) { const k = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = Math.sign(sx || 1) * Math.abs(k); sy = Math.sign(sy || 1) * Math.abs(k); }
      if (Math.abs(sx) < 0.001) sx = 0.001 * Math.sign(sx || 1);
      if (Math.abs(sy) < 0.001) sy = 0.001 * Math.sign(sy || 1);
      live(D.scaleSel(drag.base, drag.ids, sx, sy, anchor));
      return;
    }
    if (drag.kind === 'node') {
      const q = snapPoint(p);
      live(D.update(drag.base, [drag.id], (o) => {
        const lp = D.unplacePoint(o, q);
        const paths = o.paths.map((path, pi) => {
          if (pi !== drag.pi) return path;
          const out = path.slice();
          out[drag.ki] = lp;
          if (isClosed(path) && drag.ki === 0) out[out.length - 1] = lp;
          if (isClosed(path) && drag.ki === path.length - 1) out[0] = lp;
          return out;
        });
        return { paths };
      }));
    }
  };

  const onUp = (e) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.kind === 'pan') return;
    if (d.kind === 'zoomrect') {
      const w = Math.abs(d.b.x - d.a.x), h = Math.abs(d.b.y - d.a.y);
      const r = wrap.current.getBoundingClientRect();
      if (w * z < 6 || h * z < 6) zoomAt(e.clientX - r.left, e.clientY - r.top, d.out ? 0.6 : 1.6);
      else fit({ minX: Math.min(d.a.x, d.b.x), minY: Math.min(d.a.y, d.b.y), w, h });
      return;
    }
    if (d.kind === 'marquee') {
      const r = { minX: Math.min(d.a.x, d.b.x), maxX: Math.max(d.a.x, d.b.x), minY: Math.min(d.a.y, d.b.y), maxY: Math.max(d.a.y, d.b.y) };
      if ((r.maxX - r.minX) * z < 3 && (r.maxY - r.minY) * z < 3) return;
      const ids = D.expandGroups(doc, D.objectsInRect(doc.objects, r).map((o) => o.id));
      setSel(d.add ? [...new Set([...sel, ...ids])] : ids);
      return;
    }
    if (d.kind === 'draw') { finishDraw(d); return; }
    if (d.kind === 'guide') {
      // dropped back on a ruler (or off the page area) -> delete it
      const r = wrap.current.getBoundingClientRect();
      const out = d.axis === 'x' ? e.clientX - r.left < RULER : e.clientY - r.top < RULER;
      if (out) live({ ...doc, guides: { ...doc.guides, [d.axis]: doc.guides[d.axis].filter((_, i) => i !== d.i) } });
      commit();
      return;
    }
    if (d.kind === 'node') {
      // rebase the shape so its box fits the edited outline again
      live(D.update(doc, [d.id], (o) => ({ ...D.bake(o), id: o.id })));
      commit();
      return;
    }
    commit();
  };

  function finishDraw(d) {
    let x0 = Math.min(d.a.x, d.b.x), y0 = Math.min(d.a.y, d.b.y), w = Math.abs(d.b.x - d.a.x), h = Math.abs(d.b.y - d.a.y);
    if (d.t === 'line') {
      if (w * z < 2 && h * z < 2) return;
      let b = d.b;
      if (d.shift) { const dx = d.b.x - d.a.x, dy = d.b.y - d.a.y; if (Math.abs(dx) > Math.abs(dy)) b = { x: d.b.x, y: d.a.y }; else b = { x: d.a.x, y: d.b.y }; }
      const o = D.shapeFromPaths([[d.a, b]], { name: 'Line', fill: { type: 'none' }, stroke: { color: '#000000', width: 0.5 } });
      begin(); live({ ...doc, objects: [...doc.objects, o] }); commit(); setSel([o.id]);
      return;
    }
    if (w * z < 4 && h * z < 4) { w = h = 50.8; x0 = d.a.x - w / 2; y0 = d.a.y - h / 2; }
    if (d.shift) { const s = Math.max(w, h); w = h = s; if (d.b.x < d.a.x) x0 = d.a.x - s; if (d.b.y < d.a.y) y0 = d.a.y - s; }
    if (d.alt) { x0 = d.a.x - w; y0 = d.a.y - h; w *= 2; h *= 2; }
    const kind = d.t === 'rect' ? 'rect' : d.t === 'ellipse' ? 'ellipse' : shapeKind;
    const def = SHAPES.find((s) => s.id === kind) || SHAPES[0];
    const paths = def.make(w, h, {});
    const o = D.shapeFromPaths(paths, { x: x0, y: y0, name: def.name, fill: { ...opts.newFill }, stroke: { ...opts.newStroke } });
    o.w = w; o.h = h;
    begin(); live({ ...doc, objects: [...doc.objects, o] }); commit(); setSel([o.id]);
  }

  // ---- pen (bezier) ----
  function penDown(p, e) {
    if (!pen) { setPen({ pts: [{ ...p }], dragging: 0 }); setDrag({ kind: 'penhandle', i: 0 }); return; }
    const first = pen.pts[0];
    if (pen.pts.length > 2 && Math.hypot(p.x - first.x, p.y - first.y) * z < 8) { finishPen(true); return; }
    if (e.detail === 2) { finishPen(false); return; }
    setPen((q) => ({ ...q, pts: [...q.pts, { ...p }] }));
    setDrag({ kind: 'penhandle', i: pen.pts.length });
  }
  useEffect(() => {
    if (!drag || drag.kind !== 'penhandle') return undefined;
    const mv = (e) => {
      const p = toPage(e);
      setPen((q) => {
        if (!q) return q;
        const pts = q.pts.slice();
        const pt = pts[drag.i];
        if (!pt) return q;
        if (Math.hypot(p.x - pt.x, p.y - pt.y) * z > 3) pts[drag.i] = { ...pt, h: { x: p.x, y: p.y } };
        return { ...q, pts };
      });
    };
    const upH = () => setDrag(null);
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', upH);
    return () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', upH); };
  }, [drag, view]);
  const penPaths = (pts, close) => {
    if (!pts || pts.length < 1) return [];
    const out = [{ ...pts[0] }];
    const seg = (a, b) => {
      const c1 = a.h ? a.h : a;
      const c2 = b.h ? { x: 2 * b.x - b.h.x, y: 2 * b.y - b.h.y } : b;
      if (!a.h && !b.h) out.push({ x: b.x, y: b.y });
      else out.push(...flattenCubic(a, c1, c2, b, 1));
    };
    for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]);
    if (close && pts.length > 2) { seg(pts[pts.length - 1], pts[0]); out[out.length - 1] = { ...out[0] }; }
    return [out];
  };
  function finishPen(close) {
    if (!pen) return;
    const paths = penPaths(pen.pts, close);
    setPen(null);
    if (!paths.length || paths[0].length < 2) return;
    const o = D.shapeFromPaths(paths, close
      ? { name: 'Shape', fill: { ...opts.newFill }, stroke: { ...opts.newStroke } }
      : { name: 'Line', fill: { type: 'none' }, stroke: { color: '#000000', width: 0.5 } });
    begin(); live({ ...doc, objects: [...doc.objects, o] }); commit(); setSel([o.id]);
  }

  // ---- node editing ----
  const nodeObj = tool === 'node' && selObjs.length === 1 && selObjs[0].type !== 'image' ? selObjs[0] : null;
  const nodeCount = nodeObj ? nodeObj.paths.reduce((s, p) => s + p.length, 0) : 0;
  const nodePts = useMemo(() => (nodeObj && nodeCount <= 4000 ? D.placedPaths(nodeObj) : null), [nodeObj, nodeCount]);
  function nodeDown(p, e) {
    if (nodePts) {
      const tol = 5 / z;
      for (let pi = 0; pi < nodePts.length; pi++) {
        const path = nodePts[pi];
        const n = isClosed(path) ? path.length - 1 : path.length;
        for (let ki = 0; ki < n; ki++) {
          if (Math.abs(path[ki].x - p.x) < tol && Math.abs(path[ki].y - p.y) < tol) {
            setNodeSel({ id: nodeObj.id, pi, ki });
            begin();
            setDrag({ kind: 'node', id: nodeObj.id, pi, ki, base: doc });
            return;
          }
        }
      }
      // double-click on an edge adds a node there
      if (e.detail === 2) {
        for (let pi = 0; pi < nodePts.length; pi++) {
          const path = nodePts[pi];
          for (let k = 1; k < path.length; k++) {
            const a = path[k - 1], b = path[k];
            const L2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
            const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / L2)) : 0;
            const q = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
            if (Math.hypot(q.x - p.x, q.y - p.y) < tol) {
              begin();
              live(D.update(doc, [nodeObj.id], (o) => ({ paths: o.paths.map((pp, i) => (i === pi ? [...pp.slice(0, k), D.unplacePoint(o, q), ...pp.slice(k)] : pp)) })));
              commit();
              setNodeSel({ id: nodeObj.id, pi, ki: k });
              return;
            }
          }
        }
      }
    }
    const hit = D.hitTest(doc.objects.filter((o) => !o.locked), p, hitTol);
    setSel(hit ? [hit.id] : []);
    setNodeSel(null);
  }
  function deleteNode() {
    if (!nodeSel) return false;
    const o = doc.objects.find((x) => x.id === nodeSel.id);
    if (!o) return false;
    const path = o.paths[nodeSel.pi];
    const closed = isClosed(path);
    let np = path.filter((_, i) => i !== nodeSel.ki);
    if (closed) { if (nodeSel.ki === 0) np[np.length - 1] = { ...np[0] }; }
    if (np.length < (closed ? 4 : 2)) np = null;
    begin();
    live(D.update(doc, [o.id], (x) => ({ paths: x.paths.map((pp, i) => (i === nodeSel.pi ? np : pp)).filter(Boolean) })));
    commit();
    setNodeSel(null);
    return true;
  }
  useEffect(() => { if (tool !== 'node') setNodeSel(null); if (tool !== 'pen') setPen(null); }, [tool]);

  // ---- draw ----
  const pageStyle = { fill: doc.page.color || '#ffffff' };
  const gridLines = useMemo(() => {
    if (!opts.showGrid || grid * z < 6) return null;
    const out = [];
    for (let x = 0; x <= doc.page.w + 1e-6; x += grid) out.push(<line key={`x${x}`} x1={x} x2={x} y1={0} y2={doc.page.h} />);
    for (let y = 0; y <= doc.page.h + 1e-6; y += grid) out.push(<line key={`y${y}`} y1={y} y2={y} x1={0} x2={doc.page.w} />);
    return out;
  }, [opts.showGrid, grid, z, doc.page.w, doc.page.h]);

  const hs = 7 / z; // handle size (mm)
  const cursorFor = () => {
    if (space || drag?.kind === 'pan') return 'grabbing';
    if (tool === 'pan') return 'grab';
    if (tool === 'zoom') return 'zoom-in';
    if (['text'].includes(tool)) return 'text';
    if (['rect', 'ellipse', 'shape', 'line', 'pen', 'eyedropper'].includes(tool)) return 'crosshair';
    return 'default';
  };
  const drawPreview = () => {
    if (!drag) return null;
    if (drag.kind === 'marquee' || drag.kind === 'zoomrect') {
      const x = Math.min(drag.a.x, drag.b.x), y = Math.min(drag.a.y, drag.b.y);
      return <rect x={x} y={y} width={Math.abs(drag.b.x - drag.a.x)} height={Math.abs(drag.b.y - drag.a.y)} fill="rgba(255,122,26,.08)" stroke="#ff7a1a" strokeDasharray="4 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
    }
    if (drag.kind === 'draw') {
      if (drag.t === 'line') return <line x1={drag.a.x} y1={drag.a.y} x2={drag.b.x} y2={drag.b.y} stroke="#ff7a1a" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
      const x = Math.min(drag.a.x, drag.b.x), y = Math.min(drag.a.y, drag.b.y);
      return <rect x={x} y={y} width={Math.abs(drag.b.x - drag.a.x)} height={Math.abs(drag.b.y - drag.a.y)} fill="none" stroke="#ff7a1a" strokeWidth={1} vectorEffect="non-scaling-stroke" rx={drag.t === 'ellipse' ? Math.abs(drag.b.x - drag.a.x) / 2 : 0} />;
    }
    return null;
  };

  return (
    <div className="dz-canvas" ref={wrap} style={{ cursor: cursorFor() }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => { setCursor(null); onCursor(null); }}
      onContextMenu={(e) => e.preventDefault()}>
      <svg className="dz-svg" width={size.w} height={size.h}>
        <g transform={`translate(${view.vx} ${view.vy}) scale(${z})`}>
          <rect x={4 / z} y={4 / z} width={doc.page.w} height={doc.page.h} fill="rgba(0,0,0,.45)" />
          <rect x={0} y={0} width={doc.page.w} height={doc.page.h} style={pageStyle} />
          {gridLines && <g stroke="#dfe3ea" strokeWidth={1} vectorEffect="non-scaling-stroke">{gridLines}</g>}
          {doc.objects.map((o) => <ObjView key={o.id} o={o} z={z} wire={wire} />)}
          {/* guides */}
          <g stroke="#2aa8ff" strokeWidth={1} vectorEffect="non-scaling-stroke">
            {doc.guides.x.map((g, i) => <line key={`gx${i}`} x1={g} x2={g} y1={-1e5} y2={1e5} vectorEffect="non-scaling-stroke" />)}
            {doc.guides.y.map((g, i) => <line key={`gy${i}`} y1={g} y2={g} x1={-1e5} x2={1e5} vectorEffect="non-scaling-stroke" />)}
          </g>
          {/* selection */}
          {selObjs.map((o) => {
            const b = D.objBounds(o);
            return <rect key={`sb${o.id}`} x={b.minX} y={b.minY} width={b.w} height={b.h} fill="none" stroke="#2aa8ff" strokeDasharray="3 3" strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />;
          })}
          {sb && tool === 'select' && !drag?.kind?.match(/move|rotate/) && (
            <g>
              <rect x={sb.minX} y={sb.minY} width={sb.w} height={sb.h} fill="none" stroke="#ff7a1a" strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />
              <line x1={sb.cx} x2={sb.cx} y1={sb.minY} y2={sb.minY - 22 / z} stroke="#ff7a1a" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <circle cx={sb.cx} cy={sb.minY - 22 / z} r={hs * 0.65} fill="#fff" stroke="#ff7a1a" strokeWidth={1.5} vectorEffect="non-scaling-stroke"
                style={{ cursor: 'grab' }} onPointerDown={(e) => handleDown('rot', e)} />
              {!selObjs.every((o) => o.locked) && HANDLES.map(([h, fx, fy]) => (
                <rect key={h} x={sb.minX + sb.w * fx - hs / 2} y={sb.minY + sb.h * fy - hs / 2} width={hs} height={hs}
                  fill="#fff" stroke="#ff7a1a" strokeWidth={1.5} vectorEffect="non-scaling-stroke" style={{ cursor: CURSORS[h] }}
                  onPointerDown={(e) => handleDown(h, e)} />
              ))}
            </g>
          )}
          {nodePts && nodePts.map((path, pi) => path.slice(0, isClosed(path) ? -1 : undefined).map((q, ki) => (
            <rect key={`n${pi}-${ki}`} x={q.x - hs * 0.4} y={q.y - hs * 0.4} width={hs * 0.8} height={hs * 0.8}
              fill={nodeSel && nodeSel.pi === pi && nodeSel.ki === ki ? '#ff7a1a' : '#fff'} stroke="#2a6bff" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          )))}
          {pen && (
            <g pointerEvents="none">
              <path d={D.pathD(penPaths([...pen.pts, ...(pen.hover ? [pen.hover] : [])], false))} fill="none" stroke="#ff7a1a" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              {pen.pts.map((q, i) => (
                <g key={i}>
                  <rect x={q.x - hs * 0.4} y={q.y - hs * 0.4} width={hs * 0.8} height={hs * 0.8} fill="#fff" stroke="#ff7a1a" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  {q.h && <><line x1={2 * q.x - q.h.x} y1={2 * q.y - q.h.y} x2={q.h.x} y2={q.h.y} stroke="#2a6bff" strokeWidth={1} vectorEffect="non-scaling-stroke" /><circle cx={q.h.x} cy={q.h.y} r={hs * 0.35} fill="#2a6bff" /></>}
                </g>
              ))}
            </g>
          )}
          {drawPreview()}
        </g>
      </svg>
      <div className="dz-ruler-corner" title="Rulers in inches — drag from a ruler to add a guide" />
      <div className="dz-ruler-top"><Ruler axis="x" view={view} size={size} onGuideStart={startGuide} cursor={cursor} /></div>
      <div className="dz-ruler-left"><Ruler axis="y" view={view} size={size} onGuideStart={startGuide} cursor={cursor} /></div>
      {tool === 'node' && nodeObj && !nodePts && <div className="dz-hint">This shape has {nodeCount.toLocaleString()} nodes — use Effects › Reduce nodes first to edit them.</div>}
      {tool === 'pen' && <div className="dz-hint">Click to add points · drag to curve · click the first point to close · double-click or Enter to finish · Esc cancels</div>}
      {tool === 'node' && <div className="dz-hint">Drag a node to move it · double-click an edge to add one · Delete removes the selected node</div>}
    </div>
  );
});

export default Canvas;
