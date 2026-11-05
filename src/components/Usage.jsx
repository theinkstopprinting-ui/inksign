import React, { useEffect, useMemo, useState } from 'react';

const api = window.inksign;
const money = (v) => `$${(v || 0).toFixed(2)}`;

export default function Usage({ jobs }) {
  const [rows, setRows] = useState([]);
  const [range, setRange] = useState('month');
  const [msg, setMsg] = useState('');
  const [labor, setLabor] = useState([]);
  useEffect(() => { api.usage.list().then(setRows); api.timers.list().then((t) => setLabor(t.log || [])); }, [jobs]);

  const filtered = useMemo(() => {
    const now = new Date();
    const start = range === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1).getTime()
      : range === 'year' ? new Date(now.getFullYear(), 0, 1).getTime() : 0;
    return rows.filter((r) => r.date >= start).sort((a, b) => b.date - a.date);
  }, [rows, range]);

  const laborShown = useMemo(() => {
    const now = new Date();
    const start = range === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1).getTime() : range === 'year' ? new Date(now.getFullYear(), 0, 1).getTime() : 0;
    return labor.filter((l) => l.end >= start).sort((a, b) => b.end - a.end);
  }, [labor, range]);
  const sum = (list, k) => list.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const groupBy = (k) => Object.entries(filtered.reduce((m, r) => { (m[r[k] || '—'] ||= []).push(r); return m; }, {}));

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>Usage</h1>
          <p className="muted">Media and ink used by jobs sent from Wide Format.</p>
        </div>
        <div className="row">
          <select className="btn" value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="month">This month</option><option value="year">This year</option><option value="all">All time</option>
          </select>
          <button className="btn" onClick={async () => { const p = await api.usage.exportCsv(); if (p) setMsg(`Exported to ${p}`); }}>Export CSV</button>
        </div>
      </header>
      {msg && <div className="muted small" style={{ marginBottom: 10 }}>{msg}</div>}
      <div className="grid usage-cards">
        <div className="card"><div className="muted small">Jobs</div><div className="big">{filtered.length}</div></div>
        <div className="card"><div className="muted small">Media used</div><div className="big">{sum(filtered, 'mediaSqFt').toFixed(0)} sq ft</div><div className="muted small">{sum(filtered, 'lengthFt').toFixed(1)} linear ft</div></div>
        <div className="card"><div className="muted small">Ink (estimate)</div><div className="big">{(sum(filtered, 'inkMl') / 1000).toFixed(2)} L</div></div>
        <div className="card"><div className="muted small">Cost</div><div className="big">{money(sum(filtered, 'mediaCost') + sum(filtered, 'inkCost'))}</div><div className="muted small">media {money(sum(filtered, 'mediaCost'))} · ink {money(sum(filtered, 'inkCost'))}</div></div>
      </div>
      {[['deviceName', 'By printer'], ['media', 'By media']].map(([k, title]) => (
        <section key={k}>
          <h2 className="section-title">{title}</h2>
          <table className="table">
            <thead><tr><th>{k === 'media' ? 'Media' : 'Printer'}</th><th>Jobs</th><th>Sq ft</th><th>Ink ml</th><th>Cost</th></tr></thead>
            <tbody>{groupBy(k).map(([name, list]) => (
              <tr key={name}><td>{name}</td><td>{list.length}</td><td>{sum(list, 'mediaSqFt').toFixed(1)}</td><td>{sum(list, 'inkMl').toFixed(0)}</td><td>{money(sum(list, 'mediaCost') + sum(list, 'inkCost'))}</td></tr>
            ))}</tbody>
          </table>
        </section>
      ))}
      <h2 className="section-title">Labor (timers)</h2>
      {!laborShown.length ? <div className="empty">No labor timed yet. Start a timer in the sidebar on an order.</div> : (<>
        <div className="muted small" style={{ marginBottom: 6 }}>{Math.round(sum(laborShown, 'minutes') / 6) / 10} hours · {money(sum(laborShown, 'costCents') / 100)}</div>
        <table className="table">
          <thead><tr><th>Finished</th><th>Who</th><th>Task</th><th>Order</th><th>Minutes</th><th>Cost</th><th>InkFlow</th></tr></thead>
          <tbody>{laborShown.slice(0, 200).map((l) => (
            <tr key={l.id}><td className="nowrap">{new Date(l.end).toLocaleString()}</td><td>{l.user}</td><td>{l.task}</td><td>{l.orderLabel || '—'}</td>
              <td>{l.minutes}</td><td>{money((l.costCents || 0) / 100)}</td><td>{l.sentToInkFlow ? 'added' : '—'}</td></tr>
          ))}</tbody>
        </table>
      </>)}
      <h2 className="section-title">Jobs</h2>
      {!filtered.length ? <div className="empty">No usage recorded yet. It's logged when a Wide Format job finishes sending.</div> : (
        <table className="table">
          <thead><tr><th>Date</th><th>Job</th><th>Printer</th><th>Media</th><th>Length</th><th>Sq ft</th><th>Ink ml</th><th>Cost</th></tr></thead>
          <tbody>{filtered.map((r, i) => (
            <tr key={i}><td className="nowrap">{new Date(r.date).toLocaleString()}</td><td>{r.jobName}</td><td>{r.deviceName}</td><td>{r.media}</td>
              <td>{(r.lengthFt || 0).toFixed(1)} ft</td><td>{(r.mediaSqFt || 0).toFixed(1)}</td><td>{(r.inkMl || 0).toFixed(0)}</td><td>{money((r.mediaCost || 0) + (r.inkCost || 0))}</td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}
