import React, { useEffect, useMemo, useRef, useState } from 'react';
import { imageToCmyk, printerProfile } from '../lib/color.js';
import Preflight from './Preflight.jsx';
import ProofButton from './ProofButton.jsx';
import { parseCsv } from '../lib/csv.js';
import { renderPages, b64ToBytes } from '../lib/pdfRender.js';

const api = window.inksign;
const SHEETS = { Letter: [8.5, 11], Legal: [8.5, 14], Tabloid: [11, 17], '12 x 18': [12, 18], '13 x 19': [13, 19] };
const MODES = [
  { id: 'repeat', name: 'Step & repeat', help: 'Business cards, postcards, labels — one design (plus a back) filled across the sheet.' },
  { id: 'nup', name: 'N-up (pages in order)', help: 'Each page of the file placed in order, as many per sheet as fit.' },
  { id: 'booklet', name: 'Booklet (saddle stitch)', help: 'Pages reordered two-up so the folded stack reads in order. Pages padded to a multiple of 4.' },
];

function NumIn({ label, value, onChange, step = 0.125, placeholder }) {
  const [t, setT] = useState(value);
  useEffect(() => setT(value), [value]);
  const commit = () => onChange(t === '' ? '' : Number(t));
  return (
    <label className="mini-field"><span>{label}</span>
      <input type="number" step={step} value={t} placeholder={placeholder} onChange={(e) => setT(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </label>
  );
}

export default function Press({ devices, onJobsSent, incoming }) {
  const [order, setOrder] = useState(null);
  const printers = devices.filter((d) => d.driver === 'network-printer');
  const [printerId, setPrinterId] = useState('');
  useEffect(() => { if (!printers.some((p) => p.id === printerId)) setPrinterId(printers[0]?.id || ''); }, [devices]);
  const [appSettings, setAppSettings] = useState(null);
  useEffect(() => {
    const load = () => api.settings.get().then(setAppSettings);
    load();
    window.addEventListener('inksign-settings', load);
    return () => window.removeEventListener('inksign-settings', load);
  }, [devices]);
  const colorProf = printerProfile(appSettings, printerId);
  const printer = printers.find((p) => p.id === printerId);
  const trays = (printer?.config?.trays || 'AUTO').split(',').map((t) => t.trim()).filter(Boolean);
  const paperTypes = (printer?.config?.paperTypes || '').split(',').map((t) => t.trim()).filter(Boolean);

  const [src, setSrc] = useState(null);
  const [srcInfo, setSrcInfo] = useState(null);
  const [mode, setMode] = useState('repeat');
  const [sheetName, setSheetName] = useState('12 x 18');
  const [bleedIn, setBleedIn] = useState(0.125);
  const [gapIn, setGapIn] = useState('');
  const [cropMarks, setCropMarks] = useState(true);
  const [allowRotate, setAllowRotate] = useState(true);
  const [duplex, setDuplex] = useState(true);
  const [imgW, setImgW] = useState(3.5);
  const [imgH, setImgH] = useState(2);
  // Variable data (numbered tickets, name badges…)
  const [vdpOn, setVdpOn] = useState(false);
  const [vdpTemplate, setVdpTemplate] = useState(null); // the background art the data goes on
  const [vdpSource, setVdpSource] = useState('numbers');
  const [vdpNum, setVdpNum] = useState({ start: 1, end: 100, pad: 4 });
  const [vdpCsv, setVdpCsv] = useState('Name,Title\nJane Smith,Owner\nLee Jones,Manager');
  const [vdpFields, setVdpFields] = useState([{ text: 'No. {Number}', xIn: 1.75, yIn: 0.75, sizePt: 18, font: 'Helvetica Bold', align: 'center', color: '#000000' }]);
  const [fontList, setFontList] = useState([]);
  useEffect(() => {
    if (!vdpOn || fontList.length) return;
    api.fonts.list().then((list) => {
      setFontList(list);
      const pick = list.find((x) => /^arial bold$/i.test(x.name)) || list.find((x) => /^(liberation sans|dejavu sans) bold$/i.test(x.name)) || list.find((x) => /^arial$/i.test(x.name));
      if (pick) setVdpFields((fs) => fs.map((f) => (f.fontFile ? f : { ...f, fontFile: pick.file, font: pick.name })));
    });
  }, [vdpOn]);
  const vdpData = useMemo(() => (vdpSource === 'csv' ? parseCsv(vdpCsv) : null), [vdpSource, vdpCsv]);
  const setField = (i, patch) => setVdpFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const makeVdp = async () => {
    setMsg('');
    const tpl = vdpTemplate || src;
    if (!tpl) return setMsg('Open the background art first (or start with a blank piece).');
    try {
      const r = await api.vdp.build(tpl.ext === 'blank' ? null : { ext: tpl.ext, base64: tpl.base64 }, {
        source: vdpSource, numbers: vdpNum, rows: vdpData?.rows, fields: vdpFields,
        widthIn: Number(imgW), heightIn: Number(imgH), bleedIn: Number(bleedIn) || 0,
      });
      if (!vdpTemplate) setVdpTemplate(src);
      await loadSource({ name: `${(tpl.name || 'Job')} (variable)`, ext: 'pdf', base64: r.base64 });
      setMode('nup');
      setMsg(`Made ${r.pages} pieces — laid out in order (N-up). Print as usual.`);
    } catch (e) { setMsg(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  };
  const [qty, setQty] = useState(500);
  const [copies, setCopies] = useState(1);
  const [tray, setTray] = useState('AUTO');
  const [paperType, setPaperType] = useState('');
  const [color, setColor] = useState('color');
  const [hold, setHold] = useState(false);
  const [name, setName] = useState('');
  const [preview, setPreview] = useState(null);
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const seq = useRef(0);

  const [sheetW, sheetH] = SHEETS[sheetName];
  const opts = useMemo(() => ({
    mode, sheetW, sheetH, bleedIn: Number(bleedIn) || 0, gapIn, cropMarks, allowRotate, duplex,
  }), [mode, sheetW, sheetH, bleedIn, gapIn, cropMarks, allowRotate, duplex]);
  const source = useMemo(() => (src ? { ...src, widthIn: Number(imgW) + 2 * (Number(bleedIn) || 0), heightIn: Number(imgH) + 2 * (Number(bleedIn) || 0) } : null), [src, imgW, imgH, bleedIn]);

  const open = async () => loadSource(await api.press.open());
  useEffect(() => {
    if (!incoming || incoming.target !== 'press') return;
    setOrder(incoming.inkflow ? { ...incoming.inkflow, label: incoming.label } : null);
    const f = incoming.files.find((x) => ['pdf', 'png', 'jpg'].includes(x.ext));
    if (!f) { setMsg('Press takes a PDF, PNG or JPG — this order item has none.'); return; }
    loadSource(f).then(() => setName(incoming.name || f.name));
    if (incoming.item?.qty) setQty(incoming.item.qty);
  }, [incoming]);
  const loadSource = async (f) => {
    setMsg('');
    if (!f) return;
    setSrc(f); setName(f.name);
    if (f.ext === 'pdf') {
      const r = await renderPages(b64ToBytes(f.base64), { maxPages: 2, width: 240 });
      setSrcInfo({ pages: r.pages, thumbs: r.images });
      if (r.pages > 2 && mode === 'repeat') setMode('nup');
    } else setSrcInfo({ pages: 1, thumbs: [`data:image/${f.ext === 'png' ? 'png' : 'jpeg'};base64,${f.base64}`] });
  };

  // Re-impose for the preview whenever settings change
  useEffect(() => {
    if (!source) return;
    const id = ++seq.current;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.press.impose(source, opts);
        if (id !== seq.current) return;
        const pv = await renderPages(b64ToBytes(r.base64), { maxPages: 2, width: 560 });
        if (id !== seq.current) return;
        setInfo(r.info); setPreview(pv); setMsg('');
      } catch (e) { if (id === seq.current) { setInfo(null); setPreview(null); setMsg(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); } }
      finally { if (id === seq.current) setBusy(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [source, opts]);

  const sheetsNeeded = info ? (mode === 'repeat' ? Math.ceil((Number(qty) || 0) / Math.max(1, info.perSheet)) : info.sheets) : 0;
  const printCopies = mode === 'repeat' ? sheetsNeeded : Math.max(1, Number(copies) || 1);
  const duplexMode = (mode === 'booklet') ? 'short' : (mode === 'repeat' && duplex && srcInfo?.pages > 1 ? 'long' : 'none');

  // Photos / PNG / JPG go to the Xerox already converted to its CMYK (Color page profile). PDFs go as they are.
  const withColor = async (src) => {
    const fresh = printerProfile(await api.settings.get(), printerId);
    if (!src || src.ext === 'pdf' || !fresh) return src;
    const dataUrl = `data:image/${src.ext === 'png' ? 'png' : 'jpeg'};base64,${src.base64}`;
    return { ...src, cmyk: await imageToCmyk(dataUrl, fresh.profileId, fresh.intent) };
  };
  const send = async () => {
    setMsg('');
    try {
      await api.press.send(printerId, await withColor(source), opts, {
        name: name || 'Press job', copies: printCopies, hold, inkflow: order,
        options: { duplex: duplexMode, tray, paperType, color },
      });
      onJobsSent();
    } catch (e) { setMsg(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  };
  const save = async () => {
    const p = await api.press.save(await withColor(source), opts, name || 'Press job');
    if (p) setMsg(`Saved ${p}`);
  };

  return (
    <div className="studio">
      <div className="studio-left">
        <h1>Press</h1>
        <div className="muted small">Xerox imposition — business cards, postcards, booklets.</div>
        <div className="tool-box">
          <button className="btn primary wide" onClick={open}>Open PDF or image…</button>
          {src && <div className="muted small">{src.name}.{src.ext} · {srcInfo?.pages} page{srcInfo?.pages > 1 ? 's' : ''}</div>}
          {srcInfo && <div className="thumbs">{srcInfo.thumbs.map((t, i) => <img key={i} src={t} alt="" />)}</div>}
          {src && src.ext !== 'pdf' && (
            <div className="mini-row">
              <NumIn label="Finished width (in)" value={imgW} onChange={setImgW} />
              <NumIn label="Finished height (in)" value={imgH} onChange={setImgH} />
            </div>
          )}
        </div>
        <div className="tool-box">
          <div className="box-title">Layout</div>
          {MODES.map((m) => (
            <label key={m.id} className="check"><input type="radio" checked={mode === m.id} onChange={() => setMode(m.id)} /> {m.name}</label>
          ))}
          <div className="help">{MODES.find((m) => m.id === mode).help}</div>
        </div>
        <div className="tool-box">
          <label className="check"><input type="checkbox" checked={vdpOn} onChange={(e) => setVdpOn(e.target.checked)} /> <b>Variable data</b> — numbers, names on each piece</label>
          {vdpOn && (<>
            <div className="mini-row">
              <NumIn label="Piece width (in)" value={imgW} onChange={setImgW} />
              <NumIn label="Piece height (in)" value={imgH} onChange={setImgH} />
            </div>
            <div className="help">{vdpTemplate ? `Background: ${vdpTemplate.name}` : src ? `Background: ${src.name}` : 'Open the background art above, or leave it blank.'}{vdpTemplate && <> · <button className="btn ghost small" onClick={() => setVdpTemplate(null)}>use current file</button></>}</div>
            {!src && !vdpTemplate && <button className="btn small" onClick={() => setVdpTemplate({ ext: 'blank', name: 'Blank' })}>Start blank</button>}
            <label className="mini-field"><span>Data</span>
              <select value={vdpSource} onChange={(e) => setVdpSource(e.target.value)}>
                <option value="numbers">Numbers (tickets, stubs)</option><option value="csv">A list (names, badges) — paste or open CSV</option>
              </select>
            </label>
            {vdpSource === 'numbers' ? (
              <div className="mini-row">
                <NumIn label="From" value={vdpNum.start} onChange={(v) => setVdpNum((n) => ({ ...n, start: Math.round(v) }))} step={1} />
                <NumIn label="To" value={vdpNum.end} onChange={(v) => setVdpNum((n) => ({ ...n, end: Math.round(v) }))} step={1} />
                <NumIn label="Digits" value={vdpNum.pad} onChange={(v) => setVdpNum((n) => ({ ...n, pad: Math.max(0, Math.round(v)) }))} step={1} />
              </div>
            ) : (<>
              <textarea rows={4} className="code-input" value={vdpCsv} onChange={(e) => setVdpCsv(e.target.value)} />
              <div className="mini-row">
                <button className="btn small" onClick={async () => { const t = await api.vdp.openCsv(); if (t != null) setVdpCsv(t); }}>Open CSV…</button>
                <span className="muted small">{vdpData ? `${vdpData.rows.length} rows · columns: ${vdpData.columns.join(', ')}` : ''}</span>
              </div>
            </>)}
            <div className="box-title" style={{ marginTop: 6 }}>Text on each piece</div>
            {vdpFields.map((f, i) => (
              <div key={i} className="vdp-field">
                <input type="text" value={f.text} title="Use {Column} for data, e.g. {Name} or {Number}" onChange={(e) => setField(i, { text: e.target.value })} />
                <div className="mini-row">
                  <NumIn label="From left (in)" value={f.xIn} onChange={(v) => setField(i, { xIn: v })} step={0.0625} />
                  <NumIn label="From top (in)" value={f.yIn} onChange={(v) => setField(i, { yIn: v })} step={0.0625} />
                  <NumIn label="Size (pt)" value={f.sizePt} onChange={(v) => setField(i, { sizePt: v })} step={1} />
                </div>
                <div className="mini-row">
                  <select value={f.fontFile || f.font} onChange={(e) => { const inst = fontList.find((x) => x.file === e.target.value); setField(i, inst ? { fontFile: inst.file, font: inst.name } : { fontFile: undefined, font: e.target.value }); }}>
                    <optgroup label="Installed (embedded)">{fontList.map((x) => <option key={x.file} value={x.file}>{x.name}</option>)}</optgroup>
                    <optgroup label="Printer fonts">{['Helvetica', 'Helvetica Bold', 'Times', 'Times Bold', 'Courier', 'Courier Bold'].map((x) => <option key={x} value={x}>{x}</option>)}</optgroup>
                  </select>
                  <select value={f.align} onChange={(e) => setField(i, { align: e.target.value })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select>
                  <input type="color" value={f.color} onChange={(e) => setField(i, { color: e.target.value })} />
                  <button className="btn ghost small" onClick={() => setVdpFields((fs) => fs.filter((_, j) => j !== i))}>✕</button>
                </div>
              </div>
            ))}
            <button className="btn small" onClick={() => setVdpFields((fs) => [...fs, { text: vdpSource === 'csv' ? `{${vdpData?.columns[0] || 'Name'}}` : '{Number}', xIn: Number(imgW) / 2, yIn: 0.5, sizePt: 14, font: 'Helvetica', align: 'center', color: '#000000' }])}>+ Add text</button>
            <button className="btn primary" onClick={makeVdp}>Make the pieces</button>
            <div className="help">Positions are from the top-left of the finished piece. "Center" puts the middle of the text at that spot.</div>
          </>)}
        </div>
        <div className="tool-box">
          <div className="box-title">Sheet & trim</div>
          <select value={sheetName} onChange={(e) => setSheetName(e.target.value)}>{Object.keys(SHEETS).map((s) => <option key={s}>{s}</option>)}</select>
          <div className="mini-row">
            <NumIn label="Bleed in file (in)" value={bleedIn} onChange={setBleedIn} />
            {mode !== 'booklet' && <NumIn label="Gutter (in)" value={gapIn} onChange={setGapIn} placeholder="auto" />}
          </div>
          <label className="check"><input type="checkbox" checked={cropMarks} onChange={(e) => setCropMarks(e.target.checked)} /> Crop marks</label>
          {mode !== 'booklet' && <label className="check"><input type="checkbox" checked={allowRotate} onChange={(e) => setAllowRotate(e.target.checked)} /> Rotate pieces if more fit</label>}
          {mode === 'repeat' && srcInfo?.pages > 1 && <label className="check"><input type="checkbox" checked={duplex} onChange={(e) => setDuplex(e.target.checked)} /> Page 2 is the back (print duplex)</label>}
          {info && <div className="muted small">Finished size {info.trimIn[0].toFixed(3)} × {info.trimIn[1].toFixed(3)}"</div>}
        </div>
      </div>

      <div className="studio-canvas light press-canvas">
        {preview ? (
          <div className="press-pages">
            {preview.images.map((im, i) => (
              <figure key={i}><img src={im} alt="" /><figcaption>{mode === 'booklet' ? `Sheet 1 ${i ? 'back' : 'front'}` : i ? 'Back' : 'Front'}{preview.pages > 2 ? ` · ${preview.pages} sides total` : ''}</figcaption></figure>
            ))}
          </div>
        ) : <div className="canvas-empty dark">{src ? (busy ? 'Laying out…' : '') : 'Open a PDF (with bleed) or an image to lay it out on the sheet.'}</div>}
      </div>

      <div className="studio-right">
        <div className="tool-box">
          <div className="box-title">Printer</div>
          <select value={printerId} onChange={(e) => setPrinterId(e.target.value)}>
            {printers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div className="mini-row">
            <label className="mini-field"><span>Tray</span>
              <select value={tray} onChange={(e) => setTray(e.target.value)}>{trays.map((t) => <option key={t}>{t}</option>)}</select>
            </label>
            <label className="mini-field"><span>Paper</span>
              <select value={paperType} onChange={(e) => setPaperType(e.target.value)}>
                <option value="">Printer default</option>{paperTypes.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
          </div>
          <label className="mini-field"><span>Color</span>
            <select value={color} onChange={(e) => setColor(e.target.value)}><option value="color">Color</option><option value="gray">Black & white</option></select>
          </label>
          <label className="mini-field"><span>Job name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
          {order && <div className="order-tag">InkFlow order {order.label} — marked {order.status} there when the job finishes. <button className="btn ghost small" onClick={() => setOrder(null)}>Unlink</button></div>}
        </div>

        <div className="tool-box stats">
          {mode === 'repeat'
            ? <NumIn label="Quantity needed (pieces)" value={qty} onChange={setQty} step={50} />
            : <NumIn label="Copies" value={copies} onChange={setCopies} step={1} />}
          {info && (<>
            <div><span>Per sheet</span><b>{mode === 'booklet' ? '4 pages' : info.perSheet}{info.rotated ? ' (rotated)' : ''}</b></div>
            <div><span>Sheets to print</span><b>{mode === 'repeat' ? sheetsNeeded : info.sheets * printCopies}</b></div>
            {mode === 'repeat' && <div><span>Pieces you get</span><b>{sheetsNeeded * info.perSheet}</b></div>}
            <div><span>Sides</span><b>{duplexMode === 'none' ? '1-sided' : `2-sided (${duplexMode} edge)`}</b></div>
            {info.blankPages ? <div><span>Blank pages added</span><b>{info.blankPages}</b></div> : null}
          </>)}
        </div>
        <label className="check"><input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} /> Hold in queue until I release it</label>
        {colorProf && src && src.ext !== 'pdf' && <div className="help">Color: converted to CMYK with {colorProf.profile.name}.</div>}
        {src && <Preflight purpose="press" bleedIn={Number(bleedIn) || 0} items={[{ name: src.name, ext: src.ext, base64: src.base64, widthIn: mode === 'repeat' ? Number(imgW) : null, heightIn: mode === 'repeat' ? Number(imgH) : null }]} />}
        <button className="btn primary wide" disabled={!info || !printerId} onClick={send}>{hold ? 'Send to queue (held)' : `Print on ${printer?.name || 'printer'}`}</button>
        <button className="btn wide" disabled={!info} onClick={save}>Save imposed PDF…</button>
        <ProofButton order={order} disabled={!info} makeProof={async () => ({ kind: 'press', name: `${name || 'Press job'} proof.pdf`, note: 'Imposed print sheet from InkSign', payload: { src: await withColor(source), opts } })} />
        {msg && <div className="studio-msg">{msg}</div>}
        <div className="help">Tray, paper type and B&amp;W go to the Xerox as PJL commands — check the first job prints from the right tray. Color matching stays on the Xerox's own settings.</div>
      </div>
    </div>
  );
}
