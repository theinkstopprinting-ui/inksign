import React, { useEffect, useState } from 'react';

const api = window.inksign;
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Settings sections for the shop: people & sign-in, phone view, shared setup, job files.
export default function ShopSettings({ s, setS, onUsersChanged }) {
  const [u, setU] = useState(null);
  const [userList, setUserList] = useState([]);
  const [requireLogin, setRequireLogin] = useState(false);
  const [msg, setMsg] = useState('');
  const [addrs, setAddrs] = useState([]);
  const [sharedMsg, setSharedMsg] = useState('');
  useEffect(() => { api.users.state().then((st) => { setU(st); setUserList(st.users.map((x) => ({ ...x, newPin: '' }))); setRequireLogin(st.required); }); api.phone.addresses().then(setAddrs); }, []);
  const saveUsers = async () => {
    setMsg('');
    try { const r = await api.users.save(userList.map((x) => ({ id: x.id, name: x.name, role: x.role, newPin: x.newPin || undefined })), requireLogin); setUserList(r.users.map((x) => ({ ...x, newPin: '' }))); setRequireLogin(r.requireLogin); setMsg('Saved.'); onUsersChanged && onUsersChanged(); }
    catch (e) { setMsg(clean(e.message)); }
  };
  const ph = s.phone || {}, sh = s.shared || {};
  const setPh = (p) => setS({ ...s, phone: { ...ph, ...p } });
  const setSh = (p) => setS({ ...s, shared: { ...sh, ...p } });
  return (<>
    <section className="card">
      <h2 className="card-title">People & sign-in</h2>
      <p className="muted small">Each person gets a PIN. Jobs, timers and maintenance show who did them. With sign-in on, only owners can change settings, devices, cutter calibration, pricing and color profiles.</p>
      {userList.map((x, i) => (
        <div key={x.id || i} className="wf-row">
          <input type="text" value={x.name} placeholder="Name" onChange={(e) => setUserList((l) => l.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} />
          <select value={x.role} onChange={(e) => setUserList((l) => l.map((y, j) => (j === i ? { ...y, role: e.target.value } : y)))}><option value="owner">Owner</option><option value="staff">Staff</option></select>
          <input type="password" inputMode="numeric" style={{ width: 130, flex: 'none', minWidth: 0 }} placeholder={x.id ? 'New PIN (blank = keep)' : 'PIN (4–8 digits)'} value={x.newPin} onChange={(e) => setUserList((l) => l.map((y, j) => (j === i ? { ...y, newPin: e.target.value.replace(/\D/g, '').slice(0, 8) } : y)))} />
          <button className="btn ghost small" onClick={() => setUserList((l) => l.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div className="row">
        <button className="btn small" onClick={() => setUserList((l) => [...l, { name: '', role: l.length ? 'staff' : 'owner', newPin: '' }])}>+ Add person</button>
        <label className="check"><input type="checkbox" checked={requireLogin} onChange={(e) => setRequireLogin(e.target.checked)} /> Ask who's using InkSign when it opens</label>
        <button className="btn small primary" onClick={saveUsers}>Save people</button>
        <span className="muted small">{msg}{u?.current ? ` Signed in: ${u.current.name}` : ''}</span>
      </div>
    </section>

    <section className="card">
      <h2 className="card-title">Phone view</h2>
      <p className="muted small">See the job queue and release held jobs from a phone on the shop Wi-Fi. Sign in with a person's PIN (or the phone PIN below if no people are set up). Windows may ask to allow InkSign through the firewall the first time — allow it on private networks.</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="check"><input type="checkbox" checked={!!ph.enabled} onChange={(e) => setPh({ enabled: e.target.checked })} /> Turn on</label>
        <label className="mini-field" style={{ width: 110 }}><span>Port</span><input type="number" value={ph.port || 4848} onChange={(e) => setPh({ port: Number(e.target.value) || 4848 })} /></label>
        <label className="mini-field" style={{ width: 160 }}><span>Phone PIN (if no people)</span><input type="password" inputMode="numeric" value={ph.pin || ''} onChange={(e) => setPh({ pin: e.target.value.replace(/\D/g, '').slice(0, 8) })} /></label>
      </div>
      {ph.enabled && <div className="help">Save settings, then open {addrs.length ? addrs.map((a) => <code key={a} style={{ marginRight: 6 }}>{a}</code>) : 'this PC\'s address on port ' + (ph.port || 4848)} on the phone.</div>}
    </section>

    <section className="card">
      <h2 className="card-title">Shared setup (all shop PCs)</h2>
      <p className="muted small">Keeps materials, pricing, colors, media, color profiles, the clip-art library and the machine list the same on every PC, through a shared folder (a network share or a Nextcloud-synced folder). Each PC keeps its own USB/COM connection to the cutters.</p>
      <div className="wf-row">
        <input type="text" value={sh.folder || ''} placeholder="Shared folder, e.g. \\\\SERVER\\InkSign or C:\\Users\\…\\Nextcloud\\InkSign" onChange={(e) => setSh({ folder: e.target.value })} />
        <button className="btn small" onClick={async () => { const f = await api.system.pickFolder(); if (f) setSh({ folder: f }); }}>Browse…</button>
        <select value={sh.mode || 'off'} onChange={(e) => setSh({ mode: e.target.value })}>
          <option value="off">Off</option><option value="publish">This is the main PC (publishes changes)</option><option value="follow">Follow the main PC (checks every 5 min)</option>
        </select>
      </div>
      <div className="row">
        <button className="btn small" disabled={!sh.folder} onClick={async () => { setSharedMsg(''); try { const m = await api.shared.publish(); setSharedMsg(`Published ${new Date(m.updatedAt).toLocaleString()}.`); } catch (e) { setSharedMsg(clean(e.message)); } }}>Publish now</button>
        <button className="btn small" disabled={!sh.folder} onClick={async () => { setSharedMsg(''); try { const r = await api.shared.pull(); setSharedMsg(`Loaded the setup from ${r.manifest.by} (${new Date(r.manifest.updatedAt).toLocaleString()}).`); } catch (e) { setSharedMsg(clean(e.message)); } }}>Load from shared folder now</button>
        <span className="muted small">{sharedMsg || (sh.lastSync ? `Last sync ${new Date(sh.lastSync).toLocaleString()}` : '')}</span>
      </div>
    </section>

    <section className="card">
      <h2 className="card-title">Job files</h2>
      <div className="row"><label className="mini-field" style={{ width: 220 }}><span>Keep print/cut files for (days)</span><input type="number" value={s.keepJobsDays || 90} onChange={(e) => setS({ ...s, keepJobsDays: Math.max(7, Number(e.target.value) || 90) })} /></label>
        <span className="muted small">Older files are cleaned up at start-up; the history keeps the record (reprint needs the file).</span></div>
    </section>
  </>);
}
