import React, { useEffect, useState } from 'react';
import { gatherLocal, putLocal } from '../lib/localPresets.js';

const api = window.inksign;
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Settings › Backup: one file with all of InkSign's setup, saved to a folder (Nextcloud) by hand or daily.
export default function BackupCard() {
  const [st, setSt] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => setSt(await api.backup.state());
  useEffect(() => { load(); }, []);
  if (!st) return null;
  const saveCfg = async (patch) => { await api.settings.save({ backup: { folder: st.folder, auto: st.auto, ...patch } }); await load(); };
  const pick = async () => { const f = await api.backup.pickFolder(); if (f) await saveCfg({ folder: f }); };
  const now = async () => {
    setBusy(true); setMsg('');
    try { const f = await api.backup.now(gatherLocal()); setMsg(`Backed up to ${f}`); await load(); } catch (e) { setMsg(clean(e.message)); }
    setBusy(false);
  };
  const restore = async () => {
    if (!window.confirm('Restore replaces this PC\'s settings, devices, presets and history with the ones in the backup. The current files are kept as .before-restore. Go on?')) return;
    setBusy(true); setMsg('');
    try {
      const r = await api.backup.restore();
      if (r) { const n = putLocal(r.localStore); setMsg(`Restored ${r.files} files and ${n} presets from ${r.host || 'a backup'} (${new Date(r.at).toLocaleString()}). Restarting the screen…`); setTimeout(() => window.location.reload(), 1800); }
    } catch (e) { setMsg(clean(e.message)); }
    setBusy(false);
  };
  return (
    <section className="card">
      <h2 className="card-title">Backup</h2>
      <p className="muted small">Settings, devices and cutter corrections, materials and pricing, media presets, cut presets, saved barcode jobs, ICC profiles, the maintenance log and history — in one file. Put it in your Nextcloud folder and it's off this PC.</p>
      <div className="row" style={{ flexWrap: 'wrap', marginTop: 6 }}>
        <button className="btn" onClick={pick}>{st.folder ? 'Change folder…' : 'Pick the backup folder…'}</button>
        <span className="muted small">{st.folder || 'No folder picked yet'}</span>
      </div>
      <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={st.auto} disabled={!st.folder} onChange={(e) => saveCfg({ auto: e.target.checked })} /> Back up by itself once a day (keeps the last 14)</label>
      <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy || !st.folder} onClick={now}>Back up now</button>
        <button className="btn" disabled={busy} onClick={restore}>Restore from a backup…</button>
        <span className="muted small">{st.last ? `Last backup ${new Date(st.last.at).toLocaleString()}` : 'No backup yet'}</span>
      </div>
      {msg && <p className="small" style={{ marginTop: 6 }}>{msg}</p>}
    </section>
  );
}
