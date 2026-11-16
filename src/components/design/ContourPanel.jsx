// Create Cut Contour: the panel VinylMaster opens from Curves › Create Cut Contour. It draws the
// contour on the page while you change the settings, and adds it when you press Apply.
//   Outline options  — distance (or a % of the art's size), corner style, keep holes
//   Images           — follow the shape of a picture instead of its rectangle
//   Output options   — a contour cut line (dashed), or a solid fill color behind the art
import React, { useEffect, useRef, useState } from 'react';
import { MM } from './Panels.jsx';

const KEY = 'inksign.dz.contour';
const DEFAULTS = { mode: 'abs', dist: 1.5875, pct: 5, corners: 'round', keepHoles: false, images: true, traceMode: 'notbg', threshold: 128, output: 'cut', color: '#ffffff' };
const load = () => { try { return { ...DEFAULTS, ...JSON.parse(window.localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; } };

export default function ContourPanel({ count, hasImage, sig, unit, units, compute, onPreview, onApply, marks, page, onMarks, onRemoveMarks }) {
  const [p, setP] = useState(load);
  const [paths, setPaths] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const run = useRef(0);
  const set = (k, v) => setP((o) => ({ ...o, [k]: v }));
  const U = units[unit];

  useEffect(() => { try { window.localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* not saved */ } }, [p]);
  // redraw the preview a moment after the settings or the selection change
  useEffect(() => {
    if (!count) { setPaths(null); onPreview(null); setErr(''); return undefined; }
    const me = ++run.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const out = await compute(p);
        if (me !== run.current) return;
        setPaths(out); onPreview(out); setErr(out.length ? '' : 'Nothing to go around — select closed shapes, text or a picture');
      } catch (e) { if (me === run.current) { setPaths(null); onPreview(null); setErr(e.message); } } finally { if (me === run.current) setBusy(false); }
    }, 160);
    return () => clearTimeout(t);
  }, [JSON.stringify(p), sig, count]);
  useEffect(() => () => onPreview(null), []);

  const clear = marks ? marks.margin + marks.size + 2 : 0;
  const outside = marks && paths && paths.some((q) => q.some((pt) => pt.x < clear || pt.y < clear || pt.x > page.w - clear || pt.y > page.h - clear));
  const lenField = (k, label) => (
    <label className="dz-num">{label}
      <div className="input-unit"><input type="number" step={unit === 'in' ? 0.0625 : U.step} value={+(p[k] / U.k).toFixed(U.dp + 1)} onChange={(e) => set(k, (parseFloat(e.target.value) || 0) * U.k)} /><em>{unit}</em></div>
    </label>
  );

  return (
    <div className="dz-section ct">
      <div className="box-title">Create cut contour</div>
      {!count && <p className="muted small">Select the art to go around — shapes, text or a picture — and the contour is drawn on the page as you change these settings.</p>}

      <div className="ct-group">
        <b>Outline options</b>
        <div className="seg">
          <button className={p.mode === 'abs' ? 'on' : ''} onClick={() => set('mode', 'abs')}>Distance</button>
          <button className={p.mode === 'pct' ? 'on' : ''} onClick={() => set('mode', 'pct')}>Scale by %</button>
        </div>
        {p.mode === 'abs'
          ? lenField('dist', 'Distance from the art (0 = on the edge, minus = inside)')
          : <label className="dz-num">Distance, as a % of the art's shorter side<div className="input-unit"><input type="number" step={0.5} value={p.pct} onChange={(e) => set('pct', parseFloat(e.target.value) || 0)} /><em>%</em></div></label>}
        <label className="dz-num">Corner style
          <select value={p.corners} onChange={(e) => set('corners', e.target.value)}><option value="round">Round</option><option value="miter">Sharp</option><option value="square">Square</option></select>
        </label>
        <label className="check"><input type="checkbox" checked={p.keepHoles} onChange={(e) => set('keepHoles', e.target.checked)} /> Keep holes (also cut inside letters like O and A)</label>
      </div>

      <div className="ct-group">
        <b>Images</b>
        <label className="check"><input type="checkbox" checked={p.images} onChange={(e) => set('images', e.target.checked)} /> Follow the shape of pictures (vectorize), not their rectangle</label>
        {p.images && hasImage && (
          <>
            <label className="dz-num">Find the shape by
              <select value={p.traceMode} onChange={(e) => set('traceMode', e.target.value)}><option value="alpha">Transparent background</option><option value="notbg">Not the background color</option><option value="dark">Dark areas</option></select>
            </label>
            <label className="dz-num">Threshold — {p.threshold}<input type="range" min={5} max={250} value={p.threshold} onChange={(e) => set('threshold', Number(e.target.value))} /></label>
          </>
        )}
      </div>

      <div className="ct-group">
        <b>Output options</b>
        <label className="check"><input type="radio" checked={p.output === 'cut'} onChange={() => set('output', 'cut')} /> Contour cut line (dashed outline, cut by the cutter)</label>
        <label className="check"><input type="radio" checked={p.output === 'fill'} onChange={() => set('output', 'fill')} /> Solid fill color behind the art (a printed border)</label>
        {p.output === 'fill' && <label className="dz-field"><span>Fill color</span><input type="color" value={p.color} onChange={(e) => set('color', e.target.value)} /></label>}
      </div>

      {err && <p className="error small">{err}</p>}
      {outside && <p className="error small">This contour goes outside the registration marks. Move the art in, or use Registration marks › fit the page.</p>}
      <div className="row">
        <button className="btn primary" disabled={!paths || !paths.length || busy} onClick={() => onApply(paths, p)}>{busy ? 'Working…' : 'Apply'}</button>
        <button className="btn" onClick={() => setP({ ...DEFAULTS })}>Reset</button>
      </div>

      <div className="ct-group">
        <b>Registration marks</b>
        <p className="muted small">{marks
          ? `Shown on the page: ${+(marks.size / MM).toFixed(2)}″ marks, ${+(marks.margin / MM).toFixed(2)}″ in from the edge. Keep the art and the cut line inside the dashed box. They print when you use Print & Cut.`
          : 'Show the cutter\'s registration marks on the page while you design, so you can see where the art and the cut line have to stay.'}</p>
        <div className="row">
          <button className="btn" onClick={onMarks}>{marks ? 'Change marks…' : 'Place registration marks…'}</button>
          {marks && <button className="btn" onClick={onRemoveMarks}>Remove</button>}
        </div>
      </div>
    </div>
  );
}
