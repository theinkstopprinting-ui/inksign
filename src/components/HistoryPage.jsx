import React, { useEffect, useState } from 'react';

const api = window.inksign;
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Every job sent (5,000 kept): find by name, order, machine or person, and send it again.
export default function HistoryPage({ devices, onJobsSent }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');
  const [target, setTarget] = useState({});
  useEffect(() => { api.history.list().then(setList); }, []);
  const s = q.trim().toLowerCase();
  const shown = (list || []).filter((h) => !s || `${h.name} ${h.deviceName} ${h.user || ''} ${h.inkflow?.label || ''} ${new Date(h.finishedAt).toLocaleDateString()}`.toLowerCase().includes(s)).slice(0, 300);
  const reprint = async (h) => {
    setMsg('');
    try { await api.history.reprint(h.id, target[h.id] || h.deviceId); onJobsSent(); } catch (e) { setMsg(clean(e.message)); }
  };
  return (
    <div>
      <header className="page-head">
        <div><h1>Job history</h1><p className="muted">Every job sent from this PC. Reprint sends the same file again — to the same machine or another of the same kind.</p></div>
        <input className="btn" placeholder="Search: name, order, machine, person, date…" style={{ width: 320 }} value={q} onChange={(e) => setQ(e.target.value)} />
      </header>
      {msg && <div className="studio-msg" style={{ marginBottom: 10 }}>{msg}</div>}
      {list && !shown.length && <div className="empty">{s ? 'Nothing matches.' : 'No jobs yet.'}</div>}
      {!!shown.length && (
        <table className="table">
          <thead><tr><th>When</th><th>Job</th><th>Machine</th><th>Who</th><th>Result</th><th /></tr></thead>
          <tbody>
            {shown.map((h) => {
              const kind = devices.find((d) => d.id === h.deviceId)?.kind;
              const same = devices.filter((d) => !kind || d.kind === kind);
              return (
                <tr key={h.id}>
                  <td className="nowrap">{new Date(h.finishedAt).toLocaleString()}</td>
                  <td>{h.name}{h.meta?.feet ? <div className="muted small">{h.meta.feet.toFixed(1)} ft of roll</div> : null}</td>
                  <td>{h.deviceName}</td>
                  <td>{h.user || ''}</td>
                  <td><span className={`pill pill-job-${h.status}`}>{h.status}</span></td>
                  <td className="nowrap">
                    {h.action !== 'test' && h.status !== 'cancelled' && (<>
                      <select className="btn small" value={target[h.id] || h.deviceId} onChange={(e) => setTarget((t) => ({ ...t, [h.id]: e.target.value }))}>
                        {same.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>{' '}
                      <button className="btn small" onClick={() => reprint(h)}>Reprint</button>
                    </>)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
