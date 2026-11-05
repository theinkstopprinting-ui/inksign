import React from 'react';

const api = window.inksign;
const LABEL = { cancelled: 'Cancelled', held: 'Held', queued: 'Waiting', sending: 'Sending', done: 'Done', warning: 'Check', error: 'Failed' };

function fmt(t) {
  const d = new Date(t);
  return d.toLocaleDateString() === new Date().toLocaleDateString() ? d.toLocaleTimeString() : d.toLocaleString();
}

export default function QueueView({ jobs, reload }) {
  const list = [...jobs].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div>
      <header className="page-head">
        <div>
          <h1>Job queue</h1>
          <p className="muted">Jobs to the same machine go one at a time. Different machines run side by side.</p>
        </div>
        <button className="btn" onClick={async () => { await api.jobs.clearFinished(); reload(); }}>Clear finished</button>
      </header>
      {!list.length && <div className="empty">No jobs yet. Send a test from the Devices page.</div>}
      {!!list.length && (
        <table className="table">
          <thead><tr><th>Status</th><th>Job</th><th>Device</th><th>Sent</th><th>Details</th><th /></tr></thead>
          <tbody>
            {list.map((j) => (
              <tr key={j.id}>
                <td><span className={`pill pill-job-${j.status}`}>{LABEL[j.status] || j.status}</span></td>
                <td>{j.name}</td>
                <td>{j.deviceName}</td>
                <td className="nowrap">{fmt(j.createdAt)}</td>
                <td className="msg">{j.message}</td>
                <td className="nowrap">
                  {j.status === 'held' && <button className="btn primary small" onClick={() => api.jobs.release(j.id)}>Release</button>}
                  {(j.status === 'error' || j.status === 'warning') && (
                    <button className="btn small" onClick={() => api.jobs.retry(j.id)}>Retry</button>
                  )}
                  {j.status !== 'sending' && (
                    <button className="btn ghost small" onClick={async () => { await api.jobs.remove(j.id); reload(); }}>✕</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
