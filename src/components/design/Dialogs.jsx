// Dialogs for the Design workspace: effect settings (one generic form driven by a field list),
// RIP and Print, Print & Cut, and Job Info. (Cut / Plot is the Send to be Cut window, CutWindow.jsx.)
import React, { useEffect, useMemo, useState } from 'react';
import { MM, UNIT } from './Panels.jsx';
import { jobBarcode } from '../../lib/jobBarcode.js';

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
            {f.type === 'in' && <div className="input-unit"><input type="number" step={UNIT.key === 'in' ? (f.step ?? 0.0625) : UNIT.step} value={+(Number(v[f.key]) / UNIT.k).toFixed(UNIT.key === 'in' ? 4 : 2)} onChange={(e) => set(f.key, (parseFloat(e.target.value) || 0) * UNIT.k)} /><em>{UNIT.label}</em></div>}
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

// ---------------- Print & Cut ----------------
export function PrintCutDialog({ devices, doc, sceneFor, cutPaths, onClose, onSent, defaultName, onAddCut, inkflow, colorize }) {
  const printers = devices.filter((d) => d.kind === 'printer');
  const cutters = devices.filter((d) => d.kind === 'cutter');
  const [printerId, setPrinterId] = useState(recall('printer') || printers[0]?.id || '');
  const [cutterId, setCutterId] = useState(recall('cutter') || cutters[0]?.id || '');
  const printer = printers.find((d) => d.id === printerId) || printers[0];
  const cutter = cutters.find((d) => d.id === cutterId) || cutters[0];
  const titan = cutter?.config?.hpglStyle === 'titan';
  // marks placed on the design (Tools › Place registration marks) are used as they are
  const [marginIn, setMarginIn] = useState(doc.marks ? doc.marks.margin / MM : 0.4);
  const [markIn, setMarkIn] = useState(doc.marks ? doc.marks.size / MM : titan ? 26 / MM : 0.4);
  useEffect(() => { if (!doc.marks) setMarkIn(titan ? 26 / MM : 0.4); }, [titan]);
  const [name, setName] = useState(defaultName);
  const [step, setStep] = useState('print');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [useCode, setUseCode] = useState(recall('jobBarcode') !== 'off');
  const [jobNo, setJobNo] = useState('');
  // HP Latex roll print & cut: the media preset (Print window › Saved media preset) picks the HP media and mode
  const [wideMedia, setWideMedia] = useState([]);
  useEffect(() => { api.settings.get().then((s) => setWideMedia((s.wideMedia || []).filter((m) => m.hpMediaId))).catch(() => {}); }, []);
  const [hpPreset, setHpPreset] = useState(recall('hpPreset') || '');
  const isHp = printer?.driver === 'hp-latex';
  const hp = isHp ? wideMedia.find((m) => m.name === hpPreset) : null;
  const marks = { margin: marginIn * MM, size: markIn * MM, thickness: titan ? 1 : 0.5 };
  const clear = marks.margin + marks.size + 2;
  const art = sceneFor(marks);
  const inMarks = art.items.length > 0;
  const tooClose = cutPaths.some((p) => p.some((q) => q.x < clear || q.y < clear || q.x > doc.page.w - clear || q.y > doc.page.h - clear));
  const print = async () => {
    setErr(''); setBusy(true);
    try {
      let out = art, no = '';
      if (useCode && cutPaths.length) {
        no = await api.printcut.newJobNo();
        const barcode = jobBarcode(doc.page, marks, no);
        if (barcode) out = sceneFor({ ...marks, barcode }); else no = '';
      }
      if (colorize) out = await colorize(out, printer);
      await api.design.print(printer.id, out, { name: `${name} (print)`, keepCutLines: printer.driver === 'flexi-hotfolder', hpMediaId: hp?.hpMediaId, hpModeKey: hp?.hpModeKey });
      if (isHp) remember('hpPreset', hpPreset);
      if (no) await api.printcut.saveJob(no, { name, sheetW: doc.page.w, sheetH: doc.page.h, cutPaths, marks });
      setJobNo(no);
      remember('printer', printer.id); remember('jobBarcode', useCode ? 'on' : 'off');
      setStep('cut');
      onSent(`Printing “${name}” with registration marks on ${printer.name}${no ? ` — job ${no}` : ''}`);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const cut = async () => {
    setErr(''); setBusy(true);
    try {
      await api.printcut.cut(cutter.id, { name, sheetW: doc.page.w, sheetH: doc.page.h, cutPaths, marks, inkflow: inkflow ? { ...inkflow, status: 'cut' } : undefined });
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
        {isHp && (
          <label className="dz-field"><span>HP media preset</span>
            <select value={hpPreset} onChange={(e) => setHpPreset(e.target.value)}>
              <option value="">What's set on the printer</option>
              {wideMedia.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
            </select>
            {!wideMedia.length && <small className="muted">Save one from the Print window (Print mode & color › Saved media preset)</small>}
          </label>
        )}
        <label className="dz-field"><span>Cutter</span><select value={cutter?.id || ''} onChange={(e) => setCutterId(e.target.value)}>{cutters.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label className="dz-field"><span>Marks from the page edge</span><div className="input-unit"><input type="number" step={0.05} value={marginIn} onChange={(e) => setMarginIn(parseFloat(e.target.value) || 0)} /><em>in</em></div></label>
        <label className="dz-field"><span>Mark size</span><div className="input-unit"><input type="number" step={0.05} value={+markIn.toFixed(3)} onChange={(e) => setMarkIn(parseFloat(e.target.value) || 0)} /><em>in</em></div>{titan && <small className="muted">Titan: 26 mm marks, 1 mm thick — the same as Flexi prints</small>}</label>
      </div>
      <label className="check"><input type="checkbox" checked={useCode} onChange={(e) => setUseCode(e.target.checked)} /> Print a job number and barcode beside the marks, and keep the cut under that number</label>
      {jobNo && <p className="seg-note">Printed as <b>job {jobNo}</b>. Cut it now with button 2, or any time later: open the cutter's controls, and scan or type {jobNo}.</p>}
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
