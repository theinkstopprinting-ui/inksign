// Dialogs for the Design workspace: effect settings (one generic form driven by a field list),
// RIP and Print, Cut/Plot, Print & Cut, and Job Info.
import React, { useEffect, useMemo, useState } from 'react';
import { MM } from './Panels.jsx';

const api = window.inksign;
const remember = (key, v) => { try { window.localStorage.setItem(`inksign.dz.${key}`, JSON.stringify(v)); } catch { /* not saved */ } };
const recall = (key) => { try { return JSON.parse(window.localStorage.getItem(`inksign.dz.${key}`) || 'null'); } catch { return null; } };

export function Modal({ title, onClose, children, foot, wide }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`}>
        <div className="modal-head"><h2>{title}</h2><button className="btn ghost small" onClick={onClose}>✕</button></div>
        <div className="dz-modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

/**
 * Generic settings form. fields: [{ key, label, type: 'in'|'num'|'select'|'color'|'bool'|'text'|'textarea', options, default, help, unit, step, show(v) }]
 * Inch fields hold mm in the result.
 */
export function ParamDialog({ id, title, intro, fields, okLabel = 'Apply', onOk, onClose, preview }) {
  const init = useMemo(() => {
    const saved = recall(id) || {};
    return Object.fromEntries(fields.map((f) => [f.key, saved[f.key] ?? f.default]));
  }, [id]);
  const [v, setV] = useState(init);
  const [err, setErr] = useState('');
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  const go = async () => {
    setErr('');
    try { await onOk(v); remember(id, v); onClose(); } catch (e) { setErr(e.message || String(e)); }
  };
  return (
    <Modal title={title} onClose={onClose} foot={<><span className="error">{err}</span><div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go}>{okLabel}</button></div></>}>
      {intro && <p className="muted">{intro}</p>}
      <div className="dz-form">
        {fields.filter((f) => !f.show || f.show(v)).map((f) => (
          <label key={f.key} className={`dz-field ${f.type === 'bool' ? 'dz-field-check' : ''}`} title={f.help}>
            {f.type !== 'bool' && <span>{f.label}</span>}
            {f.type === 'in' && <div className="input-unit"><input type="number" step={f.step ?? 0.0625} value={+(Number(v[f.key]) / MM).toFixed(4)} onChange={(e) => set(f.key, (parseFloat(e.target.value) || 0) * MM)} /><em>in</em></div>}
            {f.type === 'num' && <div className="input-unit"><input type="number" step={f.step ?? 1} value={v[f.key]} onChange={(e) => set(f.key, parseFloat(e.target.value) || 0)} />{f.unit && <em>{f.unit}</em>}</div>}
            {f.type === 'text' && <input type="text" value={v[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />}
            {f.type === 'textarea' && <textarea rows={3} value={v[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />}
            {f.type === 'color' && <input type="color" value={v[f.key]} onChange={(e) => set(f.key, e.target.value)} />}
            {f.type === 'select' && <select value={v[f.key]} onChange={(e) => set(f.key, e.target.value)}>{f.options.map(([val, l]) => <option key={val} value={val}>{l}</option>)}</select>}
            {f.type === 'bool' && <span className="check"><input type="checkbox" checked={!!v[f.key]} onChange={(e) => set(f.key, e.target.checked)} /> {f.label}</span>}
            {f.help && f.type !== 'bool' && <small className="muted">{f.help}</small>}
          </label>
        ))}
      </div>
      {preview && preview(v)}
    </Modal>
  );
}

// ---------------- RIP and Print ----------------
export function PrintDialog({ devices, doc, scene, onClose, onSent, defaultName }) {
  const printers = devices.filter((d) => d.kind === 'printer');
  const [deviceId, setDeviceId] = useState(recall('printer') || printers[0]?.id || '');
  const dev = printers.find((d) => d.id === deviceId) || printers[0];
  const isHp = dev?.driver === 'hp-latex';
  const viaFlexi = dev?.driver === 'flexi-hotfolder';
  const [media, setMedia] = useState([]);
  const [modes, setModes] = useState([]);
  const [mediaId, setMediaId] = useState('');
  const [modeKey, setModeKey] = useState('');
  const [orientation, setOrientation] = useState('auto');
  const [keepCut, setKeepCut] = useState(false);
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setKeepCut(!!viaFlexi); }, [viaFlexi]);
  useEffect(() => {
    if (!isHp) return;
    api.devices.fieldOptions('hp-latex', 'hpMedia', dev.config).then((m) => { setMedia(m); setMediaId(dev.config.mediaId || m[0]?.value || ''); }).catch(() => setMedia([]));
  }, [deviceId, isHp]);
  useEffect(() => {
    if (!isHp || !mediaId) return;
    api.devices.fieldOptions('hp-latex', 'hpMode', { ...dev.config, mediaId }).then((m) => { setModes(m); setModeKey(m.some((x) => x.value === dev.config.modeKey) ? dev.config.modeKey : ''); }).catch(() => setModes([]));
  }, [mediaId, isHp]);
  const hasCut = scene.items.some((i) => i.cut);
  const go = async () => {
    setBusy(true); setErr('');
    try {
      remember('printer', dev.id);
      await api.design.print(dev.id, scene, { name, keepCutLines: keepCut, hpMediaId: isHp ? mediaId : undefined, hpModeKey: isHp ? modeKey : undefined, orientation });
      onSent(`Sent “${name}” to ${dev.name}`);
      onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="RIP and Print" onClose={onClose} foot={<><span className="error">{err}</span><div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!dev || busy} onClick={go}>{busy ? 'Sending…' : 'Print'}</button></div></>}>
      {!printers.length && <p className="warn-text">No printers set up yet — add one under Devices.</p>}
      <div className="dz-form">
        <label className="dz-field"><span>Job name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="dz-field"><span>Printer</span>
          <select value={dev?.id || ''} onChange={(e) => setDeviceId(e.target.value)}>{printers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        </label>
        {isHp && (
          <>
            <label className="dz-field"><span>Media</span><select value={mediaId} onChange={(e) => setMediaId(e.target.value)}>{media.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
            <label className="dz-field"><span>Print mode</span><select value={modeKey} onChange={(e) => setModeKey(e.target.value)}>{modes.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
            <label className="dz-field"><span>On the roll</span>
              <select value={orientation} onChange={(e) => setOrientation(e.target.value)}>
                <option value="auto">Best fit (least media)</option><option value="across">As drawn (width across the roll)</option><option value="along">Turned (width along the roll)</option>
              </select>
            </label>
          </>
        )}
        {hasCut && <label className="dz-field dz-field-check"><span className="check"><input type="checkbox" checked={keepCut} onChange={(e) => setKeepCut(e.target.checked)} /> Send the cut lines too (CutContour) — for a RIP that cuts, like Flexi</span></label>}
      </div>
      <p className="muted small">Page {(doc.page.w / MM).toFixed(2)}″ × {(doc.page.h / MM).toFixed(2)}″ · {scene.items.length} items{scene.marks ? ' · with registration marks' : ''}</p>
    </Modal>
  );
}

// ---------------- Cut / Plot ----------------
export function CutDialog({ devices, groupsFor, onClose, onSent, defaultName, hasCutLines, hasSelection }) {
  const cutters = devices.filter((d) => d.kind === 'cutter');
  const [deviceId, setDeviceId] = useState(recall('cutter') || cutters[0]?.id || '');
  const dev = cutters.find((d) => d.id === deviceId) || cutters[0];
  const [what, setWhat] = useState(hasCutLines ? 'cut' : 'color');
  const [onlySel, setOnlySel] = useState(false);
  const [weedIn, setWeedIn] = useState(0.25);
  const [mirror, setMirror] = useState(false);
  const [hold, setHold] = useState(true);
  const [name, setName] = useState(defaultName);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const panels = useMemo(() => groupsFor(what, onlySel, { weedMm: weedIn * MM, mirror }), [what, onlySel, weedIn, mirror]);
  const go = async (save) => {
    setErr('');
    if (!dev) { setErr('Add a cutter under Devices first'); return; }
    if (!panels.length) { setErr('Nothing to cut'); return; }
    setBusy(true);
    try {
      remember('cutter', dev.id);
      const out = panels.map((p, i) => ({ name: p.color ? `${name} — ${p.name}` : name, paths: p.paths, hold: hold && i > 0, holdMessage: p.color ? `Load ${p.name} vinyl, then press Release` : undefined }));
      if (save) {
        const files = await api.files.saveCut(dev.id, { name, panels: out, overrides: {} });
        if (files.length) onSent(`Saved ${files.length} cut file${files.length > 1 ? 's' : ''}`);
      } else {
        await api.jobs.sendCut(dev.id, { name, panels: out, overrides: {} });
        onSent(`Sent ${out.length} cut job${out.length > 1 ? 's' : ''} to ${dev.name}`);
      }
      onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const ft = panels.reduce((s, p) => s + p.paths.reduce((a, q) => a + q.reduce((b, pt, k) => (k ? b + Math.hypot(pt.x - q[k - 1].x, pt.y - q[k - 1].y) : 0), 0), 0), 0) / MM / 12;
  return (
    <Modal title="Cut / Plot" onClose={onClose} foot={<><span className="error">{err}</span><div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn" disabled={busy} onClick={() => go(true)}>Save cut file…</button><button className="btn primary" disabled={busy || !dev} onClick={() => go(false)}>Send to cutter</button></div></>}>
      {!cutters.length && <p className="warn-text">No cutters set up yet — add one under Devices.</p>}
      <div className="dz-form">
        <label className="dz-field"><span>Job name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="dz-field"><span>Cutter</span><select value={dev?.id || ''} onChange={(e) => setDeviceId(e.target.value)}>{cutters.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label className="dz-field"><span>What to cut</span>
          <select value={what} onChange={(e) => setWhat(e.target.value)}>
            {hasCutLines && <option value="cut">Cut lines only (CutContour)</option>}
            <option value="color">Every shape, one job per color (vinyl)</option>
            <option value="all">Every shape, all in one job</option>
          </select>
        </label>
        {hasSelection && <label className="dz-field dz-field-check"><span className="check"><input type="checkbox" checked={onlySel} onChange={(e) => setOnlySel(e.target.checked)} /> Only what's selected</span></label>}
        <label className="dz-field"><span>Weed border</span><div className="input-unit"><input type="number" step={0.125} value={weedIn} onChange={(e) => setWeedIn(parseFloat(e.target.value) || 0)} /><em>in</em></div><small className="muted">0 = no border</small></label>
        <label className="dz-field dz-field-check"><span className="check"><input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} /> Mirror (heat transfer / reverse-weeded window lettering)</span></label>
        {panels.length > 1 && <label className="dz-field dz-field-check"><span className="check"><input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} /> Hold each new color in the queue until it's loaded</span></label>}
      </div>
      <p className="muted small">{panels.length} job{panels.length !== 1 ? 's' : ''}: {panels.map((p) => p.name).join(', ') || '—'} · {ft.toFixed(1)} ft of cutting</p>
    </Modal>
  );
}

// ---------------- Print & Cut ----------------
export function PrintCutDialog({ devices, doc, sceneFor, cutPaths, onClose, onSent, defaultName, onAddCut }) {
  const printers = devices.filter((d) => d.kind === 'printer');
  const cutters = devices.filter((d) => d.kind === 'cutter');
  const [printerId, setPrinterId] = useState(recall('printer') || printers[0]?.id || '');
  const [cutterId, setCutterId] = useState(recall('cutter') || cutters[0]?.id || '');
  const printer = printers.find((d) => d.id === printerId) || printers[0];
  const cutter = cutters.find((d) => d.id === cutterId) || cutters[0];
  const titan = cutter?.config?.hpglStyle === 'titan';
  const [marginIn, setMarginIn] = useState(0.4);
  const [markIn, setMarkIn] = useState(titan ? 26 / MM : 0.4);
  useEffect(() => setMarkIn(titan ? 26 / MM : 0.4), [titan]);
  const [name, setName] = useState(defaultName);
  const [step, setStep] = useState('print');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const marks = { margin: marginIn * MM, size: markIn * MM, thickness: titan ? 1 : 0.5 };
  const clear = marks.margin + marks.size + 2;
  const art = sceneFor(marks);
  const inMarks = art.items.length > 0;
  const tooClose = cutPaths.some((p) => p.some((q) => q.x < clear || q.y < clear || q.x > doc.page.w - clear || q.y > doc.page.h - clear));
  const print = async () => {
    setErr(''); setBusy(true);
    try {
      await api.design.print(printer.id, art, { name: `${name} (print)`, keepCutLines: printer.driver === 'flexi-hotfolder' });
      remember('printer', printer.id);
      setStep('cut');
      onSent(`Printing “${name}” with registration marks on ${printer.name}`);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const cut = async () => {
    setErr(''); setBusy(true);
    try {
      await api.printcut.cut(cutter.id, { name, sheetW: doc.page.w, sheetH: doc.page.h, cutPaths, marks });
      remember('cutter', cutter.id);
      onSent(`Contour cut for “${name}” sent to ${cutter.name}`);
      onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Print & Cut" onClose={onClose} foot={<><span className="error">{err}</span><div className="row"><button className="btn" onClick={onClose}>Close</button>
      <button className={`btn ${step === 'print' ? 'primary' : ''}`} disabled={busy || !printer || !inMarks} onClick={print}>1 · Print with marks</button>
      <button className={`btn ${step === 'cut' ? 'primary' : ''}`} disabled={busy || !cutter || !cutPaths.length} onClick={cut}>2 · Cut</button></div></>}>
      {!cutPaths.length && (
        <div className="warn-text">There are no cut lines yet. Select the art and use Effects › Contour cut (or <button className="link" onClick={onAddCut}>add one around everything now</button>).</div>
      )}
      <div className="dz-form">
        <label className="dz-field"><span>Job name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="dz-field"><span>Printer</span><select value={printer?.id || ''} onChange={(e) => setPrinterId(e.target.value)}>{printers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label className="dz-field"><span>Cutter</span><select value={cutter?.id || ''} onChange={(e) => setCutterId(e.target.value)}>{cutters.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label className="dz-field"><span>Marks from the page edge</span><div className="input-unit"><input type="number" step={0.05} value={marginIn} onChange={(e) => setMarginIn(parseFloat(e.target.value) || 0)} /><em>in</em></div></label>
        <label className="dz-field"><span>Mark size</span><div className="input-unit"><input type="number" step={0.05} value={+markIn.toFixed(3)} onChange={(e) => setMarkIn(parseFloat(e.target.value) || 0)} /><em>in</em></div>{titan && <small className="muted">Titan: 26 mm marks, 1 mm thick — the same as Flexi prints</small>}</label>
      </div>
      {tooClose && <p className="warn-text">Some cut lines run into the mark area — keep art at least {(clear / MM).toFixed(2)}″ in from the page edges.</p>}
      <p className="muted small">The marks print in the page corners. After printing, load the print in the cutter, let it read the marks, then press Cut. Tip: set the page to the sheet or roll size you're printing on.</p>
    </Modal>
  );
}

// ---------------- Job info ----------------
export function JobInfo({ doc, stats, onClose }) {
  const area = doc.page.w * doc.page.h;
  return (
    <Modal title="Job info" onClose={onClose} foot={<span />}>
      <div className="dz-stats dz-stats-big">
        <div><em>Page</em>{(doc.page.w / MM).toFixed(2)}″ × {(doc.page.h / MM).toFixed(2)}″ ({(area / (MM * MM * 144)).toFixed(2)} sq ft)</div>
        <div><em>Objects</em>{stats.objects}</div>
        <div><em>Nodes</em>{stats.nodes.toLocaleString()}</div>
        <div><em>Total outline length</em>{(stats.cutMm / MM / 12).toFixed(1)} ft</div>
      </div>
      <table className="table">
        <thead><tr><th>Color</th><th>Area</th><th>Coverage</th></tr></thead>
        <tbody>
          {stats.colors.filter((c) => c.areaMm2 > 0 || c.color === 'CutContour').map((c) => (
            <tr key={c.color}><td><span className="dz-obj-chip" style={{ background: c.color.startsWith('#') ? c.color : c.color === 'CutContour' ? '#ff00ff' : '#888' }} /> {c.color}</td>
              <td>{(c.areaMm2 / (MM * MM)).toFixed(1)} sq in</td><td>{((c.areaMm2 / area) * 100).toFixed(1)}%</td></tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Areas are each object's box — overlapping shapes are counted once each.</p>
    </Modal>
  );
}
