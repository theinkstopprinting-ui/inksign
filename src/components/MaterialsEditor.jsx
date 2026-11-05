import React, { useState } from 'react';

const COLS = [
  ['name', 'Material', 'text', 190],
  ['costPerFt', '$ / ft', 'number', 70],
  ['rollWidthIn', 'Roll width (in)', 'number', 80],
  ['force', 'Force', 'number', 60],
  ['speed', 'Speed', 'number', 60],
  ['overcutMm', 'Overcut mm', 'number', 70],
  ['mirror', 'Mirror', 'bool', 56],
  ['note', 'Note', 'text', 200],
];

export default function MaterialsEditor({ settings, onClose, onSave }) {
  const [materials, setMaterials] = useState(settings.materials.map((m) => ({ ...m })));
  const [pricing, setPricing] = useState({ ...settings.pricing });
  const [colors, setColors] = useState((settings.colors || []).map((c) => ({ ...c })));
  const [wideMedia, setWideMedia] = useState((settings.wideMedia || []).map((m) => ({ ...m })));
  const [inkCost, setInkCost] = useState(settings.inkCostPerMl ?? 0.2);
  const setW = (i, k, v) => setWideMedia((ms) => ms.map((m, j) => (j === i ? { ...m, [k]: v } : m)));
  const setC = (i, k, v) => setColors((cs) => cs.map((c, j) => (j === i ? { ...c, [k]: v } : c)));

  const set = (i, k, v) => setMaterials((ms) => ms.map((m, j) => (j === i ? { ...m, [k]: v } : m)));
  const add = () => setMaterials((ms) => [...ms, { id: `m${Date.now()}`, name: 'New material', costPerFt: 1, rollWidthIn: 24, force: '', speed: '', overcutMm: 0.5, note: '' }]);
  const del = (i) => setMaterials((ms) => ms.filter((_, j) => j !== i));
  const P = [
    ['laborPerHour', 'Labor $/hour'], ['weedMinPerFt', 'Weeding min per ft of cut'], ['setupMin', 'Setup minutes per job'],
    ['markup', 'Markup (× cost)'], ['minimum', 'Minimum charge $'],
  ];

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <div className="modal-head"><h2>Materials, colors & pricing</h2><button className="btn ghost" onClick={onClose}>✕</button></div>
        <p className="muted small">Force and speed are sent to the cutter with each job (blank = use the cutter panel). Do a test cut on scrap to find the right numbers for each material, then save them here.</p>
        <div className="mat-table">
          <div className="mat-row mat-head">{COLS.map(([k, l, , w]) => <span key={k} style={{ width: w }}>{l}</span>)}<span /></div>
          {materials.map((m, i) => (
            <div className="mat-row" key={m.id}>
              {COLS.map(([k, , type, w]) => (type === 'bool'
                ? <label key={k} style={{ width: w, display: 'flex', justifyContent: 'center' }} title="Cut mirrored (heat transfer vinyl)"><input type="checkbox" checked={!!m[k]} onChange={(e) => set(i, k, e.target.checked)} /></label>
                : <input key={k} style={{ width: w }} type={type} step="any" value={m[k] ?? ''}
                  onChange={(e) => set(i, k, type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />
              ))}
              <button className="btn ghost small" onClick={() => del(i)}>✕</button>
            </div>
          ))}
        </div>
        <button className="btn small" onClick={add}>+ Add material</button>
        <h3 className="section-title">Color library (vinyl & brand colors)</h3>
        <div className="mat-table">
          <div className="mat-row mat-head"><span style={{ width: 46 }}>Color</span><span style={{ width: 200 }}>Name (e.g. Oracal 751 Signal Red)</span><span style={{ width: 90 }}>Hex</span><span style={{ width: 120 }}>CMYK (for print)</span><span /></div>
          {colors.map((c, i) => (
            <div className="mat-row" key={i}>
              <input type="color" style={{ width: 46, padding: 2 }} value={c.hex} onChange={(e) => setC(i, 'hex', e.target.value)} />
              <input type="text" style={{ width: 200 }} value={c.name} onChange={(e) => setC(i, 'name', e.target.value)} />
              <input type="text" style={{ width: 90 }} value={c.hex} onChange={(e) => setC(i, 'hex', e.target.value)} />
              <input type="text" style={{ width: 120 }} value={c.cmyk || ''} placeholder="C,M,Y,K" onChange={(e) => setC(i, 'cmyk', e.target.value)} />
              <button className="btn ghost small" onClick={() => setColors((cs) => cs.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
        </div>
        <button className="btn small" onClick={() => setColors((cs) => [...cs, { name: 'New color', hex: '#888888', cmyk: '' }])}>+ Add color</button>
        <h3 className="section-title">Wide-format media (HP)</h3>
        <div className="mat-table">
          <div className="mat-row mat-head"><span style={{ width: 220 }}>Media name (match the hot folder names)</span><span style={{ width: 90 }}>$ / sq ft</span><span style={{ width: 110 }}>Ink ml / sq ft</span><span /></div>
          {wideMedia.map((m, i) => (
            <div className="mat-row" key={i}>
              <input type="text" style={{ width: 220 }} value={m.name} onChange={(e) => setW(i, 'name', e.target.value)} />
              <input type="number" step="any" style={{ width: 90 }} value={m.costPerSqFt} onChange={(e) => setW(i, 'costPerSqFt', Number(e.target.value))} />
              <input type="number" step="any" style={{ width: 110 }} value={m.inkMlPerSqFt} onChange={(e) => setW(i, 'inkMlPerSqFt', Number(e.target.value))} />
              <button className="btn ghost small" onClick={() => setWideMedia((ms) => ms.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
        </div>
        <div className="row">
          <button className="btn small" onClick={() => setWideMedia((ms) => [...ms, { name: 'New media', costPerSqFt: 0.5, inkMlPerSqFt: 1 }])}>+ Add media</button>
          <label className="mini-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><span>Ink cost $ / ml</span>
            <input type="number" step="any" style={{ width: 80 }} className="btn" value={inkCost} onChange={(e) => setInkCost(Number(e.target.value))} /></label>
        </div>
        <h3 className="section-title">Pricing</h3>
        <div className="form">
          {P.map(([k, l]) => (
            <div className="field" key={k}>
              <label>{l}</label>
              <input type="number" step="any" value={pricing[k]} onChange={(e) => setPricing((p) => ({ ...p, [k]: Number(e.target.value) }))} />
            </div>
          ))}
        </div>
        <div className="modal-foot"><span /><div className="row">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onSave({ materials, pricing, colors, wideMedia, inkCostPerMl: inkCost })}>Save</button>
        </div></div>
      </div>
    </div>
  );
}
