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
import JobCenter from './components/server/JobCenter.jsx';
import Home from './components/Home.jsx';
import Icon from './components/shell/Icon.jsx';

const api = window.inksign;

// Menu, grouped by what you're doing. [id, label, icon, what it's for]
const NAV = [
  { items: [['home', 'Home', 'home', 'Start here — pick what you are making']] },
  { title: 'Make', items: [
    ['studio', 'Vinyl (Cut Studio)', 'vinyl', 'Cut lettering, logos and decals'],
    ['printcut', 'Print & Cut', 'sticker', 'Stickers and labels: print, then contour-cut'],
    ['wide', 'Wide Format (HP)', 'banner', 'Banners, signs and canvas on the HP Latex'],
    ['press', 'Press (Xerox)', 'press', 'Cards, flyers and booklets on the Xerox'],
  ] },
  { title: 'Run', items: [
    ['server', 'Xerox Server', 'server', 'Held, printing and printed Xerox jobs'],
    ['queue', 'Job queue', 'queue', 'Cutter and HP jobs waiting or sending'],
    ['history', 'History', 'history', 'Finished jobs — reprint from here'],
  ] },
  { title: 'Shop', items: [
    ['orders', 'Orders', 'orders', 'InkFlow orders and artwork'],
    ['inventory', 'Rolls & stock', 'stock', 'Vinyl and media rolls'],
    ['mockup', 'Mockup', 'mockup', 'Show the customer how it will look'],
    ['usage', 'Usage & costs', 'usage', 'Media, ink and time per job'],
  ] },
  { title: 'Set up', items: [
    ['devices', 'Devices', 'devices', 'Cutters and printers'],
    ['color', 'Color', 'color', 'ICC profiles and colors'],
    ['settings', 'Settings', 'settings', 'Shop, InkFlow, users, updates'],
  ] },
];
const LABEL = Object.fromEntries(NAV.flatMap((g) => g.items.map(([id, label, , help]) => [id, { label, help }])));
const FULL = ['studio', 'printcut', 'press', 'wide', 'mockup'];
const NARROW_KEY = 'inksign.navNarrow';

export default function App() {
  const [tab, setTab] = useState('home');
  const [statuses, setStatuses] = useState({});
  const [narrow, setNarrow] = useState(() => { try { return window.localStorage.getItem(NARROW_KEY) === '1'; } catch { return false; } });
  const toggleNarrow = () => setNarrow((n) => { try { window.localStorage.setItem(NARROW_KEY, n ? '0' : '1'); } catch { /* not saved */ } return !n; });
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

  // Machine status for the top bar and Home (every minute)
  useEffect(() => {
    if (!devices.length) return undefined;
    let live = true;
    const check = () => devices.forEach((d) => api.devices.status(d.id).then((st) => { if (live) setStatuses((x) => ({ ...x, [d.id]: st })); }).catch(() => {}));
    check();
    const t = setInterval(check, 60000);
    return () => { live = false; clearInterval(t); };
  }, [devices.map((d) => `${d.id}:${JSON.stringify(d.config || {})}`).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

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
      <aside className={`sidebar ${narrow ? 'narrow' : ''}`}>
        <div className="brand">
          <span className="logo">◆</span><span className="brand-name">InkSign</span>
          <button className="nav-toggle" title={narrow ? 'Show menu names' : 'Make the menu narrow'} onClick={toggleNarrow}>{narrow ? '»' : '«'}</button>
        </div>
        <nav>
          {NAV.map((g, gi) => (
            <div key={gi} className="nav-group">
              {g.title && <div className="nav-title">{g.title}</div>}
              {g.items.map(([id, label, icon, help]) => (
                <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)} title={narrow ? `${label} — ${help}` : help}>
                  <Icon name={icon} />
                  <span className="nav-label">{label}</span>
                  {id === 'queue' && active > 0 && <span className="badge">{active}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <TimerWidget notice={notice} />
        <div className="sidebar-foot">
          {userState.current && (
            <div className="row small" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span className="nav-label">{userState.current.name}{owner ? '' : ' (staff)'}</span>
              {userState.required && <button className="btn ghost small" onClick={signOut}>Sign out</button>}
            </div>
          )}
          {update && (update.status === 'available' || update.status === 'ready' || update.status === 'downloading') ? (
            <button className="update-pill" onClick={() => setTab('settings')}>{update.message}</button>
          ) : (
            <div className="muted small nav-label">The Ink Stop · v{update?.version || ''}</div>
          )}
        </div>
      </aside>
      <div className="main-col">
        <header className="topbar">
          <div className="topbar-title"><b>{LABEL[tab]?.label}</b><span className="muted">{LABEL[tab]?.help}</span></div>
          <div className="topbar-machines">
            {devices.map((d) => {
              const st = statuses[d.id];
              return (
                <button key={d.id} className={`mchip sd-${st ? st.state : 'wait'}`} title={`${d.name}: ${st?.message || 'checking…'}`} onClick={() => setTab('devices')}>
                  <i />{d.name}
                </button>
              );
            })}
          </div>
        </header>
      <main key={reloadKey} className={`content ${FULL.includes(tab) ? 'content-full' : ''}`}>
        {tab === 'home' && <Home devices={devices} statuses={statuses} jobs={jobs} userName={userState.current?.name} go={setTab} />}
        {/* The four tools stay mounted so work isn't lost when you switch pages */}
        <div style={{ display: tab === 'studio' ? 'contents' : 'none' }}><CutStudio devices={devices} jobs={jobs} incoming={incoming} onJobsSent={() => setTab('queue')} /></div>
        <div style={{ display: tab === 'printcut' ? 'contents' : 'none' }}><PrintCut devices={devices} incoming={incoming} onDevicesChanged={reloadDevices} /></div>
        <div style={{ display: tab === 'wide' ? 'contents' : 'none' }}><WideFormat devices={devices} incoming={incoming} onJobsSent={() => setTab('queue')} /></div>
        <div style={{ display: tab === 'press' ? 'contents' : 'none' }}><Press devices={devices} incoming={incoming} onJobsSent={() => setTab('queue')} onServerSent={() => setTab('server')} /></div>
        <div style={{ display: tab === 'mockup' ? 'contents' : 'none' }}><Mockup /></div>
        {tab === 'orders' && <Orders openIn={openIn} focusOrder={focusOrder} goSettings={() => setTab('settings')} />}
        {tab === 'devices' && (
          <DevicesView catalog={catalog} devices={devices} reload={reloadDevices} jobs={jobs}
            onJobsSent={() => setTab('queue')} owner={owner} />
        )}
        {tab === 'server' && <JobCenter owner={owner} active />}
        {tab === 'history' && <HistoryPage devices={devices} onJobsSent={() => setTab('queue')} />}
        {tab === 'inventory' && <InventoryPage />}
        {tab === 'queue' && <QueueView jobs={jobs} reload={reloadJobs} />}
        {tab === 'usage' && <Usage jobs={jobs} />}
        {tab === 'color' && <ColorPage devices={devices} />}
        {tab === 'settings' && (owner ? <Settings devices={devices} onUsersChanged={loadUsers} />
          : <div className="card"><h2 className="card-title">Settings</h2><p className="muted">Only an owner can change settings. Sign out and sign in as an owner.</p></div>)}
      </main>
      </div>
      <div className="toasts">
        {notices.map((n) => (
          <div key={n.id} className="toast" onClick={() => setNotices((x) => x.filter((y) => y.id !== n.id))}>{n.text}</div>
        ))}
      </div>
    </div>
  );
}
