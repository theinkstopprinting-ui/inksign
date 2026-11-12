import React, { useEffect, useMemo, useState } from 'react';
import Icon from './shell/Icon.jsx';

// Job queue, one lane per machine: what's being sent now (with its picture, progress and Stop), what's
// waiting (reorder, move to another machine of the same kind, release, cancel) and what's finished
// (reprint, retry). HP printers also show what the printer itself says (asleep, printing, errors).
const api = window.inksign;
const LABEL = { cancelled: 'Cancelled', held: 'Held', queued: 'Waiting', sending: 'Sending', done: 'Done', warning: 'Check', error: 'Failed' };
const CAN_STOP = new Set(['hp-latex']); // drivers that can stop a job part way through sending
const WAITING = (s) => s === 'queued' || s === 'held';
const FINISHED = (s) => s === 'done' || s === 'warning' || s === 'error' || s === 'cancelled';
const orderOf = (j) => (Number.isFinite(j.order) ? j.order : j.createdAt);
const SHOW_FINISHED = 8;

function when(t) {
  if (!t) return '';
  const d = new Date(t);
  return d.toLocaleDateString() === new Date().toLocaleDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const inches = (v) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
function sizeText(info) {
  if (!info || !(info.wIn > 0) || !(info.hIn > 0)) return '';
  const len = info.hIn >= 48 ? `${inches(info.hIn / 12)} ft` : `${inches(info.hIn)}″`;
  return `${inches(info.wIn)}″ × ${len}${info.pages > 1 ? ` · ${info.pages} pages` : ''}`;
}

// Job pictures, fetched once each
const thumbCache = new Map();
function useThumb(name) {
  const [url, setUrl] = useState(() => (name ? thumbCache.get(name) || null : null));
  useEffect(() => {
    if (!name) { setUrl(null); return undefined; }
    if (thumbCache.has(name)) { setUrl(thumbCache.get(name)); return undefined; }
    let live = true;
    api.jobs.thumb(name).then((u) => { thumbCache.set(name, u || null); if (live) setUrl(u || null); }).catch(() => {});
    return () => { live = false; };
  }, [name]);
  return url;
}

function Thumb({ job, kind, big }) {
  const url = useThumb(job.thumb);
  return (
    <div className={`q-thumb ${big ? 'big' : ''}`}>
      {url ? <img src={url} alt="" draggable={false} />
        : <span className="q-thumb-none"><Icon name={job.action === 'test' ? 'check' : kind === 'cutter' ? 'cutter' : 'file'} size={big ? 34 : 22} stroke={1.4} /></span>}
    </div>
  );
}

const run = (fn, onErr) => async (...a) => { try { await fn(...a); } catch (e) { onErr(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); } };

function NowCard({ job, device, onErr }) {
  const pct = Number.isFinite(job.progress) ? Math.round(job.progress * 100) : null;
  const stoppable = CAN_STOP.has(device?.driver);
  return (
    <div className="q-now">
      <Thumb job={job} kind={device?.kind} big />
      <div className="q-now-main">
        <div className="q-now-tag">Sending now</div>
        <div className="q-name" title={job.name}>{job.name}</div>
        <div className="q-meta">{[sizeText(job.info), job.info?.setup].filter(Boolean).join(' · ')}</div>
        <div className="q-bar"><i style={{ width: `${pct ?? 6}%` }} className={pct == null ? 'busy' : ''} /></div>
        <div className="q-msg">{pct != null ? `${pct}% · ` : ''}{job.message}</div>
        <div className="q-actions">
          {stoppable
            ? <button className="btn small danger" disabled={job.message === 'Stopping…'} onClick={run(() => api.jobs.cancel(job.id), onErr)}>■ Stop sending</button>
            : <span className="small muted">Already going to the machine — stop it on the machine itself if needed.</span>}
        </div>
      </div>
    </div>
  );
}

function WaitCard({ job, index, count, device, targets, paused, onErr }) {
  return (
    <div className={`q-card ${job.status === 'held' ? 'held' : ''}`}>
      <div className="q-pos">{index + 1}</div>
      <Thumb job={job} kind={device?.kind} />
      <div className="q-card-main">
        <div className="q-name" title={job.name}>{job.name}</div>
        <div className="q-meta">{[sizeText(job.info), job.info?.setup].filter(Boolean).join(' · ') || ' '}</div>
        <div className="q-sub">
          <span className={`pill pill-job-${job.status}`}>{LABEL[job.status]}</span>
          <span className="muted">{job.status === 'held' ? job.message : paused ? 'Waiting — queue paused' : index === 0 ? 'Next up' : 'Waiting'}</span>
          <span className="muted">· {when(job.createdAt)}{job.user ? ` · ${job.user}` : ''}</span>
        </div>
      </div>
      <div className="q-card-side">
        {job.status === 'held' && <button className="btn primary small" onClick={run(() => api.jobs.release(job.id), onErr)}>Release</button>}
        <div className="q-order">
          <button className="btn ghost small" title="Send first" disabled={index === 0} onClick={run(() => api.jobs.move(job.id, 'top'), onErr)}>⤒</button>
          <button className="btn ghost small" title="Move up" disabled={index === 0} onClick={run(() => api.jobs.move(job.id, 'up'), onErr)}>▲</button>
          <button className="btn ghost small" title="Move down" disabled={index === count - 1} onClick={run(() => api.jobs.move(job.id, 'down'), onErr)}>▼</button>
        </div>
        {targets.length > 0 && (
          <select className="q-moveto" value="" title="Send this job to another machine of the same kind"
            onChange={run((e) => api.jobs.reassign(job.id, e.target.value), onErr)}>
            <option value="">Move to…</option>
            {targets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        )}
        <button className="btn small danger" onClick={run(() => api.jobs.cancel(job.id), onErr)}>Cancel</button>
      </div>
    </div>
  );
}

function DoneRow({ job, device, reload, onErr }) {
  const url = useThumb(job.thumb);
  return (
    <div className="q-done">
      <span className="q-mini">{url ? <img src={url} alt="" /> : <Icon name={device?.kind === 'cutter' ? 'cutter' : 'file'} size={14} />}</span>
      <span className={`pill pill-job-${job.status}`}>{LABEL[job.status] || job.status}</span>
      <span className="q-done-name" title={job.name}>{job.name}</span>
      <span className="q-done-msg" title={job.message}>{job.message}</span>
      <span className="muted nowrap">{when(job.finishedAt || job.updatedAt)}</span>
      <span className="q-done-btns">
        {(job.status === 'error' || job.status === 'warning') && <button className="btn small" onClick={run(() => api.jobs.retry(job.id), onErr)}>Retry</button>}
        {job.status !== 'error' && <button className="btn small" title="Print it again with the same settings" onClick={run(() => api.jobs.reprint(job.id), onErr)}>Reprint</button>}
        <button className="btn ghost small" title="Remove from the list" onClick={run(async () => { await api.jobs.remove(job.id); reload(); }, onErr)}>✕</button>
      </span>
    </div>
  );
}

const LIVE_TEXT = { sleep: 'Asleep', printing: 'Printing', ok: 'Ready', error: 'Needs attention', offline: 'Not answering' };

function Lane({ device, name, jobs, devices, status, live, reload, onErr, wide }) {
  const [showAll, setShowAll] = useState(false);
  const [waking, setWaking] = useState(false);
  const sending = jobs.filter((j) => j.status === 'sending');
  const waiting = jobs.filter((j) => WAITING(j.status)).sort((a, b) => orderOf(a) - orderOf(b));
  const finished = jobs.filter((j) => FINISHED(j.status)).sort((a, b) => (b.finishedAt || b.updatedAt) - (a.finishedAt || a.updatedAt));
  const paused = !!device?.state?.paused;
  const targets = device ? devices.filter((d) => d.id !== device.id && d.driver === device.driver) : [];
  const state = live?.state || (status?.state === 'ok' ? 'ok' : status?.state === 'error' ? 'offline' : status?.state || '');
  const text = live ? live.text : status?.message || '';
  const wake = run(async () => { setWaking(true); try { await api.print.wake(device.id); } finally { setWaking(false); } }, onErr);
  const idle = !jobs.length && !paused && !wide;

  return (
    <section className={`q-lane ${wide ? 'wide' : ''} ${idle ? 'idle' : ''}`}>
      <header className="q-lane-head">
        <span className={`q-dot ${state}`} />
        <div className="q-lane-title">
          <div className="q-lane-name"><Icon name={device?.kind === 'cutter' ? 'cutter' : 'print'} size={16} /> {name}</div>
          <div className="q-lane-status">
            {state && <b>{LIVE_TEXT[state] || state}</b>}
            {text && <span> · {text}</span>}
            {live?.media?.widthMm > 0 && <span> · {live.media.name || 'Media'} {inches(live.media.widthMm / 25.4)}″</span>}
            {live?.lowInk?.length > 0 && <span className="warn-text"> · Low ink: {live.lowInk.join(', ')}</span>}
          </div>
        </div>
        <div className="q-lane-btns">
          {live?.state === 'sleep' && <button className="btn small" disabled={waking} onClick={wake}>{waking ? 'Waking…' : '☀ Wake'}</button>}
          {device && <button className={`btn small ${paused ? 'primary' : ''}`} onClick={run(async () => { await api.jobs.pause(device.id, !paused); reload(); }, onErr)}
            title={paused ? 'Start sending waiting jobs again' : 'Hold the waiting jobs — the one being sent finishes'}>{paused ? '▶ Resume' : '❚❚ Pause'}</button>}
          {device && waiting.length > 1 && <button className="btn small danger" onClick={run(async () => { if (window.confirm(`Cancel all ${waiting.length} waiting jobs for ${name}?`)) await api.jobs.cancelWaiting(device.id); }, onErr)}>Cancel all</button>}
        </div>
      </header>
      {paused && <div className="q-paused">Queue paused — waiting jobs stay here until you press Resume.</div>}
      {idle ? <div className="q-idle">No jobs.</div> : (<>

      {sending.map((j) => <NowCard key={j.id} job={j} device={device} onErr={onErr} />)}

      <div className="q-sec">
        <span>Waiting</span><span className="q-count">{waiting.length}</span>
      </div>
      {waiting.length ? waiting.map((j, i) => (
        <WaitCard key={j.id} job={j} index={i} count={waiting.length} device={device} targets={targets} paused={paused} onErr={onErr} />
      )) : <div className="q-none">{sending.length ? 'Nothing else waiting.' : 'Nothing waiting — send a job from Design, Print or the cut tools.'}</div>}

      {finished.length > 0 && (
        <>
          <div className="q-sec">
            <span>Finished</span><span className="q-count">{finished.length}</span>
            <button className="btn ghost small" onClick={run(async () => { await api.jobs.clearFinished(device?.id || jobs[0].deviceId); reload(); }, onErr)}>Clear</button>
          </div>
          {(showAll ? finished : finished.slice(0, SHOW_FINISHED)).map((j) => <DoneRow key={j.id} job={j} device={device} reload={reload} onErr={onErr} />)}
          {finished.length > SHOW_FINISHED && (
            <button className="btn ghost small q-more" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : `Show all ${finished.length}`}</button>
          )}
        </>
      )}
      </>)}
    </section>
  );
}

export default function QueueView({ jobs, devices = [], statuses = {}, reload }) {
  const [pick, setPick] = useState('all');
  const [live, setLive] = useState({});
  const [err, setErr] = useState('');

  // Lanes: every printer and cutter, busiest first, plus jobs for machines that were removed
  const lanes = useMemo(() => {
    const byDev = new Map();
    for (const j of jobs) { if (!byDev.has(j.deviceId)) byDev.set(j.deviceId, []); byDev.get(j.deviceId).push(j); }
    const out = devices.filter((d) => d.kind === 'printer' || d.kind === 'cutter' || byDev.has(d.id))
      .map((d) => ({ id: d.id, device: d, name: d.name, jobs: byDev.get(d.id) || [] }));
    for (const [id, list] of byDev) if (!devices.some((d) => d.id === id)) out.push({ id, device: null, name: `${list[0].deviceName} (removed)`, jobs: list });
    const active = (l) => l.jobs.filter((j) => j.status === 'sending' || WAITING(j.status)).length;
    return out.sort((a, b) => (active(b) > 0) - (active(a) > 0) || a.name.localeCompare(b.name));
  }, [jobs, devices]);

  // What each HP says right now (without waking it), every 15 s while this page is open
  const hpIds = devices.filter((d) => d.driver === 'hp-latex' && d.config?.host).map((d) => d.id).join(',');
  useEffect(() => {
    if (!hpIds) return undefined;
    let on = true;
    const check = () => hpIds.split(',').forEach((id) => api.jobs.printerLive(id).then((st) => { if (on) setLive((x) => ({ ...x, [id]: st })); }).catch(() => {}));
    check();
    const t = setInterval(check, 15000);
    return () => { on = false; clearInterval(t); };
  }, [hpIds]);

  useEffect(() => { if (!err) return undefined; const t = setTimeout(() => setErr(''), 7000); return () => clearTimeout(t); }, [err]);
  useEffect(() => { if (pick !== 'all' && !lanes.some((l) => l.id === pick)) setPick('all'); }, [lanes, pick]);

  const counts = (l) => l.jobs.filter((j) => j.status === 'sending' || WAITING(j.status)).length;
  const shown = pick === 'all' ? lanes : lanes.filter((l) => l.id === pick);
  const anyFinished = jobs.some((j) => FINISHED(j.status));

  return (
    <div className="q-page">
      <header className="page-head">
        <div>
          <h1>Job queue</h1>
          <p className="muted">Each machine runs its own line of jobs — one at a time per machine, all machines at once.</p>
        </div>
        <button className="btn" disabled={!anyFinished} onClick={run(async () => { await api.jobs.clearFinished(); reload(); }, setErr)}>Clear all finished</button>
      </header>

      {lanes.length > 1 && (
        <div className="q-tabs">
          <button className={pick === 'all' ? 'on' : ''} onClick={() => setPick('all')}>All machines</button>
          {lanes.map((l) => (
            <button key={l.id} className={pick === l.id ? 'on' : ''} onClick={() => setPick(l.id)}>
              <span className={`q-dot small ${live[l.id]?.state || (statuses[l.id]?.state === 'ok' ? 'ok' : statuses[l.id]?.state === 'error' ? 'offline' : '')}`} />
              {l.name}{counts(l) > 0 && <span className="q-tab-n">{counts(l)}</span>}
            </button>
          ))}
        </div>
      )}
      {err && <div className="q-err">{err}</div>}
      {!lanes.length && <div className="empty">No machines yet. Add your printers and cutters on the Devices page.</div>}

      <div className={`q-lanes ${shown.length === 1 ? 'single' : ''}`}>
        {shown.map((l) => (
          <Lane key={l.id} device={l.device} name={l.name} jobs={l.jobs} devices={devices} status={statuses[l.id]} live={live[l.id]}
            reload={reload} onErr={setErr} wide={shown.length === 1} />
        ))}
      </div>
    </div>
  );
}
