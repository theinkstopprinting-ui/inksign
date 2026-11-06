import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cleanErr } from './common.js';

const api = window.inksign;
const COUNTS = [100, 150, 200, 300, 400];
const store = {
  get: (k) => { try { return window.localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* not saved */ } },
  del: (k) => { try { window.localStorage.removeItem(k); } catch { /* fine */ } },
};
// rough screen colour of a CMYK patch, to show which patch to scan next
const cmykCss = ([c, m, y, k]) => `rgb(${Math.round(255 * (1 - c) * (1 - k))},${Math.round(255 * (1 - m) * (1 - k))},${Math.round(255 * (1 - y) * (1 - k))})`;
const labCss = ([L, a, b]) => {
  // Lab (D50) -> approximate sRGB for a swatch
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const f = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  let X = 0.9642 * f(fx), Y = f(fy), Z = 0.8249 * f(fz);
  const r = 3.1339 * X - 1.6169 * Y - 0.4906 * Z, g = -0.9788 * X + 1.9161 * Y + 0.0335 * Z, bl = 0.0719 * X - 0.2290 * Y + 1.4052 * Z;
  const gam = (v) => Math.round(255 * Math.max(0, Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
  return `rgb(${gam(r)},${gam(g)},${gam(bl)})`;
};

// Readings as "Patch,L,a,b" lines (what InkRIP's reading parser takes; same as the Nix app's CSV)
const toCsv = (scans) => `Patch,L,a,b\n${Object.keys(scans).map(Number).sort((a, b) => a - b).map((n) => `${n},${scans[n].map((v) => v.toFixed(2)).join(',')}`).join('\n')}`;

function Scanner({ kind, n, scans, setScans, nixInfo, onNix, getPatches }) {
  const [list, setList] = useState(null);
  const [at, setAt] = useState(1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [last, setLast] = useState(null);
  const btn = useRef(null);
  useEffect(() => { (getPatches || api.profiling.patches)(kind, n).then((r) => setList(r.patches)).catch((e) => setMsg(cleanErr(e))); }, [kind, n]);
  useEffect(() => {
    if (!list) return;
    let k = 1; while (scans[k] && k <= list.length) k++;
    setAt(Math.min(k, list.length));
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps
  const connected = !!nixInfo?.device;
  const scan = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await api.nix.measure();
      if (!r.ok && r.error) throw new Error(r.error);
      setScans((s) => ({ ...s, [at]: r.lab }));
      setLast({ n: at, lab: r.lab });
      setAt((a) => Math.min(a + 1, list.length));
    } catch (e) { setMsg(cleanErr(e)); } finally { setBusy(false); setTimeout(() => btn.current?.focus(), 0); }
  };
  const connect = async () => { setBusy(true); setMsg(''); try { const r = await api.nix.connect(); if (r && r.ok === false) throw new Error(r.error || 'Could not connect'); } catch (e) { setMsg(cleanErr(e)); } finally { setBusy(false); onNix(); } };
  if (!nixInfo?.available) return <div className="help">The Nix on USB needs NixBridge on this PC (see <b>Nix on USB</b>). You can still use the Nix app and paste its export below.</div>;
  const done = Object.keys(scans).length;
  return (
    <div className="pm-scan">
      <div className="row">
        {connected ? <span className="pill pill-ok">Nix connected{nixInfo.device?.name ? ` — ${nixInfo.device.name}` : ''}</span>
          : <button className="btn small" disabled={busy} onClick={connect}>{busy ? 'Connecting…' : 'Connect the Nix'}</button>}
        <span className="muted small">{done} of {list?.length || '…'} patches read</span>
      </div>
      {list && connected && (
        <div className="pm-scanbox">
          <div className="pm-next">
            <div className="pm-swatch" style={{ background: cmykCss(list[at - 1]) }} />
            <div>
              <div className="muted small">Put the Nix on patch</div>
              <div className="pm-num">{at}</div>
              <div className="muted small">C{Math.round(list[at - 1][0] * 100)} M{Math.round(list[at - 1][1] * 100)} Y{Math.round(list[at - 1][2] * 100)} K{Math.round(list[at - 1][3] * 100)}{scans[at] ? ' · already read (scan again to replace)' : ''}</div>
            </div>
          </div>
          <div className="row">
            <button ref={btn} className="btn primary" disabled={busy} onClick={scan} autoFocus>{busy ? 'Reading…' : `Scan patch ${at}`}</button>
            <button className="btn small" disabled={at <= 1} onClick={() => setAt((a) => Math.max(1, a - 1))}>◀ Back</button>
            <button className="btn small" disabled={at >= list.length} onClick={() => setAt((a) => Math.min(list.length, a + 1))}>Skip ▶</button>
            <label className="mini-field" style={{ maxWidth: 110 }}><span>Go to patch</span><input type="number" min="1" max={list.length} value={at} onChange={(e) => setAt(Math.max(1, Math.min(list.length, Number(e.target.value) || 1)))} /></label>
          </div>
          {last && <div className="small"><span className="pm-dot" style={{ background: labCss(last.lab) }} /> Patch {last.n}: L {last.lab[0].toFixed(1)} a {last.lab[1].toFixed(1)} b {last.lab[2].toFixed(1)}</div>}
          <div className="help">Press Enter or Space to scan. Hold the Nix flat in the middle of the patch.</div>
        </div>
      )}
      {msg && <div className="studio-msg">{msg}</div>}
    </div>
  );
}

export function Measure({ kind, n, text, setText, nixInfo, onNix, getPatches }) {
  const [scans, setScansRaw] = useState(() => {
    const out = {};
    for (const l of String(text || '').split('\n').slice(1)) { const c = l.split(','); if (c.length >= 4 && /^\d+$/.test(c[0])) out[Number(c[0])] = c.slice(1, 4).map(Number); }
    return out;
  });
  const setScans = (fn) => setScansRaw((s) => { const next = typeof fn === 'function' ? fn(s) : fn; setText(toCsv(next)); return next; });
  const fileRef = useRef(null);
  const loadFile = async (f) => { if (f) setText(await f.text()); };
  return (<>
    <Scanner kind={kind} n={n} scans={scans} setScans={setScans} nixInfo={nixInfo} onNix={onNix} getPatches={getPatches} />
    <div className="row" style={{ marginTop: 8 }}>
      <span className="box-title" style={{ margin: 0 }}>Readings</span>
      <button className="btn small" onClick={() => fileRef.current?.click()}>Open Nix app export…</button>
      <input ref={fileRef} type="file" accept=".csv,.txt,.ti3" style={{ display: 'none' }} onChange={(e) => loadFile(e.target.files?.[0])} />
      <button className="btn small ghost" onClick={() => { if (window.confirm('Clear all readings for this chart?')) { setScansRaw({}); setText(''); } }}>Clear</button>
    </div>
    <textarea className="pm-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={'Scan with the Nix above, or paste the Nix app export (CSV) here.\nIn the Nix app: name each scan with its patch number (or scan in order), then Export → CSV with CIELAB.'} />
  </>);
}

export function CheckResult({ r }) {
  if (!r) return null;
  return (
    <div className="pm-result">
      <div><b>{r.readings}</b> of {r.patches} patches read{r.used ? ` · ${r.used}` : ''}</div>
      {r.missing?.length > 0 && <div className="warn-text">Missing: {r.missing.slice(0, 40).join(', ')}{r.missing.length > 40 ? '…' : ''}</div>}
      {r.problems?.map((p, i) => <div key={i} className="warn-text">⚠ {p}</div>)}
      {r.rescan?.length > 0 && <div>Worth scanning again (don't fit the rest): {r.rescan.map((x) => `${x.patch} (ΔE ${x.dE})`).join(', ')}</div>}
      {r.before && <div>Current profile's error on these colours: ΔE avg {r.before.avg}, max {r.before.max}</div>}
      {!r.missing?.length && !r.problems?.length && <div className="ok-text">Readings look good.</div>}
      {r.notes?.map?.((x, i) => <div key={`n${i}`} className="muted small">{x}</div>)}
    </div>
  );
}

export function NixSetup({ info, onChange }) {
  const [lic, setLic] = useState('');
  const [msg, setMsg] = useState('');
  const run = async (fn) => { setMsg(''); try { await fn(); } catch (e) { setMsg(cleanErr(e)); } onChange(); };
  return (
    <div className="tool-box">
      <div className="box-title">Nix Mini on USB</div>
      <div className="stats small">
        <div><span>NixBridge</span><b>{info?.bridge ? info.bridge : info?.windows === false ? 'Windows only' : 'not found'}</b></div>
        <div><span>Nix licence</span><b>{info?.license ? 'on this PC' : 'not on this PC'}</b></div>
        <div><span>Scanner</span><b>{info?.device ? `connected${info.device.name ? ` — ${info.device.name}` : ''}` : 'not connected'}</b></div>
      </div>
      <div className="help">InkSign uses the same NixBridge as InkRIP. If InkRIP is installed on this PC it's found automatically; otherwise point to NixBridge.exe (InkRIP's program folder → nixbridge, with its DLLs next to it).</div>
      <div className="row">
        <button className="btn small" onClick={() => run(() => api.nix.pickBridge())}>Find NixBridge.exe…</button>
        {info?.device ? <button className="btn small ghost" onClick={() => run(() => api.nix.disconnect())}>Disconnect</button>
          : <button className="btn small" disabled={!info?.available} onClick={() => run(async () => { const r = await api.nix.connect(); if (r && r.ok === false) throw new Error(r.error || 'Could not connect'); })}>Connect</button>}
      </div>
      {!info?.license && (<>
        <label className="mini-field"><span>Nix licence (Options + Signature, from Nix Sensor)</span><textarea rows={4} value={lic} onChange={(e) => setLic(e.target.value)} /></label>
        <button className="btn small" disabled={!lic.trim()} onClick={() => run(async () => { await api.nix.saveLicense(lic); setLic(''); })}>Save licence on this PC</button>
      </>)}
      {msg && <div className="studio-msg">{msg}</div>}
    </div>
  );
}

// Profile maker for the Xerox: the same steps as InkRIP's — print the chart, measure it with the Nix,
// check the readings, build the profile; and top-up charts for hard colours.
export default function ProfileMaker({ caps, catalog, owner, paperId, onClose }) {
  const [tab, setTab] = useState('new');
  const [paper, setPaper] = useState(paperId || catalog[0]?.id || '');
  const [count, setCount] = useState(200);
  const [quality, setQuality] = useState('Standard');
  const [nixInfo, setNixInfo] = useState(null);
  const [sent, setSent] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [checkRes, setCheckRes] = useState(null);
  const [built, setBuilt] = useState(null);
  const [name, setName] = useState('');
  const [tac, setTac] = useState(280);
  const [gcr, setGcr] = useState('medium');
  const [assign, setAssign] = useState(true);
  const [topups, setTopups] = useState([]);
  const [topId, setTopId] = useState('');
  const draftKey = tab === 'topup' ? `inksign.prof.topup.${topId}` : `inksign.prof.${paper}.${count}`;
  const [text, setTextRaw] = useState('');
  const setText = (t) => { setTextRaw(t); if (t) store.set(draftKey, t); else store.del(draftKey); };

  const loadNix = () => api.nix.info().then(setNixInfo).catch(() => {});
  useEffect(() => { loadNix(); api.profiling.topups().then((l) => { setTopups(l); setTopId((id) => id || l[0]?.id || ''); }).catch(() => {}); }, []);
  useEffect(() => { setTextRaw(store.get(draftKey) || ''); setCheckRes(null); setBuilt(null); }, [draftKey]);
  const entry = catalog.find((c) => c.id === paper);
  useEffect(() => { setName(entry ? `Xerox 7845 – ${entry.name}` : ''); }, [paper]); // eslint-disable-line react-hooks/exhaustive-deps
  const top = topups.find((t) => t.id === topId);

  const go = async (label, fn) => {
    setBusy(label); setMsg('');
    try { await fn(); } catch (e) { setMsg(cleanErr(e)); } finally { setBusy(''); }
  };
  const printChart = (kind) => go('chart', async () => {
    const r = await api.profiling.chart(kind === 'topup' ? { kind: 'topup', profileId: topId } : { kind: 'main', patches: count, catalogId: paper, quality });
    setSent(r);
  });
  const check = () => go('check', async () => setCheckRes(await api.profiling.check(tab === 'topup' ? { kind: 'topup', profileId: topId, text } : { kind: 'main', patches: count, text })));
  const build = () => go('build', async () => {
    const r = await api.profiling.build({ patches: count, text, catalogId: paper, quality, name, tac, gcr, assign });
    setBuilt(r); store.del(draftKey);
    api.profiling.topups().then(setTopups).catch(() => {});
  });
  const topBuild = () => go('build', async () => { const r = await api.profiling.topupBuild({ profileId: topId, text }); setBuilt(r); store.del(draftKey); api.profiling.topups().then(setTopups).catch(() => {}); });
  const qLabel = useMemo(() => caps.quality.find((q) => q.key === quality)?.label || quality, [caps, quality]);

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal pm-modal">
        <div className="modal-head"><h2>Profile maker — Xerox 7845</h2><button className="btn ghost" onClick={onClose}>✕</button></div>
        <p className="muted small">Same system as InkRIP's: print a chart, read it with the Nix, InkSign builds the ICC profile. One profile per paper (and print quality). Run the Xerox's own color calibration first, and again every few weeks.</p>
        <div className="seg" style={{ margin: '8px 0 12px' }}>
          {[['new', 'New profile'], ['topup', 'Top-up'], ['nix', 'Nix on USB']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); setSent(null); setMsg(''); }}>{l}</button>)}
        </div>

        {tab === 'nix' && <NixSetup info={nixInfo} onChange={loadNix} />}

        {tab === 'new' && (<div className="pm-steps">
          <section className="tool-box">
            <div className="box-title"><span className="pm-step">1</span> Print the chart</div>
            <div className="mini-row">
              <label className="mini-field"><span>Paper</span>
                <select value={paper} onChange={(e) => setPaper(e.target.value)}>{catalog.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
              </label>
              <label className="mini-field" style={{ maxWidth: 140 }}><span>Patches</span>
                <select value={count} onChange={(e) => setCount(Number(e.target.value))}>{COUNTS.map((c) => <option key={c} value={c}>{c}{c === 200 ? ' (best start)' : ''}</option>)}</select>
              </label>
              <label className="mini-field"><span>Print quality</span>
                <select value={quality} onChange={(e) => setQuality(e.target.value)}>{caps.quality.map((q) => <option key={q.key} value={q.key}>{q.label}</option>)}</select>
              </label>
            </div>
            <div className="row">
              <button className="btn primary" disabled={!!busy || !paper} onClick={() => printChart('main')}>{busy === 'chart' ? 'Sending…' : 'Print the chart'}</button>
              <span className="help">Prints at 100% with InkSign color management off, from the paper's tray. Let it rest 10 minutes before reading.</span>
            </div>
            {sent && <div className="ok-text small">Sent "{sent.job.name}" — {sent.pages} page{sent.pages > 1 ? 's' : ''}, {sent.patches} patches ({sent.code}). {sent.job.queue === 'held' ? sent.job.message : 'Printing now.'}</div>}
          </section>
          <section className="tool-box">
            <div className="box-title"><span className="pm-step">2</span> Read it with the Nix</div>
            <Measure key={draftKey} kind="main" n={count} text={text} setText={setText} nixInfo={nixInfo} onNix={loadNix} />
          </section>
          <section className="tool-box">
            <div className="box-title"><span className="pm-step">3</span> Check the readings</div>
            <button className="btn" disabled={!!busy || !text.trim()} onClick={check}>{busy === 'check' ? 'Checking…' : 'Check readings'}</button>
            <CheckResult r={checkRes} />
          </section>
          <section className="tool-box">
            <div className="box-title"><span className="pm-step">4</span> Build the profile</div>
            <label className="mini-field"><span>Profile name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
            <div className="mini-row">
              <label className="mini-field"><span>Toner limit (%)</span><input type="number" min="150" max="400" value={tac} onChange={(e) => setTac(Number(e.target.value) || 280)} /></label>
              <label className="mini-field"><span>Black (GCR)</span>
                <select value={gcr} onChange={(e) => setGcr(e.target.value)}><option value="light">Light — more color in darks</option><option value="medium">Medium (InkRIP default)</option><option value="heavy">Heavy — more black, steadier greys</option></select>
              </label>
            </div>
            <label className="check"><input type="checkbox" checked={assign} onChange={(e) => setAssign(e.target.checked)} /> Use it for "{entry?.name}" in the paper catalog</label>
            <button className="btn primary" disabled={!!busy || !text.trim() || !owner} onClick={build}>{busy === 'build' ? 'Building (about 5 s)…' : 'Build profile'}</button>
            {!owner && <div className="help">Only an owner can build profiles.</div>}
            {built && !built.added && (
              <div className="pm-result">
                <div className="ok-text"><b>{built.name}</b> made from {built.patches} patches.</div>
                <div>How well it fits the readings: ΔE avg {built.fit.avg}, max {built.fit.max} {built.fit.avg <= 2 ? '(very good)' : built.fit.avg <= 3.5 ? '(good)' : '(rough — re-scan the flagged patches)'}</div>
                <div className="small">Paper white L {built.paperLab.map((v) => v.toFixed(1)).join(' / ')} · darkest L {built.blackLab[0].toFixed(1)}</div>
                {built.assigned ? <div>Set as the profile for <b>{built.assigned}</b>. Jobs on it use it when Job properties → Color & image → InkSign color management is on.</div> : <div>Saved. Pick it on a paper in the paper catalog.</div>}
                {built.problems?.map((p, i) => <div key={i} className="warn-text">⚠ {p}</div>)}
              </div>
            )}
          </section>
          <div className="help">Quality {qLabel}: a profile is only right for the print quality it was printed with.</div>
        </div>)}

        {tab === 'topup' && (<div className="pm-steps">
          <section className="tool-box">
            <div className="box-title">Top-up: 100 hard colors (blues, teals, greens, purples, oranges, darks)</div>
            {topups.length ? (<>
              <label className="mini-field"><span>Profile</span>
                <select value={topId} onChange={(e) => setTopId(e.target.value)}>{topups.map((t) => <option key={t.id} value={t.id}>{t.name} — {t.paperName}{t.toppedUp ? ' (topped up)' : ''}</option>)}</select>
              </label>
              {top && <div className="help">Readings so far: {Object.entries(top.counts).map(([k, v]) => `${k}: ${v}`).join(' · ')}. Prints on {top.paperName}, quality {caps.quality.find((q) => q.key === top.quality)?.label || top.quality}.</div>}
              <button className="btn primary" disabled={!!busy || !topId} onClick={() => printChart('topup')}>{busy === 'chart' ? 'Sending…' : 'Print top-up chart'}</button>
              {sent && <div className="ok-text small">Sent "{sent.job.name}" — {sent.pages} page{sent.pages > 1 ? 's' : ''}.</div>}
            </>) : <div className="muted">No profiles made here yet — make one under New profile first.</div>}
          </section>
          {topId && (<>
            <section className="tool-box">
              <div className="box-title">Read it with the Nix</div>
              <Measure key={draftKey} kind="topup" n={100} text={text} setText={setText} nixInfo={nixInfo} onNix={loadNix} />
            </section>
            <section className="tool-box">
              <div className="row">
                <button className="btn" disabled={!!busy || !text.trim()} onClick={check}>{busy === 'check' ? 'Checking…' : 'Check readings'}</button>
                <button className="btn primary" disabled={!!busy || !text.trim() || !owner} onClick={topBuild}>{busy === 'build' ? 'Rebuilding…' : 'Add & rebuild profile'}</button>
              </div>
              <CheckResult r={checkRes} />
              {built?.added && (
                <div className="pm-result">
                  <div className="ok-text"><b>{built.name}</b> rebuilt from {built.patches} patches ({built.added} new).</div>
                  <div>Error on the hard colors: ΔE avg {built.before.avg} → <b>{built.after.avg}</b> (max {built.before.max} → {built.after.max}). Same profile name, so papers keep using it.</div>
                </div>
              )}
            </section>
          </>)}
        </div>)}
        {msg && <div className="studio-msg" style={{ marginTop: 8 }}>{msg}</div>}
        <div className="modal-foot"><span className="muted small">Readings are kept with each profile for top-ups.</span><button className="btn primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
