import React, { useEffect, useMemo, useState } from 'react';
import { planCut, areaBox, usageReport, TOOL_PRESETS, MM } from '../lib/cutPlan.js';

// "Send to be Cut" — the cut window, laid out like VinylMaster's: General, Cutter control, Settings and
// Tiling / panels on the left; on the right the vinyl as it comes out of the cutter with the job on it.
// Area Test runs the blade (up) round the job; Cut Now sends it; Spool All parks every job in the queue.
const api = window.inksign;
const save = (k, v) => { try { window.localStorage.setItem(`inksign.cut.${k}`, JSON.stringify(v)); } catch { /* not saved */ } };
const load = (k, d) => { try { const v = JSON.parse(window.localStorage.getItem(`inksign.cut.${k}`) || 'null'); return v == null ? d : v; } catch { return d; } };
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const TABS = [['general', 'General'], ['control', 'Cutter control'], ['settings', 'Settings'], ['tiles', 'Tiling / panels']];

function Inches({ label, value, onChange, step = 0.125, min = 0, note }) {
  return (
    <label className="dz-field"><span>{label}</span>
      <div className="input-unit"><input type="number" step={step} min={min} value={+(value / MM).toFixed(3)} onChange={(e) => onChange((parseFloat(e.target.value) || 0) * MM)} /><em>in</em></div>
      {note && <small className="muted">{note}</small>}
    </label>
  );
}
const Check = ({ label, checked, onChange, title }) => (
  <label className="check" title={title}><input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} /> {label}</label>
);

// The vinyl hanging out of the cutter: origin at the bottom right like the machine, across the roll = left-right
function Preview({ job, mediaMm, pos }) {
  if (!job) return <div className="cw-empty">Nothing to cut.</div>;
  const media = Math.max(mediaMm || 0, job.h + pos.y, 50);
  const len = Math.max(job.w + pos.x + 20, media * 0.45);
  const pad = media * 0.12;
  const X = (y) => media - y;          // across the roll, from the right edge
  const Y = (x) => len - x;            // along the roll, up from the cutter
  const d = job.paths.map((p) => `M${p.map((q) => `${X(q.y + pos.y).toFixed(2)},${Y(q.x + pos.x).toFixed(2)}`).join('L')}`).join('');
  const sw = media / 500;
  const fs = media / 28;
  const stroke = job.color && /^#/.test(job.color) && job.color.toLowerCase() !== '#ffffff' ? job.color : '#111111';
  const over = mediaMm > 0 && job.h + pos.y > mediaMm + 0.01;
  return (
    <svg className="cw-svg" viewBox={`${-pad * 1.6} ${-pad * 0.5} ${media + pad * 3.1} ${len + pad * 1.9}`} preserveAspectRatio="xMidYMid meet">
      <rect x={0} y={0} width={media} height={len} fill="#fdfdfb" stroke="#9aa0aa" strokeWidth={sw} />
      {over && <rect x={X(job.h + pos.y)} y={Y(job.w + pos.x)} width={job.h + pos.y - mediaMm} height={job.w} fill="rgba(255,90,95,.35)" />}
      <path d={d} fill="none" stroke={stroke} strokeWidth={sw * 1.4} strokeLinejoin="round" />
      {/* the cutter */}
      <rect x={-pad * 0.9} y={len} width={media + pad * 1.8} height={pad * 0.55} rx={pad * 0.12} fill="#2b3340" />
      <rect x={-pad * 1.25} y={len - pad * 0.08} width={pad * 0.5} height={pad * 0.7} rx={pad * 0.1} fill="#3d6bd6" />
      <rect x={media + pad * 0.75} y={len - pad * 0.08} width={pad * 0.5} height={pad * 0.7} rx={pad * 0.1} fill="#3d6bd6" />
      <circle cx={media} cy={len} r={sw * 5} fill="#e5482b" />
      {/* sizes */}
      <g stroke="#7a8190" strokeWidth={sw} fill="#c9ced8" fontSize={fs} fontFamily="system-ui, sans-serif">
        <line x1={X(job.h + pos.y)} y1={len + pad * 0.85} x2={X(pos.y)} y2={len + pad * 0.85} />
        <text x={X(pos.y + job.h / 2)} y={len + pad * 0.85 + fs * 1.15} textAnchor="middle" stroke="none">{(job.h / MM).toFixed(2)} in across</text>
        <line x1={-pad * 0.55} y1={Y(job.w + pos.x)} x2={-pad * 0.55} y2={Y(pos.x)} />
        <text transform={`translate(${-pad * 0.75} ${Y(pos.x + job.w / 2)}) rotate(-90)`} textAnchor="middle" stroke="none">{(job.w / MM).toFixed(2)} in of roll</text>
      </g>
    </svg>
  );
}

export default function CutWindow({ devices, groupsFor, hasCutLines, hasSelection, defaultName, onClose, onSent }) {
  const cutters = devices.filter((d) => d.kind === 'cutter');
  const [deviceId, setDeviceId] = useState(load('cutter', '') || cutters[0]?.id || '');
  const dev = cutters.find((d) => d.id === deviceId) || cutters[0];
  const [tab, setTab] = useState('general');
  const [name, setName] = useState(defaultName || 'Cut job');
  const [what, setWhat] = useState(hasCutLines ? 'cut' : 'color');
  const [onlySel, setOnlySel] = useState(false);
  const [hold, setHold] = useState(true);
  const [advance, setAdvance] = useState(true);
  const [absolute, setAbsolute] = useState(false);
  const [mediaMm, setMediaMm] = useState((Number(dev?.config?.mediaWidthIn) || 24) * MM);
  useEffect(() => { setMediaMm((Number(dev?.config?.mediaWidthIn) || 24) * MM); }, [dev?.id]);
  const [o, setO] = useState(() => ({
    rotate: false, mirror: false, copies: 1, copyGapMm: 6.35, weldOverlaps: false, weedBox: false, speedWeed: false,
    weedOffsetMm: load('weedOffsetMm', 5), easyLift: false, regMarks: false, cutHolesFirst: true, passes: 1, dash: null,
    autoTile: false, tileLengthMm: 0, tileOverlapMm: 10,
  }));
  const set = (patch) => setO((v) => ({ ...v, ...patch }));
  const [pos, setPos] = useState({ x: 0, y: 0 });
  // cutting condition
  const [mine, setMine] = useState(() => load('presets', []));
  const presets = [...TOOL_PRESETS, ...mine];
  const [preset, setPreset] = useState('');
  const [force, setForce] = useState('');
  const [speed, setSpeed] = useState('');
  const [overcut, setOvercut] = useState(Number(dev?.config?.overcutMm ?? 0.5));
  const usePreset = (n) => {
    setPreset(n);
    const p = presets.find((x) => x.name === n);
    if (!p) return;
    setForce(p.force ?? ''); setSpeed(p.speed ?? ''); setOvercut(p.overcutMm ?? 0.5);
    set({ passes: p.passes || 1, dash: p.dash || null });
  };
  const [newName, setNewName] = useState('');
  const savePreset = () => {
    const n = newName.trim();
    if (!n) return;
    setNewName('');
    const next = [...mine.filter((p) => p.name !== n), { name: n, force, speed, overcutMm: overcut, passes: o.passes, dash: o.dash }];
    setMine(next); save('presets', next); setPreset(n);
  };
  const dropPreset = () => { const next = mine.filter((p) => p.name !== preset); setMine(next); save('presets', next); setPreset(''); };

  const [page, setPage] = useState(0);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const groups = useMemo(() => groupsFor(what === 'all' ? 'all' : what, onlySel), [what, onlySel]);
  const plan = useMemo(() => planCut(groups, { ...o, separate: what !== 'all', mediaWidthMm: Math.max(0, mediaMm - pos.y) }), [groups, o, what, mediaMm, pos.y]);
  const jobs = plan.jobs;
  const cur = jobs[Math.min(page, Math.max(0, jobs.length - 1))];
  useEffect(() => { if (page > jobs.length - 1) setPage(0); }, [jobs.length]);
  const report = useMemo(() => usageReport(plan, mediaMm), [plan, mediaMm]);
  const overrides = { speed, force, overcutMm: overcut, posXmm: pos.x || '', posYmm: pos.y || '', absolute: absolute || '', advanceMm: advance ? '' : 0 };

  const run = async (fn) => {
    setErr(''); setMsg('');
    if (!dev) { setErr('Add a cutter under Devices first'); return; }
    if (!jobs.length) { setErr('Nothing to cut'); return; }
    setBusy(true);
    try { await fn(); } catch (e) { setErr(clean(e.message)); } finally { setBusy(false); }
  };
  const panelsOut = (holdAll) => jobs.map((j, i) => ({
    name: j.name,
    paths: j.paths,
    hold: holdAll || (hold && i > 0),
    holdMessage: holdAll ? 'Spooled — press Release to cut' : j.color ? `Load ${j.name} vinyl, then press Release` : 'Load the next panel, then press Release',
    meta: { cutMm: j.cutMm },
  }));
  const send = (holdAll) => run(async () => {
    save('cutter', dev.id); save('weedOffsetMm', o.weedOffsetMm);
    await api.jobs.sendCut(dev.id, { name, panels: panelsOut(holdAll), overrides });
    onSent(holdAll ? `Spooled ${jobs.length} cut job${jobs.length > 1 ? 's' : ''} for ${dev.name} — release them from the Job queue` : `Sent ${jobs.length} cut job${jobs.length > 1 ? 's' : ''} to ${dev.name}`);
    onClose();
  });
  const areaTest = () => run(async () => {
    const r = await api.cutter.areaTest(dev.id, [areaBox(cur)], overrides);
    setMsg(`${r.message}. Watch the blade go round ${jobs.length > 1 ? `“${cur.name}”` : 'the job'} — nothing is cut.`);
  });
  const saveFile = () => run(async () => {
    const files = await api.files.saveCut(dev.id, { name, panels: panelsOut(false), overrides });
    if (files.length) setMsg(`Saved ${files.length} cut file${files.length > 1 ? 's' : ''}`);
  });

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div className="modal-back">
      <div className="modal cw">
        <div className="modal-head"><h2>Send to be Cut</h2><button className="btn ghost small" onClick={onClose}>✕</button></div>
        <div className="cw-body">
          <div className="cw-left">
            <div className="cw-tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>

            {tab === 'general' && (
              <div className="cw-pane">
                {!cutters.length && <p className="warn-text">No cutters set up yet — add one under Devices.</p>}
                <fieldset><legend>Vinyl cutter</legend>
                  <div className="dz-form">
                    <label className="dz-field"><span>Cutter</span><select value={dev?.id || ''} onChange={(e) => setDeviceId(e.target.value)}>{cutters.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
                    <Inches label="Media width" value={mediaMm} onChange={setMediaMm} step={1} note="What you can cut across the roll" />
                    <label className="dz-field"><span>Job name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
                    <label className="dz-field"><span>Quantity</span><div className="input-unit"><input type="number" min={1} step={1} value={o.copies} onChange={(e) => set({ copies: Math.max(1, parseInt(e.target.value, 10) || 1) })} /><em>copies</em></div></label>
                    {o.copies > 1 && <Inches label="Space between copies" value={o.copyGapMm} onChange={(v) => set({ copyGapMm: v })} step={0.0625} />}
                  </div>
                  <div className="cw-checks">
                    <Check label="Rotate 90°" checked={o.rotate} onChange={(v) => set({ rotate: v })} />
                    <Check label="Mirror" checked={o.mirror} onChange={(v) => set({ mirror: v })} title="Heat transfer, or lettering that goes on the inside of glass" />
                    <Check label="Advance after plot" checked={advance} onChange={setAdvance} title="Feed past the job when it's done" />
                    <Check label="Absolute (position)" checked={absolute} onChange={setAbsolute} title="Cut from the cutter's origin, ignoring 'start next job here' and the roll position" />
                  </div>
                </fieldset>
                <fieldset><legend>General options</legend>
                  <div className="dz-form cw-one">
                    <label className="dz-field"><span>What to cut</span>
                      <select value={what} onChange={(e) => setWhat(e.target.value)}>
                        {hasCutLines && <option value="cut">Cut lines only (CutContour)</option>}
                        <option value="color">Separate by color — one job per vinyl color</option>
                        <option value="all">All colors combined in one job</option>
                      </select>
                    </label>
                  </div>
                  <div className="cw-checks">
                    {hasSelection && <Check label="Only what's selected" checked={onlySel} onChange={setOnlySel} />}
                    <Check label="Registration marks" checked={o.regMarks} onChange={(v) => set({ regMarks: v })} title="Small squares in the same spot on every color, so the layers line up when you apply them" />
                    <Check label="Auto weed-box" checked={o.weedBox} onChange={(v) => set({ weedBox: v })} title="A box around the job" />
                    <Check label="Auto speed-weed" checked={o.speedWeed} onChange={(v) => set({ speedWeed: v })} title="The box plus a line between each row, so the waste pulls off in strips" />
                    {jobs.length > 1 && <Check label="Hold each new color until it's loaded" checked={hold} onChange={setHold} />}
                  </div>
                </fieldset>
                <fieldset><legend>Text options</legend>
                  <div className="cw-checks">
                    <Check label="Easy-lift weed marks" checked={o.easyLift} onChange={(v) => set({ easyLift: v })} title="A short cut inside every hole (O, A, e…) so the middles lift out quickly" />
                    <Check label="Weld text" checked={o.weldOverlaps} onChange={(v) => set({ weldOverlaps: v })} title="Letters that overlap become one outline — script and cursive fonts" />
                  </div>
                </fieldset>
              </div>
            )}

            {tab === 'control' && (
              <div className="cw-pane">
                <fieldset><legend>Cutting condition</legend>
                  <div className="dz-form cw-one">
                    <label className="dz-field"><span>Preset</span>
                      <select value={preset} onChange={(e) => usePreset(e.target.value)}>
                        <option value="">— none: use what's set here —</option>
                        <optgroup label="Built in">{TOOL_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}</optgroup>
                        {mine.length > 0 && <optgroup label="Yours">{mine.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}</optgroup>}
                      </select>
                    </label>
                  </div>
                  <div className="btn-row">
                    <input type="text" className="cw-newpreset" value={newName} placeholder="Name it (the vinyl or blade)" onChange={(e) => setNewName(e.target.value)} />
                    <button className="btn small" disabled={!newName.trim()} onClick={savePreset}>Save as my preset</button>
                    {mine.some((p) => p.name === preset) && <button className="btn small ghost" onClick={dropPreset}>Delete preset</button>}
                  </div>
                </fieldset>
                <fieldset><legend>Force / speed</legend>
                  <div className="dz-form">
                    <label className="dz-field"><span>Force</span><input type="number" value={force} placeholder="cutter's panel setting" onChange={(e) => setForce(e.target.value)} /></label>
                    <label className="dz-field"><span>Speed</span><input type="number" value={speed} placeholder="cutter's panel setting" onChange={(e) => setSpeed(e.target.value)} /></label>
                    <label className="dz-field"><span>Overcut</span><div className="input-unit"><input type="number" step={0.1} min={0} value={overcut} onChange={(e) => setOvercut(parseFloat(e.target.value) || 0)} /><em>mm</em></div><small className="muted">How far past the start each closed shape keeps cutting</small></label>
                    <label className="dz-field"><span>Passes</span><div className="input-unit"><input type="number" min={1} max={5} step={1} value={o.passes} onChange={(e) => set({ passes: Math.max(1, Math.min(5, parseInt(e.target.value, 10) || 1)) })} /><em>times</em></div></label>
                  </div>
                  <p className="muted small">Leave force and speed empty to use what's set on the cutter. Blade offset is set on the cutter's own panel.</p>
                  <Check label="Cut holes first (insides before outsides, shortest travel)" checked={o.cutHolesFirst} onChange={(v) => set({ cutHolesFirst: v })} />
                </fieldset>
              </div>
            )}

            {tab === 'settings' && (
              <div className="cw-pane">
                <fieldset><legend>Position</legend>
                  <div className="dz-form">
                    <Inches label="Position X (along the roll)" value={pos.x} onChange={(v) => setPos((p) => ({ ...p, x: v }))} />
                    <Inches label="Position Y (across the roll)" value={pos.y} onChange={(v) => setPos((p) => ({ ...p, y: v }))} />
                  </div>
                  <button className="btn small" onClick={() => setPos({ x: 0, y: 0 })}>Reset</button>
                </fieldset>
                <fieldset><legend>Options</legend>
                  <div className="dz-form cw-one"><Inches label="Weed box offset" value={o.weedOffsetMm} onChange={(v) => set({ weedOffsetMm: v })} step={0.0625} note="How far outside the art the weed box is cut" /></div>
                </fieldset>
                <fieldset><legend>Perforation cut</legend>
                  <Check label="Cut as a dashed line (pounce patterns, tear-off, fold lines)" checked={!!o.dash} onChange={(v) => set({ dash: v ? { cutMm: 20, gapMm: 1 } : null })} />
                  {o.dash && (
                    <div className="dz-form">
                      <label className="dz-field"><span>Dash length</span><div className="input-unit"><input type="number" step={0.5} min={0.5} value={o.dash.cutMm} onChange={(e) => set({ dash: { ...o.dash, cutMm: parseFloat(e.target.value) || 1 } })} /><em>mm</em></div></label>
                      <label className="dz-field"><span>Gap length</span><div className="input-unit"><input type="number" step={0.1} min={0.2} value={o.dash.gapMm} onChange={(e) => set({ dash: { ...o.dash, gapMm: parseFloat(e.target.value) || 0.2 } })} /><em>mm</em></div></label>
                    </div>
                  )}
                </fieldset>
              </div>
            )}

            {tab === 'tiles' && (
              <div className="cw-pane">
                <fieldset><legend>General options</legend>
                  <Check label="Automatic tiling — split a job that's too big into panels" checked={o.autoTile} onChange={(v) => set({ autoTile: v })} />
                  <div className="dz-form">
                    <Inches label="Vinyl width" value={mediaMm} onChange={setMediaMm} step={1} />
                    <Inches label="Vinyl length" value={o.tileLengthMm} onChange={(v) => set({ tileLengthMm: v })} step={1} note="Longest panel to cut in one go — 0 = no limit" />
                    <Inches label="Tile overlap" value={o.tileOverlapMm} onChange={(v) => set({ tileOverlapMm: v })} step={0.0625} />
                  </div>
                </fieldset>
                <p className="muted small">Each panel becomes its own job and waits in the queue until you load it and press Release. Shapes that cross a panel edge are cut on both panels, with the overlap for lining them up.</p>
              </div>
            )}
          </div>

          <div className="cw-right">
            <div className="cw-pager">
              <button className="btn ghost small" disabled={page <= 0} onClick={() => setPage(page - 1)}>◀</button>
              <span>{cur ? (<>{cur.color && <i style={{ background: cur.color }} />}{jobs.length > 1 ? `${cur.name} · ${page + 1} of ${jobs.length}` : what === 'all' ? 'All colors combined' : cur.name}</>) : '—'}</span>
              <button className="btn ghost small" disabled={page >= jobs.length - 1} onClick={() => setPage(page + 1)}>▶</button>
            </div>
            <div className="cw-stage"><Preview job={cur} mediaMm={mediaMm} pos={pos} /></div>
            <div className="cw-stats">
              {dev ? <b>{dev.name}, {(mediaMm / MM).toFixed(0)}″</b> : null}
              <span>{jobs.length} job{jobs.length !== 1 ? 's' : ''}</span>
              <span>{(plan.totalCutMm / MM / 12).toFixed(1)} ft of cutting</span>
              <span>{(plan.mediaMm / MM / 12).toFixed(2)} ft of vinyl ({report.reduce((s, r) => s + r.sqFt, 0).toFixed(2)} sq ft)</span>
            </div>
            {plan.warnings.map((w) => <div key={w} className="warn-text small">⚠ {w}</div>)}
          </div>
        </div>
        <div className="modal-foot">
          <span className={err ? 'error' : 'muted small'}>{err || msg}</span>
          <div className="row">
            <button className="btn" disabled={busy || !cur} onClick={saveFile}>Save cut file…</button>
            <button className="btn" disabled={busy || !cur} onClick={areaTest} title="The blade stays up and runs once round the outside of the job, so you can see it fits">Area Test</button>
            <button className="btn primary" disabled={busy || !cur} onClick={() => send(false)}>{busy ? 'Sending…' : 'Cut Now'}</button>
            <button className="btn" disabled={busy || !cur} onClick={() => send(true)} title="Park every job in the queue, held, to cut later">Spool All</button>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
