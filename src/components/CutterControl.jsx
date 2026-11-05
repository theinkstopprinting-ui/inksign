import React, { useState } from 'react';

const api = window.inksign;
const MM = 25.4;
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const STEPS = [[1, '1 mm'], [10, '10 mm'], [MM, '1"'], [6 * MM, '6"']];

// Jog the blade, pick where the next job starts, keep track of the roll, pause or cancel.
// X = along the roll (feed), Y = across the roll. All moves are blade-up.
export default function CutterControl({ cutter, jobs = [] }) {
  const [step, setStep] = useState(10);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  if (!cutter) return null;
  const st = cutter.state || {};
  const run = async (fn) => {
    setBusy(true); setMsg('');
    try { await fn(); } catch (e) { setMsg(clean(e.message)); }
    setBusy(false);
  };
  const jog = (dx, dy) => run(() => api.cutter.jog(cutter.id, { dx, dy }));
  const waiting = jobs.filter((j) => j.deviceId === cutter.id && (j.status === 'queued' || j.status === 'held')).length;
  const inch = (mm) => (mm / MM).toFixed(2);
  const usedFt = (Number(st.rollUsedMm) || 0) / MM / 12;

  return (
    <div className="cutter-control">
      <div className="jog-row">
        <div className="jog-pad">
          <span />
          <button className="btn small" disabled={busy} title="Across the roll, away from the origin" onClick={() => jog(0, step)}>▲</button>
          <span />
          <button className="btn small" disabled={busy} title="Back along the roll" onClick={() => jog(-step, 0)}>◀</button>
          <button className="btn small" disabled={busy} title="Blade to the origin" onClick={() => run(() => api.cutter.jog(cutter.id, { to: { x: 0, y: 0 } }))}>⌂</button>
          <button className="btn small" disabled={busy} title="Forward along the roll" onClick={() => jog(step, 0)}>▶</button>
          <span />
          <button className="btn small" disabled={busy} title="Across the roll, toward the origin" onClick={() => jog(0, -step)}>▼</button>
          <span />
        </div>
        <div className="jog-side">
          <label className="mini-field"><span>Step</span>
            <select value={step} onChange={(e) => setStep(Number(e.target.value))}>
              {STEPS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
            </select>
          </label>
          <div className="small muted">Blade at X {inch(st.jogX || 0)}" · Y {inch(st.jogY || 0)}"</div>
        </div>
      </div>
      <div className="btn-row">
        <button className="btn small" disabled={busy} onClick={() => run(() => api.cutter.setStart(cutter.id, true))}>Start next job here</button>
        <button className="btn small ghost" disabled={busy} onClick={() => run(() => api.cutter.setStart(cutter.id, false))}>Reset start</button>
      </div>
      {(Number(st.startX) || Number(st.startY)) ? <div className="small muted">Jobs start at X {inch(st.startX || 0)}" · Y {inch(st.startY || 0)}" from the origin.</div> : null}

      <label className="check"><input type="checkbox" checked={!!st.continueRoll} onChange={(e) => run(() => api.cutter.roll(cutter.id, { continueRoll: e.target.checked }))} /> Next job starts after the last one (save vinyl)</label>
      {st.continueRoll && (
        <div className="roll-line">
          <span>Used on this roll: <b>{usedFt.toFixed(2)} ft</b></span>
          <button className="btn ghost small" onClick={() => run(() => api.cutter.roll(cutter.id, { newRoll: true }))}>New roll / reset</button>
        </div>
      )}

      <div className="btn-row">
        <button className="btn small" disabled={busy} onClick={() => run(() => api.cutter.pause(cutter.id, !st.paused))}>{st.paused ? 'Resume queue' : 'Pause queue'}</button>
        <button className="btn small danger" disabled={busy} onClick={() => run(async () => {
          const r = await api.cutter.cancel(cutter.id);
          setMsg(`Cancelled ${r.cancelled} waiting job${r.cancelled === 1 ? '' : 's'}${r.spooled ? ` and cleared ${r.spooled} from Windows` : ''}.`);
        })}>Cancel waiting{waiting ? ` (${waiting})` : ''}</button>
      </div>
      {st.paused && <div className="seg-note">Queue paused — jobs to {cutter.name} wait until you resume.</div>}
      <div className="help">To stop a cut that's already running, press PAUSE on the cutter — it keeps cutting what it has already received.</div>
      {msg && <div className="studio-msg">{msg}</div>}
    </div>
  );
}
