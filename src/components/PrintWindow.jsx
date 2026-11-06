// The Print window — InkSign's version of Flexi's "RIP and Print". Pick the printer, press
// "Get media from printer" to read the roll that's loaded (media preset and width, straight from the HP),
// then lay the job out on the media in the preview — position, size, rotation, copies, tiling — pick the
// print mode and color settings, and send. What you see in the preview is where it prints: the printer's
// origin is the bottom-right corner (x from the right edge, y along the feed), the same as Flexi.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { plan, fitScale, printableWidth, shownSize, trimLines, LABEL_MM } from '../lib/printPlan.js';
import { renderPages, b64ToBytes } from '../lib/pdfRender.js';
import HpProfileMaker from './HpProfileMaker.jsx';

const api = window.inksign;
const MM = 25.4;
const KEY = 'inksign.printWindow';
const load = () => { try { return JSON.parse(window.localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const save = (v) => { try { window.localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* not saved */ } };
const fmt = (mm, d = 3) => String(+(mm / MM).toFixed(d));
const ROLL_PRINTERS = ['hp-latex', 'flexi-hotfolder'];

function In({ label, mm, onChange, icon, disabled, step = 0.125, title }) {
  const [t, setT] = useState(fmt(mm));
  useEffect(() => setT(fmt(mm)), [mm]);
  const go = () => { const v = parseFloat(t); if (Number.isFinite(v)) onChange(v * MM); else setT(fmt(mm)); };
  return (
    <label className="pw-in" title={title || label}>
      {icon && <span className="pw-ic">{icon}</span>}
      {label && <span className="pw-lb">{label}</span>}
      <input type="number" step={step} value={t} disabled={disabled} onChange={(e) => setT(e.target.value)} onBlur={go} onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />
      <em>in</em>
    </label>
  );
}
function Num({ label, value, onChange, unit, step = 1, min = 0, icon, title }) {
  const [t, setT] = useState(String(value));
  useEffect(() => setT(String(value)), [value]);
  const go = () => { const v = parseFloat(t); if (Number.isFinite(v)) onChange(Math.max(min, v)); else setT(String(value)); };
  return (
    <label className="pw-in" title={title || label}>
      {icon && <span className="pw-ic">{icon}</span>}
      {label && <span className="pw-lb">{label}</span>}
      <input type="number" step={step} value={t} onChange={(e) => setT(e.target.value)} onBlur={go} onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />
      {unit && <em>{unit}</em>}
    </label>
  );
}

/**
 * props: devices, jobs, source ({ scene } or { pdfBase64 }), previewPdfBase64 (job PDF for the thumbnail),
 *        jobSize { w, h } (mm), name, hasCutLines, onClose, onSent(text)
 */
export default function PrintWindow({ devices, jobs = [], source, previewPdfBase64, jobSize, name, hasCutLines, onClose, onSent }) {
  const printers = devices.filter((d) => d.kind === 'printer');
  const saved = useMemo(load, []);
  const [deviceId, setDeviceId] = useState(saved.deviceId && printers.some((p) => p.id === saved.deviceId) ? saved.deviceId : printers[0]?.id || '');
  const dev = printers.find((d) => d.id === deviceId);
  const isHp = dev?.driver === 'hp-latex';
  const isRoll = ROLL_PRINTERS.includes(dev?.driver);
  const [tab, setTab] = useState('layout');
  const [media, setMedia] = useState(() => ({
    widthMm: (Number(dev?.config?.rollWidthIn) || 54) * MM, lengthMm: null, name: 'Typed in',
    margins: { left: 9, right: 9, lead: 0, trail: 0, ...(saved.margins || {}) },
  }));
  const [printer, setPrinter] = useState(null); // last answer from the printer
  const [asking, setAsking] = useState(false);
  const [set, setSet] = useState(() => ({ scale: 100, rotate: 0, x: 0, y: 0, copies: 1, gapX: 12.7, gapY: 12.7, tile: false, overlap: 19.05, labels: false, trim: false, ...(saved.set || {}), copies: 1, x: 0, y: 0, scale: 100, rotate: 0 }));
  const [hpMedia, setHpMedia] = useState([]);
  const [hpModes, setHpModes] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [color, setColor] = useState(() => ({ mediaId: '', modeKey: '', icc: 'auto', intent: '0', keepCut: false, ...(saved.color || {}) }));
  const [sendMode, setSendMode] = useState('now');
  const [repeat, setRepeat] = useState(1);
  const [jobName, setJobName] = useState(name || 'Print');
  const [thumb, setThumb] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [profMaker, setProfMaker] = useState(false);
  const up = (patch) => setSet((s) => ({ ...s, ...patch }));

  useEffect(() => { save({ deviceId, margins: media.margins, set: { gapX: set.gapX, gapY: set.gapY, overlap: set.overlap, labels: set.labels, trim: set.trim, tile: set.tile }, color }); }, [deviceId, media.margins, set, color]);
  useEffect(() => {
    if (!previewPdfBase64) return;
    renderPages(b64ToBytes(previewPdfBase64), { maxPages: 1, width: 1000 }).then((r) => setThumb(r.images[0])).catch(() => setThumb(null));
  }, [previewPdfBase64]);
  // the printer's media presets, print modes and color profiles
  useEffect(() => {
    if (!isHp) { setHpMedia([]); return; }
    api.print.fieldOptions(dev.id, 'hpMedia').then((m) => {
      setHpMedia(m);
      setColor((c) => ({ ...c, mediaId: m.some((x) => x.value === c.mediaId) ? c.mediaId : (dev.config.mediaId || m[0]?.value || '') }));
    }).catch(() => setHpMedia([]));
    api.print.fieldOptions(dev.id, 'hpProfile').then(setProfiles).catch(() => setProfiles([]));
    setMedia((m) => ({ ...m, widthMm: (Number(dev.config.rollWidthIn) || 54) * MM, name: 'Typed in' }));
    setPrinter(null);
  }, [deviceId]);
  useEffect(() => {
    if (!isHp || !color.mediaId) return;
    api.print.fieldOptions(dev.id, 'hpMode', { mediaId: color.mediaId }).then((m) => {
      setHpModes(m);
      setColor((c) => ({ ...c, modeKey: m.some((x) => x.value === c.modeKey) ? c.modeKey : '' }));
    }).catch(() => setHpModes([]));
  }, [color.mediaId, deviceId]);
  useEffect(() => { setColor((c) => ({ ...c, keepCut: dev?.driver === 'flexi-hotfolder' })); }, [dev?.driver]);

  const askPrinter = async () => {
    setErr(''); setAsking(true);
    try {
      const st = await api.print.printerState(dev.id);
      setPrinter(st);
      if (st.media && st.media.widthMm) setMedia((m) => ({ ...m, widthMm: st.media.widthMm, lengthMm: st.media.lengthMm || null, name: st.media.mediaType || 'Loaded roll' }));
      if (st.mediaMatch) setColor((c) => ({ ...c, mediaId: st.mediaMatch.id }));
      if (!st.media || !st.media.widthMm) setErr('The printer says no media is loaded.');
    } catch (e) { setErr(e.message); } finally { setAsking(false); }
  };
  // ask as soon as an HP is picked, the way Flexi fills in the loaded roll
  useEffect(() => { if (isHp && dev.config.host) askPrinter(); }, [deviceId]);

  const job = jobSize || { w: 100, h: 100 };
  const labelText = `${jobName} · ${fmt(shownSize(job, set).w, 2)}" × ${fmt(shownSize(job, set).h, 2)}" · ${new Date().toLocaleDateString()}`;
  const p = useMemo(() => plan(job, { ...set, labelText }, media), [job.w, job.h, set, media, labelText]);
  const sz = shownSize(job, set);
  const pw = printableWidth(media);

  const setW = (w) => { const base = set.rotate % 180 ? job.h : job.w; up({ scale: Math.max(1, (w / base) * 100) }); };
  const setH = (h) => { const base = set.rotate % 180 ? job.w : job.h; up({ scale: Math.max(1, (h / base) * 100) }); };
  const center = () => up({ x: Math.max(0, (pw - sz.w) / 2) });

  const send = async () => {
    setErr(''); setBusy(true);
    try {
      if (isRoll && p.problems.length) throw new Error(p.problems[0]);
      const layout = isRoll ? { pieces: p.pieces, usedW: p.usedW, usedL: p.usedL, scale: set.scale, rotate: set.rotate, labels: p.labels.map((l) => ({ ...l, text: labelText })), trim: set.trim ? trimLines(p.pieces) : [] } : null;
      await api.print.send(dev.id, source, layout, {
        name: jobName, sendMode, repeat, keepCutLines: color.keepCut, rightMarginMm: media.margins.right, mediaWidthMm: media.widthMm,
        hpMediaId: isHp ? color.mediaId : undefined, hpModeKey: isHp ? color.modeKey : undefined, icc: isHp ? color.icc : undefined, intent: isHp ? color.intent : undefined,
      });
      onSent(sendMode === 'hold' ? `“${jobName}” is held in the queue for ${dev.name}` : `“${jobName}” sent to ${dev.name}`);
      onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const devJobs = jobs.filter((j) => j.deviceId === deviceId).slice(-6).reverse();
  const usedFt = p.usedL / MM / 12;
  const sqft = (p.usedL * media.widthMm) / (MM * MM * 144);
  const marginSet = (k, v) => setMedia((m) => ({ ...m, margins: { ...m.margins, [k]: Math.max(0, v) } }));

  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pw">
        <div className="pw-head">
          <div className="pw-printer">
            <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              {printers.map((d) => <option key={d.id} value={d.id}>{d.name}{d.config?.host ? ` @ ${d.config.host}` : ''}</option>)}
            </select>
            <div className={`pw-status ${printer?.alerts?.some((a) => a.severity === 'Error') ? 'bad' : printer ? 'ok' : ''}`}>
              {!dev ? 'Add a printer under Devices' : !isHp ? (isRoll ? 'Roll printer — type the media width' : 'Prints the page as laid out in the design') : asking ? 'Asking the printer…' : printer ? (printer.statusText || 'Connected') : 'Not asked yet'}
            </div>
            {printer?.ink?.length > 0 && (
              <div className="pw-inkline" title="Ink left in each cartridge">
                {printer.ink.map((k, i) => <span key={`${k.code}${i}`} className={k.percent != null && k.percent < 15 ? 'low' : ''}><i style={{ background: k.css }} />{k.code} {k.percent ?? '?'}%</span>)}
              </div>
            )}
          </div>
          <div className="pw-joblist">
            <div className="pw-jl-head"><span>Job</span><span>Status</span></div>
            {devJobs.length ? devJobs.map((j) => <div key={j.id} className="pw-jl-row"><span>{j.name}</span><span>{j.status}</span></div>) : <div className="pw-jl-row muted"><span>No jobs on this printer yet</span><span /></div>}
          </div>
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>

        <div className="pw-body">
          <div className="pw-left">
            <div className="seg pw-tabs">
              <button className={tab === 'layout' ? 'on' : ''} onClick={() => setTab('layout')}>Layout</button>
              <button className={tab === 'tile' ? 'on' : ''} onClick={() => setTab('tile')}>Tiling</button>
              <button className={tab === 'color' ? 'on' : ''} onClick={() => setTab('color')}>Print mode & color</button>
            </div>

            {tab === 'layout' && (
              <div className="pw-panel">
                <fieldset>
                  <legend>Material</legend>
                  <div className="row">
                    <div className="pw-medianame" title="The roll the printer says is loaded">{media.name}</div>
                    <button className="btn small primary" disabled={!isHp || asking} onClick={askPrinter} title="Read the loaded media and its width from the printer">{asking ? 'Asking…' : '⟳ Get media from printer'}</button>
                  </div>
                  <div className="pw-pair">
                    <In icon="↔" label="Width" mm={media.widthMm} onChange={(v) => setMedia((m) => ({ ...m, widthMm: Math.max(50, v), name: 'Typed in' }))} />
                    <In icon="↕" label="Length" mm={media.lengthMm || 0} onChange={(v) => setMedia((m) => ({ ...m, lengthMm: v > 0 ? v : null }))} title="Length left on the roll (0 = unknown)" />
                  </div>
                  <div className="pw-sub">Margins</div>
                  <div className="pw-pair">
                    <In label="Right (origin)" mm={media.margins.right} onChange={(v) => marginSet('right', v)} step={0.0625} />
                    <In label="Left" mm={media.margins.left} onChange={(v) => marginSet('left', v)} step={0.0625} />
                  </div>
                  <div className="muted small">Printable width {fmt(pw, 2)}″</div>
                </fieldset>
                <label className="pw-row"><span>Send mode</span>
                  <select value={sendMode} onChange={(e) => setSendMode(e.target.value)}>
                    <option value="now">Send now</option><option value="hold">Hold in the queue</option>
                  </select>
                </label>
                <fieldset>
                  <legend>Position <small className="muted">(from the right edge · along the feed)</small></legend>
                  <div className="pw-pair">
                    <In icon="⇤" label="From right" mm={set.x} onChange={(v) => up({ x: Math.max(0, v) })} />
                    <In icon="⇡" label="Along" mm={set.y} onChange={(v) => up({ y: Math.max(0, v) })} />
                  </div>
                  <div className="row"><button className="btn small" onClick={() => up({ x: 0, y: 0 })}>To the origin</button><button className="btn small" onClick={center}>Center across</button></div>
                </fieldset>
                <fieldset>
                  <legend>Job size</legend>
                  <div className="pw-pair">
                    <In icon="↔" label="Width" mm={sz.w} onChange={setW} />
                    <Num icon="%" label="Scale" value={Math.round(set.scale * 1000) / 1000} unit="%" step={1} onChange={(v) => up({ scale: Math.max(1, v) })} />
                  </div>
                  <div className="pw-pair">
                    <In icon="↕" label="Height" mm={sz.h} onChange={setH} />
                    <label className="check"><input type="checkbox" checked={!!set.fit} onChange={(e) => up({ fit: e.target.checked, scale: e.target.checked ? fitScale(job, set, media) : 100 })} /> Fit to media</label>
                  </div>
                  <div className="row">
                    <span className="muted small">Turn</span>
                    {[0, 90, 180, 270].map((r) => <button key={r} className={`btn small ${set.rotate === r ? 'primary' : ''}`} onClick={() => up({ rotate: r, ...(set.fit ? { scale: fitScale(job, { ...set, rotate: r }, media) } : {}) })}>{r}°</button>)}
                  </div>
                </fieldset>
                <fieldset>
                  <legend>Copies</legend>
                  <div className="pw-pair">
                    <Num icon="⧉" label="Copies" value={set.copies} min={1} onChange={(v) => up({ copies: Math.max(1, Math.round(v)) })} />
                    <In icon="⟷" label="Space across" mm={set.gapX} onChange={(v) => up({ gapX: Math.max(0, v) })} step={0.0625} />
                  </div>
                  <div className="pw-pair">
                    <span />
                    <In icon="⇕" label="Space along" mm={set.gapY} onChange={(v) => up({ gapY: Math.max(0, v) })} step={0.0625} />
                  </div>
                </fieldset>
                <fieldset>
                  <legend>Repeat job</legend>
                  <Num label="Send the job" value={repeat} min={1} unit="times" onChange={(v) => setRepeat(Math.max(1, Math.round(v)))} />
                </fieldset>
              </div>
            )}

            {tab === 'tile' && (
              <div className="pw-panel">
                <fieldset>
                  <legend>Tiling</legend>
                  <label className="check"><input type="checkbox" checked={!!set.tile} onChange={(e) => up({ tile: e.target.checked })} /> Tile jobs wider than the media into panels</label>
                  <In label="Overlap between panels" mm={set.overlap} onChange={(v) => up({ overlap: Math.max(0, v) })} step={0.125} />
                  <div className="muted small">
                    {p.tiles > 1 ? `${p.tiles} panels, each about ${fmt(p.pieces[0]?.w || 0, 2)}″ wide, printed one after another along the roll.` : 'The job fits across — no tiling needed.'}
                  </div>
                </fieldset>
                <fieldset>
                  <legend>Marks and labels</legend>
                  <label className="check"><input type="checkbox" checked={!!set.trim} onChange={(e) => up({ trim: e.target.checked })} /> Trim marks around each piece</label>
                  <label className="check"><input type="checkbox" checked={!!set.labels} onChange={(e) => up({ labels: e.target.checked })} /> Print dimensions and label</label>
                  {set.labels && <div className="muted small">{labelText}</div>}
                </fieldset>
              </div>
            )}

            {tab === 'color' && (
              <div className="pw-panel">
                {isHp ? (
                  <fieldset>
                    <legend>Output settings</legend>
                    <label className="pw-row"><span>Media preset</span>
                      <select value={color.mediaId} onChange={(e) => setColor((c) => ({ ...c, mediaId: e.target.value }))}>
                        {hpMedia.map((m) => <option key={m.value} value={m.value}>{m.label}{printer?.mediaMatch?.id === m.value ? ' — loaded' : ''}</option>)}
                      </select>
                    </label>
                    {printer?.media?.mediaKey && printer.mediaMatch && color.mediaId !== printer.mediaMatch.id && <div className="warn-text small">The printer has {printer.mediaMatch.name} loaded.</div>}
                    <label className="pw-row"><span>Print mode</span>
                      <select value={color.modeKey} onChange={(e) => setColor((c) => ({ ...c, modeKey: e.target.value }))}>{hpModes.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select>
                    </label>
                    <label className="pw-row"><span>Output profile</span>
                      <select value={color.icc} onChange={(e) => setColor((c) => ({ ...c, icc: e.target.value }))}>{profiles.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select>
                    </label>
                    <button className="btn small" onClick={() => setProfMaker(true)} title="Print a chart, read it with the Nix Mini, build an ICC profile for this media and print mode">Make a profile for this media with the Nix…</button>
                    <label className="pw-row"><span>Rendering intent</span>
                      <select value={color.intent} onChange={(e) => setColor((c) => ({ ...c, intent: e.target.value }))}>
                        <option value="0">Perceptual (photos)</option><option value="1">Relative colorimetric (logos, spot colors)</option><option value="2">Saturation (bold graphics)</option><option value="3">Absolute colorimetric (proofing)</option>
                      </select>
                    </label>
                  </fieldset>
                ) : <p className="muted">{dev?.driver === 'flexi-hotfolder' ? 'Flexi sets the media, print mode and color for this hot folder.' : 'This printer uses its own settings.'}</p>}
                {hasCutLines && (
                  <fieldset>
                    <legend>Cut lines</legend>
                    <label className="check"><input type="checkbox" checked={color.keepCut} onChange={(e) => setColor((c) => ({ ...c, keepCut: e.target.checked }))} /> Send the CutContour lines with the print (for a RIP that cuts, like Flexi)</label>
                    {!color.keepCut && <div className="muted small">Cut lines are left off the print.</div>}
                  </fieldset>
                )}
                {printer && (
                  <fieldset>
                    <legend>The printer says</legend>
                    {printer.media && <div className="small">Loaded: <b>{printer.media.mediaType || '—'}</b>, {fmt(printer.media.widthMm || 0, 2)}″ wide{printer.media.trayType ? ` (${printer.media.trayType})` : ''}</div>}
                    {printer.alerts.filter((a) => a.id !== 'ready').map((a, i) => <div key={i} className={a.severity === 'Error' ? 'error small' : 'warn-text small'}>{a.severity}: {a.text}</div>)}
                    {printer.ink.length > 0 && (
                      <div className="pw-ink">
                        {printer.ink.map((k, i) => (
                          <span key={`${k.code}${i}`} title={`${k.name}: ${k.percent ?? '?'}%${k.state === 'nonHP' ? ' (non-HP / refilled cartridge)' : ''}${k.product ? ` · ${k.product}` : ''} · slot ${k.slot}`}>
                            <b>{k.percent ?? '?'}%</b>
                            <span className="pw-ink-tank"><i style={{ height: `${Math.max(2, k.percent || 0)}%`, background: k.css }} /></span>
                            <small>{k.code}</small>
                          </span>
                        ))}
                      </div>
                    )}
                    {printer.heads?.length > 0 && (
                      <div className="small muted">Printheads: {printer.heads.map((h) => `slot ${h.slot} ${h.state === 'expired' ? '(past warranty date)' : h.state === 'nonHP' ? '(non-HP)' : h.state || ''}`.trim()).join(' · ')}</div>
                    )}
                  </fieldset>
                )}
              </div>
            )}
          </div>

          <div className="pw-right">
            <Preview media={media} p={p} sz={sz} set={set} job={job} thumb={thumb} onMove={(x, y) => up({ x: Math.max(0, x), y: Math.max(0, y) })} isRoll={isRoll} />
          </div>
        </div>

        <div className="pw-foot">
          <label className="pw-name">Job name <input type="text" value={jobName} onChange={(e) => setJobName(e.target.value)} /></label>
          <div className="pw-sum">
            {isRoll ? <>Printed {fmt(sz.w, 2)}″ × {fmt(sz.h, 2)}″{set.copies > 1 ? ` × ${set.copies}` : ''}{p.tiles > 1 ? ` in ${p.tiles} panels` : ''} · uses {usedFt < 1 ? `${fmt(p.usedL, 1)}″` : `${usedFt.toFixed(2)} ft`} of media ({sqft.toFixed(1)} sq ft)</> : `${fmt(job.w, 2)}″ × ${fmt(job.h, 2)}″ page`}
          </div>
          <span className="error">{err || (isRoll && p.problems[0]) || ''}</span>
          <div className="row">
            <button className="btn" onClick={onClose}>Done</button>
            <button className="btn primary" disabled={!dev || busy || (isRoll && p.problems.length > 0)} onClick={send}>{busy ? 'Sending…' : sendMode === 'hold' ? 'Send to queue' : 'Send'}</button>
          </div>
        </div>
      </div>
      {profMaker && dev && (
        <HpProfileMaker devices={devices} deviceId={dev.id} mediaId={color.mediaId} modeKey={color.modeKey}
          onClose={async () => { setProfMaker(false); setProfiles(await api.print.fieldOptions(dev.id, 'hpProfile').catch(() => profiles)); }} />
      )}
    </div>
  );
}

// Media preview: the printer's origin is the bottom-right; the roll feeds up the screen
function Preview({ media, p, sz, set, job, thumb, onMove, isRoll }) {
  const box = useRef(null);
  const [size, setSize] = useState({ w: 600, h: 600 });
  const [drag, setDrag] = useState(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const M = media.widthMm, mr = media.margins.right, ml = media.margins.left;
  const showL = Math.max(p.usedL + 100, Math.min(media.lengthMm || Infinity, Math.max(p.usedL * 1.25, M * 0.6)));
  const RUL = 24, PAD = 16;
  const z = Math.min((size.w - RUL - 2 * PAD) / M, (size.h - RUL - 2 * PAD) / showL);
  const ox = RUL + PAD + ((size.w - RUL - 2 * PAD) - M * z) / 2, oy = PAD;
  // media coords: X from the right edge of the media, Y along the feed from the bottom of the view
  const sx = (xFromRight) => ox + (M - xFromRight) * z;
  const sy = (yAlong) => oy + (showL - yAlong) * z;
  const W0 = job.w * (set.scale / 100), H0 = job.h * (set.scale / 100);
  const r = set.rotate || 0;
  const imgTf = r === 90 ? `translate(${H0} 0) rotate(90)` : r === 180 ? `translate(${W0} ${H0}) rotate(180)` : r === 270 ? `translate(0 ${W0}) rotate(270)` : '';
  const stepIn = z * MM > 60 ? 1 : z * MM > 18 ? 6 : z * MM > 6 ? 12 : 24;
  const ticksX = [], ticksY = [];
  for (let v = 0; v <= M / MM + 1e-6; v += stepIn) ticksX.push(v);
  for (let v = 0; v <= showL / MM + 1e-6; v += stepIn) ticksY.push(v);
  const first = p.pieces[0];
  const down = (e) => {
    if (!first) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ sx: e.clientX, sy: e.clientY, x: set.x, y: set.y });
  };
  const move = (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.sx) / z, dy = (e.clientY - drag.sy) / z;
    let x = drag.x - dx, y = drag.y - dy;
    const snap = 6 / z;
    if (Math.abs(x) < snap) x = 0;
    if (Math.abs(y) < snap) y = 0;
    onMove(x, y);
  };
  return (
    <div className="pw-preview" ref={box} onPointerMove={move} onPointerUp={() => setDrag(null)}>
      <svg width={size.w} height={size.h}>
        {/* rulers: inches from the right edge, and along the feed */}
        <g className="pw-ruler">
          <rect x={0} y={size.h - RUL} width={size.w} height={RUL} />
          <rect x={0} y={0} width={RUL} height={size.h - RUL} />
          {ticksX.map((v) => <g key={`x${v}`}><line x1={sx(v * MM)} x2={sx(v * MM)} y1={size.h - RUL} y2={size.h - RUL + 6} /><text x={sx(v * MM) - 2} y={size.h - 8} textAnchor="end">{v}</text></g>)}
          {ticksY.map((v) => <g key={`y${v}`}><line y1={sy(v * MM)} y2={sy(v * MM)} x1={RUL - 6} x2={RUL} /><text x={RUL - 8} y={sy(v * MM) - 2} textAnchor="end" transform={`rotate(-90 ${RUL - 8} ${sy(v * MM) - 2})`}>{v}</text></g>)}
        </g>
        {/* the media */}
        <rect x={sx(M)} y={sy(showL)} width={M * z} height={showL * z} fill="#fff" stroke="#888" />
        {media.lengthMm && media.lengthMm <= showL && <line x1={sx(M)} x2={sx(0)} y1={sy(media.lengthMm)} y2={sy(media.lengthMm)} stroke="#e33" strokeDasharray="6 4" />}
        {/* margins */}
        <rect x={sx(mr)} y={sy(showL)} width={mr * z} height={showL * z} fill="url(#pw-hatch)" />
        <rect x={sx(M)} y={sy(showL)} width={ml * z} height={showL * z} fill="url(#pw-hatch)" />
        <defs>
          <pattern id="pw-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#eef0f3" /><line x1="0" y1="0" x2="0" y2="6" stroke="#c9ced6" strokeWidth="2" /></pattern>
        </defs>
        {/* used area */}
        {isRoll && p.usedL > 0 && <rect x={sx(mr + p.usedW)} y={sy(p.usedL)} width={p.usedW * z} height={p.usedL * z} fill="none" stroke="#2aa8ff" strokeDasharray="4 3" />}
        {/* pieces */}
        {p.pieces.map((pc, i) => {
          const [u0, v0, u1, v1] = pc.clip;
          const X = sx(mr + pc.x + pc.w), Y = sy(pc.y + pc.h);
          return (
            <g key={i} onPointerDown={i === 0 ? down : undefined} style={{ cursor: i === 0 ? 'move' : 'default' }}>
              <svg x={X} y={Y} width={pc.w * z} height={pc.h * z} viewBox={`${u0} ${v0} ${u1 - u0} ${v1 - v0}`} preserveAspectRatio="none">
                {thumb ? <image href={thumb} x={0} y={0} width={W0} height={H0} transform={imgTf} preserveAspectRatio="none" />
                  : <rect x={0} y={0} width={sz.w} height={sz.h} fill="#9fc6ff" />}
              </svg>
              <rect x={X} y={Y} width={pc.w * z} height={pc.h * z} fill="none" stroke={i === 0 ? '#ff7a1a' : '#e46b1a'} strokeWidth={i === 0 ? 2 : 1} />
              {(pc.tile > 0 || p.pieces.length > 1) && <text x={X + 4} y={Y + 14} className="pw-piece-label">{pc.tile ? `Panel ${pc.tile}` : ''}{pc.tile && pc.copy > 1 ? ` · ` : ''}{p.pieces.length > 1 && (!pc.tile || pc.copy > 1) ? `Copy ${pc.copy}` : ''}</text>}
            </g>
          );
        })}
        {p.labels.map((l, i) => <rect key={`l${i}`} x={sx(mr + l.x) - Math.min(p.usedW, 120) * z} y={sy(l.y + LABEL_MM - 2)} width={Math.min(p.usedW, 120) * z} height={(LABEL_MM - 3) * z} fill="#d7dbe2" />)}
        {/* origin */}
        <circle cx={sx(mr)} cy={sy(0)} r={5} fill="#ff7a1a" />
        <text x={sx(mr) - 8} y={sy(0) - 8} textAnchor="end" className="pw-origin">origin</text>
        <text x={sx(M / 2)} y={sy(0) + 14} textAnchor="middle" className="pw-feed">▲ first out of the printer</text>
      </svg>
    </div>
  );
}
