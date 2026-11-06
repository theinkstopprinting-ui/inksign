// Right-hand panels of the Design workspace (Flexi's DesignCentral, Fill/Stroke Editor, Color Mixer
// and object list) and the swatch bar along the bottom.
import React, { useEffect, useMemo, useState } from 'react';
import * as D from '../../lib/doc.js';

export const MM = 25.4;
export const SIGN_SWATCHES = [
  ['#000000', 'Black'], ['#ffffff', 'White'], ['#e31b23', 'Red'], ['#b5121b', 'Cardinal'], ['#ff6a13', 'Orange'], ['#ffc72c', 'Sunflower'],
  ['#fff200', 'Yellow'], ['#78be20', 'Lime'], ['#00843d', 'Green'], ['#00594f', 'Forest'], ['#00a3e0', 'Light blue'], ['#0057b8', 'Blue'],
  ['#002855', 'Navy'], ['#5f259f', 'Purple'], ['#e10098', 'Pink'], ['#7a3e1d', 'Brown'], ['#a7a8aa', 'Silver'], ['#b38e5d', 'Gold'],
  ['#53565a', 'Gray'], ['#d0d3d4', 'Light gray'],
];

/** A number box in inches (stores mm) that commits on Enter / blur */
export function InchIn({ label, mm, onCommit, digits = 3, unit = 'in', disabled, title, step = 0.125 }) {
  const fmt = (v) => (v == null || Number.isNaN(v) ? '' : String(+(v / MM).toFixed(digits)));
  const [txt, setTxt] = useState(fmt(mm));
  useEffect(() => setTxt(fmt(mm)), [mm]);
  const go = () => {
    const v = parseFloat(String(txt).replace(/["\s]|in$/g, ''));
    if (Number.isFinite(v) && fmt(mm) !== txt) onCommit(v * MM); else setTxt(fmt(mm));
  };
  return (
    <label className="dz-num" title={title}>
      {label && <span>{label}</span>}
      <div className="input-unit">
        <input type="number" step={step} value={txt} disabled={disabled} onChange={(e) => setTxt(e.target.value)} onBlur={go}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.target.blur(); } if (e.key === 'Escape') { setTxt(fmt(mm)); e.target.blur(); } }} />
        <em>{unit}</em>
      </div>
    </label>
  );
}
export function NumIn({ label, value, onCommit, unit, step = 1, min, max, disabled, title }) {
  const [txt, setTxt] = useState(String(value ?? ''));
  useEffect(() => setTxt(String(value ?? '')), [value]);
  const go = () => {
    let v = parseFloat(txt);
    if (!Number.isFinite(v)) { setTxt(String(value ?? '')); return; }
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    if (v !== value) onCommit(v); else setTxt(String(value));
  };
  return (
    <label className="dz-num" title={title}>
      {label && <span>{label}</span>}
      <div className="input-unit">
        <input type="number" step={step} value={txt} disabled={disabled} onChange={(e) => setTxt(e.target.value)} onBlur={go}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />
        {unit && <em>{unit}</em>}
      </div>
    </label>
  );
}

// ---- color helpers ----
export const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt((h || '#000000').slice(i, i + 2), 16) || 0);
export const rgbToHex = (r, g, b) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
export function rgbToCmyk([r, g, b]) {
  const R = r / 255, G = g / 255, B = b / 255, K = 1 - Math.max(R, G, B);
  if (K >= 1) return [0, 0, 0, 100];
  return [(1 - R - K) / (1 - K), (1 - G - K) / (1 - K), (1 - B - K) / (1 - K), K].map((v) => Math.round(v * 100));
}
export const cmykToRgb = ([c, m, y, k]) => [c, m, y].map((v) => 255 * (1 - v / 100) * (1 - k / 100));

function ColorMixer({ color, onChange, label }) {
  const [mode, setMode] = useState('rgb');
  const rgb = hexToRgb(color);
  const cmyk = rgbToCmyk(rgb);
  const [hex, setHex] = useState(color);
  useEffect(() => setHex(color), [color]);
  const slider = (name, v, max, set) => (
    <div className="dz-slider" key={name}>
      <span>{name}</span>
      <input type="range" min={0} max={max} value={v} onChange={(e) => set(Number(e.target.value))} />
      <input type="number" min={0} max={max} value={v} onChange={(e) => set(Number(e.target.value) || 0)} />
    </div>
  );
  return (
    <div className="dz-mixer">
      <div className="row">
        {label && <span className="box-title" style={{ flex: 1 }}>{label}</span>}
        <div className="seg dz-seg-small">
          <button className={mode === 'rgb' ? 'on' : ''} onClick={() => setMode('rgb')}>RGB</button>
          <button className={mode === 'cmyk' ? 'on' : ''} onClick={() => setMode('cmyk')}>CMYK</button>
        </div>
      </div>
      <div className="row">
        <input type="color" value={color} onChange={(e) => onChange(e.target.value)} style={{ width: 44, height: 30 }} />
        <input type="text" value={hex} onChange={(e) => setHex(e.target.value)} onBlur={() => { if (/^#[0-9a-f]{6}$/i.test(hex)) onChange(hex.toLowerCase()); else setHex(color); }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} style={{ flex: 1 }} />
      </div>
      {mode === 'rgb' ? ['R', 'G', 'B'].map((n, i) => (
        slider(n, rgb[i], 255, (v) => { const x = rgb.slice(); x[i] = v; onChange(rgbToHex(...x)); })
      )) : ['C', 'M', 'Y', 'K'].map((n, i) => (
        slider(n, cmyk[i], 100, (v) => { const x = cmyk.slice(); x[i] = v; onChange(rgbToHex(...cmykToRgb(x))); })
      ))}
    </div>
  );
}

// ---------------- Properties (DesignCentral) ----------------
const PAGE_PRESETS = [
  ['Letter 8.5×11', 8.5, 11], ['Tabloid 11×17', 11, 17], ['12×18', 12, 18], ['18×24', 18, 24], ['24×36', 24, 36], ['Arch D 24×36', 24, 36],
  ['Yard sign 24×18', 24, 18], ['Banner 2×4 ft', 48, 24], ['Banner 3×6 ft', 72, 36], ['Banner 3×8 ft', 96, 36], ['4×8 sheet', 96, 48], ['Vinyl roll 15"', 48, 15], ['Vinyl roll 24"', 48, 24],
];

export function PageProps({ doc, setPage, stats }) {
  return (
    <div className="dz-section">
      <div className="box-title">Document</div>
      <label className="dz-field"><span>Name</span><input type="text" value={doc.name} onChange={(e) => setPage({ name: e.target.value })} /></label>
      <div className="dz-pair">
        <InchIn label="Width" mm={doc.page.w} onCommit={(v) => setPage({ page: { ...doc.page, w: Math.max(5, v) } })} />
        <InchIn label="Height" mm={doc.page.h} onCommit={(v) => setPage({ page: { ...doc.page, h: Math.max(5, v) } })} />
      </div>
      <label className="dz-field"><span>Size</span>
        <select value="" onChange={(e) => { const p = PAGE_PRESETS[Number(e.target.value)]; if (p) setPage({ page: { ...doc.page, w: p[1] * MM, h: p[2] * MM } }); }}>
          <option value="">Choose a size…</option>
          {PAGE_PRESETS.map((p, i) => <option key={p[0]} value={i}>{p[0]}</option>)}
        </select>
      </label>
      <div className="row">
        <button className="btn small" onClick={() => setPage({ page: { ...doc.page, w: doc.page.h, h: doc.page.w } })}>⟲ Swap orientation</button>
        <label className="dz-field" style={{ flex: 1 }}><span>Page color</span><input type="color" value={doc.page.color || '#ffffff'} onChange={(e) => setPage({ page: { ...doc.page, color: e.target.value } })} /></label>
      </div>
      {stats && (
        <div className="dz-stats">
          <div><em>Objects</em>{stats.objects}</div>
          <div><em>Cut length</em>{(stats.cutMm / MM / 12).toFixed(1)} ft</div>
          <div><em>Nodes</em>{stats.nodes.toLocaleString()}</div>
        </div>
      )}
      <p className="muted small">Nothing selected. Click a shape to edit it, or use the tools on the left to draw. Drag from a ruler to add a guide.</p>
    </div>
  );
}

export function ObjectProps({ objs, apply, setBox, fonts, onText, onOutline, onTraceCut }) {
  const b = D.selBounds(objs);
  const one = objs.length === 1 ? objs[0] : null;
  const [ratio, setRatio] = useState(true);
  const text = one && one.type === 'text' ? one : null;
  const [draft, setDraft] = useState(text?.text || '');
  useEffect(() => setDraft(text?.text || ''), [text?.id, text?.text]);
  const [fontQ, setFontQ] = useState('');
  const fontList = useMemo(() => {
    const q = fontQ.trim().toLowerCase();
    return (q ? fonts.filter((f) => f.name.toLowerCase().includes(q)) : fonts).slice(0, 400);
  }, [fonts, fontQ]);
  const allLocked = objs.every((o) => o.locked);
  const opacity = one ? Math.round((one.opacity ?? 1) * 100) : 100;
  return (
    <div className="dz-section">
      <div className="box-title">{one ? `${one.type === 'text' ? 'Text' : one.type === 'image' ? 'Picture' : one.cut ? 'Cut line' : 'Shape'}${one.groupId ? ' (in a group)' : ''}` : `${objs.length} objects`}</div>
      {one && <label className="dz-field"><span>Name</span><input type="text" value={one.name || ''} onChange={(e) => apply((d) => D.setAll(d, [one.id], { name: e.target.value }), 'name')} /></label>}
      <div className="dz-pair">
        <InchIn label="X" mm={b.minX} onCommit={(v) => setBox({ x: v })} disabled={allLocked} />
        <InchIn label="Y" mm={b.minY} onCommit={(v) => setBox({ y: v })} disabled={allLocked} />
      </div>
      <div className="dz-pair">
        <InchIn label="Width" mm={b.w} onCommit={(v) => setBox({ w: Math.max(0.1, v) }, ratio)} disabled={allLocked} />
        <InchIn label="Height" mm={b.h} onCommit={(v) => setBox({ h: Math.max(0.1, v) }, ratio)} disabled={allLocked} />
      </div>
      <div className="row">
        <label className="check"><input type="checkbox" checked={ratio} onChange={(e) => setRatio(e.target.checked)} /> Keep proportions</label>
        {one && <NumIn label="" unit="°" value={Math.round((one.rot || 0) * 100) / 100} onCommit={(v) => apply((d) => D.rotateSel(d, [one.id], v - (one.rot || 0), { x: b.cx, y: b.cy }))} title="Rotation" />}
      </div>
      <div className="row dz-wrap">
        <label className="check"><input type="checkbox" checked={allLocked} onChange={(e) => apply((d) => D.setAll(d, objs.map((o) => o.id), { locked: e.target.checked }))} /> Locked</label>
        <label className="check" title="Flexi's CutContour: cut along this line, don't print it">
          <input type="checkbox" checked={objs.every((o) => o.cut)} disabled={objs.some((o) => o.type === 'image')}
            onChange={(e) => apply((d) => D.update(d, objs.map((o) => o.id), (o) => (e.target.checked ? { cut: true, prevFill: o.fill, fill: { type: 'none' } } : { cut: false, fill: o.prevFill || { type: 'solid', color: '#000000' } })))} /> Cut line (CutContour)
        </label>
      </div>
      {one && !one.cut && (
        <label className="dz-field"><span>Transparency (lens) — {100 - opacity}%</span>
          <input type="range" min={5} max={100} value={opacity} onChange={(e) => apply((d) => D.setAll(d, [one.id], { opacity: Number(e.target.value) / 100 }), `op${one.id}`)} />
        </label>
      )}

      {text && (
        <>
          <div className="box-title" style={{ marginTop: 6 }}>Text</div>
          <textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== text.text && onText(text, { text: draft })}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.target.blur(); }} />
          <label className="dz-field"><span>Font — {text.fontName || 'pick one'}</span>
            <input type="text" placeholder="Search fonts…" value={fontQ} onChange={(e) => setFontQ(e.target.value)} />
            <select size={6} value={text.font} onChange={(e) => { const f = fonts.find((x) => x.file === e.target.value); if (f) onText(text, { font: f.file, fontName: f.name }); }}>
              {fontList.map((f) => <option key={f.file} value={f.file}>{f.name}</option>)}
            </select>
          </label>
          <div className="dz-pair">
            <InchIn label="Letter height" mm={text.sizeMm} onCommit={(v) => onText(text, { sizeMm: Math.max(0.5, v) })} title="Height of a capital letter" />
            <NumIn label="Tracking" unit="%" step={1} value={Math.round((text.tracking || 0) * 100)} onCommit={(v) => onText(text, { tracking: v / 100 })} title="Space between letters" />
          </div>
          <div className="dz-pair">
            <NumIn label="Line spacing" unit="×" step={0.05} value={text.lineSpacing || 1.2} onCommit={(v) => onText(text, { lineSpacing: Math.max(0.5, v) })} />
            <label className="dz-num"><span>Align</span>
              <div className="seg dz-seg-small">
                {['left', 'center', 'right'].map((a) => <button key={a} className={(text.align || 'left') === a ? 'on' : ''} onClick={() => onText(text, { align: a })}>{a === 'left' ? '⇤' : a === 'center' ? '≡' : '⇥'}</button>)}
              </div>
            </label>
          </div>
          <label className="check"><input type="checkbox" checked={!!text.arc?.on} onChange={(e) => onText(text, { arc: { radiusMm: 150, position: 'top', ...(text.arc || {}), on: e.target.checked } })} /> Text on an arc</label>
          {text.arc?.on && (
            <div className="dz-pair">
              <InchIn label="Radius" mm={text.arc.radiusMm || 150} onCommit={(v) => onText(text, { arc: { ...text.arc, radiusMm: Math.max(10, v) } })} />
              <label className="dz-num"><span>Reads</span>
                <select value={text.arc.position || 'top'} onChange={(e) => onText(text, { arc: { ...text.arc, position: e.target.value } })}>
                  <option value="top">Over the top</option><option value="bottom">Under the bottom</option>
                </select>
              </label>
            </div>
          )}
          <button className="btn small" onClick={() => onOutline([text.id])}>Convert to outlines</button>
        </>
      )}
      {one && one.type === 'image' && (
        <>
          <div className="muted small">
            {one.natPx ? `${one.natPx.w} × ${one.natPx.h} px · ${Math.round(one.natPx.w / (one.w / MM))} ppi at this size` : 'Picture'}
          </div>
          <button className="btn small" onClick={() => onTraceCut(one)}>Contour cut around the picture…</button>
        </>
      )}
    </div>
  );
}

// ---------------- Fill & stroke ----------------
export function FillStroke({ objs, apply, swatches, addSwatch }) {
  const one = objs[0];
  const f = one?.fill || { type: 'none' };
  const st = one?.stroke || { color: null, width: 0 };
  const ids = objs.map((o) => o.id);
  const setFill = (patch) => apply((d) => D.update(d, ids, (o) => ({ fill: { ...(o.fill?.type ? o.fill : { color: '#000000' }), ...patch }, cut: false })), 'fill');
  const setStroke = (patch) => apply((d) => D.update(d, ids, (o) => ({ stroke: { color: '#000000', width: 0.5, ...(o.stroke || {}), ...patch } })), 'stroke');
  if (!one) return <div className="dz-section"><p className="muted small">Select shapes or text to change their fill and outline. Left-click a swatch below for the fill, right-click for the outline.</p></div>;
  if (objs.every((o) => o.type === 'image')) return <div className="dz-section"><p className="muted small">Pictures print as they are. Use the Properties tab for transparency or a contour cut.</p></div>;
  return (
    <div className="dz-section">
      <div className="box-title">Fill</div>
      <div className="seg dz-seg-small">
        {[['none', 'None'], ['solid', 'Solid'], ['linear', 'Gradient'], ['radial', 'Radial']].map(([k, l]) => (
          <button key={k} className={f.type === k ? 'on' : ''} onClick={() => setFill({ type: k, color: f.color || '#000000', color2: f.color2 || '#ffffff', angle: f.angle || 0 })}>{l}</button>
        ))}
      </div>
      {f.type !== 'none' && <ColorMixer color={f.color || '#000000'} onChange={(c) => setFill({ color: c })} label={f.type === 'solid' ? 'Color' : 'Start color'} />}
      {(f.type === 'linear' || f.type === 'radial') && (
        <>
          <ColorMixer color={f.color2 || '#ffffff'} onChange={(c) => setFill({ color2: c })} label="End color" />
          {f.type === 'linear' && <label className="dz-field"><span>Angle — {f.angle || 0}°</span><input type="range" min={0} max={359} value={f.angle || 0} onChange={(e) => setFill({ angle: Number(e.target.value) })} /></label>}
        </>
      )}
      {f.type === 'solid' && <button className="btn small" onClick={() => addSwatch(f.color)}>+ Add to swatches</button>}

      <div className="box-title" style={{ marginTop: 10 }}>Outline (stroke)</div>
      <div className="row">
        <label className="check"><input type="checkbox" checked={!!st.color && st.width > 0} onChange={(e) => setStroke(e.target.checked ? { color: st.color || '#000000', width: st.width || 0.5 } : { color: null, width: 0 })} /> Outline</label>
        {st.color && st.width > 0 && <InchIn label="" unit="in" digits={4} step={0.01} mm={st.width} onCommit={(v) => setStroke({ width: Math.max(0.01, v) })} title="Outline width" />}
      </div>
      {st.color && st.width > 0 && <ColorMixer color={st.color} onChange={(c) => setStroke({ color: c })} label="Outline color" />}
      {swatches.length > 0 && (
        <>
          <div className="box-title" style={{ marginTop: 10 }}>Shop swatches</div>
          <div className="swatches">{swatches.map((c) => <button key={c} className="swatch" style={{ background: c }} title={c} onClick={() => setFill({ type: 'solid', color: c })} />)}</div>
        </>
      )}
    </div>
  );
}

// ---------------- Objects list ----------------
export function ObjectList({ doc, sel, setSel, apply }) {
  const list = doc.objects.slice().reverse();
  return (
    <div className="dz-section dz-objlist">
      <div className="box-title">Objects (top first)</div>
      {!list.length && <p className="muted small">The page is empty.</p>}
      {list.map((o) => (
        <div key={o.id} className={`dz-obj ${sel.includes(o.id) ? 'on' : ''}`} onClick={(e) => setSel(e.shiftKey ? (sel.includes(o.id) ? sel.filter((x) => x !== o.id) : [...sel, o.id]) : D.expandGroups(doc, [o.id]))}>
          <span className="dz-obj-chip" style={{ background: o.cut ? D.CUT_COLOR : o.type === 'image' ? 'linear-gradient(135deg,#7aa7ff,#ff7a1a)' : o.fill?.type === 'solid' ? o.fill.color : o.fill?.type !== 'none' ? `linear-gradient(90deg,${o.fill.color},${o.fill.color2})` : 'transparent' }} />
          <span className="dz-obj-name">{o.groupId ? '▸ ' : ''}{o.name || o.type}</span>
          <button title={o.hidden ? 'Show' : 'Hide'} onClick={(e) => { e.stopPropagation(); apply((d) => D.setAll(d, [o.id], { hidden: !o.hidden })); }}>{o.hidden ? '◌' : '●'}</button>
          <button title={o.locked ? 'Unlock' : 'Lock'} onClick={(e) => { e.stopPropagation(); apply((d) => D.setAll(d, [o.id], { locked: !o.locked })); }}>{o.locked ? '🔒' : '🔓'}</button>
        </div>
      ))}
    </div>
  );
}

// ---------------- Swatch bar ----------------
export function SwatchBar({ swatches, onFill, onStroke, onCut }) {
  return (
    <div className="dz-swatchbar" onContextMenu={(e) => e.preventDefault()}>
      <span className="muted small" title="Left-click: fill · Right-click: outline">Colors</span>
      <button className="dz-sw dz-sw-none" title="No fill (right-click: no outline)" onClick={() => onFill(null)} onContextMenu={(e) => { e.preventDefault(); onStroke(null); }}>⌀</button>
      <button className="dz-sw dz-sw-cut" title="CutContour — make this a cut line" onClick={onCut}>✂</button>
      {[...SIGN_SWATCHES.map(([c, n]) => [c, n]), ...swatches.filter((c) => !SIGN_SWATCHES.some(([x]) => x === c)).map((c) => [c, c])].map(([c, n]) => (
        <button key={c} className="dz-sw" style={{ background: c }} title={`${n} (left: fill · right: outline)`}
          onClick={() => onFill(c)} onContextMenu={(e) => { e.preventDefault(); onStroke(c); }} />
      ))}
    </div>
  );
}
