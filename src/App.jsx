import React, { useCallback, useEffect, useState } from 'react';
import DevicesView from './components/DevicesView.jsx';
import QueueView from './components/QueueView.jsx';
import CutStudio from './components/CutStudio.jsx';
import PrintCut from './components/PrintCut.jsx';
import Press from './components/Press.jsx';
import WideFormat from './components/WideFormat.jsx';
import Usage from './components/Usage.jsx';
import Orders from './components/Orders.jsx';
import Settings from './components/Settings.jsx';
import Mockup from './components/Mockup.jsx';
import ColorPage from './components/ColorPage.jsx';
import LoginScreen from './components/LoginScreen.jsx';
import TimerWidget from './components/TimerWidget.jsx';
import HistoryPage from './components/HistoryPage.jsx';
import InventoryPage from './components/InventoryPage.jsx';

const api = window.inksign;

const NAV = [
  ['orders', 'Orders'],
  ['studio', 'Cut Studio'],
  ['printcut', 'Print & Cut'],
  ['wide', 'Wide Format (HP)'],
  ['press', 'Press (Xerox)'],
  ['mockup', 'Mockup'],
  ['color', 'Color'],
  ['devices', 'Devices'],
  ['queue', 'Job queue'],
  ['history', 'History'],
  ['inventory', 'Rolls & stock'],
  ['usage', 'Usage'],
  ['settings', 'Settings'],
];
const FULL = ['studio', 'printcut', 'press', 'wide', 'mockup'];

export default function App() {
  const [tab, setTab] = useState('studio');
  const [catalog, setCatalog] = useState(null);
  const [devices, setDevices] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [incoming, setIncoming] = useState(null);
  const [focusOrder, setFocusOrder] = useState(null);
  const [notices, setNotices] = useState([]);
  const [update, setUpdate] = useState(null);
  const [userState, setUserState] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const loadUsers = useCallback(async () => setUserState(await api.users.state()), []);

  const reloadDevices = useCallback(async () => setDevices(await api.devices.list()), []);

  const notice = useCallback((text) => {
    const id = Date.now() + Math.random();
    setNotices((n) => [...n.slice(-3), { id, text }]);
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 9000);
  }, []);

  useEffect(() => {
    (async () => {
      setCatalog(await api.catalog());
      await reloadDevices();
      setJobs(await api.jobs.list());
      setUpdate(await api.updates.state());
      await loadUsers();
    })();
    const offJobs = api.jobs.onUpdate((job) =>
      setJobs((prev) => {
        const i = prev.findIndex((j) => j.id === job.id);
        if (i < 0) return [...prev, job];
        const next = prev.slice(); next[i] = job; return next;
      }));
    const offNotice = api.onNotice(notice);
    // inksign://order/<id> links from InkFlow
    const offOpen = api.inkflow.onOpen((id) => { setFocusOrder(id ? { id, seq: Date.now() } : null); setTab('orders'); });
    const offUpd = api.updates.onState(setUpdate);
    const offDev = api.devices.onUpdate((d) => setDevices((list) => list.map((x) => (x.id === d.id ? d : x))));
    // Shared setup pulled from the main PC: refresh machines and remount the tools with the new settings
    const offReload = api.onReload(async () => { await reloadDevices(); setReloadKey((k) => k + 1); notice('Loaded the shared shop setup.'); });
    return () => { offJobs(); offNotice(); offOpen(); offUpd(); offDev(); offReload(); };
  }, [reloadDevices, notice, loadUsers]);

  const reloadJobs = async () => setJobs(await api.jobs.list());
  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'sending' || j.status === 'held').length;

  // Orders page hands artwork to a tool
  const openIn = (target, payload) => {
    setIncoming({ ...payload, target, label: `${payload.order?.number || ''}`, seq: Date.now() });
    setTab(target);
  };

  if (!catalog || !userState) return <div className="loading">Starting InkSign…</div>;
  if (userState.required && !userState.current) return <LoginScreen users={userState.users} onIn={() => loadUsers()} />;
  const owner = !userState.required || userState.current?.role === 'owner';
  const signOut = async () => { await api.users.logout(); await loadUsers(); };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><span className="logo">◆</span> InkSign<small>v{update?.version || ''}</small></div>
        <nav>
          {NAV.map(([id, label]) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              {label}
              {id === 'queue' && active > 0 && <span className="badge">{active}</span>}
            </button>
          ))}
        </nav>
        <TimerWidget notice={notice} />
        <div className="sidebar-foot">
          {userState.current && (
            <div className="row small" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span>{userState.current.name}{owner ? '' : ' (staff)'}</span>
              {userState.required && <button className="btn ghost small" onClick={signOut}>Sign out</button>}
            </div>
          )}
          {update && (update.status === 'available' || update.status === 'ready' || update.status === 'downloading') ? (
            <button className="update-pill" onClick={() => setTab('settings')}>{update.message}</button>
          ) : (
            <div className="muted small">The Ink Stop</div>
          )}
        </div>
      </aside>
      <main key={reloadKey} className={`content ${FULL.includes(tab) ? 'content-full' : ''}`}>
        {/* The four tools stay mounted so work isn't lost when you switch pages */}
        <div style={{ display: tab === 'studio' ? 'contents' : 'none' }}><CutStudio devices={devices} jobs={jobs} incoming={incoming} onJobsSent={() => setTab('queue')} /></div>
        <div style={{ display: tab === 'printcut' ? 'contents' : 'none' }}><PrintCut devices={devices} incoming={incoming} onDevicesChanged={reloadDevices} /></div>
        <div style={{ display: tab === 'wide' ? 'contents' : 'none' }}><WideFormat devices={devices} incoming={incoming} onJobsSent={() => setTab('queue')} /></div>
        <div style={{ display: tab === 'press' ? 'contents' : 'none' }}><Press devices={devices} incoming={incoming} onJobsSent={() => setTab('queue')} /></div>
        <div style={{ display: tab === 'mockup' ? 'contents' : 'none' }}><Mockup /></div>
        {tab === 'orders' && <Orders openIn={openIn} focusOrder={focusOrder} goSettings={() => setTab('settings')} />}
        {tab === 'devices' && (
          <DevicesView catalog={catalog} devices={devices} reload={reloadDevices} jobs={jobs}
            onJobsSent={() => setTab('queue')} owner={owner} />
        )}
        {tab === 'history' && <HistoryPage devices={devices} onJobsSent={() => setTab('queue')} />}
        {tab === 'inventory' && <InventoryPage />}
        {tab === 'queue' && <QueueView jobs={jobs} reload={reloadJobs} />}
        {tab === 'usage' && <Usage jobs={jobs} />}
        {tab === 'color' && <ColorPage devices={devices} />}
        {tab === 'settings' && (owner ? <Settings devices={devices} onUsersChanged={loadUsers} />
          : <div className="card"><h2 className="card-title">Settings</h2><p className="muted">Only an owner can change settings. Sign out and sign in as an owner.</p></div>)}
      </main>
      <div className="toasts">
        {notices.map((n) => (
          <div key={n.id} className="toast" onClick={() => setNotices((x) => x.filter((y) => y.id !== n.id))}>{n.text}</div>
        ))}
      </div>
    </div>
  );
}
