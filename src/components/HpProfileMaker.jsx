// Profile maker for the HP Latex — the same steps as the Xerox one and InkRIP's: print a chart on the
// loaded roll (in the media preset and print mode you're profiling, colour management off), read it
// with the Nix Mini, check the readings, build the ICC profile. The profile is then used automatically
// ("Auto") whenever that media + print mode prints from InkSign. Top-up charts add 100 hard colours.
import React, { useEffect, useState } from 'react';
import { Measure, CheckResult, NixSetup } from './server/ProfileMaker.jsx';

const api = window.inksign;
const COUNTS = [100, 150, 200, 300, 400];
const ls = {
  get: (k) => { try { return window.localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* not saved */ } },
  del: (k) => { try { window.localStorage.removeItem(k); } catch { /* fine */ } },
};
const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export default function HpProfileMaker({ devices, owner = true, deviceId: startDevice, mediaId: startMedia, modeKey: startMode, onClose }) {
  const hps = devices.filter((d) => d.driver === 'hp-latex');
  const [tab, setTab] = useState('new');
  const [deviceId, setDeviceId] = useState(startDevice || hps[0]?.id || '');
  const dev = hps.find((d) => d.id === deviceId);
  const [media, setMedia] = useState([]);
  const [modes, setModes] = useState([]);
  const [mediaId, setMediaId] = useState(startMedia || '');
  const [modeKey, setModeKey] = useState(startMode || '');
  const [loaded, setLoaded] = useState(null);
  const [count, setCount] = useState(200);
  const [nixInfo, setNixInfo] = useState(null);
  const [sent, setSent] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [checkRes, setCheckRes] = useState(null);
  const [built, setBuilt] = useState(null);
  const [name, setName] = useState('');
  const [tac, setTac] = useState(300);
  const [gcr, setGcr] = useState('medium');
  const [assign, setAssign] = useState(true);
  const [topups, setTopups] = useState([]);
  const [topId, setTopId] = useState('');
  const draftKey = tab === 'topup' ? `inksign.hpprof.topup.${topId}` : `inksign.hpprof.${deviceId}.${mediaId}.${modeKey}.${count}`;
  const [text, setTextRaw] = useState('');
  const setText = (t) => { setTextRaw(t); if (t) ls.set(draftKey, t); else ls.del(draftKey); };

  const loadNix = () => api.nix.info().then(setNixInfo).catch(() => {});
  const loadTopups = () => api.hpProfiling.topups().then((l) => { setTopups(l); setTopId((id) => id || l[0]?.id || ''); }).catch(() => {});
  useEffect(() => { loadNix(); loadTopups(); }, []);
  useEffect(() => { setTextRaw(ls.get(draftKey) || ''); setCheckRes(null); setBuilt(null); }, [draftKey]);
  useEffect(() => {
    if (!dev) return;
    api.print.fieldOptions(dev.id, 'hpMedia').then((m) => { setMedia(m); setMediaId((id) => (m.some((x) => x.value === id) ? id : dev.config.mediaId || m[0]?.value || '')); }).catch(() => setMedia([]));
    // what's loaded right now — profile the roll that's in the printer
    api.print.printerState(dev.id).then((st) => { setLoaded(st); if (st.mediaMatch && !startMedia) setMediaId(st.mediaMatch.id); }).catch(() => setLoaded(null));
  }, [deviceId]);
  useEffect(() => {
    if (!dev || !mediaId) return;
    api.print.fieldOptions(dev.id, 'hpMode', { mediaId }).then((m) => {
      const real = m.filter((x) => x.value);
      setModes(real);
      setModeKey((k) => (real.some((x) => x.value === k) ? k : real.find((x) => /^8p-L10-E/.test(x.value))?.value || real[0]?.value || ''));
    }).catch(() => setModes([]));
  }, [mediaId, deviceId]);
  const mediaName = media.find((m) => m.value === mediaId)?.label || '';
  const modeName = modes.find((m) => m.value === modeKey)?.label || '';
  useEffect(() => { setName(dev ? `${/115/.test(dev.config.model || '') ? 'HP Latex 115' : 'HP Latex 335'} – ${mediaName.replace(/ \(shop preset\)$/, '')} ${modeName}`.trim() : ''); }, [deviceId, mediaName, modeName]);
  const top = topups.find((t) => t.id === topId);
  const getPatches = (kind, n) => api.hpProfiling.patches(kind, n);

  const go = async (label, fn) => { setBusy(label); setMsg(''); try { await fn(); } catch (e) { setMsg(cleanErr(e)); } finally { setBusy(''); } };
  const printChart = (kind) => go('chart', async () => {
    setSent(await api.hpProfiling.chart(kind === 'topup' ? { kind: 'topup', profileId: topId } : { kind: 'main', deviceId, mediaId, modeKey, patches: count, widthIn: loaded?.media?.widthMm ? loaded.media.widthMm / 25.4 : undefined }));
  });
  const check = () => go('check', async () => setCheckRes(await api.hpProfiling.check(tab === 'topup' ? { kind: 'topup', profileId: topId, text } : { kind: 'main', patches: count, text })));
  const build = () => go('build', async () => {
    setBuilt(await api.hpProfiling.build({ deviceId, mediaId, modeKey, patches: count, text, name, tac, gcr, assign }));
    ls.del(draftKey); loadTopups();
  });
  const topBuild = () => go('build', async () => { setBuilt(await api.hpProfiling.topupBuild({ profileId: topId, text })); ls.del(draftKey); loadTopups(); });

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal pm-modal">
        <div className="modal-head"><h2>Profile maker — HP Latex</h2><button className="btn ghost" onClick={onClose}>✕</button></div>
        <p className="muted small">Same system as InkRIP's and the Xerox's: print a chart, read it with the Nix, InkSign builds the ICC profile. One profile per media and print mode — InkSign then uses it automatically for that media and mode. Run the printer's own color calibration for the media first (front panel › Color calibration).</p>
        <div className="seg" style={{ margin: '8px 0 12px' }}>
          {[['new', 'New profile'], ['topup', 'Top-up'], ['nix', 'Nix on USB']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); setSent(null); setMsg(''); }}>{l}</button>)}
        </div>

        {tab === 'nix' && <NixSetup info={nixInfo} onChange={loadNix} />}

        {tab === 'new' && (<div className="pm-steps">
          <section className="tool-box">
            <div className="box-title"><span className="pm-step">1</span> Print the chart</div>
            {!hps.length && <div className="warn-text">Add the HP Latex under Devices first.</div>}
            <div className="mini-row">
              <label className="mini-field"><span>Printer</span>
                <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>{hps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
              </label>
              <label className="mini-field" style={{ maxWidth: 140 }}><span>Patches</span>
                <select value={count} onChange={(e) => setCount(Number(e.target.value))}>{COUNTS.map((c) => <option key={c} value={c}>{c}{c === 200 ? ' (best start)' : ''}</option>)}</select>
              </label>
            </div>
            <div className="mini-row">
              <label className="mini-field"><span>Media preset</span>
                <select value={mediaId} onChange={(e) => setMediaId(e.target.value)}>{media.map((m) => <option key={m.value} value={m.value}>{m.label}{loaded?.mediaMatch?.id === m.value ? ' — loaded' : ''}</option>)}</select>
              </label>
              <label className="mini-field"><span>Print mode</span>
                <select value={modeKey} onChange={(e) => setModeKey(e.target.value)}>{modes.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select>
              </label>
            </div>
            {loaded?.media && <div className="help">Loaded now: {loaded.media.mediaType} ({(loaded.media.widthMm / 25.4).toFixed(2)}″).{loaded.alerts?.some((a) => a.severity === 'Error') ? ` ⚠ The printer reports: ${loaded.alerts.filter((a) => a.severity === 'Error').map((a) => a.text).join('; ')} — fix that first or the chart will be off.` : ''}</div>}
            <div className="row">
              <button className="btn primary" disabled={!!busy || !dev || !mediaId} onClick={() => printChart('main')}>{busy === 'chart' ? 'Sending…' : 'Print the chart'}</button>
              <span className="help">Prints with color management off, in this media preset and print mode, about 24″ wide. Let it cure and cool (10 minutes) before reading.</span>
            </div>
            {sent && <div className="ok-text small">Sent "{sent.job.name}" — {sent.patches} patches ({sent.code}).</div>}
          </section>
          <section className="tool-box">
            <div className="box-title"><span className="pm-step">2</span> Read it with the Nix</div>
            <Measure key={draftKey} kind="main" n={count} text={text} setText={setText} nixInfo={nixInfo} onNix={loadNix} getPatches={getPatches} />
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
              <label className="mini-field"><span>Ink limit (%)</span><input type="number" min="150" max="400" value={tac} onChange={(e) => setTac(Number(e.target.value) || 300)} /></label>
              <label className="mini-field"><span>Black (GCR)</span>
                <select value={gcr} onChange={(e) => setGcr(e.target.value)}><option value="light">Light — more color in darks</option><option value="medium">Medium (InkRIP default)</option><option value="heavy">Heavy — more black, steadier greys</option></select>
              </label>
            </div>
            <label className="check"><input type="checkbox" checked={assign} onChange={(e) => setAssign(e.target.checked)} /> Use it automatically for this media and print mode</label>
            <button className="btn primary" disabled={!!busy || !text.trim() || !owner || !dev} onClick={build}>{busy === 'build' ? 'Building (about 5 s)…' : 'Build profile'}</button>
            {!owner && <div className="help">Only an owner can build profiles.</div>}
            {built && !built.added && (
              <div className="pm-result">
                <div className="ok-text"><b>{built.name}</b> made from {built.patches} patches.</div>
                <div>How well it fits the readings: ΔE avg {built.fit.avg}, max {built.fit.max} {built.fit.avg <= 2 ? '(very good)' : built.fit.avg <= 3.5 ? '(good)' : '(rough — re-scan the flagged patches)'}</div>
                <div className="small">Media white L {built.paperLab.map((v) => v.toFixed(1)).join(' / ')} · darkest L {built.blackLab[0].toFixed(1)}</div>
                {built.assigned ? <div>Now the <b>Auto</b> profile for <b>{built.assigned}</b> — print jobs on that media and mode use it.</div> : <div>Saved. Pick it under Output profile in the Print window.</div>}
                {built.problems?.map((p, i) => <div key={i} className="warn-text">⚠ {p}</div>)}
              </div>
            )}
          </section>
        </div>)}

        {tab === 'topup' && (<div className="pm-steps">
          <section className="tool-box">
            <div className="box-title">Top-up: 100 hard colors (blues, teals, greens, purples, oranges, darks)</div>
            {topups.length ? (<>
              <label className="mini-field"><span>Profile</span>
                <select value={topId} onChange={(e) => setTopId(e.target.value)}>{topups.map((t) => <option key={t.id} value={t.id}>{t.name}{t.toppedUp ? ' (topped up)' : ''}</option>)}</select>
              </label>
              {top && <div className="help">Readings so far: {Object.entries(top.counts).map(([k, v]) => `${k}: ${v}`).join(' · ')}. Prints on {top.mediaName}, {top.modeLabel}.</div>}
              <button className="btn primary" disabled={!!busy || !topId} onClick={() => printChart('topup')}>{busy === 'chart' ? 'Sending…' : 'Print top-up chart'}</button>
              {sent && <div className="ok-text small">Sent "{sent.job.name}".</div>}
            </>) : <div className="muted">No HP profiles made here yet — make one under New profile first.</div>}
          </section>
          {topId && (<>
            <section className="tool-box">
              <div className="box-title">Read it with the Nix</div>
              <Measure key={draftKey} kind="topup" n={100} text={text} setText={setText} nixInfo={nixInfo} onNix={loadNix} getPatches={getPatches} />
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
                  <div>Error on the hard colors: ΔE avg {built.before.avg} → <b>{built.after.avg}</b> (max {built.before.max} → {built.after.max}).</div>
                </div>
              )}
            </section>
          </>)}
        </div>)}
        {msg && <div className="studio-msg" style={{ marginTop: 8 }}>{msg}</div>}
        <div className="modal-foot"><span className="muted small">Readings are kept with each profile for top-ups. Match colors with these profiles on the Color page.</span><button className="btn primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
