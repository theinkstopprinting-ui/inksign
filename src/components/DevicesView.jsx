import React, { useEffect, useState } from 'react';
import DeviceEditor from './DeviceEditor.jsx';
import CutterControl from './CutterControl.jsx';
import MaintenancePanel from './MaintenancePanel.jsx';
import FlexiCapture from './FlexiCapture.jsx';

const api = window.inksign;

function StatusPill({ status }) {
  if (!status) return <span className="pill pill-wait">Checking…</span>;
  const label = { ok: 'Ready', warn: 'Check', error: 'Offline', setup: 'Needs setup' }[status.state] || status.state;
  return <span className={`pill pill-${status.state}`} title={status.message}>{label}</span>;
}

export default function DevicesView({ catalog, devices, reload, jobs, onJobsSent, owner = true }) {
  const [learning, setLearning] = useState(false);
  const [statuses, setStatuses] = useState({});
  const [editing, setEditing] = useState(null); // device object, or {} for new
  const [controlId, setControlId] = useState(null);

  const checkAll = async () => {
    setStatuses({});
    const entries = await Promise.all(devices.map(async (d) => [d.id, await api.devices.status(d.id)]));
    setStatuses(Object.fromEntries(entries));
  };
  useEffect(() => { checkAll(); }, [devices]);

  const presetName = (id) => catalog.presets.find((p) => p.id === id)?.name || id;
  const lastJob = (id) => [...jobs].reverse().find((j) => j.deviceId === id);

  const groups = [['cutter', 'Cutters'], ['printer', 'Printers']];

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>Devices</h1>
          <p className="muted">Hook each machine up once, then send a test to make sure it answers.</p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setLearning(true)}>Learn from Flexi…</button>
          <button className="btn" onClick={checkAll}>Refresh status</button>
          {owner && <button className="btn primary" onClick={() => setEditing({})}>+ Add device</button>}
        </div>
      </header>

      {groups.map(([kind, title]) => {
        const list = devices.filter((d) => d.kind === kind);
        if (!list.length) return null;
        return (
          <section key={kind}>
            <h2 className="section-title">{title}</h2>
            <div className="grid">
              {list.map((d) => {
                const st = statuses[d.id];
                const lj = lastJob(d.id);
                return (
                  <div className="card" key={d.id}>
                    <div className="card-top">
                      <div>
                        <div className="card-title">{d.name}</div>
                        <div className="muted small">{presetName(d.presetId)}</div>
                      </div>
                      <StatusPill status={st} />
                    </div>
                    <div className="card-msg small">{st?.message || '…'}</div>
                    {lj && <div className={`card-last small st-${lj.status}`}>Last job: {lj.name} — {lj.status}</div>}
                    <div className="card-actions">
                      <button className="btn" disabled={st?.state === 'setup'}
                        onClick={async () => { await api.jobs.sendTest(d.id); onJobsSent(); }}>
                        {kind === 'cutter' ? 'Test cut' : 'Test print'}
                      </button>
                      <button className="btn" disabled={st?.state === 'setup'}
                        onClick={async () => { const r = await api.jobs.sendFile(d.id); if (r.length) onJobsSent(); }}>
                        Send file…
                      </button>
                      {kind === 'cutter' && <button className="btn ghost" onClick={() => setControlId(controlId === d.id ? null : d.id)}>{controlId === d.id ? 'Hide controls' : 'Controls'}</button>}
                      {owner && <button className="btn ghost" onClick={() => setEditing(d)}>Settings</button>}
                    </div>
                    {controlId === d.id && <CutterControl cutter={d} jobs={jobs} />}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      <details className="maint-wrap">
        <summary>Maintenance — blades, cleaning, printheads</summary>
        <MaintenancePanel owner={owner} />
      </details>
      {learning && <FlexiCapture devices={devices} onClose={() => setLearning(false)} />}

      {editing && (
        <DeviceEditor catalog={catalog} device={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }} />
      )}
    </div>
  );
}
