import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JobProperties from './JobProperties.jsx';
import SheetPreview from './SheetPreview.jsx';
import PaperCatalog from './PaperCatalog.jsx';
import ServerSetup from './ServerSetup.jsx';
import { cleanErr, fmtDate, STATUS } from './common.js';

const api = window.inksign;
const QUEUES = [
  ['printing', 'Printing'],
  ['held', 'Held'],
  ['printed', 'Printed'],
  ['all', 'All jobs'],
];

function Thumb({ id, updatedAt }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let live = true;
    api.server.thumb(id).then((b) => { if (live && b) setSrc(`data:image/png;base64,${b}`); }).catch(() => {});
    return () => { live = false; };
  }, [id, updatedAt > 0 && Math.floor(updatedAt / 60000)]);
  return <div className="jc-thumb">{src ? <img src={src} alt="" /> : null}</div>;
}

export default function JobCenter({ owner, active }) {
  const [state, setState] = useState(null);
  const [caps, setCaps] = useState(null);
  const [err, setErr] = useState('');
  const [queue, setQueue] = useState('held');
  const [sel, setSel] = useState([]);
  const [dialog, setDialog] = useState(null); // { kind, job }
  const [msg, setMsg] = useState('');
  const [filter, setFilter] = useState('');
  const [info, setInfo] = useState(null);
  const lastSel = useRef(null);

  const load = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([api.server.state(), api.server.info()]);
      setState(s); setInfo(i); setErr('');
      if (!caps) setCaps(await api.server.capabilities());
    } catch (e) {
      setErr(cleanErr(e));
      setInfo(await api.server.info().catch(() => null));
    }
  }, [caps]);

  useEffect(() => {
    if (!active) return undefined;
    load();
    const t = setInterval(load, 2000);
    const off = api.server.onChange(() => load());
    return () => { clearInterval(t); off(); };
  }, [active, load]);

  const jobs = state?.jobs || [];
  const counts = useMemo(() => Object.fromEntries(QUEUES.map(([q]) => [q, q === 'all' ? jobs.length : jobs.filter((j) => j.queue === q).length])), [jobs]);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return jobs
      .filter((j) => queue === 'all' || j.queue === queue)
      .filter((j) => !f || [j.name, j.user, j.from, j.paperName, j.inkflow?.label].some((x) => String(x || '').toLowerCase().includes(f)))
      .sort((a, b) => (queue === 'printing' ? (b.rush - a.rush) || a.createdAt - b.createdAt : (b.printedAt || b.updatedAt) - (a.printedAt || a.updatedAt)));
  }, [jobs, queue, filter]);
  const selected = jobs.filter((j) => sel.includes(j.id));
  const one = selected.length === 1 ? selected[0] : null;

  const click = (e, id) => {
    if (e.shiftKey && lastSel.current) {
      const ids = shown.map((j) => j.id);
      const a = ids.indexOf(lastSel.current), b = ids.indexOf(id);
      if (a >= 0 && b >= 0) { setSel(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); return; }
    }
    if (e.ctrlKey || e.metaKey) setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
    else setSel([id]);
    lastSel.current = id;
  };

  const run = async (act, arg) => {
    setMsg('');
    const ids = selected.map((j) => j.id);
    if (!ids.length) return;
    if (act === 'remove' && !window.confirm(`Remove ${ids.length === 1 ? `"${selected[0].name}"` : `${ids.length} jobs`} from the server? The file is deleted too.`)) return;
    try {
      for (const id of ids) await api.server.action(id, act, arg);
      if (act === 'remove') setSel([]);
      await load();
    } catch (e) { setMsg(cleanErr(e)); }
  };
  const importFiles = async () => {
    setMsg('');
    try {
      const r = await api.server.importFiles({ hold: true });
      if (r.length) { setQueue('held'); setSel(r.map((j) => j.id)); setMsg(`Imported ${r.length} job${r.length > 1 ? 's' : ''} to the Held queue.`); }
      await load();
    } catch (e) { setMsg(cleanErr(e)); }
  };
  const rename = async () => {
    const n = window.prompt('Job name', one.name);
    if (n && n.trim()) run('rename', n.trim());
  };
  const exportPdf = async () => {
    try { const p = await api.server.exportPdf(one.id, one.name); if (p) setMsg(`Saved ${p}`); } catch (e) { setMsg(cleanErr(e)); }
  };
  const togglePause = async () => { try { await api.server.pause(!state.server.paused); await load(); } catch (e) { setMsg(cleanErr(e)); } };

  const can = (fn) => selected.length > 0 && selected.every(fn);
  const notBusy = (j) => j.status !== 'printing' && j.status !== 'processing';

  if (!state) {
    return (
      <div className="jc-page">
        <div className="page-head"><div><h1>Xerox Server</h1><p className="muted">Fiery-style print server for the Xerox WorkCentre 7845.</p></div>
          {owner && <button className="btn" onClick={() => setDialog({ kind: 'setup' })}>Server setup…</button>}</div>
        {err ? <div className="empty"><b>{err}</b><div className="muted small" style={{ marginTop: 8 }}>{info?.role === 'client' ? `This PC uses the print server at ${info.address || '(no address set)'}.` : ''}</div>
          {owner && <button className="btn primary" style={{ marginTop: 14 }} onClick={() => setDialog({ kind: 'setup' })}>Server setup…</button>}</div>
          : <div className="empty">Connecting to the print server…</div>}
        {dialog?.kind === 'setup' && <ServerSetup onClose={() => { setDialog(null); load(); }} />}
      </div>
    );
  }

  const printer = state.printer;
  return (
    <div className="jc-page">
      <div className="page-head">
        <div>
          <h1>Xerox Server</h1>
          <p className="muted small">
            {info?.role === 'client' ? <>Connected to the print server on <b>{state.server.name}</b> ({info.address})</> : <>This PC (<b>{state.server.name}</b>) is the print server</>}
            {' · '}{printer ? <>{printer.name} — {printer.host || <span className="warn-text">no IP address set (Devices)</span>}</> : <span className="warn-text">no Xerox set up in Devices</span>}
            {state.server.paused && <> · <b className="warn-text">Printing paused</b></>}
          </p>
        </div>
        <div className="row">
          <button className="btn primary" onClick={importFiles}>Import…</button>
          <button className="btn" onClick={() => setDialog({ kind: 'catalog' })}>Paper catalog</button>
          <button className={`btn ${state.server.paused ? 'primary' : ''}`} onClick={togglePause}>{state.server.paused ? 'Resume printing' : 'Pause printing'}</button>
          {owner && <button className="btn ghost" onClick={() => setDialog({ kind: 'setup' })}>Setup…</button>}
        </div>
      </div>

      <div className="jc-bar">
        <div className="seg jc-queues">
          {QUEUES.map(([q, label]) => (
            <button key={q} className={queue === q ? 'on' : ''} onClick={() => { setQueue(q); setSel([]); }}>{label}<span className="jc-count">{counts[q]}</span></button>
          ))}
        </div>
        <input className="jc-search" type="text" placeholder="Search jobs, people, paper, orders" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>

      <div className="jc-actions">
        <button className="btn primary" disabled={!can((j) => notBusy(j) && j.status !== 'waiting')} onClick={() => run('print')}>{one?.queue === 'printed' ? 'Reprint' : 'Print'}</button>
        <button className="btn" disabled={!can((j) => j.status === 'waiting' || j.queue === 'printed' || j.status === 'error')} onClick={() => run('hold')}>Hold</button>
        <button className="btn" disabled={!can(notBusy)} onClick={() => run('processHold')} title="Prepare the job for the printer now, so it prints right away later">Process & hold</button>
        <button className="btn" disabled={!can((j) => j.status !== 'printed')} onClick={() => run('printNext')}>Print next</button>
        <button className="btn" disabled={!one || !notBusy(one)} onClick={() => run('proof')} title="Print 1 copy and keep the job held">Proof</button>
        <span className="jc-sep" />
        <button className="btn" disabled={!one || !notBusy(one)} onClick={() => setDialog({ kind: 'props', job: one })}>Properties…</button>
        <button className="btn" disabled={!one} onClick={() => setDialog({ kind: 'preview', job: one })}>Preview</button>
        <button className="btn" disabled={!one} onClick={() => run('duplicate')}>Duplicate</button>
        <button className="btn" disabled={!one} onClick={rename}>Rename</button>
        <button className="btn" disabled={!one} onClick={exportPdf}>Save PDF…</button>
        <span className="jc-sep" />
        <button className="btn" disabled={!can((j) => j.status === 'waiting')} onClick={() => run('cancel')}>Cancel</button>
        <button className="btn danger" disabled={!can(notBusy)} onClick={() => run('remove')}>Remove</button>
      </div>
      {msg && <div className="studio-msg" style={{ marginBottom: 8 }}>{msg}</div>}

      <div className="jc-main">
        <div className="jc-list">
          {shown.length ? (
            <table className="table jc-table">
              <thead><tr><th /><th>Status</th><th>Job</th><th>From</th><th className="num">Copies</th><th>Paper</th><th>Output</th></tr></thead>
              <tbody>
                {shown.map((j) => (
                  <tr key={j.id} className={`jc-row ${sel.includes(j.id) ? 'sel' : ''} ${j.rush ? 'rush' : ''}`} onClick={(e) => click(e, j.id)}
                    onDoubleClick={() => notBusy(j) && setDialog({ kind: 'props', job: j })}>
                    <td><Thumb id={j.id} updatedAt={j.createdAt} /></td>
                    <td><span className={`pill ${STATUS[j.status]?.cls || 'pill-wait'}`}>{STATUS[j.status]?.label || j.status}</span>{j.rush && j.status !== 'printed' ? <div className="small warn-text">Next</div> : null}</td>
                    <td><div className="jc-name">{j.name}</div><div className="small muted jc-msg">{j.inkflow?.label ? `Order ${j.inkflow.label} · ` : ''}{j.message}</div></td>
                    <td className="small nowrap" title={j.source === 'virtual-printer' ? `Windows printer on ${j.from}` : j.from}>{j.user || j.from || '—'}
                      <div className="muted">{fmtDate(queue === 'printed' ? j.printedAt : j.createdAt)}{j.printCount > 1 ? ` · ${j.printCount}×` : ''}</div></td>
                    <td className="num"><b>{j.copies}</b><div className="small muted nowrap">{j.pages ?? '?'} pg{j.sheets != null ? ` · ${j.sheets * (j.copies || 1)} sh` : ''}</div></td>
                    <td className="small jc-paper">{j.paperName}{j.mixed ? <div className="muted">+ mixed media</div> : null}</td>
                    <td className="small jc-out">{[j.sidesText, j.colorText, j.layout, j.finishing].filter(Boolean).join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">
              {queue === 'held' ? 'No held jobs. Import a PDF, send from Press, or print from any PC to "InkSign 7845 - Hold".'
                : queue === 'printing' ? 'Nothing printing right now.' : queue === 'printed' ? 'Printed jobs stay here for reprinting.' : 'No jobs yet.'}
            </div>
          )}
        </div>
        {one && (
          <aside className="jc-detail">
            <Thumb id={one.id} updatedAt={one.createdAt} />
            <div className="jc-name">{one.name}</div>
            <div className="small muted">{one.message}</div>
            <div className="stats small">
              <div><span>Paper</span><b>{one.paperName}</b></div>
              <div><span>Sides</span><b>{one.sidesText}</b></div>
              <div><span>Color</span><b>{one.colorText}</b></div>
              {one.layout && <div><span>Layout</span><b>{one.layout}</b></div>}
              {one.finishing && <div><span>Finishing</span><b>{one.finishing}</b></div>}
              <div><span>Copies</span><b>{one.copies}</b></div>
              {one.sheets != null && <div><span>Sheets per copy</span><b>{one.sheets}</b></div>}
              {one.props?.notes && <div><span>Notes</span><b>{one.props.notes}</b></div>}
            </div>
            <div className="box-title" style={{ marginTop: 8 }}>History</div>
            <div className="jc-log">
              {(one.log || []).slice().reverse().map((l, i) => <div key={i} className="small"><span className="muted">{fmtDate(l.at)}</span> {l.what}{l.who ? ` — ${l.who}` : ''}</div>)}
            </div>
          </aside>
        )}
      </div>

      {dialog?.kind === 'props' && caps && (
        <JobProperties job={dialog.job} caps={caps} catalog={state.catalog} onClose={() => setDialog(null)}
          onSaved={async (andPrint) => { if (andPrint) await api.server.action(dialog.job.id, 'print'); setDialog(null); load(); }}
          onPreview={(props) => setDialog({ kind: 'preview', job: dialog.job, props, back: dialog })} />
      )}
      {dialog?.kind === 'preview' && <SheetPreview job={dialog.job} props={dialog.props} onClose={() => setDialog(dialog.back || null)} />}
      {dialog?.kind === 'catalog' && caps && <PaperCatalog caps={caps} owner={owner} state={state} onClose={() => { setDialog(null); load(); }} />}
      {dialog?.kind === 'setup' && <ServerSetup onClose={() => { setDialog(null); setCaps(null); load(); }} />}
    </div>
  );
}
