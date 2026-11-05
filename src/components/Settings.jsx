import React, { useEffect, useState } from 'react';
import ShopSettings from './ShopSettings.jsx';

const api = window.inksign;
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export default function Settings({ devices, onUsersChanged }) {
  const [s, setS] = useState(null);
  const [testMsg, setTestMsg] = useState('');
  const [saved, setSaved] = useState('');
  const [upd, setUpd] = useState(null);
  const [showSecret, setShowSecret] = useState(false);

  useEffect(() => {
    api.settings.get().then(setS);
    api.updates.state().then(setUpd);
    return api.updates.onState(setUpd);
  }, []);
  if (!s) return null;

  const ifl = s.inkflow || {};
  const setIfl = (patch) => setS({ ...s, inkflow: { ...ifl, ...patch } });
  const wf = s.watchFolders || [];
  const setWf = (list) => setS({ ...s, watchFolders: list });
  const save = async () => {
    try {
      const r = await api.settings.save({ inkflow: s.inkflow, updateUrl: s.updateUrl, watchFolders: s.watchFolders, phone: s.phone, shared: s.shared, keepJobsDays: s.keepJobsDays });
      setS(r); setSaved('Saved.'); setTimeout(() => setSaved(''), 2000);
    } catch (e) { setSaved(clean(e.message)); }
  };
  const deviceById = Object.fromEntries(devices.map((d) => [d.id, d]));

  return (
    <div className="settings-page">
      <header className="page-head">
        <div><h1>Settings</h1><p className="muted">InkFlow link, watch folders and updates.</p></div>
        <div className="row">{saved && <span className="muted small">{saved}</span>}<button className="btn primary" onClick={save}>Save settings</button></div>
      </header>

      <section className="card">
        <h2 className="card-title">InkFlow</h2>
        <p className="muted small">
          Pulls orders in production (with their artwork) from InkFlow, and marks each item printed / cut on the order when InkSign finishes it —
          with the media cost added to the order's costs. Connects the same way as InkRIP: one shared secret on both sides.
        </p>
        <div className="form">
          <div className="field"><label>InkFlow address</label><input type="text" placeholder="https://inkflow.up.railway.app" value={ifl.url || ''} onChange={(e) => setIfl({ url: e.target.value.trim() })} /></div>
          <div className="field">
            <label>Shared secret</label>
            <div className="row">
              <input type={showSecret ? 'text' : 'password'} value={ifl.secret || ''} onChange={(e) => setIfl({ secret: e.target.value.trim() })} />
              <button className="btn ghost small" onClick={() => setShowSecret((v) => !v)}>{showSecret ? 'Hide' : 'Show'}</button>
            </div>
            <div className="help">Railway → InkFlow → Variables → <b>INKSIGN_SHARED_SECRET</b> (paste the same long string here).</div>
          </div>
        </div>
        <label className="check" style={{ marginTop: 10 }}><input type="checkbox" checked={ifl.autoReport !== false} onChange={(e) => setIfl({ autoReport: e.target.checked })} /> Mark items printed / cut in InkFlow automatically when the job finishes</label>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={async () => { setTestMsg('Testing…'); try { setTestMsg(await api.inkflow.test(ifl)); } catch (e) { setTestMsg(clean(e.message)); } }}>Test connection</button>
          <span className="muted small">{testMsg}</span>
        </div>
        <p className="help">The <b>Open in InkSign</b> button on an InkFlow order jumps straight to that order here (on a computer with InkSign installed).</p>
      </section>

      <section className="card">
        <h2 className="card-title">Watch folders</h2>
        <p className="muted small">Drop a file in a folder and InkSign sends it to a machine, then moves it to a "Done" folder inside (or "Errors" if the machine can't take it). Good for print-ready PDFs from other computers or designers.</p>
        {wf.map((w, i) => {
          const d = deviceById[w.deviceId];
          const upd8 = (patch) => setWf(wf.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          return (
            <div className="wf-row" key={w.id}>
              <label className="check" title="On / off"><input type="checkbox" checked={!!w.enabled} onChange={(e) => upd8({ enabled: e.target.checked })} /></label>
              <input type="text" value={w.folder} placeholder="Folder, e.g. \\SERVER\Print\Xerox" onChange={(e) => upd8({ folder: e.target.value })} />
              <button className="btn small" onClick={async () => { const f = await api.system.pickFolder(); if (f) upd8({ folder: f }); }}>Browse…</button>
              <span className="muted small">→</span>
              <select value={w.deviceId} onChange={(e) => upd8({ deviceId: e.target.value, options: {} })}>
                <option value="">Choose machine…</option>
                {devices.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              {d?.driver === 'flexi-hotfolder' && (
                <select value={w.options?.media || ''} onChange={(e) => upd8({ options: { ...w.options, media: e.target.value } })}>
                  <option value="">Main hot folder</option>{(s.wideMedia || []).map((m) => <option key={m.name}>{m.name}</option>)}
                </select>
              )}
              {d?.driver === 'network-printer' && (
                <>
                  <select value={w.options?.duplex || 'none'} onChange={(e) => upd8({ options: { ...w.options, duplex: e.target.value } })}>
                    <option value="none">1-sided</option><option value="long">2-sided long edge</option><option value="short">2-sided short edge</option>
                  </select>
                  <label className="check small"><input type="checkbox" checked={!!w.hold} onChange={(e) => upd8({ hold: e.target.checked })} /> Hold</label>
                </>
              )}
              <button className="btn ghost small" onClick={() => setWf(wf.filter((_, j) => j !== i))}>✕</button>
            </div>
          );
        })}
        <button className="btn small" onClick={() => setWf([...wf, { id: `w${Date.now()}`, folder: '', deviceId: '', enabled: true, options: {} }])}>+ Add watch folder</button>
        <p className="help">Save settings to start watching. Files are picked up once they stop growing, so big copies over the network are safe.</p>
      </section>

      <ShopSettings s={s} setS={setS} onUsersChanged={onUsersChanged} />

      <section className="card">
        <h2 className="card-title">Updates</h2>
        <p className="muted small">
          With InkFlow connected, InkSign checks it every few hours for a newer version (post new versions on InkFlow → <b>Shop apps → InkSign</b>).
          Installing a new version over the old one keeps all devices, jobs and settings.
        </p>
        <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
          <button className="btn" onClick={async () => { await save(); setUpd(await api.updates.check()); }}>Check now</button>
          {upd?.status === 'available' && <button className="btn primary" onClick={() => api.updates.install()}>Download InkSign {upd.newVersion}</button>}
          {upd?.status === 'ready' && <button className="btn primary" onClick={() => api.updates.install()}>Restart to update</button>}
          <span className="muted small">You have version {upd?.version}{upd?.message ? ` · ${upd.message}` : ''}</span>
        </div>
        {upd?.notes && <p className="help" style={{ whiteSpace: 'pre-line' }}>{upd.notes}</p>}
        <details style={{ marginTop: 12 }}>
          <summary className="muted small">Fully automatic updates (optional)</summary>
          <p className="help">Point this at a web folder holding <code>latest.yml</code> and the installer from a new build, and InkSign will download and install updates by itself.</p>
          <div className="field"><input type="text" placeholder="https://files.example.com/inksign" value={s.updateUrl || ''} onChange={(e) => setS({ ...s, updateUrl: e.target.value.trim() })} /></div>
        </details>
      </section>
    </div>
  );
}
