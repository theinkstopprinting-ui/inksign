import React, { useEffect, useMemo, useRef, useState } from 'react';
import Preflight from './Preflight.jsx';
import ProofButton from './ProofButton.jsx';
import QuoteDialog from './QuoteDialog.jsx';
import RollCanvas from './shell/RollCanvas.jsx';
import Icon from './shell/Icon.jsx';
import { renderPages, b64ToBytes } from '../lib/pdfRender.js';

const api = window.inksign;
let nextId = 1;
const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function NumIn({ label, value, onChange, step = 1, placeholder, unit }) {
  const [t, setT] = useState(value);
  useEffect(() => setT(value), [value]);
  const commit = () => { if (t !== '' && !Number.isNaN(Number(t))) onChange(Number(t)); };
  return (
    <label className="mini-field"><span>{label}</span>
      <span className="input-unit">
        <input type="number" step={step} value={t} placeholder={placeholder} onChange={(e) => setT(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
        {unit && <em>{unit}</em>}
      </span>
    </label>
  );
}

// Same mapping as the print file: item frame (inches, y down from the art's top-left) -> roll (inches, y down).
function pieceMatrix(p) {
  const f = (X, Yd) => {
    const Y = p.outerH - Yd;
    let u, v;
    if (!p.rotated) { u = X; v = p.outerH - Y; } else { u = Y; v = X; }
    v -= p.crop.y0;
    if (p.extraRot) { const u2 = v, v2 = p.w - u; u = u2; v = v2; }
    return { x: p.x + u, y: p.y + v };
  };
  const o = f(0, 0), ax = f(1, 0), ay = f(0, 1);
  return `matrix(${ax.x - o.x} ${ax.y - o.y} ${ay.x - o.x} ${ay.y - o.y} ${o.x} ${o.y})`;
}

const toB64 = (buf) => {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const finishText = (it) => [it.hemIn > 0 ? (it.hemFill === 'mirror' ? `wrap ${it.hemIn}"` : `hem ${it.hemIn}"`) : '', it.grommets?.on ? `grommets ${it.grommets.spacingIn}"` : ''].filter(Boolean).join(' · ');

export default function WideFormat({ devices, onJobsSent, incoming }) {
  const [order, setOrder] = useState(null);
  const hps = devices.filter((d) => d.driver === 'hp-latex' || d.driver === 'flexi-hotfolder');
  const [deviceId, setDeviceId] = useState('');
  useEffect(() => { if (!hps.some((d) => d.id === deviceId)) setDeviceId(hps[0]?.id || ''); }, [devices]); // eslint-disable-line react-hooks/exhaustive-deps
  const device = hps.find((d) => d.id === deviceId);
  const [settings, setSettings] = useState(null);
  useEffect(() => { api.settings.get().then(setSettings); }, []);
  const [media, setMedia] = useState('Banner 13oz');
  const mediaInfo = settings?.wideMedia?.find((m) => m.name === media);

  const [rollIn, setRollIn] = useState(54);
  useEffect(() => { const w = device?.config?.rollWidthIn || device?.config?.mediaWidthIn; if (w) setRollIn(Number(w)); }, [deviceId]); // eslint-disable-line react-hooks/exhaustive-deps
  // HP printed directly: the printer's media preset and print mode for this job (defaults from the printer's settings)
  const direct = device?.driver === 'hp-latex';
  const [hpMediaId, setHpMediaId] = useState('');
  const [hpModeKey, setHpModeKey] = useState('');
  const [hpMediaList, setHpMediaList] = useState([]);
  const [hpModes, setHpModes] = useState([]);
  useEffect(() => {
    if (!direct) return;
    setHpMediaId(device.config.mediaId || '150100');
    setHpModeKey(device.config.modeKey || '');
    api.devices.fieldOptions('hp-latex', 'hpMedia', device.config).then(setHpMediaList).catch(() => setHpMediaList([]));
  }, [deviceId, direct]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!direct || !hpMediaId) return;
    api.devices.fieldOptions('hp-latex', 'hpMode', { ...device.config, mediaId: hpMediaId }).then(setHpModes).catch(() => setHpModes([]));
  }, [hpMediaId, deviceId, direct]); // eslint-disable-line react-hooks/exhaustive-deps
  const [gapIn, setGapIn] = useState(1);
  const [overlapIn, setOverlapIn] = useState(1);
  const [allowRotate, setAllowRotate] = useState(true);
  const [items, setItems] = useState([]);
  const [selId, setSelId] = useState(null);
  const sel = items.find((i) => i.id === selId);
  const [layout, setLayout] = useState(null);
  const [name, setName] = useState('Banner job');
  const [msg, setMsg] = useState('');
  const [previews, setPreviews] = useState({});
  const [tab, setTab] = useState('piece');
  const [more, setMore] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [sending, setSending] = useState(false);
  // InkFlow roll stock: picking a roll sets the roll width and takes the feet off it when the job finishes
  const [rolls, setRolls] = useState([]);
  const [rollId, setRollId] = useState('');
  const [quoting, setQuoting] = useState(false);
  useEffect(() => { api.shopflow.rolls().then(setRolls).catch(() => setRolls([])); }, []);
  const seq = useRef(0);
  const canvas = useRef(null);

  const add = async () => addFiles(await api.wide.open());
  useEffect(() => {
    if (!incoming || incoming.target !== 'wide') return;
    if (order) { setItems([]); setPreviews({}); setSelId(null); }
    setOrder(incoming.inkflow ? { ...incoming.inkflow, label: incoming.label } : null);
    setName(incoming.name || 'Banner job');
    const ok = incoming.files.filter((f) => ['pdf', 'png', 'jpg'].includes(f.ext));
    if (ok.length < incoming.files.length) setMsg('Wide Format takes PDF, PNG or JPG — other files on this order were skipped.');
    // Use the finished size from the order when there's one file
    const size = incoming.item?.widthIn && incoming.item?.heightIn && ok.length === 1 ? { widthIn: incoming.item.widthIn, heightIn: incoming.item.heightIn, copies: incoming.item.qty || 1 } : null;
    addFiles(ok, true, size);
  }, [incoming]); // eslint-disable-line react-hooks/exhaustive-deps
  const addFiles = async (files, keepMsg, size) => {
    if (!keepMsg) setMsg('');
    for (const f of files) {
      let w = f.widthIn, h = f.heightIn, preview;
      try {
        if (f.ext === 'pdf') {
          const r = await renderPages(b64ToBytes(f.base64), { maxPages: 1, width: 500 });
          preview = r.images[0];
          if (!w || !h) ({ widthIn: w, heightIn: h } = r.sizes[0]);
        } else {
          preview = `data:image/${f.ext === 'png' ? 'png' : 'jpeg'};base64,${f.base64}`;
          const img = new Image(); img.src = preview; await img.decode();
          w = 48; h = +(48 * img.naturalHeight / img.naturalWidth).toFixed(2);
        }
      } catch (e) { setMsg(`Couldn't open ${f.name}: ${clean(e)}`); continue; }
      if (size) { w = size.widthIn; h = size.heightIn; }
      const it = {
        id: `i${nextId++}`, name: f.name, ext: f.ext, base64: f.base64, widthIn: +w.toFixed(3), heightIn: +h.toFixed(3), aspect: w / h,
        lock: true, copies: size?.copies || 1, hemIn: 0, hemFill: 'white', allowRotate: true, grommets: { on: false, spacingIn: 24, insetIn: 0.5 },
      };
      setPreviews((p) => ({ ...p, [it.id]: preview }));
      setItems((l) => [...l, it]);
      setSelId(it.id);
      setTab('piece');
    }
  };
  // Drag files from Explorer onto the page
  const onDrop = async (e) => {
    e.preventDefault(); setDropping(false);
    const files = [];
    for (const f of e.dataTransfer.files) {
      const ext = (f.name.split('.').pop() || '').toLowerCase().replace('jpeg', 'jpg');
      if (!['pdf', 'png', 'jpg'].includes(ext)) { setMsg(`${f.name}: Wide Format takes PDF, PNG or JPG.`); continue; }
      files.push({ name: f.name.replace(/\.[^.]+$/, ''), ext, base64: toB64(await f.arrayBuffer()) });
    }
    if (files.length) addFiles(files, true);
  };
  const update = (id, patch) => setItems((l) => l.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const setSize = (key, v) => {
    if (!sel || v <= 0) return;
    if (!sel.lock) return update(sel.id, { [key]: v });
    if (key === 'widthIn') update(sel.id, { widthIn: v, heightIn: +(v / sel.aspect).toFixed(3) });
    else update(sel.id, { heightIn: v, widthIn: +(v * sel.aspect).toFixed(3) });
  };
  const preset = (kind) => {
    if (!sel) return;
    if (kind === 'banner') update(sel.id, { hemIn: 1, hemFill: 'white', grommets: { on: true, spacingIn: 24, insetIn: 0.5 } });
    if (kind === 'canvas') update(sel.id, { hemIn: 1.75, hemFill: 'mirror', grommets: { ...sel.grommets, on: false } });
    if (kind === 'none') update(sel.id, { hemIn: 0, hemFill: 'white', grommets: { ...sel.grommets, on: false } });
  };
  const remove = () => { if (!sel) return; setItems((l) => l.filter((i) => i.id !== sel.id)); setSelId(null); };
  const duplicate = () => {
    if (!sel) return;
    const it = { ...JSON.parse(JSON.stringify({ ...sel, base64: undefined })), base64: sel.base64, id: `i${nextId++}` };
    setPreviews((p) => ({ ...p, [it.id]: previews[sel.id] }));
    setItems((l) => [...l, it]);
    setSelId(it.id);
  };
  const swap = () => sel && update(sel.id, { widthIn: sel.heightIn, heightIn: sel.widthIn, aspect: 1 / sel.aspect });
  // Delete key removes the selected piece, Ctrl+D duplicates
  useEffect(() => {
    const onKey = (e) => {
      if (/input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key === 'Delete' && sel) { e.preventDefault(); remove(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && sel) { e.preventDefault(); duplicate(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const [whiteSpot, setWhiteSpot] = useState('');
  const opts = useMemo(() => ({ rollWidthIn: Number(rollIn), gapIn: Number(gapIn), overlapIn: Number(overlapIn), allowRotate, white: whiteSpot ? { spot: whiteSpot } : null }), [rollIn, gapIn, overlapIn, allowRotate, whiteSpot]);
  // only geometry goes to the layout call (not the big file data)
  const geoItems = useMemo(() => items.map(({ base64, ...rest }) => rest), [items]);
  useEffect(() => {
    if (!items.length) { setLayout(null); return; }
    const id = ++seq.current;
    api.wide.layout(geoItems, opts).then((L) => { if (id === seq.current) { setLayout(L); setMsg(''); } })
      .catch((e) => { if (id === seq.current) setMsg(clean(e)); });
  }, [geoItems, opts]);

  const est = layout && mediaInfo ? {
    mediaCost: layout.mediaSqFt * mediaInfo.costPerSqFt,
    inkMl: layout.printedSqFt * mediaInfo.inkMlPerSqFt,
  } : null;
  if (est) {
    const pr = settings?.pricing || {};
    est.inkCost = est.inkMl * (settings?.inkCostPerMl || 0);
    est.labor = ((Number(pr.setupMin) || 0) / 60) * (Number(pr.laborPerHour) || 0);
    est.price = Math.max(Number(pr.minimum) || 0, (est.mediaCost + est.inkCost + est.labor) * (Number(pr.markup) || 1));
  }
  // One quote line per piece, the price split by printed area
  const quoteLines = () => {
    const area = (it) => (Number(it.widthIn) || 0) * (Number(it.heightIn) || 0) * (Number(it.copies) || 1);
    const totalArea = items.reduce((s, it) => s + area(it), 0) || 1;
    return items.map((it) => {
      const qty = Number(it.copies) || 1;
      return {
        description: `${it.name.replace(/\.[^.]+$/, '')} — ${media}`, quantity: qty,
        unitPriceCents: Math.round(((est?.price || 0) * (area(it) / totalArea) / qty) * 100),
        widthIn: Number(it.widthIn) || undefined, heightIn: Number(it.heightIn) || undefined, material: media, notes: 'Printed on the HP Latex',
      };
    });
  };

  const send = async () => {
    setMsg(''); setSending(true);
    try { await api.wide.send(deviceId, items, opts, { name, media, inkflow: order, rollId: rollId || undefined, ...(direct ? { hpMediaId, hpModeKey } : {}) }); onJobsSent(); }
    catch (e) { setMsg(clean(e)); } finally { setSending(false); }
  };
  const save = async () => { setMore(false); const p = await api.wide.save(items, opts, name); if (p) setMsg(`Saved ${p}`); };

  const itemById = Object.fromEntries(items.map((i) => [i.id, i]));
  const mediaFolders = device?.config?.mediaFolders || '';
  const hasFolder = mediaFolders.toLowerCase().includes(media.toLowerCase());
  const pieces = items.reduce((s, it) => s + (Number(it.copies) || 1), 0);
  const step = !items.length ? 1 : !layout ? 2 : 3;

  return (
    <div className={`ws ${dropping ? 'dropping' : ''}`} onDragOver={(e) => { e.preventDefault(); setDropping(true); }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDropping(false); }} onDrop={onDrop}>
      {/* ---- toolbar ---- */}
      <div className="ws-toolbar">
        <div className="tb-group">
          <button className="tb-btn primary" onClick={add} title="Add PDF, PNG or JPG files (or drop them anywhere)"><Icon name="plus" /> Add files</button>
          <button className="tb-btn" disabled={!sel} onClick={duplicate} title="Duplicate (Ctrl+D)"><Icon name="copy" /></button>
          <button className="tb-btn" disabled={!sel} onClick={swap} title="Turn 90° (swap width and height)"><Icon name="rotate" /></button>
          <button className="tb-btn" disabled={!sel} onClick={remove} title="Remove (Delete)"><Icon name="trash" /></button>
        </div>
        <div className="tb-group">
          <button className={`tb-btn ${allowRotate ? 'on' : ''}`} onClick={() => setAllowRotate((v) => !v)} title="Nest: turn pieces to use less media"><Icon name="nest" /> Nest</button>
          <button className="tb-btn" onClick={() => canvas.current?.zoom(1 / 1.25)} title="Zoom out"><Icon name="zoomOut" /></button>
          <button className="tb-btn" onClick={() => canvas.current?.fit()} title="Fit the roll"><Icon name="fit" /></button>
          <button className="tb-btn" onClick={() => canvas.current?.zoom(1.25)} title="Zoom in"><Icon name="zoomIn" /></button>
        </div>
        <div className="tb-group tb-setup">
          <label><span>Printer</span>
            <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              {hps.length ? hps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>) : <option value="">No HP set up</option>}
            </select>
          </label>
          <label><span>Media</span>
            <select value={media} onChange={(e) => setMedia(e.target.value)}>
              {(settings?.wideMedia || []).map((m) => <option key={m.name}>{m.name}</option>)}
            </select>
          </label>
          <label className="tb-roll"><span>Roll</span>
            <span className="input-unit"><input type="number" value={rollIn} onChange={(e) => setRollIn(Number(e.target.value) || 0)} /><em>in</em></span>
          </label>
          {direct && (
            <button className="tb-btn" title="Read the loaded roll (media and width) from the printer" onClick={async () => {
              try {
                const st = await api.print.printerState(device.id);
                if (st.media?.widthMm) setRollIn(Math.round((st.media.widthMm / 25.4) * 1000) / 1000);
                if (st.mediaMatch) setHpMediaId(st.mediaMatch.id);
                setMsg(`Loaded: ${st.media?.mediaType || 'unknown media'}, ${((st.media?.widthMm || 0) / 25.4).toFixed(2)}" wide`);
              } catch (e) { setMsg(e.message); }
            }}>⟳ From printer</button>
          )}
        </div>
        <div className="tb-group tb-right">
          <div className="more-wrap">
            <button className="tb-btn" onClick={() => setMore((v) => !v)} disabled={!layout}>More ▾</button>
            {more && (
              <div className="more-menu" onMouseLeave={() => setMore(false)}>
                <button onClick={save}><Icon name="file" /> Save print PDF…</button>
                <ProofButton order={order} disabled={!layout} makeProof={async () => ({ kind: 'wide', name: `${name || 'Banner'} proof.pdf`, note: 'Print layout from InkSign', payload: { items, opts } })} />
                <button disabled={!est} onClick={() => { setMore(false); setQuoting(true); }}><Icon name="money" /> Create InkFlow quote…</button>
              </div>
            )}
          </div>
          <button className="print-btn" disabled={!layout || !deviceId || sending} onClick={send}>
            <Icon name="print" /> {sending ? 'Sending…' : `Print on ${device?.name || 'HP'}`}
          </button>
        </div>
      </div>

      {/* ---- job list ---- */}
      <aside className="ws-left">
        <div className="steps">
          {[['Add files', 1], ['Size & finishing', 2], ['Print', 3]].map(([t, n]) => <div key={n} className={`step ${step === n ? 'now' : step > n ? 'done' : ''}`}><b>{step > n ? <Icon name="check" size={13} /> : n}</b>{t}</div>)}
        </div>
        <div className="ws-left-head"><b>This job</b><span className="muted small">{items.length ? `${items.length} file${items.length > 1 ? 's' : ''} · ${pieces} piece${pieces > 1 ? 's' : ''}` : 'empty'}</span></div>
        <div className="joblist">
          {items.map((it) => (
            <button key={it.id} className={`jobcard ${it.id === selId ? 'on' : ''}`} onClick={() => { setSelId(it.id); setTab('piece'); }}>
              <span className="jobthumb">{previews[it.id] && <img src={previews[it.id]} alt="" />}</span>
              <span className="jobinfo">
                <b>{it.name}</b>
                <span>{it.widthIn}" × {it.heightIn}"{it.copies > 1 ? ` · ${it.copies} copies` : ''}</span>
                {finishText(it) && <span className="muted">{finishText(it)}</span>}
              </span>
            </button>
          ))}
          <button className="dropzone" onClick={add}>
            <Icon name="plus" size={22} />
            <span>Add files</span>
            <small>or drop PDF, PNG, JPG anywhere</small>
          </button>
        </div>
        {order && <div className="order-tag">InkFlow order {order.label} — marked {order.status} when printed. <button className="btn ghost small" onClick={() => setOrder(null)}>Unlink</button></div>}
      </aside>

      {/* ---- roll ---- */}
      <div className="ws-canvas">
        <RollCanvas ref={canvas} widthIn={layout?.lengthIn} heightIn={layout?.rollWidthIn} onBackground={() => setSelId(null)}
          mediaLabel={layout ? `${media} · ${layout.rollWidthIn}" roll · ${(layout.lengthIn / 12).toFixed(2)} ft` : null}
          empty={(
            <div className="canvas-welcome">
              <Icon name="banner" size={46} />
              <h2>Lay out a banner, sign or canvas</h2>
              <p>Add your print files. InkSign places them on the {Number(rollIn)}" roll to use the least media, splits anything wider than the roll into panels, and adds hems, grommet marks or canvas wraps.</p>
              <button className="btn primary" onClick={add}><Icon name="plus" /> Add files</button>
              <small className="muted">or drag them here from your computer</small>
            </div>
          )}>
          {(scale) => {
            const sw = 1 / scale;
            return (<>
              <rect x={0} y={(layout.rollWidthIn - layout.printableW) / 2} width={layout.lengthIn} height={layout.printableW} className="safe" strokeWidth={sw} strokeDasharray={`${5 * sw} ${4 * sw}`} />
              <defs>{layout.pieces.map((p, i) => <clipPath id={`wc${i}`} key={i}><rect x={p.x} y={p.y} width={p.pw} height={p.ph} /></clipPath>)}</defs>
              {layout.pieces.map((p, i) => {
                const it = itemById[p.itemId];
                if (!it) return null;
                const on = it.id === selId;
                return (
                  <g key={i} data-piece onMouseDown={(e) => e.stopPropagation()} onClick={() => { setSelId(it.id); setTab('piece'); }} style={{ cursor: 'pointer' }}>
                    <title>{`${it.name} — ${it.widthIn}" × ${it.heightIn}"`}</title>
                    <g clipPath={`url(#wc${i})`}>
                      <g transform={pieceMatrix(p)}>
                        {it.hemIn > 0 && <rect x={0} y={0} width={p.outerW} height={p.outerH} fill={it.hemFill === 'mirror' ? '#d8dbe2' : '#f3f4f6'} />}
                        <image href={previews[it.id]} x={it.hemIn} y={it.hemIn} width={it.widthIn} height={it.heightIn} preserveAspectRatio="none" />
                        {it.hemIn > 0 && <rect x={it.hemIn} y={it.hemIn} width={it.widthIn} height={it.heightIn} fill="none" stroke="#e6007e" strokeWidth={sw} strokeDasharray={`${3 * sw} ${2 * sw}`} />}
                      </g>
                    </g>
                    <rect x={p.x} y={p.y} width={p.pw} height={p.ph} fill={on ? 'rgba(255,122,26,.08)' : 'none'} stroke={on ? '#ff7a1a' : '#8f98ab'} strokeWidth={sw * (on ? 2.5 : 1)} />
                    {(on || p.tiles > 1) && scale * p.pw > 60 && (
                      <text x={p.x + 4 * sw} y={p.y + p.ph - 5 * sw} fontSize={11 * sw} className="piece-label">{p.tiles > 1 ? p.label : `${it.widthIn}" × ${it.heightIn}"`}</text>
                    )}
                  </g>
                );
              })}
            </>);
          }}
        </RollCanvas>
      </div>

      {/* ---- properties ---- */}
      <aside className="ws-right">
        <div className="ptabs">
          {[['piece', 'Piece'], ['media', 'Media & roll'], ['job', 'Job']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        <div className="ppane">
          {tab === 'piece' && (sel ? (<>
            <div className="pane-title">{sel.name}</div>
            <div className="mini-row">
              <NumIn label="Width" unit="in" value={sel.widthIn} onChange={(v) => setSize('widthIn', v)} step={0.5} />
              <NumIn label="Height" unit="in" value={sel.heightIn} onChange={(v) => setSize('heightIn', v)} step={0.5} />
            </div>
            <label className="check"><input type="checkbox" checked={sel.lock} onChange={(e) => update(sel.id, { lock: e.target.checked })} /> Keep proportions</label>
            <div className="mini-row">
              <NumIn label="Copies" value={sel.copies} onChange={(v) => update(sel.id, { copies: Math.max(1, Math.round(v)) })} />
            </div>
            <label className="check"><input type="checkbox" checked={sel.allowRotate} onChange={(e) => update(sel.id, { allowRotate: e.target.checked })} /> May turn to save media</label>
            <div className="pane-sub">Finishing</div>
            <div className="finish-grid">
              {[['none', 'Trim to size', 'Cut on the edge'], ['banner', 'Hemmed banner', '1" hem + grommets'], ['canvas', 'Canvas wrap', '1.75" mirrored edge']].map(([k, t, d]) => {
                const on = k === 'none' ? !sel.hemIn && !sel.grommets.on : k === 'banner' ? sel.hemIn > 0 && sel.hemFill === 'white' : sel.hemFill === 'mirror' && sel.hemIn > 0;
                return <button key={k} className={`finish-card ${on ? 'on' : ''}`} onClick={() => preset(k)}><b>{t}</b><span>{d}</span></button>;
              })}
            </div>
            <details className="adv">
              <summary>Fine-tune hems and grommets</summary>
              <div className="mini-row">
                <NumIn label="Hem / wrap" unit="in" value={sel.hemIn} onChange={(v) => update(sel.id, { hemIn: Math.max(0, v) })} step={0.25} />
                <label className="mini-field"><span>Hem area</span>
                  <select value={sel.hemFill} onChange={(e) => update(sel.id, { hemFill: e.target.value })}>
                    <option value="white">Blank</option><option value="mirror">Mirrored edge</option>
                  </select>
                </label>
              </div>
              <label className="check"><input type="checkbox" checked={sel.grommets.on} onChange={(e) => update(sel.id, { grommets: { ...sel.grommets, on: e.target.checked } })} /> Grommet marks</label>
              {sel.grommets.on && (
                <div className="mini-row">
                  <NumIn label="Every" unit="in" value={sel.grommets.spacingIn} onChange={(v) => update(sel.id, { grommets: { ...sel.grommets, spacingIn: v } })} step={6} />
                  <NumIn label="From edge" unit="in" value={sel.grommets.insetIn} onChange={(v) => update(sel.id, { grommets: { ...sel.grommets, insetIn: v } })} step={0.25} />
                </div>
              )}
            </details>
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn small" onClick={duplicate}><Icon name="copy" size={14} /> Duplicate</button>
              <button className="btn small danger" onClick={remove}><Icon name="trash" size={14} /> Remove</button>
            </div>
          </>) : <div className="pane-empty">{items.length ? 'Click a piece on the roll (or in the list) to size it and pick its finishing.' : 'Add files to start.'}</div>)}

          {tab === 'media' && (<>
            <label className="mini-field"><span>Printer</span>
              <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>{hps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
            </label>
            <label className="mini-field"><span>Media</span>
              <select value={media} onChange={(e) => setMedia(e.target.value)}>{(settings?.wideMedia || []).map((m) => <option key={m.name}>{m.name}</option>)}</select>
            </label>
            {direct ? (<>
              <label className="mini-field"><span>HP media preset</span>
                <select value={hpMediaId} onChange={(e) => { setHpMediaId(e.target.value); setHpModeKey(''); }}>
                  {!hpMediaList.some((m) => m.value === hpMediaId) && <option value={hpMediaId}>{hpMediaList.length ? '—' : 'Loading…'}</option>}
                  {hpMediaList.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </label>
              <label className="mini-field"><span>Print mode</span>
                <select value={hpModeKey} onChange={(e) => setHpModeKey(e.target.value)}>
                  {hpModes.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </label>
              <div className="help">Printed directly by InkSign — no Flexi needed. Load this media on the printer (same preset name on its front panel).</div>
            </>) : <div className="help">{hasFolder ? `Goes to the "${media}" hot folder in Flexi.` : "Uses the printer's main Flexi hot folder (no hot folder set for this media — Devices → Settings)."}</div>}
            {rolls.length > 0 && (
              <label className="mini-field"><span>Take media off InkFlow roll</span>
                <select value={rollId} onChange={(e) => { setRollId(e.target.value); const r = rolls.find((x) => x.id === e.target.value); if (r?.widthIn) setRollIn(Number(r.widthIn)); }}>
                  <option value="">Don't track</option>
                  {rolls.map((r) => <option key={r.id} value={r.id}>{r.widthIn}" {r.materialName}{r.color ? ` ${r.color}` : ''} — {Math.round(r.remainingFeet)} ft left</option>)}
                </select>
              </label>
            )}
            <div className="mini-row">
              <NumIn label="Roll width" unit="in" value={rollIn} onChange={setRollIn} />
              <NumIn label="Gap between pieces" unit="in" value={gapIn} onChange={setGapIn} step={0.25} />
            </div>
            <NumIn label="Panel overlap when tiling" unit="in" value={overlapIn} onChange={setOverlapIn} step={0.25} />
            <label className="check"><input type="checkbox" checked={allowRotate} onChange={(e) => setAllowRotate(e.target.checked)} /> Nest to save media</label>
            <details className="adv">
              <summary>White ink</summary>
              <label className="check"><input type="checkbox" checked={!!whiteSpot} onChange={(e) => setWhiteSpot(e.target.checked ? 'White' : '')} /> White ink under each piece</label>
              {whiteSpot && <label className="mini-field"><span>White spot name in the RIP</span><input type="text" value={whiteSpot} onChange={(e) => setWhiteSpot(e.target.value || 'White')} /></label>}
              <div className="help">For printers with white ink. The HP Latex 335/115 don't have white.</div>
            </details>
          </>)}

          {tab === 'job' && (<>
            <label className="mini-field"><span>Job name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
            {order && <div className="order-tag">InkFlow order {order.label} — marked {order.status} there when the job finishes. <button className="btn ghost small" onClick={() => setOrder(null)}>Unlink</button></div>}
            <Preflight purpose="wide" items={items.map((it) => ({ name: it.name, ext: it.ext, base64: it.base64, widthIn: it.widthIn, heightIn: it.heightIn }))} />
            <div className="help">Ink is an estimate from the media list (Settings → Materials, colors &amp; pricing). Compare with the HP's accounting page and adjust.</div>
          </>)}
        </div>
        {msg && <div className="studio-msg">{msg}</div>}
      </aside>

      {/* ---- status bar ---- */}
      <div className="ws-status">
        {layout ? (<>
          <span><em>Roll used</em>{(layout.lengthIn / 12).toFixed(2)} ft</span>
          <span><em>Media</em>{layout.mediaSqFt.toFixed(1)} sq ft</span>
          <span><em>Printed</em>{layout.printedSqFt.toFixed(1)} sq ft · {Math.round((layout.printedSqFt / layout.mediaSqFt) * 100)}% used</span>
          {est && <span><em>Ink</em>{est.inkMl.toFixed(0)} ml</span>}
          {est && <span><em>Cost</em>${(est.mediaCost + est.inkCost).toFixed(2)}</span>}
          {est && <span className="price"><em>Suggested price</em>${est.price.toFixed(2)}</span>}
          {layout.pieces.some((p) => p.tiles > 1) && <span className="warn-text">Split into panels ({overlapIn}" overlap)</span>}
        </>) : <span className="muted">Scroll to zoom · drag the empty area to move around · Delete removes the selected piece</span>}
      </div>
      {quoting && <QuoteDialog lines={quoteLines()} defaultName={name} onClose={() => setQuoting(false)}
        makeProof={async () => ({ kind: 'wide', name: `${name || 'Banner'} proof.pdf`, note: 'Print layout from InkSign', payload: { items, opts } })} />}
      {dropping && <div className="drop-overlay"><Icon name="plus" size={40} />Drop to add to the job</div>}
    </div>
  );
}
