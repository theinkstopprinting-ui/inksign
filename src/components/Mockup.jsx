import React, { useEffect, useMemo, useRef, useState } from 'react';
import { bounds } from '../lib/geometry.js';
import ProofButton from './ProofButton.jsx';

const api = window.inksign;
const MM = 25.4;
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Vehicle / window / wall mockups at real size.
// 1. Load a photo. 2. Click two points on something you've measured and type its length.
// 3. Bring in the Cut Studio design (or a printed graphic) — it lands at its real size. Move, turn, save.
export default function Mockup() {
  const [photo, setPhoto] = useState(null); // { dataUrl, w, h, name }
  const [cal, setCal] = useState({ pts: [], inches: 36, pxPerIn: null });
  const [calMode, setCalMode] = useState(false);
  const [layers, setLayers] = useState([]); // { id, kind: 'vinyl'|'image', paths?, colors?, dataUrl?, wMm, hMm, x, y, rot, opacity, name }
  const [selId, setSelId] = useState(null);
  const [msg, setMsg] = useState('');
  const svgRef = useRef(null);
  const drag = useRef(null);
  const sel = layers.find((l) => l.id === selId);
  const pxPerMm = cal.pxPerIn ? cal.pxPerIn / MM : null;

  const loadPhoto = async () => {
    const files = await api.printcut.openImages();
    if (!files.length) return;
    const f = files[0];
    const img = new Image(); img.src = f.dataUrl; await img.decode();
    setPhoto({ dataUrl: f.dataUrl, w: img.naturalWidth, h: img.naturalHeight, name: f.name });
    setCal({ pts: [], inches: cal.inches, pxPerIn: null });
    setCalMode(true);
    setMsg('Click both ends of something you know the size of (a door, a window, the wheelbase), then type its length.');
  };

  const toPhoto = (e) => {
    const svg = svgRef.current, pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  };

  const onDownBg = (e) => {
    if (!photo) return;
    if (calMode) {
      const p = toPhoto(e);
      setCal((c) => {
        const pts = c.pts.length >= 2 ? [p] : [...c.pts, p];
        const pxPerIn = pts.length === 2 && c.inches > 0 ? Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) / c.inches : null;
        if (pxPerIn) { setCalMode(false); setMsg('Scale set. Bring in the design.'); }
        return { ...c, pts, pxPerIn };
      });
      return;
    }
    setSelId(null);
  };
  const setInches = (v) => setCal((c) => ({ ...c, inches: v, pxPerIn: c.pts.length === 2 && v > 0 ? Math.hypot(c.pts[1].x - c.pts[0].x, c.pts[1].y - c.pts[0].y) / v : c.pxPerIn }));

  const addLayer = (l) => {
    const id = `l${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
    // Center it on the photo
    const wPx = l.wMm * (pxPerMm || 1), hPx = l.hMm * (pxPerMm || 1);
    setLayers((ls) => [...ls, { rot: 0, opacity: 1, ...l, id, x: (photo.w - wPx) / 2, y: (photo.h - hPx) / 2 }]);
    setSelId(id);
  };
  const useDesign = () => {
    const d = window.__inksignDesign ? window.__inksignDesign() : null;
    if (!d || !d.paths.length) return setMsg('Cut Studio is empty — lay out the lettering there first.');
    const b = bounds(d.paths);
    addLayer({ kind: 'vinyl', name: d.name || 'Cut Studio design', paths: d.paths.map((p) => p.map((q) => ({ x: q.x - b.minX, y: q.y - b.minY }))), colors: d.colors, wMm: b.w, hMm: b.h });
  };
  const addGraphic = async () => {
    const files = await api.printcut.openImages();
    for (const f of files) {
      const img = new Image(); img.src = f.dataUrl; await img.decode();
      const wIn = 24; // set the real print width in the panel after adding
      addLayer({ kind: 'image', name: f.name, dataUrl: f.dataUrl, wMm: wIn * MM, hMm: (wIn * MM * img.naturalHeight) / img.naturalWidth });
    }
    if (files.length) setMsg('Added at 24" wide — set its real print width on the left.');
  };
  const upd = (id, patch) => setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const onDownLayer = (e, l) => {
    if (calMode) return;
    e.stopPropagation();
    setSelId(l.id);
    const p = toPhoto(e);
    drag.current = { id: l.id, dx: p.x - l.x, dy: p.y - l.y };
    svgRef.current.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const p = toPhoto(e);
    upd(d.id, { x: p.x - d.dx, y: p.y - d.dy });
  };
  const onUp = () => { drag.current = null; };

  // Real size in photo pixels; "fit" scale (no calibration) treats 1 mm as 1 px.
  const k = pxPerMm || 1;
  const transformOf = (l) => `translate(${l.x} ${l.y}) rotate(${l.rot} ${(l.wMm * k) / 2} ${(l.hMm * k) / 2}) scale(${k})`;
  const pathD = (paths) => paths.map((p) => `M${p.map((q) => `${q.x.toFixed(2)},${q.y.toFixed(2)}`).join('L')}Z`).join('');
  const byColor = (l) => {
    const m = new Map();
    l.paths.forEach((p, i) => { const c = l.colors[i] || '#000000'; if (!m.has(c)) m.set(c, []); m.get(c).push(p); });
    return [...m.entries()];
  };

  // Save the mockup as a PNG (photo + vinyl + graphics), drawn at the photo's own resolution.
  const savePng = async () => {
    if (!photo) return;
    const p = await api.files.savePng(`${photo.name} mockup`, await renderPng());
    if (p) setMsg(`Saved ${p}`);
  };
  const renderPng = async () => {
    const c = document.createElement('canvas');
    c.width = photo.w; c.height = photo.h;
    const ctx = c.getContext('2d');
    const bg = new Image(); bg.src = photo.dataUrl; await bg.decode();
    ctx.drawImage(bg, 0, 0);
    for (const l of layers) {
      ctx.save();
      ctx.globalAlpha = l.opacity;
      ctx.translate(l.x, l.y);
      ctx.translate((l.wMm * k) / 2, (l.hMm * k) / 2); ctx.rotate((l.rot * Math.PI) / 180); ctx.translate(-(l.wMm * k) / 2, -(l.hMm * k) / 2);
      ctx.scale(k, k);
      if (l.kind === 'image') {
        const im = new Image(); im.src = l.dataUrl; await im.decode();
        ctx.drawImage(im, 0, 0, l.wMm, l.hMm);
      } else {
        for (const [color, paths] of byColor(l)) { ctx.fillStyle = color; ctx.fill(new Path2D(pathD(paths)), 'evenodd'); }
      }
      ctx.restore();
    }
    return c.toDataURL('image/png');
  };

  useEffect(() => {
    const onKey = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || !sel) return;
      if (e.key === 'Delete') { setLayers((ls) => ls.filter((l) => l.id !== sel.id)); setSelId(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const sizeLabel = (l) => `${(l.wMm / MM).toFixed(1)} × ${(l.hMm / MM).toFixed(1)}"`;
  const lineW = photo ? Math.max(photo.w, photo.h) / 400 : 1;

  return (
    <div className="studio">
      <div className="studio-left">
        <h1>Mockup</h1>
        <div className="tool-box">
          <button className="btn primary wide" onClick={loadPhoto}>{photo ? 'Change photo…' : 'Load a photo…'}</button>
          <div className="help">A straight-on photo of the truck door, window or wall works best.</div>
        </div>
        {photo && (
          <div className="tool-box">
            <div className="box-title">Scale</div>
            <label className="mini-field"><span>The two points are this far apart (in)</span>
              <input type="number" step="0.5" value={cal.inches} onChange={(e) => setInches(Number(e.target.value))} />
            </label>
            <button className={`btn small ${calMode ? 'primary' : ''}`} onClick={() => { setCalMode(true); setCal((c) => ({ ...c, pts: [] })); }}>{calMode ? 'Click two points on the photo…' : 'Measure again'}</button>
            <div className="muted small">{cal.pxPerIn ? `Set: ${cal.pxPerIn.toFixed(1)} pixels per inch` : 'Not set — designs won\'t be at real size yet.'}</div>
          </div>
        )}
        {photo && (
          <div className="tool-box">
            <div className="box-title">Add</div>
            <button className="btn" onClick={useDesign}>Cut Studio design (vinyl)</button>
            <button className="btn" onClick={addGraphic}>Printed graphic (PNG / JPG)…</button>
          </div>
        )}
        {layers.map((l) => (
          <button key={l.id} className={`piece ${l.id === selId ? 'on' : ''}`} onClick={() => setSelId(l.id)}>
            <span>{l.name}</span><span className="muted small">{sizeLabel(l)}</span>
          </button>
        ))}
        {sel && (
          <div className="tool-box">
            <div className="box-title">{sel.name}</div>
            <div className="mini-row">
              <label className="mini-field"><span>Width (in)</span>
                <input type="number" step="0.5" value={(sel.wMm / MM).toFixed(2)} onChange={(e) => { const w = Number(e.target.value) * MM; if (w > 0) upd(sel.id, { wMm: w, hMm: sel.hMm * (w / sel.wMm), paths: sel.paths && sel.paths.map((p) => p.map((q) => ({ x: q.x * (w / sel.wMm), y: q.y * (w / sel.wMm) }))) }); }} />
              </label>
              <label className="mini-field"><span>Turn (°)</span>
                <input type="number" step="1" value={sel.rot} onChange={(e) => upd(sel.id, { rot: Number(e.target.value) || 0 })} />
              </label>
            </div>
            <label className="mini-field"><span>Opacity</span>
              <input type="range" min="0.2" max="1" step="0.05" value={sel.opacity} onChange={(e) => upd(sel.id, { opacity: Number(e.target.value) })} />
            </label>
            <button className="btn small danger" onClick={() => { setLayers((ls) => ls.filter((l) => l.id !== sel.id)); setSelId(null); }}>Remove</button>
          </div>
        )}
      </div>

      <div className="studio-canvas light">
        {photo ? (
          <svg ref={svgRef} viewBox={`0 0 ${photo.w} ${photo.h}`} preserveAspectRatio="xMidYMid meet" onPointerDown={onDownBg} onPointerMove={onMove} onPointerUp={onUp}
            style={{ cursor: calMode ? 'crosshair' : 'default' }}>
            <image href={photo.dataUrl} x={0} y={0} width={photo.w} height={photo.h} />
            {layers.map((l) => (
              <g key={l.id} transform={transformOf(l)} opacity={l.opacity} onPointerDown={(e) => onDownLayer(e, l)} style={{ cursor: 'move' }}>
                {l.kind === 'image'
                  ? <image href={l.dataUrl} x={0} y={0} width={l.wMm} height={l.hMm} preserveAspectRatio="none" />
                  : byColor(l).map(([color, paths]) => <path key={color} d={pathD(paths)} fill={color} fillRule="evenodd" />)}
                {l.id === selId && <rect x={0} y={0} width={l.wMm} height={l.hMm} fill="none" stroke="#ff7a1a" strokeWidth={lineW / k} strokeDasharray={`${(lineW * 4) / k} ${(lineW * 3) / k}`} />}
              </g>
            ))}
            {cal.pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={lineW * 4} fill="#ff7a1a" />)}
            {cal.pts.length === 2 && <line x1={cal.pts[0].x} y1={cal.pts[0].y} x2={cal.pts[1].x} y2={cal.pts[1].y} stroke="#ff7a1a" strokeWidth={lineW * 1.5} />}
          </svg>
        ) : <div className="canvas-empty dark">Load a photo of the vehicle, window or wall to start.</div>}
      </div>

      <div className="studio-right">
        <div className="tool-box">
          <div className="box-title">Save</div>
          <button className="btn primary wide" disabled={!photo} onClick={savePng}>Save mockup (PNG)…</button>
          <ProofButton disabled={!photo || !layers.length} label="Send mockup to an InkFlow order" makeProof={async () => ({ kind: 'png', name: `${photo.name} mockup.png`, note: 'Mockup from InkSign', payload: { dataUrl: await renderPng() } })} />
          <div className="help">Use it as the customer proof — attach it in InkFlow.</div>
        </div>
        {msg && <div className="studio-msg">{msg}</div>}
        <div className="tool-box howto">
          <div className="box-title">How it works</div>
          <ol>
            <li>Load a photo taken straight on.</li>
            <li>Click both ends of something you measured and type its length — that sets real size.</li>
            <li>Add the Cut Studio design or a printed graphic. Drag to place, set width or turn it.</li>
            <li>Save the PNG for the proof.</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
