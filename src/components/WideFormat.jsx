import React, { useEffect, useMemo, useRef, useState } from 'react';
import Preflight from './Preflight.jsx';
import ProofButton from './ProofButton.jsx';
import QuoteDialog from './QuoteDialog.jsx';
import { renderPages, b64ToBytes } from '../lib/pdfRender.js';

const api = window.inksign;
let nextId = 1;

function NumIn({ label, value, onChange, step = 1, placeholder }) {
  const [t, setT] = useState(value);
  useEffect(() => setT(value), [value]);
  const commit = () => { if (t !== '' && !Number.isNaN(Number(t))) onChange(Number(t)); };
  return (
    <label className="mini-field"><span>{label}</span>
      <input type="number" step={step} value={t} placeholder={placeholder} onChange={(e) => setT(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
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

export default function WideFormat({ devices, onJobsSent, incoming }) {
  const [order, setOrder] = useState(null);
  const hps = devices.filter((d) => d.driver === 'flexi-hotfolder');
  const [deviceId, setDeviceId] = useState('');
  useEffect(() => { if (!hps.some((d) => d.id === deviceId)) setDeviceId(hps[0]?.id || ''); }, [devices]);
  const device = hps.find((d) => d.id === deviceId);
  const [settings, setSettings] = useState(null);
  useEffect(() => { api.settings.get().then(setSettings); }, []);
  const [media, setMedia] = useState('Banner 13oz');
  const mediaInfo = settings?.wideMedia?.find((m) => m.name === media);

  const [rollIn, setRollIn] = useState(54);
  useEffect(() => { if (device?.config?.mediaWidthIn) setRollIn(Number(device.config.mediaWidthIn)); }, [deviceId]);
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
  // InkFlow roll stock: picking a roll sets the roll width and takes the feet off it when the job finishes
  const [rolls, setRolls] = useState([]);
  const [rollId, setRollId] = useState('');
  const [quoting, setQuoting] = useState(false);
  useEffect(() => { api.shopflow.rolls().then(setRolls).catch(() => setRolls([])); }, []);
  const seq = useRef(0);

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
  }, [incoming]);
  const addFiles = async (files, keepMsg, size) => {
    if (!keepMsg) setMsg('');
    for (const f of files) {
      let w = f.widthIn, h = f.heightIn, preview;
      if (f.ext === 'pdf') {
        const r = await renderPages(b64ToBytes(f.base64), { maxPages: 1, width: 500 });
        preview = r.images[0];
      } else {
        preview = `data:image/${f.ext === 'png' ? 'png' : 'jpeg'};base64,${f.base64}`;
        const img = new Image(); img.src = preview; await img.decode();
        w = 48; h = +(48 * img.naturalHeight / img.naturalWidth).toFixed(2);
      }
      if (size) { w = size.widthIn; h = size.heightIn; }
      const it = {
        id: `i${nextId++}`, name: f.name, ext: f.ext, base64: f.base64, widthIn: +w.toFixed(3), heightIn: +h.toFixed(3), aspect: w / h,
        lock: true, copies: size?.copies || 1, hemIn: 0, hemFill: 'white', allowRotate: true, grommets: { on: false, spacingIn: 24, insetIn: 0.5 },
      };
      setPreviews((p) => ({ ...p, [it.id]: preview }));
      setItems((l) => [...l, it]);
      setSelId(it.id);
    }
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

  const [whiteSpot, setWhiteSpot] = useState('');
  const opts = useMemo(() => ({ rollWidthIn: Number(rollIn), gapIn: Number(gapIn), overlapIn: Number(overlapIn), allowRotate, white: whiteSpot ? { spot: whiteSpot } : null }), [rollIn, gapIn, overlapIn, allowRotate, whiteSpot]);
  // only geometry goes to the layout call (not the big file data)
  const geoItems = useMemo(() => items.map(({ base64, ...rest }) => rest), [items]);
  useEffect(() => {
    if (!items.length) { setLayout(null); return; }
    const id = ++seq.current;
    api.wide.layout(geoItems, opts).then((L) => { if (id === seq.current) { setLayout(L); setMsg(''); } })
      .catch((e) => { if (id === seq.current) setMsg(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); });
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
    setMsg('');
    try { await api.wide.send(deviceId, items, opts, { name, media, inkflow: order, rollId: rollId || undefined }); onJobsSent(); }
    catch (e) { setMsg(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  };
  const save = async () => { const p = await api.wide.save(items, opts, name); if (p) setMsg(`Saved ${p}`); };

  const pad = 4;
  const vbW = (layout?.lengthIn || 96) + 2 * pad, vbH = Number(rollIn) + 2 * pad;
  const sw = vbW / 900;
  const itemById = Object.fromEntries(items.map((i) => [i.id, i]));
  const mediaFolders = device?.config?.mediaFolders || '';
  const hasFolder = mediaFolders.toLowerCase().includes(media.toLowerCase());

  return (
    <div className="studio">
      <div className="studio-left">
        <h1>Wide Format</h1>
        <div className="muted small">HP Latex through Flexi — banners, signs, canvas.</div>
        <div className="tool-box">
          <button className="btn primary wide" onClick={add}>Add print files…</button>
          <div className="help">PDF (stays vector, sized from the page) or PNG/JPG.</div>
        </div>
        {items.map((it) => (
          <button key={it.id} className={`piece ${it.id === selId ? 'on' : ''}`} onClick={() => setSelId(it.id)}>
            <span>{it.name}</span><span className="muted small">{it.copies > 1 ? `${it.copies} × ` : ''}{it.widthIn}×{it.heightIn}"</span>
          </button>
        ))}
        {sel && (<>
          <div className="tool-box">
            <div className="box-title">{sel.name}</div>
            <div className="mini-row">
              <NumIn label="Width (in)" value={sel.widthIn} onChange={(v) => setSize('widthIn', v)} step={0.5} />
              <NumIn label="Height (in)" value={sel.heightIn} onChange={(v) => setSize('heightIn', v)} step={0.5} />
            </div>
            <label className="check"><input type="checkbox" checked={sel.lock} onChange={(e) => update(sel.id, { lock: e.target.checked })} /> Keep proportions</label>
            <div className="mini-row">
              <NumIn label="Copies" value={sel.copies} onChange={(v) => update(sel.id, { copies: Math.max(1, Math.round(v)) })} />
            </div>
            <label className="check"><input type="checkbox" checked={sel.allowRotate} onChange={(e) => update(sel.id, { allowRotate: e.target.checked })} /> May rotate to save media</label>
          </div>
          <div className="tool-box">
            <div className="box-title">Finishing</div>
            <div className="shape-grid">
              <button className="chip" onClick={() => preset('banner')}>Hemmed banner</button>
              <button className="chip" onClick={() => preset('canvas')}>Canvas wrap</button>
              <button className="chip" onClick={() => preset('none')}>Trim to size</button>
            </div>
            <div className="mini-row">
              <NumIn label="Hem / wrap (in)" value={sel.hemIn} onChange={(v) => update(sel.id, { hemIn: Math.max(0, v) })} step={0.25} />
              <label className="mini-field"><span>Hem area</span>
                <select value={sel.hemFill} onChange={(e) => update(sel.id, { hemFill: e.target.value })}>
                  <option value="white">Blank</option><option value="mirror">Mirrored edge</option>
                </select>
              </label>
            </div>
            <label className="check"><input type="checkbox" checked={sel.grommets.on} onChange={(e) => update(sel.id, { grommets: { ...sel.grommets, on: e.target.checked } })} /> Grommet marks</label>
            {sel.grommets.on && (
              <div className="mini-row">
                <NumIn label="Every (in)" value={sel.grommets.spacingIn} onChange={(v) => update(sel.id, { grommets: { ...sel.grommets, spacingIn: v } })} step={6} />
                <NumIn label="From edge (in)" value={sel.grommets.insetIn} onChange={(v) => update(sel.id, { grommets: { ...sel.grommets, insetIn: v } })} step={0.25} />
              </div>
            )}
            <button className="btn small danger" onClick={() => { setItems((l) => l.filter((i) => i.id !== sel.id)); setSelId(null); }}>Remove</button>
          </div>
        </>)}
      </div>

      <div className="studio-canvas light">
        {layout ? (
          <svg viewBox={`${-pad} ${-pad} ${vbW} ${vbH}`} preserveAspectRatio="xMidYMid meet">
            <rect x={0} y={0} width={layout.lengthIn} height={layout.rollWidthIn} className="sheet" />
            <rect x={0} y={(layout.rollWidthIn - layout.printableW) / 2} width={layout.lengthIn} height={layout.printableW} className="safe" strokeWidth={sw} strokeDasharray={`${4 * sw} ${3 * sw}`} />
            <defs>
              {layout.pieces.map((p, i) => <clipPath id={`wc${i}`} key={i}><rect x={p.x} y={p.y} width={p.pw} height={p.ph} /></clipPath>)}
            </defs>
            {layout.pieces.map((p, i) => {
              const it = itemById[p.itemId];
              if (!it) return null;
              return (
                <g key={i} clipPath={`url(#wc${i})`} onClick={() => setSelId(it.id)} style={{ cursor: 'pointer' }}>
                  <g transform={pieceMatrix(p)}>
                    {it.hemIn > 0 && <rect x={0} y={0} width={p.outerW} height={p.outerH} fill={it.hemFill === 'mirror' ? '#d8dbe2' : '#f3f4f6'} />}
                    <image href={previews[it.id]} x={it.hemIn} y={it.hemIn} width={it.widthIn} height={it.heightIn} preserveAspectRatio="none" />
                    {it.hemIn > 0 && <rect x={it.hemIn} y={it.hemIn} width={it.widthIn} height={it.heightIn} fill="none" stroke="#e6007e" strokeWidth={sw} strokeDasharray={`${3 * sw} ${2 * sw}`} />}
                  </g>
                  <rect x={p.x} y={p.y} width={p.pw} height={p.ph} fill="none" stroke={it.id === selId ? '#ff7a1a' : '#9aa3b5'} strokeWidth={sw * (it.id === selId ? 2 : 1)} />
                  {p.tiles > 1 && <text x={p.x + 1} y={p.y + p.ph - 1} fontSize={2.2} fill="#333">{p.label.replace(it.name, '').trim()}</text>}
                </g>
              );
            })}
          </svg>
        ) : <div className="canvas-empty dark">Add print files to lay them out on the roll.</div>}
      </div>

      <div className="studio-right">
        <div className="tool-box">
          <div className="box-title">Printer & media</div>
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            {hps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <label className="mini-field"><span>Media</span>
            <select value={media} onChange={(e) => setMedia(e.target.value)}>
              {(settings?.wideMedia || []).map((m) => <option key={m.name}>{m.name}</option>)}
            </select>
          </label>
          <div className="help">{hasFolder ? `Goes to the "${media}" hot folder.` : 'No hot folder set for this media — uses the printer\'s main hot folder. Add one in Devices → Settings.'}</div>
          <div className="mini-row">
            <NumIn label="Roll width (in)" value={rollIn} onChange={setRollIn} />
            <NumIn label="Gap (in)" value={gapIn} onChange={setGapIn} step={0.25} />
          </div>
          <NumIn label="Panel overlap when tiling (in)" value={overlapIn} onChange={setOverlapIn} step={0.25} />
          <label className="check"><input type="checkbox" checked={allowRotate} onChange={(e) => setAllowRotate(e.target.checked)} /> Nest to save media</label>
          <label className="check"><input type="checkbox" checked={!!whiteSpot} onChange={(e) => setWhiteSpot(e.target.checked ? 'White' : '')} /> White ink under each piece</label>
          {whiteSpot && <label className="mini-field"><span>White spot name in the RIP</span><input type="text" value={whiteSpot} onChange={(e) => setWhiteSpot(e.target.value || 'White')} /></label>}
          {whiteSpot && <div className="help">For printers with white ink (clear or colored media). The HP Latex 335/115 don't have white — Flexi will ignore this layer for them.</div>}
          <label className="mini-field"><span>Job name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
          {order && <div className="order-tag">InkFlow order {order.label} — marked {order.status} there when the job finishes. <button className="btn ghost small" onClick={() => setOrder(null)}>Unlink</button></div>}
        </div>
        {layout && (
          <div className="tool-box stats">
            <div><span>Roll used</span><b>{(layout.lengthIn / 12).toFixed(2)} ft</b></div>
            <div><span>Media</span><b>{layout.mediaSqFt.toFixed(1)} sq ft</b></div>
            <div><span>Printed</span><b>{layout.printedSqFt.toFixed(1)} sq ft ({Math.round((layout.printedSqFt / layout.mediaSqFt) * 100)}%)</b></div>
            {est && (<>
              <div><span>Ink (estimate)</span><b>{est.inkMl.toFixed(0)} ml</b></div>
              <div><span>Media cost</span><b>${est.mediaCost.toFixed(2)}</b></div>
              <div><span>Ink cost</span><b>${est.inkCost.toFixed(2)}</b></div>
              <div className="price"><span>Suggested price</span><b>${est.price.toFixed(2)}</b></div>
            </>)}
            {layout.pieces.some((p) => p.tiles > 1) && <div className="help">Oversized pieces were split into panels with {overlapIn}" overlap.</div>}
          </div>
        )}
        <Preflight purpose="wide" items={items.map((it) => ({ name: it.name, ext: it.ext, base64: it.base64, widthIn: it.widthIn, heightIn: it.heightIn }))} />
        {rolls.length > 0 && (
          <label className="mini-field" style={{ margin: '8px 0' }}><span>Take media off InkFlow roll</span>
            <select value={rollId} onChange={(e) => { setRollId(e.target.value); const r = rolls.find((x) => x.id === e.target.value); if (r?.widthIn) setRollIn(Number(r.widthIn)); }}>
              <option value="">Don't track</option>
              {rolls.map((r) => <option key={r.id} value={r.id}>{r.widthIn}" {r.materialName}{r.color ? ` ${r.color}` : ''} — {Math.round(r.remainingFeet)} ft left</option>)}
            </select>
          </label>
        )}
        <button className="btn primary wide" disabled={!layout || !deviceId} onClick={send}>Send to {device?.name || 'HP'} (Flexi)</button>
        <button className="btn wide" disabled={!layout} onClick={save}>Save print PDF…</button>
        <ProofButton order={order} disabled={!layout} makeProof={async () => ({ kind: 'wide', name: `${name || 'Banner'} proof.pdf`, note: 'Print layout from InkSign', payload: { items, opts } })} />
        <button className="btn wide" disabled={!layout || !est} onClick={() => setQuoting(true)}>Create InkFlow quote…</button>
        {quoting && <QuoteDialog lines={quoteLines()} defaultName={name} onClose={() => setQuoting(false)}
          makeProof={async () => ({ kind: 'wide', name: `${name || 'Banner'} proof.pdf`, note: 'Print layout from InkSign', payload: { items, opts } })} />}
        {msg && <div className="studio-msg">{msg}</div>}
        <div className="help">Ink is an estimate from the media list (Materials, colors &amp; pricing). Compare with the HP's accounting page and adjust.</div>
      </div>
    </div>
  );
}
