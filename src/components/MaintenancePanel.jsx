import React, { useEffect, useState } from 'react';

const api = window.inksign;
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Blade changes, head cleanings… per machine, by days, meters of cut or square feet printed.
export default function MaintenancePanel({ owner }) {
  const [list, setList] = useState(null);
  const [notes, setNotes] = useState({});
  const [editing, setEditing] = useState(null); // { deviceId, deviceName, tasks }
  const [log, setLog] = useState(null);
  const [msg, setMsg] = useState('');
  const load = async () => setList(await api.maint.list());
  useEffect(() => { load(); }, []);
  if (!list) return null;
  const dueCount = list.reduce((s, d) => s + d.tasks.filter((t) => t.due).length, 0);
  const done = async (d, t) => { setMsg(''); try { setList(await api.maint.done(d.deviceId, t.id, notes[`${d.deviceId}:${t.id}`] || '')); setNotes((n) => ({ ...n, [`${d.deviceId}:${t.id}`]: '' })); } catch (e) { setMsg(clean(e.message)); } };
  const saveTasks = async () => { setMsg(''); try { setList(await api.maint.saveTasks(editing.deviceId, editing.tasks)); setEditing(null); } catch (e) { setMsg(clean(e.message)); } };
  return (
    <section className="card" style={{ marginBottom: 18 }}>
      <div className="card-top">
        <div><div className="card-title">Maintenance {dueCount ? <span className="pill pill-error">{dueCount} due</span> : <span className="pill pill-ok">up to date</span>}</div>
          <div className="muted small">Counts days, meters cut and square feet printed for each machine. Mark a task done when you've done it.</div></div>
        <button className="btn small" onClick={async () => setLog(log ? null : await api.maint.log())}>{log ? 'Hide log' : 'Log'}</button>
      </div>
      {msg && <div className="studio-msg">{msg}</div>}
      {list.map((d) => (
        <div key={d.deviceId} style={{ marginTop: 10 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>{d.deviceName}</b>
            <span className="muted small">{d.kind === 'cutter' ? `${Math.round(d.meters.cutM)} m cut` : `${Math.round(d.meters.sqft)} sq ft`} · {d.meters.jobs} jobs {owner && <button className="btn ghost small" onClick={() => setEditing({ deviceId: d.deviceId, deviceName: d.deviceName, tasks: d.tasks.map((t) => ({ id: t.id, name: t.name, everyDays: t.everyDays || '', everyCutM: t.everyCutM || '', everySqft: t.everySqft || '' })) })}>Edit tasks</button>}</span>
          </div>
          {d.tasks.map((t) => (
            <div key={t.id} className="maint-row">
              <div>{t.name}<div className="muted small">{t.detail}</div></div>
              <div className="maint-bar"><i className={t.due ? 'due' : t.soon ? 'soon' : ''} style={{ width: `${Math.round(t.progress * 100)}%` }} /></div>
              <div className="row">
                <input className="btn small" style={{ width: 130 }} placeholder="Note (optional)" value={notes[`${d.deviceId}:${t.id}`] || ''} onChange={(e) => setNotes((n) => ({ ...n, [`${d.deviceId}:${t.id}`]: e.target.value }))} />
                <button className={`btn small ${t.due ? 'primary' : ''}`} onClick={() => done(d, t)}>Done</button>
              </div>
            </div>
          ))}
        </div>
      ))}
      {log && (
        <table className="table" style={{ marginTop: 12 }}>
          <thead><tr><th>When</th><th>Machine</th><th>Task</th><th>Who</th><th>Note</th></tr></thead>
          <tbody>{log.map((l, i) => <tr key={i}><td className="nowrap">{new Date(l.at).toLocaleString()}</td><td>{l.deviceName}</td><td>{l.task}</td><td>{l.user}</td><td>{l.note}</td></tr>)}</tbody>
        </table>
      )}
      {editing && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="modal">
            <div className="modal-head"><h2>Maintenance — {editing.deviceName}</h2><button className="btn ghost" onClick={() => setEditing(null)}>✕</button></div>
            <p className="muted small">A task is due when any of its limits is reached. Leave a limit blank to skip it.</p>
            {editing.tasks.map((t, i) => (
              <div key={i} className="mini-row" style={{ marginBottom: 6 }}>
                <label className="mini-field" style={{ flex: 2 }}><span>Task</span><input value={t.name} onChange={(e) => setEditing((ed) => ({ ...ed, tasks: ed.tasks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) }))} /></label>
                {['everyDays', 'everyCutM', 'everySqft'].map((k) => (
                  <label key={k} className="mini-field"><span>{{ everyDays: 'Days', everyCutM: 'Meters cut', everySqft: 'Sq ft' }[k]}</span>
                    <input type="number" value={t[k]} onChange={(e) => setEditing((ed) => ({ ...ed, tasks: ed.tasks.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)) }))} /></label>
                ))}
                <button className="btn ghost small" onClick={() => setEditing((ed) => ({ ...ed, tasks: ed.tasks.filter((_, j) => j !== i) }))}>✕</button>
              </div>
            ))}
            <button className="btn small" onClick={() => setEditing((ed) => ({ ...ed, tasks: [...ed.tasks, { name: 'New task', everyDays: 30, everyCutM: '', everySqft: '' }] }))}>+ Add task</button>
            <div className="modal-foot"><span /><div className="row"><button className="btn" onClick={() => setEditing(null)}>Cancel</button><button className="btn primary" onClick={saveTasks}>Save</button></div></div>
          </div>
        </div>
      )}
    </section>
  );
}
