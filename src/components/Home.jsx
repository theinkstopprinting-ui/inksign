import React, { useEffect, useState } from 'react';
import Icon from './shell/Icon.jsx';

const api = window.inksign;

// What people come to InkSign to make — each opens the right tool
const MAKE = [
  { tab: 'studio', icon: 'vinyl', title: 'Vinyl lettering & decals', text: 'Cut text, logos and shapes on the Graphtec, Titan or Kona.' },
  { tab: 'printcut', icon: 'sticker', title: 'Stickers & labels', text: 'Print, then contour-cut — Xerox sheets or HP rolls.' },
  { tab: 'wide', icon: 'banner', title: 'Banners, signs & canvas', text: 'Lay out on the HP Latex roll — nest, tile, hems, grommets.' },
  { tab: 'press', icon: 'press', title: 'Cards, flyers & booklets', text: 'Step & repeat, booklets and finishing on the Xerox.' },
];

const fmtAgo = (t) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

function StatusDot({ st }) {
  const cls = !st ? 'wait' : st.state;
  const label = !st ? 'Checking' : { ok: 'Ready', warn: 'Check', error: 'Offline', setup: 'Needs setup' }[st.state] || st.state;
  return <span className={`status-dot sd-${cls}`} title={st?.message || ''}><i />{label}</span>;
}

export default function Home({ devices, statuses, jobs, userName, go }) {
  const [history, setHistory] = useState([]);
  useEffect(() => { api.history.list().then((h) => setHistory((h || []).slice().sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0)).slice(0, 8))).catch(() => {}); }, [jobs.length]);
  const active = jobs.filter((j) => ['queued', 'sending', 'held'].includes(j.status));
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const needsSetup = devices.filter((d) => statuses[d.id]?.state === 'setup');

  return (
    <div className="home">
      <div className="home-hello">
        <h1>{hello}{userName ? `, ${userName}` : ''}</h1>
        <p className="muted">What are we making?</p>
      </div>

      <div className="make-grid">
        {MAKE.map((m) => (
          <button key={m.tab} className="make-card" onClick={() => go(m.tab)}>
            <span className="make-icon"><Icon name={m.icon} size={28} /></span>
            <span className="make-title">{m.title}</span>
            <span className="make-text">{m.text}</span>
            <span className="make-go">Start <Icon name="arrow" size={15} /></span>
          </button>
        ))}
      </div>

      {needsSetup.length > 0 && (
        <button className="home-alert" onClick={() => go('devices')}>
          <Icon name="info" /> {needsSetup.map((d) => d.name).join(', ')} {needsSetup.length === 1 ? 'needs' : 'need'} setting up — open Devices
        </button>
      )}

      <div className="home-cols">
        <section className="home-panel">
          <div className="home-panel-head"><h2>Machines</h2><button className="btn ghost small" onClick={() => go('devices')}>Manage</button></div>
          {devices.length ? devices.map((d) => (
            <div key={d.id} className="machine-row">
              <span className="machine-icon"><Icon name={d.kind === 'cutter' ? 'cutter' : d.driver === 'network-printer' ? 'press' : 'print'} /></span>
              <span className="machine-name">{d.name}<small>{statuses[d.id]?.message || ''}</small></span>
              <StatusDot st={statuses[d.id]} />
            </div>
          )) : <div className="muted">No machines yet — add them in Devices.</div>}
        </section>

        <section className="home-panel">
          <div className="home-panel-head"><h2>Right now</h2><button className="btn ghost small" onClick={() => go('queue')}>Job queue</button></div>
          {active.length ? active.slice(0, 6).map((j) => (
            <div key={j.id} className="job-row">
              <span className={`pill pill-job-${j.status}`}>{j.status === 'held' ? 'Held' : j.status === 'sending' ? 'Sending' : 'Waiting'}</span>
              <span className="job-name">{j.name}<small>{j.deviceName}</small></span>
            </div>
          )) : <div className="muted">Nothing waiting. Xerox jobs are in <button className="link" onClick={() => go('server')}>Xerox Server</button>.</div>}
          <div className="home-panel-head" style={{ marginTop: 16 }}><h2>Recently finished</h2><button className="btn ghost small" onClick={() => go('history')}>History</button></div>
          {history.length ? history.map((h) => (
            <div key={h.id} className="job-row">
              <span className={`pill ${h.status === 'error' ? 'pill-error' : 'pill-ok'}`}>{h.status === 'error' ? 'Failed' : 'Done'}</span>
              <span className="job-name">{h.name}<small>{h.deviceName} · {fmtAgo(h.finishedAt)}</small></span>
            </div>
          )) : <div className="muted">Finished jobs show up here.</div>}
        </section>
      </div>
    </div>
  );
}
