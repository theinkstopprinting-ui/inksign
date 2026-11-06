import React, { useEffect, useMemo, useState } from 'react';
import { MM, bounds, translate } from '../lib/geometry.js';
import { makeMask, traceToPaths } from '../lib/trace.js';
import { offsetPaths } from '../lib/offset.js';
import { rectangle, ellipse } from '../lib/shapes.js';
import { imageToCmyk, printerProfile } from '../lib/color.js';
import Preflight from './Preflight.jsx';
import ProofButton from './ProofButton.jsx';
import Icon from './shell/Icon.jsx';

const api = window.inksign;
const SHEETS = { Letter: [8.5, 11], Legal: [8.5, 14], Tabloid: [11, 17], '12 x 18': [12, 18], '13 x 19': [13, 19] };
const MARK_T_DEFAULT = 0.5; // mark line thickness, mm (Graphtec)
const TITAN_MARK = { size: 26, thickness: 1 }; // the Titan's marks as Flexi prints them: 26 mm L corners, 1 mm thick
let nextId = 1;
const inch = (mm) => (mm / MM).toFixed(2);
const toMm = (v) => (Number(v) || 0) * MM;
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Load an image and build its contour mask (downsampled for speed).
async function analyzeImage(dataUrl) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const maxSide = 900;
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) transparent++;
  return { pxW: img.naturalWidth, pxH: img.naturalHeight, w, h, data, hasAlpha: transparent > w * h * 0.01 };
}

function NumIn({ label, value, onChange, step = 0.1 }) {
  const [t, setT] = useState(value);
  useEffect(() => setT(value), [value]);
  const commit = () => { if (t !== '' && !Number.isNaN(Number(t))) onChange(Number(t)); };
  return (
    <label className="mini-field"><span>{label}</span>
      <input type="number" step={step} value={t} onChange={(e) => setT(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </label>
  );
}

// Four L marks for one frame — same geometry as electron/lib/printCutPdf.js markRects().
function frameMarks(sheetW, f, margin, size, MARK_T = MARK_T_DEFAULT) {
  const x0 = margin, y0 = f.y0 + margin, x1 = sheetW - margin, y1 = f.y0 + f.h - margin, s = size, t = MARK_T;
  return [
    [x0, y0, s, t], [x0, y0, t, s], [x1 - s, y0, s, t], [x1 - t, y0, t, s],
    [x0, y1 - t, s, t], [x0, y1 - s, t, s], [x1 - s, y1 - t, s, t], [x1 - t, y1 - s, t, s],
  ];
}

// Alignment test: five targets (center + four corners) inside one frame.
// Printed: a 12 mm square with a crosshair. Cut: the same 12 mm square.
function alignmentTargets(sheetW, frame, margin, markSize) {
  const S = 12, inset = margin + markSize + 15;
  const xs = [inset + S / 2, sheetW / 2, sheetW - inset - S / 2];
  const ys = [frame.y0 + inset + S / 2, frame.y0 + frame.h / 2, frame.y0 + frame.h - inset - S / 2];
  const centers = [
    ['A', xs[0], ys[0]], ['B', xs[2], ys[0]], ['C', xs[1], ys[1]], ['D', xs[0], ys[2]], ['E', xs[2], ys[2]],
  ];
  const sq = (cx, cy) => [[{ x: cx - S / 2, y: cy - S / 2 }, { x: cx + S / 2, y: cy - S / 2 }, { x: cx + S / 2, y: cy + S / 2 }, { x: cx - S / 2, y: cy + S / 2 }, { x: cx - S / 2, y: cy - S / 2 }]];
  const printPaths = [], cutPaths = [], labels = [];
  for (const [name, cx, cy] of centers) {
    printPaths.push(...sq(cx, cy));
    printPaths.push([{ x: cx - S, y: cy }, { x: cx + S, y: cy }], [{ x: cx, y: cy - S }, { x: cx, y: cy + S }]);
    cutPaths.push(...sq(cx, cy));
    labels.push({ text: name, x: cx + S / 2 + 2, y: cy - S / 2 - 1, sizeMm: 4 });
  }
  labels.push({ text: 'InkSign alignment test — the cut square should sit exactly on each printed square. Measure at C.', x: margin + markSize + 3, y: frame.y0 + margin + markSize + 6, sizeMm: 3 });
  return { printPaths, cutPaths, labels };
}

export default function PrintCut({ devices, incoming, onDevicesChanged }) {
  const [order, setOrder] = useState(null);
  const printers = devices.filter((d) => d.kind === 'printer');
  const cutters = devices.filter((d) => d.kind === 'cutter');
  const [route, setRoute] = useState('direct'); // 'direct' = InkSign marks, 'flexi' = CutContour for Flexi
  const routePrinters = printers.filter((p) => (route === 'flexi' ? p.driver === 'flexi-hotfolder' : true));
  const [printerId, setPrinterId] = useState('');
  const [cutterId, setCutterId] = useState(cutters[0]?.id || '');
  useEffect(() => { if (!cutters.some((c) => c.id === cutterId)) setCutterId(cutters[0]?.id || ''); }, [devices]);
  // Sheets of stickers usually go on the Xerox; the HPs are picked for roll jobs.
  useEffect(() => { if (!routePrinters.some((p) => p.id === printerId)) setPrinterId((routePrinters.find((p) => p.driver === 'network-printer') || routePrinters[0])?.id || ''); }, [route, devices]);
  const printer = printers.find((p) => p.id === printerId);
  const cutter = cutters.find((c) => c.id === cutterId);
  const [appSettings, setAppSettings] = useState(null);
  useEffect(() => {
    const load = () => api.settings.get().then(setAppSettings);
    load();
    window.addEventListener('inksign-settings', load);
    return () => window.removeEventListener('inksign-settings', load);
  }, [devices]);
  const colorProf = printer?.driver === 'network-printer' ? printerProfile(appSettings, printerId) : null;
  // Artwork goes to the Xerox converted to its CMYK (Color page profile)
  const withColor = async (j) => {
    const fresh = printer?.driver === 'network-printer' ? printerProfile(await api.settings.get(), printerId) : null;
    if (!fresh) return j;
    const conv = new Map();
    for (const im of j.images) if (!conv.has(im.dataUrl)) conv.set(im.dataUrl, await imageToCmyk(im.dataUrl, fresh.profileId, fresh.intent));
    return { ...j, images: j.images.map((im) => ({ ...im, cmyk: conv.get(im.dataUrl), cmykKey: im.dataUrl.slice(-64) + im.dataUrl.length })) };
  };
  const isHp = printer?.driver === 'flexi-hotfolder' || printer?.driver === 'hp-latex';
  const hpRollIn = printer?.config?.rollWidthIn || printer?.config?.mediaWidthIn || 54;

  const [sheetName, setSheetName] = useState('Letter');
  const [landscape, setLandscape] = useState(false);
  const [rollLenIn, setRollLenIn] = useState(24);
  const [segLenIn, setSegLenIn] = useState(36);
  const [marginIn, setMarginIn] = useState(0.4);
  const [markMm, setMarkMm] = useState(10);
  const titanMarks = cutter?.config?.hpglStyle === 'titan';
  const MARK_T = titanMarks ? TITAN_MARK.thickness : MARK_T_DEFAULT;
  useEffect(() => { setMarkMm(titanMarks ? TITAN_MARK.size : 10); }, [titanMarks]);
  const [gapIn, setGapIn] = useState(0.125);
  const [items, setItems] = useState([]);
  const [selId, setSelId] = useState(null);
  const [name, setName] = useState('Stickers');
  const [msg, setMsg] = useState('');
  const sel = items.find((i) => i.id === selId);

  // Alignment test correction inputs
  const [rightMm, setRightMm] = useState(0);
  // White ink layer (printers with white, for clear / colored media)
  const [whiteMode, setWhiteMode] = useState('none');
  const [whiteChokeMm, setWhiteChokeMm] = useState(0.3);
  const [whiteSpot, setWhiteSpot] = useState('White');
  const [upMm, setUpMm] = useState(0);

  useEffect(() => { if (sheetName === 'Roll' && !isHp) setSheetName('Letter'); }, [isHp, sheetName]);
  const isRoll = sheetName === 'Roll' && isHp;

  const [sheetW, sheetH] = useMemo(() => {
    if (isRoll) return [toMm(hpRollIn), toMm(rollLenIn)];
    const s = SHEETS[sheetName] || SHEETS.Letter;
    return landscape ? [toMm(s[1]), toMm(s[0])] : [toMm(s[0]), toMm(s[1])];
  }, [sheetName, landscape, isRoll, printer, rollLenIn]);
  const margin = toMm(marginIn);
  const useMarks = route === 'direct';
  const inset = useMarks ? markMm + 3 : 0;

  // Frames: a sheet is one; a long roll printed with marks is split into equal segments,
  // each with its own four marks so the cutter corrects drift every few feet.
  const frames = useMemo(() => {
    if (!(isRoll && useMarks)) return [{ y0: 0, h: sheetH }];
    const seg = Math.max(toMm(12), toMm(segLenIn));
    const n = Math.max(1, Math.ceil(sheetH / seg - 1e-6));
    return Array.from({ length: n }, (_, i) => ({ y0: (sheetH / n) * i, h: sheetH / n }));
  }, [isRoll, useMarks, sheetH, segLenIn]);
  const areas = frames.map((f) => ({ x0: margin + inset, y0: f.y0 + margin + inset, x1: sheetW - margin - inset, y1: f.y0 + f.h - margin - inset }));

  const addImages = async () => addFiles(await api.printcut.openImages());
  useEffect(() => {
    if (!incoming || incoming.target !== 'printcut') return;
    if (order) { setItems([]); setSelId(null); }
    setOrder(incoming.inkflow ? { ...incoming.inkflow, label: incoming.label } : null);
    setName(incoming.name || 'Stickers');
    const imgs = incoming.files.filter((f) => f.ext === 'png' || f.ext === 'jpg');
    if (imgs.length < incoming.files.length) setMsg('Print & Cut takes PNG/JPG artwork — other files on this order were skipped.');
    addFiles(imgs.map((f) => ({ name: f.name, dataUrl: `data:image/${f.ext === 'png' ? 'png' : 'jpeg'};base64,${f.base64}` })), true);
  }, [incoming]);
  const addFiles = async (files, keepMsg) => {
    if (!keepMsg) setMsg('');
    for (const f of files) {
      try {
        const a = await analyzeImage(f.dataUrl);
        setItems((list) => {
          const it = {
            id: nextId++, name: f.name, dataUrl: f.dataUrl, a, widthIn: 3, copies: 0,
            shape: 'trace', offsetIn: 0.0625, mode: a.hasAlpha ? 'alpha' : 'notbg', threshold: 128, tolerance: 40,
          };
          setSelId(it.id);
          return [...list, it];
        });
      } catch (e) { setMsg(`${f.name}: ${e.message}`); }
    }
  };
  const update = (id, patch) => setItems((l) => l.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  // Contour for one copy of each item, relative to the image's top-left, in mm.
  const contours = useMemo(() => {
    const out = {};
    for (const it of items) {
      const wMm = toMm(it.widthIn), hMm = wMm * (it.a.pxH / it.a.pxW), off = toMm(it.offsetIn);
      let paths, art = null;
      try {
        if (it.shape === 'rect') paths = translate(rectangle(wMm + 2 * off, hMm + 2 * off), -off, -off);
        else if (it.shape === 'rounded') paths = translate(rectangle(wMm + 2 * off, hMm + 2 * off, Math.min(wMm, hMm) * 0.12 + off), -off, -off);
        else if (it.shape === 'circle') { const d = Math.max(wMm, hMm) * 1.0 + 2 * off; paths = translate(ellipse(d, d), (wMm - d) / 2, (hMm - d) / 2); }
        else {
          const mask = makeMask(it.a.data, it.a.w, it.a.h, { mode: it.mode, threshold: it.threshold, tolerance: it.tolerance });
          const traced = traceToPaths(mask, it.a.w, it.a.h, { widthMm: wMm, minAreaPx: 30 });
          art = traced;
          paths = traced.length ? offsetPaths(traced, Math.max(off, 0.01), { outerOnly: true, corners: 'round' }) : [];
        }
      } catch { paths = []; }
      out[it.id] = { paths, art, wMm, hMm, b: bounds(paths.length ? paths : [[{ x: 0, y: 0 }, { x: wMm, y: hMm }]]) };
    }
    return out;
  }, [items]);

  // Lay out copies in rows, frame by frame. Nothing crosses from one segment into the next.
  const layout = useMemo(() => {
    const placed = [];
    const gap = toMm(gapIn);
    let fi = 0, x = areas[0].x0, y = areas[0].y0, rowH = 0, overflow = 0;
    const nextFrame = () => {
      fi++;
      if (fi >= areas.length) return false;
      x = areas[fi].x0; y = areas[fi].y0; rowH = 0;
      return true;
    };
    for (const it of items) {
      const c = contours[it.id];
      if (!c) continue;
      const cw = c.b.w, ch = c.b.h;
      const placeOne = () => {
        for (;;) {
          if (fi >= areas.length) return false;
          const a = areas[fi];
          if (x + cw > a.x1 + 0.01) { x = a.x0; y += rowH + gap; rowH = 0; }
          if (y + ch <= a.y1 + 0.01 && x + cw <= a.x1 + 0.01) break;
          if (!nextFrame()) return false;
        }
        placed.push({ it, frame: fi, ox: x - c.b.minX, oy: y - c.b.minY });
        x += cw + gap; rowH = Math.max(rowH, ch);
        return true;
      };
      if (it.copies > 0) { for (let i = 0; i < it.copies; i++) if (!placeOne()) { overflow++; break; } }
      else { while (placeOne()) { /* fill */ } }
    }
    return { placed, overflow };
  }, [items, contours, areas.map((a) => `${a.x0},${a.y0},${a.x1},${a.y1}`).join('|'), gapIn]);

  const marks = useMarks ? { margin, size: markMm, thickness: MARK_T } : null;
  // White under each piece: the art's own shape pulled in a hair (choke) so it never peeks out, or a plain box.
  const whiteFor = (c) => {
    if (whiteMode === 'box' || !c.art || !c.art.length) return rectangle(c.wMm, c.hMm);
    return whiteChokeMm > 0 ? offsetPaths(c.art, -whiteChokeMm, { corners: 'round' }) : c.art;
  };
  const whiteLayer = () => (whiteMode === 'none' ? null : {
    spot: whiteSpot || 'White',
    paths: layout.placed.flatMap((p) => translate(whiteFor(contours[p.it.id]), p.ox, p.oy)),
  });
  const job = () => {
    const frameCuts = frames.map(() => []);
    for (const p of layout.placed) frameCuts[p.frame].push(...translate(contours[p.it.id].paths, p.ox, p.oy));
    return {
      inkflow: order, name, sheetW, sheetH, route, frames, marks, frameCuts, white: whiteLayer(),
      images: layout.placed.map((p) => ({ dataUrl: p.it.dataUrl, x: p.ox, y: p.oy, w: contours[p.it.id].wMm, h: contours[p.it.id].hMm })),
      cutPaths: frameCuts.flat(),
    };
  };
  const nSeg = frames.length;
  const doPrint = async () => {
    setMsg('');
    try {
      await api.printcut.print(printerId, await withColor(job()));
      setMsg(route === 'direct'
        ? `Sent to ${printer?.name}. Load the print in the cutter, scan the marks${nSeg > 1 ? ' of segment 1' : ''}, then press 2. Cut.`
        : 'Sent to Flexi. Check the Job queue for status.');
    } catch (e) { setMsg(clean(e.message)); }
  };
  const doCut = async () => {
    setMsg('');
    try {
      await api.printcut.cut(cutterId, job());
      setMsg(nSeg > 1
        ? `Segment 1 is cutting. Segments 2–${nSeg} are waiting in the Job queue — feed to each one, scan its marks, then press Release.`
        : 'Cut sent. Check the Job queue for status.');
    } catch (e) { setMsg(clean(e.message)); }
  };
  const doSave = async () => {
    setMsg('');
    const p = await api.printcut.savePdf(job());
    if (p) setMsg(`Saved ${p}`);
  };

  // ---- Alignment test ----
  const testFrame = isRoll ? { y0: 0, h: Math.min(sheetH, toMm(24)) } : { y0: 0, h: sheetH };
  const testJob = () => {
    const t = alignmentTargets(sheetW, testFrame, margin, markMm);
    return {
      name: `Alignment test (${cutter?.name || 'cutter'})`, sheetW, sheetH: testFrame.h, route: 'direct',
      frames: [testFrame], marks: { margin, size: markMm, thickness: MARK_T }, images: [],
      printPaths: t.printPaths, labels: t.labels, frameCuts: [t.cutPaths], cutPaths: t.cutPaths,
    };
  };
  const printTest = async () => {
    setMsg('');
    try { await api.printcut.print(printerId, testJob()); setMsg('Test sheet sent. Load it in the cutter, scan the marks, then press "Cut test sheet".'); } catch (e) { setMsg(clean(e.message)); }
  };
  const cutTest = async () => {
    setMsg('');
    try { await api.printcut.cut(cutterId, testJob()); setMsg('Test cut sent. Check target C: does the cut square sit exactly on the printed square?'); } catch (e) { setMsg(clean(e.message)); }
  };
  const saveCorrection = async (patch) => {
    if (!cutter) return;
    try {
      await api.devices.save({ id: cutter.id, name: cutter.name, config: patch });
      if (onDevicesChanged) await onDevicesChanged();
      setMsg(`Saved to ${cutter.name}. Cut the test again to check.`);
      setRightMm(0); setUpMm(0);
    } catch (e) { setMsg(clean(e.message)); }
  };
  const cal = cutter?.config || {};
  const applyMeasured = () => saveCorrection({
    regOffsetXmm: +((Number(cal.regOffsetXmm) || 0) - (Number(rightMm) || 0)).toFixed(2),
    regOffsetYmm: +((Number(cal.regOffsetYmm) || 0) - (Number(upMm) || 0)).toFixed(2),
  });

  const pts = (p) => p.map((q) => `${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(' ');
  const pad = 20;
  const sw = Math.max(sheetW, sheetH) / 900;
  const dist = { dx: sheetW - 2 * margin, dy: frames[0].h - 2 * margin };

  return (
    <div className="studio">
      <div className="studio-left">
        <h1>Print &amp; Cut</h1>
        <div className="tool-box">
          <div className="box-title">Workflow</div>
          <label className="check"><input type="radio" checked={route === 'direct'} onChange={() => setRoute('direct')} /> InkSign marks → cut on my cutter (Xerox or HP)</label>
          <label className="check"><input type="radio" checked={route === 'flexi'} onChange={() => setRoute('flexi')} /> HP through Flexi — Flexi prints its marks and cuts (CutContour)</label>
        </div>
        <div className="tool-box">
          <button className="btn primary wide" onClick={addImages}>Add artwork (PNG / JPG)…</button>
          <div className="help">PNG with a transparent background gives the cleanest contour.</div>
        </div>
        {items.map((it) => (
          <button key={it.id} className={`piece ${it.id === selId ? 'on' : ''}`} onClick={() => setSelId(it.id)}>
            <span>{it.name}</span><span className="muted small">{it.copies || 'fill'} × {it.widthIn}"</span>
          </button>
        ))}
        {sel && (
          <div className="tool-box">
            <div className="box-title">{sel.name}</div>
            <div className="mini-row">
              <NumIn label="Width (in)" value={sel.widthIn} onChange={(v) => v > 0 && update(sel.id, { widthIn: v })} />
              <NumIn label="Copies (0 = fill)" value={sel.copies} onChange={(v) => update(sel.id, { copies: Math.max(0, Math.round(v)) })} step={1} />
            </div>
            <div className="muted small">Height {(sel.widthIn * sel.a.pxH / sel.a.pxW).toFixed(2)}" · {Math.round(sel.a.pxW / sel.widthIn)} dpi</div>
            <label className="mini-field"><span>Cut shape</span>
              <select value={sel.shape} onChange={(e) => update(sel.id, { shape: e.target.value })}>
                <option value="trace">Contour (follows the art)</option><option value="rect">Rectangle</option>
                <option value="rounded">Rounded rectangle</option><option value="circle">Circle</option>
              </select>
            </label>
            <NumIn label="Cut distance from art (in)" value={sel.offsetIn} onChange={(v) => update(sel.id, { offsetIn: v })} step={0.03125} />
            {sel.shape === 'trace' && (<>
              <label className="mini-field"><span>Find the art by</span>
                <select value={sel.mode} onChange={(e) => update(sel.id, { mode: e.target.value })}>
                  <option value="alpha">Transparency</option><option value="notbg">Different from background</option><option value="dark">Dark pixels</option>
                </select>
              </label>
              {sel.mode === 'notbg' && <NumIn label="Background tolerance" value={sel.tolerance} onChange={(v) => update(sel.id, { tolerance: v })} step={5} />}
              {sel.mode !== 'notbg' && <NumIn label="Threshold (0–255)" value={sel.threshold} onChange={(v) => update(sel.id, { threshold: v })} step={8} />}
            </>)}
            <button className="btn small danger" onClick={() => { setItems((l) => l.filter((i) => i.id !== sel.id)); setSelId(null); }}>Remove</button>
          </div>
        )}
      </div>

      <div className="studio-canvas light">
        <svg viewBox={`${-pad} ${-pad} ${sheetW + 2 * pad} ${sheetH + 2 * pad}`} preserveAspectRatio="xMidYMid meet">
          <rect x={0} y={0} width={sheetW} height={sheetH} className="sheet" />
          {areas.map((a, i) => (
            <rect key={`a${i}`} x={a.x0} y={a.y0} width={a.x1 - a.x0} height={a.y1 - a.y0} className="safe" strokeWidth={sw} strokeDasharray={`${4 * sw} ${3 * sw}`} />
          ))}
          {useMarks && frames.flatMap((f, fi) => frameMarks(sheetW, f, margin, markMm, MARK_T).map(([x, y, w, h], i) => <rect key={`m${fi}-${i}`} x={x} y={y} width={w} height={h} fill="#000" />))}
          {frames.length > 1 && frames.map((f, i) => (
            <g key={`s${i}`}>
              {i > 0 && <line x1={0} x2={sheetW} y1={f.y0} y2={f.y0} stroke="#ff7a1a" strokeWidth={sw * 1.5} strokeDasharray={`${8 * sw} ${5 * sw}`} />}
              <text x={sheetW / 2} y={f.y0 + margin + markMm / 2 + 2} textAnchor="middle" fontSize={14 * sw} fill="#ff7a1a">Segment {i + 1}</text>
            </g>
          ))}
          {layout.placed.map((p, i) => (
            <g key={i} onClick={() => setSelId(p.it.id)}>
              <image href={p.it.dataUrl} x={p.ox} y={p.oy} width={contours[p.it.id].wMm} height={contours[p.it.id].hMm} preserveAspectRatio="none" />
              {contours[p.it.id].paths.map((c, j) => <polyline key={j} points={pts(translate([c], p.ox, p.oy)[0])} className="contour" strokeWidth={sw * 1.2} />)}
            </g>
          ))}
        </svg>
        {!items.length && <div className="canvas-empty dark">Add artwork to lay out a sheet of stickers or decals.</div>}
      </div>

      <div className="studio-right">
        <div className="tool-box">
          <div className="box-title">Devices</div>
          <label className="mini-field"><span>Print on</span>
            <select value={printerId} onChange={(e) => setPrinterId(e.target.value)}>
              {routePrinters.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          {route === 'direct' && (
            <label className="mini-field"><span>Cut on</span>
              <select value={cutterId} onChange={(e) => setCutterId(e.target.value)}>
                {cutters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          <label className="mini-field"><span>Job name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
          {colorProf && <div className="help">Color: artwork converted to CMYK with {colorProf.profile.name}.</div>}
          {order && <div className="order-tag">InkFlow order {order.label} — marked {order.status} there when the job finishes. <button className="btn ghost small" onClick={() => setOrder(null)}>Unlink</button></div>}
        </div>
        <div className="tool-box">
          <div className="box-title">Sheet</div>
          <select value={sheetName} onChange={(e) => setSheetName(e.target.value)}>
            {Object.keys(SHEETS).map((s) => <option key={s}>{s}</option>)}
            {isHp && <option value="Roll">Roll ({hpRollIn}" wide)</option>}
          </select>
          {isRoll
            ? (
              <div className="mini-row">
                <NumIn label="Length (in)" value={rollLenIn} onChange={(v) => setRollLenIn(Math.max(6, v))} step={6} />
                {useMarks && <NumIn label="Marks every (in)" value={segLenIn} onChange={(v) => setSegLenIn(Math.min(60, Math.max(12, v)))} step={6} />}
              </div>
            )
            : <label className="check"><input type="checkbox" checked={landscape} onChange={(e) => setLandscape(e.target.checked)} /> Landscape</label>}
          <div className="mini-row">
            <NumIn label="Edge margin (in)" value={marginIn} onChange={setMarginIn} step={0.05} />
            <NumIn label="Gap (in)" value={gapIn} onChange={setGapIn} step={0.0625} />
          </div>
          {useMarks && <NumIn label={`Mark size (mm, 4–${titanMarks ? 30 : 20})`} value={markMm} onChange={(v) => setMarkMm(Math.min(titanMarks ? 30 : 20, Math.max(4, v)))} step={1} />}
          <label className="mini-field"><span>White ink (clear / colored media)</span>
            <select value={whiteMode} onChange={(e) => setWhiteMode(e.target.value)}>
              <option value="none">None</option><option value="shape">Under the art (follows its shape)</option><option value="box">Box under each piece</option>
            </select>
          </label>
          {whiteMode !== 'none' && (
            <div className="mini-row">
              {whiteMode === 'shape' && <NumIn label="Pull in (mm)" value={whiteChokeMm} onChange={(v) => setWhiteChokeMm(Math.max(0, v))} step={0.1} />}
              <label className="mini-field"><span>Spot name in the RIP</span><input type="text" value={whiteSpot} onChange={(e) => setWhiteSpot(e.target.value)} /></label>
            </div>
          )}
          <div className="muted small">{layout.placed.length} pieces on a {inch(sheetW)} × {inch(sheetH)}" {isRoll ? 'roll section' : 'sheet'}{layout.overflow ? ' — some copies did not fit' : ''}</div>
          {nSeg > 1 && <div className="seg-note">{nSeg} segments of {inch(frames[0].h)}", each with its own 4 marks.</div>}
        </div>

        <Preflight purpose="printcut" items={items.map((it) => ({ name: it.name, ext: /image\/png/.test(it.dataUrl) ? 'png' : 'jpg', base64: it.dataUrl.split(',')[1], widthIn: it.widthIn }))} />
        <div className="action-dock">
          <button className="print-btn" disabled={!layout.placed.length || !printerId} onClick={doPrint}><Icon name="print" /> 1. Print on {printer?.name || 'printer'}</button>
          {route === 'direct' && <button className="print-btn second" disabled={!layout.placed.length || !cutterId} onClick={doCut}><Icon name="cutter" /> 2. Cut on {cutter?.name || 'cutter'}{nSeg > 1 ? ` (${nSeg} segments)` : ''}</button>}
          <div className="dock-more">
            <button className="btn small" disabled={!layout.placed.length} onClick={doSave}>Save PDF…</button>
            <ProofButton order={order} disabled={!layout.placed.length} makeProof={async () => ({ kind: 'printcut', name: `${name || 'Stickers'} proof.pdf`, note: 'Sticker sheet with cut lines (magenta) from InkSign', payload: { job: await withColor(job()) } })} />
          </div>
        </div>
        {msg && <div className="studio-msg">{msg}</div>}

        <div className="tool-box howto">
          <div className="box-title">How to run it</div>
          {route === 'direct' ? (
            <ol>
              {printer?.driver === 'flexi-hotfolder' && <li>In Flexi, this hot folder must print at <b>100% size</b>, with <b>no</b> Flexi print &amp; cut marks — the marks are already in the file.</li>}
              <li>Print. Load the print in the cutter with the <b>bottom-left mark</b> toward the cutter's origin.</li>
              {String(cal.regCommands || '').trim()
                ? <li>{cutter?.name} reads the marks on its own (mark-reading commands are set up) — just press <b>2. Cut</b>.</li>
                : <li>Cutter panel: mark scan with <b>4 marks</b>, mark type <b>1 (L-shaped)</b>, size <b>{markMm} mm</b>, distance X <b>{dist.dx.toFixed(1)} mm</b>, Y <b>{dist.dy.toFixed(1)} mm</b>. Run the scan, then press <b>2. Cut</b>.</li>}
              {nSeg > 1 && <li>For each next segment: feed to it, scan its marks, then <b>Release</b> its cut in the Job queue.</li>}
              <li>First time on a cutter: run the <b>alignment test</b> below.</li>
            </ol>
          ) : (
            <ol>
              <li>In Flexi Production Manager, set this HP's hot folder to <b>print &amp; cut</b> with your cutter.</li>
              <li>Click Print. The PDF carries the cut line as the <b>CutContour</b> spot color; Flexi adds its own marks and sends the cut.</li>
            </ol>
          )}
        </div>

        {route === 'direct' && (
          <div className="tool-box align-box">
            <div className="box-title">Alignment test — {cutter?.name || 'cutter'}</div>
            <div className="help">Prints 5 squares with crosshairs inside the marks, then cuts the same 5 squares. If the cut lands off the print, measure at the middle square (C) and save the correction — it's kept for this cutter.</div>
            <div className="mini-row">
              <button className="btn small" disabled={!printerId} onClick={printTest}>Print test sheet</button>
              <button className="btn small" disabled={!cutterId} onClick={cutTest}>Cut test sheet</button>
            </div>
            <div className="mini-row">
              <NumIn label="Cut landed right by (mm, − = left)" value={rightMm} onChange={setRightMm} step={0.1} />
              <NumIn label="Cut landed up by (mm, − = down)" value={upMm} onChange={setUpMm} step={0.1} />
            </div>
            <button className="btn small" disabled={!cutter || (!Number(rightMm) && !Number(upMm))} onClick={applyMeasured}>Save correction</button>
            <label className="mini-field"><span>Squares cut sideways or upside down? Rotate the cut</span>
              <select value={String(cal.regRotate || '0')} onChange={(e) => saveCorrection({ regRotate: e.target.value })}>
                {['0', '90', '180', '270'].map((v) => <option key={v} value={v}>{v}°</option>)}
              </select>
            </label>
            <div className="cal-now">Now: X {Number(cal.regOffsetXmm || 0).toFixed(2)} mm · Y {Number(cal.regOffsetYmm || 0).toFixed(2)} mm · rotate {cal.regRotate || 0}°
              {(Number(cal.regOffsetXmm) || Number(cal.regOffsetYmm)) ? <> · <button className="btn ghost small" onClick={() => saveCorrection({ regOffsetXmm: 0, regOffsetYmm: 0 })}>Reset</button></> : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
