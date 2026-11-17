// Print & cut alignment test (Tools › Print & cut alignment test): prints five squares with crosshairs
// inside registration marks, then cuts the same five squares. If the cut lands off the print, the
// measured difference is saved on the cutter and used for every print & cut job after that.
import React, { useEffect, useState } from 'react';
import { Modal } from './Dialogs.jsx';

const api = window.inksign;
const MM = 25.4;
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const SHEETS = { Letter: [8.5, 11], Tabloid: [11, 17], '12 x 18': [12, 18], '13 x 19': [13, 19], 'Roll piece 24 x 24': [24, 24] };

function targets(sheetW, sheetH, margin, markSize) {
  const S = 12, inset = margin + markSize + 15;
  const xs = [inset + S / 2, sheetW / 2, sheetW - inset - S / 2];
  const ys = [inset + S / 2, sheetH / 2, sheetH - inset - S / 2];
  const centers = [['A', xs[0], ys[0]], ['B', xs[2], ys[0]], ['C', xs[1], ys[1]], ['D', xs[0], ys[2]], ['E', xs[2], ys[2]]];
  const sq = (cx, cy) => [[{ x: cx - S / 2, y: cy - S / 2 }, { x: cx + S / 2, y: cy - S / 2 }, { x: cx + S / 2, y: cy + S / 2 }, { x: cx - S / 2, y: cy + S / 2 }, { x: cx - S / 2, y: cy - S / 2 }]];
  const printPaths = [], cutPaths = [], labels = [];
  for (const [name, cx, cy] of centers) {
    printPaths.push(...sq(cx, cy), [{ x: cx - S, y: cy }, { x: cx + S, y: cy }], [{ x: cx, y: cy - S }, { x: cx, y: cy + S }]);
    cutPaths.push(...sq(cx, cy));
    labels.push({ text: name, x: cx + S / 2 + 2, y: cy - S / 2 - 1, sizeMm: 4 });
  }
  labels.push({ text: 'InkSign alignment test — the cut square should sit exactly on each printed square. Measure at C.', x: margin + markSize + 3, y: margin + markSize + 6, sizeMm: 3 });
  return { printPaths, cutPaths, labels };
}

export default function AlignTest({ devices, onDevicesChanged, onClose }) {
  const printers = devices.filter((d) => d.kind === 'printer');
  const cutters = devices.filter((d) => d.kind === 'cutter');
  const [printerId, setPrinterId] = useState((printers.find((p) => p.driver === 'network-printer') || printers[0])?.id || '');
  const [cutterId, setCutterId] = useState(cutters[0]?.id || '');
  const printer = printers.find((p) => p.id === printerId);
  const cutter = cutters.find((c) => c.id === cutterId);
  const isHp = printer?.driver === 'flexi-hotfolder' || printer?.driver === 'hp-latex';
  const [sheet, setSheet] = useState('Letter');
  useEffect(() => setSheet(isHp ? 'Roll piece 24 x 24' : 'Letter'), [isHp]);
  const [rightMm, setRightMm] = useState('0');
  const [upMm, setUpMm] = useState('0');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const titan = cutter?.config?.hpglStyle === 'titan';
  const cal = cutter?.config || {};

  const job = () => {
    const [w, h] = SHEETS[sheet].map((v) => v * MM);
    const margin = 10.16, size = titan ? 26 : 10.16, thickness = titan ? 1 : 0.5;
    const t = targets(w, h, margin, size);
    const frame = { y0: 0, h };
    return { name: `Alignment test (${cutter?.name || 'cutter'})`, sheetW: w, sheetH: h, route: 'direct', frames: [frame], marks: { margin, size, thickness }, images: [],
      printPaths: t.printPaths, labels: t.labels, frameCuts: [t.cutPaths], cutPaths: t.cutPaths };
  };
  const run = async (fn, done) => { setBusy(true); setMsg(''); try { await fn(); setMsg(done); } catch (e) { setMsg(clean(e.message)); } setBusy(false); };
  const save = (patch) => run(async () => {
    await api.devices.save({ id: cutter.id, name: cutter.name, config: patch });
    if (onDevicesChanged) await onDevicesChanged();
    setRightMm('0'); setUpMm('0');
  }, `Saved to ${cutter.name}. Cut the test again to check.`);
  const r = Number(rightMm) || 0, u = Number(upMm) || 0;

  return (
    <Modal title="Print & cut alignment test" onClose={onClose} foot={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="dz-form at-form">
        <p className="muted small">Prints 5 squares with crosshairs inside the marks, then cuts the same 5 squares. If the cut lands off the print, measure at the middle square (C) and save the correction. It is kept for that cutter and used on every print &amp; cut job.</p>
        <div className="dz-grid2">
          <label className="dz-field"><span>Printer</span><select value={printerId} onChange={(e) => setPrinterId(e.target.value)}>{printers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="dz-field"><span>Cutter</span><select value={cutterId} onChange={(e) => setCutterId(e.target.value)}>{cutters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="dz-field"><span>Test sheet</span><select value={sheet} onChange={(e) => setSheet(e.target.value)}>{Object.keys(SHEETS).map((k) => <option key={k}>{k}</option>)}</select></label>
          <label className="dz-field"><span>Squares cut sideways or upside down? Rotate the cut</span>
            <select value={String(cal.regRotate || '0')} disabled={!cutter || busy} onChange={(e) => save({ regRotate: e.target.value })}>{['0', '90', '180', '270'].map((v) => <option key={v} value={v}>{v}°</option>)}</select>
          </label>
        </div>
        <div className="row">
          <button className="btn" disabled={!printer || busy} onClick={() => run(() => api.printcut.print(printerId, job()), 'Test sheet sent. Load it in the cutter, scan the marks, then press Cut test sheet.')}>1. Print test sheet</button>
          <button className="btn" disabled={!cutter || busy} onClick={() => run(() => api.printcut.cut(cutterId, job()), 'Test cut sent. Look at target C: does the cut square sit exactly on the printed square?')}>2. Cut test sheet</button>
        </div>
        <div className="dz-grid2">
          <label className="dz-field"><span>Cut landed right by (mm, minus = left)</span><input type="number" step={0.1} value={rightMm} onChange={(e) => setRightMm(e.target.value)} /></label>
          <label className="dz-field"><span>Cut landed up by (mm, minus = down)</span><input type="number" step={0.1} value={upMm} onChange={(e) => setUpMm(e.target.value)} /></label>
        </div>
        <div className="row">
          <button className="btn primary" disabled={!cutter || busy || (!r && !u)} onClick={() => save({ regOffsetXmm: +((Number(cal.regOffsetXmm) || 0) - r).toFixed(2), regOffsetYmm: +((Number(cal.regOffsetYmm) || 0) - u).toFixed(2) })}>3. Save correction</button>
          {(Number(cal.regOffsetXmm) || Number(cal.regOffsetYmm)) ? <button className="btn" disabled={busy} onClick={() => save({ regOffsetXmm: 0, regOffsetYmm: 0 })}>Reset to 0</button> : null}
        </div>
        <p className="muted small">Saved for {cutter?.name || 'this cutter'} now: X {Number(cal.regOffsetXmm || 0).toFixed(2)} mm · Y {Number(cal.regOffsetYmm || 0).toFixed(2)} mm · rotate {cal.regRotate || 0}°</p>
        {msg && <p className="small">{msg}</p>}
      </div>
    </Modal>
  );
}
