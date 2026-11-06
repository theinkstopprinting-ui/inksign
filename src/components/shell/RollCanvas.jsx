import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, forwardRef } from 'react';

// Flexi-style work area: the media drawn to scale with inch rulers on top and left, scroll-wheel
// zoom around the pointer, drag empty space to pan. Children are SVG drawn in inches
// (x along the roll / sheet, y across it).
const RULER = 22;
const STEPS = [0.125, 0.25, 0.5, 1, 2, 3, 6, 12, 24, 48, 96, 120, 240];

function Ruler({ dir, scale, offset, length }) {
  // label every N inches so labels are ~70 px apart
  const major = STEPS.find((s) => s * scale >= 70) || 240;
  const minor = STEPS.slice().reverse().find((s) => s < major && s * scale >= 7 && major % s === 0) || major;
  const ticks = [];
  const first = Math.floor(-offset / scale / minor) * minor;
  for (let v = first; v * scale + offset < length; v += minor) {
    const px = v * scale + offset;
    if (px < 0 || v < 0) continue;
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
    const label = v === 0 ? '0' : major >= 12 ? `${+(v / 12).toFixed(2)}'` : `${+v.toFixed(3)}"`;
    ticks.push(dir === 'x'
      ? <g key={v}><line x1={px} x2={px} y1={isMajor ? 6 : 15} y2={RULER} />{isMajor && <text x={px + 3} y={10}>{label}</text>}</g>
      : <g key={v}><line y1={px} y2={px} x1={isMajor ? 6 : 15} x2={RULER} />{isMajor && <text x={10} y={px + 3} transform={`rotate(-90 10 ${px + 3})`}>{label}</text>}</g>);
  }
  return dir === 'x'
    ? <svg className="ruler ruler-x" width={length} height={RULER}>{ticks}</svg>
    : <svg className="ruler ruler-y" width={RULER} height={length}>{ticks}</svg>;
}

const RollCanvas = forwardRef(function RollCanvas({ widthIn, heightIn, children, onBackground, empty, mediaLabel, light = true }, ref) {
  const box = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [view, setView] = useState({ scale: 6, ox: 40, oy: 40 });
  const fitted = useRef(false);
  const drag = useRef(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = () => setSize({ w: Math.max(0, el.clientWidth - RULER), h: Math.max(0, el.clientHeight - RULER) });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    const W = Math.max(widthIn || 1, 1), H = Math.max(heightIn || 1, 1);
    const pad = 36;
    const scale = Math.max(0.2, Math.min((size.w - 2 * pad) / W, (size.h - 2 * pad) / H));
    setView({ scale, ox: (size.w - W * scale) / 2, oy: (size.h - H * scale) / 2 });
  }, [widthIn, heightIn, size.w, size.h]);
  useImperativeHandle(ref, () => ({
    fit,
    zoom: (f) => setView((v) => {
      const cx = size.w / 2, cy = size.h / 2;
      const scale = Math.max(0.2, Math.min(400, v.scale * f));
      return { scale, ox: cx - ((cx - v.ox) * scale) / v.scale, oy: cy - ((cy - v.oy) * scale) / v.scale };
    }),
    get percent() { return view.scale; },
  }), [fit, size, view.scale]);
  // fit when the media first appears or its size changes a lot
  const sig = `${Math.round(widthIn || 0)}x${Math.round(heightIn || 0)}`;
  useEffect(() => { if (widthIn && heightIn) { fit(); fitted.current = true; } }, [sig, size.w > 0 && size.h > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const onWheel = (e) => {
    const r = box.current.getBoundingClientRect();
    const mx = e.clientX - r.left - RULER, my = e.clientY - r.top - RULER;
    setView((v) => {
      const scale = Math.max(0.2, Math.min(400, v.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      return { scale, ox: mx - ((mx - v.ox) * scale) / v.scale, oy: my - ((my - v.oy) * scale) / v.scale };
    });
  };
  const onDown = (e) => {
    if (e.target.closest('[data-piece]')) return;
    drag.current = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy, moved: false };
  };
  const onMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    setView((v) => ({ ...v, ox: d.ox + dx, oy: d.oy + dy }));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved && onBackground) onBackground();
  };
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const prevent = (e) => e.preventDefault();
    el.addEventListener('wheel', prevent, { passive: false });
    return () => el.removeEventListener('wheel', prevent);
  }, []);

  const { scale, ox, oy } = view;
  return (
    <div className={`rollcanvas ${light ? '' : 'dark'}`} ref={box} onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={() => { drag.current = null; }}>
      <div className="ruler-corner" title="Inches">in</div>
      <Ruler dir="x" scale={scale} offset={ox} length={size.w} />
      <Ruler dir="y" scale={scale} offset={oy} length={size.h} />
      <div className="rollcanvas-area">
        {widthIn && heightIn ? (
          <svg width={size.w} height={size.h}>
            <g transform={`translate(${ox} ${oy}) scale(${scale})`}>
              <rect x={-0.15} y={-0.15} width={widthIn + 0.3} height={heightIn + 0.3} fill="rgba(0,0,0,.35)" transform="translate(0.25 0.35)" />
              <rect x={0} y={0} width={widthIn} height={heightIn} className="media" />
              {children(scale)}
            </g>
          </svg>
        ) : <div className="rollcanvas-empty">{empty}</div>}
        {mediaLabel && <div className="rollcanvas-label">{mediaLabel}</div>}
      </div>
    </div>
  );
});

export default RollCanvas;
