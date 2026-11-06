// Design: InkSign's layout and design workspace, modeled on Flexi's. A page with shapes, text and
// pictures; Flexi-style menus (File, Edit, Arrange, Text, Effects, View); tools on the left; property
// panels on the right; swatches along the bottom. Opens and edits PDF, AI, EPS, SVG, DXF and pictures;
// prints (HP Latex direct, Xerox, Flexi hot folder), cuts, and does print & cut with marks.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import * as D from '../../lib/doc.js';
import * as FX from '../../lib/docEffects.js';
import { toScene, toSvg, cutGroups, cutPanels, cropScene } from '../../lib/docExport.js';
import PrintWindow from '../PrintWindow.jsx';
import { pdfToObjects, asGroup } from '../../lib/pdfObjects.js';
import { makeText, retext, toOutlines, changeCase, serialText } from '../../lib/docText.js';
import { qrPaths, code128Paths } from '../../lib/barcode.js';
import { importSvg } from '../../lib/importSvg.js';
import { importDxf } from '../../lib/importVector.js';
import { analyzeImage } from '../../lib/image.js';
import { makeMask, traceToPaths } from '../../lib/trace.js';
import { offsetPaths } from '../../lib/offset.js';
import { simplify, ENVELOPES } from '../../lib/design.js';
import { SHAPES } from '../../lib/shapes.js';
import { nest } from '../../lib/nest.js';
import Canvas from './Canvas.jsx';
import { PageProps, ObjectProps, FillStroke, ObjectList, SwatchBar, MM } from './Panels.jsx';
import { ParamDialog, CutDialog, PrintCutDialog, JobInfo, Modal } from './Dialogs.jsx';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const api = window.inksign;
const SW_KEY = 'inksign.dz.swatches';
const OPT_KEY = 'inksign.dz.view';
const loadJson = (k, d) => { try { return JSON.parse(window.localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const saveJson = (k, v) => { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch { /* not saved */ } };

const TOOLS = [
  ['select', '➤', 'Select (V) — click, drag, Shift-click to add; Ctrl-drag copies'],
  ['node', '◇', 'Edit nodes (N)'],
  ['text', 'T', 'Text (T) — click where the text goes'],
  ['rect', '▭', 'Rectangle (R) — Shift for a square, Alt from the center'],
  ['ellipse', '◯', 'Ellipse (E) — Shift for a circle'],
  ['shape', '★', 'Shapes — star, polygon, arrow, heart…'],
  ['line', '╱', 'Line (L) — Shift keeps it straight'],
  ['pen', '✒', 'Pen / Bézier (P)'],
  ['eyedropper', '⌖', 'Eyedropper (I) — copy a shape\'s colors to the selection'],
  ['zoom', '🔍', 'Zoom (Z) — click to zoom in, Alt-click out, drag a box'],
  ['pan', '✋', 'Pan (H) — or hold Space'],
];
const KEY_TOOLS = { v: 'select', n: 'node', t: 'text', r: 'rect', e: 'ellipse', l: 'line', p: 'pen', i: 'eyedropper', z: 'zoom', h: 'pan' };

function imageToDataUrl(img) {
  if (!img) return null;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0);
  else if (img.data) {
    const n = img.width * img.height;
    const out = new Uint8ClampedArray(n * 4);
    const src = img.data;
    if (img.kind === 3 || src.length === n * 4) out.set(src);
    else if (img.kind === 2 || src.length === n * 3) for (let i = 0; i < n; i++) { out[i * 4] = src[i * 3]; out[i * 4 + 1] = src[i * 3 + 1]; out[i * 4 + 2] = src[i * 3 + 2]; out[i * 4 + 3] = 255; }
    else if (img.kind === 1) {
      const rowBytes = Math.ceil(img.width / 8);
      for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
        const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0, i = y * img.width + x;
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
      }
    } else return null;
    ctx.putImageData(new ImageData(out, img.width, img.height), 0, 0);
  } else return null;
  return c.toDataURL('image/png');
}
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));

export default function Design({ devices, jobs = [], active, onJobsSent }) {
  const [doc, setDoc] = useState(() => D.newDoc({ widthIn: 24, heightIn: 12 }));
  const [sel, setSel] = useState([]);
  const [tool, setTool] = useState('select');
  const [shapeKind, setShapeKind] = useState('star');
  const [view, setView] = useState({ z: 2, vx: 60, vy: 60 });
  const [opts, setOpts] = useState(() => ({ showGrid: false, gridIn: 0.25, snapGrid: false, snapGuides: true, snapObjects: true, wire: false, newFill: { type: 'solid', color: '#000000' }, newStroke: { color: null, width: 0 }, ...loadJson(OPT_KEY, {}) }));
  const [tab, setTab] = useState('props');
  const [fonts, setFonts] = useState([]);
  const [swatches, setSwatches] = useState(() => loadJson(SW_KEY, []));
  const [menu, setMenu] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [msg, setMsg] = useState('');
  const [cursor, setCursor] = useState(null);
  const [textEdit, setTextEdit] = useState(null); // { id?: string, x, y, text }
  const [filePath, setFilePath] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [welcome, setWelcome] = useState(true);
  const [newSize, setNewSize] = useState({ w: 24, h: 12 });
  const canvas = useRef(null);
  const hist = useRef(D.history(120));
  const docRef = useRef(doc);
  docRef.current = doc;
  const gesture = useRef(false);
  const lastKey = useRef({ key: null, t: 0 });
  const clip = useRef(null);
  const [, force] = useState(0);

  useEffect(() => saveJson(OPT_KEY, { showGrid: opts.showGrid, gridIn: opts.gridIn, snapGrid: opts.snapGrid, snapGuides: opts.snapGuides, snapObjects: opts.snapObjects }), [opts]);
  useEffect(() => saveJson(SW_KEY, swatches), [swatches]);
  useEffect(() => {
    api.fonts.list().then((f) => setFonts(f || [])).catch(() => setFonts([]));
  }, []);
  const defaultFont = useMemo(() => fonts.find((x) => /^arial black$/i.test(x.name)) || fonts.find((x) => /^arial bold$/i.test(x.name)) || fonts.find((x) => /^arial$/i.test(x.name)) || fonts[0], [fonts]);
  const flash = (t) => { setMsg(t); if (t) setTimeout(() => setMsg((m) => (m === t ? '' : m)), 6000); };

  // ---- history & changes ----
  const begin = useCallback(() => { if (!gesture.current) { hist.current.push(docRef.current); gesture.current = true; } }, []);
  const commit = useCallback(() => { gesture.current = false; setDirty(true); force((n) => n + 1); }, []);
  const live = useCallback((d) => { docRef.current = d; setDoc(d); }, []);
  /** apply(fn, coalesceKey): one undo step; repeated calls with the same key within 1.5 s share it */
  const apply = useCallback((fn, key) => {
    const now = Date.now();
    const same = key && lastKey.current.key === key && now - lastKey.current.t < 1500;
    if (!same) hist.current.push(docRef.current);
    lastKey.current = { key, t: now };
    const next = fn(docRef.current);
    if (next && next !== docRef.current) { docRef.current = next; setDoc(next); setDirty(true); force((n) => n + 1); }
  }, []);
  /** run an effect that returns { doc, ids } */
  const fx = (fn) => {
    try {
      hist.current.push(docRef.current);
      const r = fn(docRef.current);
      docRef.current = r.doc; setDoc(r.doc); setSel(r.ids || []); setDirty(true); force((n) => n + 1);
      return r;
    } catch (e) { hist.current.undo(docRef.current); flash(e.message); return null; }
  };
  const undo = () => { const p = hist.current.undo(docRef.current); if (p) { live(p); setSel((s) => s.filter((id) => p.objects.some((o) => o.id === id))); force((n) => n + 1); } };
  const redo = () => { const p = hist.current.redo(docRef.current); if (p) { live(p); force((n) => n + 1); } };

  const selObjs = useMemo(() => doc.objects.filter((o) => sel.includes(o.id)), [doc, sel]);
  const stats = useMemo(() => D.jobStats(doc), [doc]);
  const needSel = (n = 1) => { if (selObjs.length < n) { flash(n > 1 ? `Select ${n} or more objects first` : 'Select something first'); return false; } return true; };

  // ---- text ----
  const onText = async (o, patch) => {
    try {
      const n = await retext(o, patch);
      apply((d) => ({ ...d, objects: d.objects.map((x) => (x.id === o.id ? n : x)) }));
    } catch (e) { flash(`Font problem: ${e.message}`); }
  };
  const createText = async (pt, text) => {
    if (!defaultFont) { flash('No fonts found on this PC'); return; }
    try {
      const o = await makeText({ x: pt.x, y: pt.y, text, font: (opts.lastFont || defaultFont).file, fontName: (opts.lastFont || defaultFont).name, sizeMm: opts.lastSize || 25.4, fill: { ...opts.newFill, type: opts.newFill.type === 'none' ? 'solid' : opts.newFill.type, color: opts.newFill.color || '#000000' } });
      apply((d) => ({ ...d, objects: [...d.objects, o] }));
      setSel([o.id]);
      setTab('props');
    } catch (e) { flash(`Font problem: ${e.message}`); }
  };
  const commitTextEdit = async () => {
    const t = textEdit;
    setTextEdit(null);
    if (!t) return;
    if (t.id) { const o = docRef.current.objects.find((x) => x.id === t.id); if (o && t.text !== o.text) await onText(o, { text: t.text }); return; }
    if (t.text.trim()) await createText({ x: t.x, y: t.y }, t.text);
    setTool('select');
  };
  const toOutlinesIds = (ids) => apply((d) => ({ ...d, objects: d.objects.map((o) => (ids.includes(o.id) && o.type === 'text' ? toOutlines(o) : o)) }));

  // ---- import ----
  const addImported = (objs, name, { center = true, keepPlace = false } = {}) => {
    if (!objs.length) return;
    let list = asGroup(objs).map((o) => ({ ...o, name: o.name === 'Shape' || o.name === 'Line' ? `${name}` : o.name }));
    const b = D.selBounds(list);
    if (!keepPlace && center && b) {
      const d = docRef.current;
      // too big for the page? bring it down to fit
      const k = Math.min(1, (d.page.w * 0.95) / b.w, (d.page.h * 0.95) / b.h);
      const tmp = { ...d, objects: list };
      let moved = k < 1 ? D.scaleSel(tmp, list.map((o) => o.id), k, k, { x: b.minX, y: b.minY }) : tmp;
      const nb = D.selBounds(moved.objects);
      moved = D.move(moved, list.map((o) => o.id), (d.page.w - nb.w) / 2 - nb.minX, (d.page.h - nb.h) / 2 - nb.minY);
      list = moved.objects;
      if (k < 1) flash(`${name} was bigger than the page — scaled to ${Math.round(k * 100)}%. Change the size in Properties.`);
    }
    apply((d) => ({ ...d, objects: [...d.objects, ...list] }));
    setSel(list.map((o) => o.id));
  };
  const importPdfFile = async (f, page = 1) => {
    const r = await pdfToObjects(pdfjs, b64ToBytes(f.base64), { page, imageToDataUrl });
    if (!r.objects.length) throw new Error('Nothing on that page could be read');
    // a page-size white background box is usually an export artifact: drop it
    const objs = r.objects.filter((o) => !(o.fill?.color === '#ffffff' && !o.stroke?.color && o.w > r.page.w * 0.98 && o.h > r.page.h * 0.98));
    const notes = [...(f.notes || []), ...r.notes];
    if (r.pages > 1 && page === 1) notes.push(`${r.pages} pages — opened page 1 (File › Import page…)`);
    return { objs, notes, pageSize: r.page, pages: r.pages };
  };
  const importFiles = async (files, { asNewDoc = false } = {}) => {
    setBusy('Opening artwork…');
    try {
      for (const f of files) {
        try {
          if (f.error) throw new Error(f.error);
          if (f.ext === 'svg') {
            const r = importSvg(f.text);
            const objs = [];
            let run = null;
            r.paths.forEach((p, i) => {
              const c = r.colors[i] && r.colors[i] !== 'none' ? r.colors[i] : '#000000';
              if (run && run.color === c) run.paths.push(p); else { run = { color: c, paths: [p] }; objs.push(run); }
            });
            addImported(objs.map((g) => D.shapeFromPaths(g.paths, { name: f.name, fill: { type: 'solid', color: g.color }, cut: /^#?(ff00ff|ec008c)$/i.test(g.color.replace('#', '')) })).map((o) => (o.cut ? { ...o, fill: { type: 'none' }, stroke: { color: D.CUT_COLOR, width: 0 } } : o)), f.name);
          } else if (f.ext === 'dxf') {
            const r = importDxf(f.text);
            addImported([D.shapeFromPaths(r.paths, { name: f.name, fill: { type: 'none' }, stroke: { color: '#000000', width: 0.35 } })], f.name);
            if (r.assumedInches) flash(`${f.name}: the DXF has no units — read as inches`);
          } else if (f.dataUrl) {
            const a = await analyzeImage(f.dataUrl, 64);
            const ppi = 150;
            const o = D.imageObject({ src: f.dataUrl, natW: (a.pxW / ppi) * MM, natH: (a.pxH / ppi) * MM, name: f.name });
            o.natPx = { w: a.pxW, h: a.pxH };
            addImported([o], f.name);
          } else if (f.base64) {
            const r = await importPdfFile(f);
            if (asNewDoc && files.length === 1) {
              const nd = { ...D.newDoc({ name: f.name }), page: { w: r.pageSize.w, h: r.pageSize.h, color: '#ffffff' } };
              hist.current.push(docRef.current);
              const objs = asGroup(r.objs);
              live({ ...nd, objects: objs }); setSel(objs.map((o) => o.id)); setFilePath(null); setDirty(true);
              setTimeout(() => canvas.current?.fit(), 30);
            } else addImported(r.objs, f.name, { center: true });
            if (r.notes.length) flash(`${f.name}: ${r.notes.join(' · ')}`);
            if (r.pages > 1) setDialog({ kind: 'pdfpages', file: f, pages: r.pages });
          }
        } catch (e) { flash(`${f.name}: ${e.message}`); }
      }
    } finally { setBusy(''); }
  };
  const doImport = async (asNewDoc = false) => {
    const files = await api.design.openArt(true);
    if (files && files.length) await importFiles(files, { asNewDoc });
  };

  // ---- files ----
  const confirmLose = () => !dirty || window.confirm('Discard the changes to this design?');
  const newDoc = () => { if (!confirmLose()) return; hist.current = D.history(120); live(D.newDoc({ widthIn: doc.page.w / MM, heightIn: doc.page.h / MM })); setSel([]); setFilePath(null); setDirty(false); setWelcome(true); };
  const save = async () => {
    const p = await api.files.saveJob(doc.name, { kind: 'inksign-design', version: 1, doc });
    if (p) { setFilePath(p); setDirty(false); flash(`Saved ${p}`); }
  };
  const open = async () => {
    if (!confirmLose()) return;
    const r = await api.files.openJob();
    if (!r) return;
    if (r.data?.kind !== 'inksign-design' || !r.data.doc) { flash('That .inksign file is a Cut Studio job — open it in Vinyl (Cut Studio).'); return; }
    hist.current = D.history(120);
    live(r.data.doc); setSel([]); setFilePath(r.path); setDirty(false);
    setTimeout(() => canvas.current?.fit(), 30);
  };
  const exportAs = async (fmt) => {
    try {
      const p = fmt === 'svg' ? await api.design.exportFile('svg', null, doc.name, toSvg(doc)) : await api.design.exportFile(fmt, toScene(doc), doc.name);
      if (p) flash(`Exported ${p}`);
    } catch (e) { flash(e.message); }
  };

  // ---- clipboard ----
  const copy = () => { if (!selObjs.length) return; clip.current = JSON.parse(JSON.stringify(selObjs)); };
  const paste = () => {
    if (!clip.current) return;
    const gmap = new Map();
    const objs = clip.current.map((o) => {
      let groupId = o.groupId;
      if (groupId) { if (!gmap.has(groupId)) gmap.set(groupId, D.newId()); groupId = gmap.get(groupId); }
      return { ...o, id: D.newId(), x: o.x + 6.35, y: o.y + 6.35, groupId };
    });
    clip.current = objs.map((o) => ({ ...o }));
    apply((d) => ({ ...d, objects: [...d.objects, ...objs] }));
    setSel(objs.map((o) => o.id));
  };
  const del = () => { if (!sel.length) return; apply((d) => D.remove(d, sel)); setSel([]); };
  const dup = () => { if (!needSel()) return; const r = D.duplicate(docRef.current, sel); hist.current.push(docRef.current); live(r.doc); setSel(r.ids); setDirty(true); };

  // ---- color from swatches ----
  const setFillColor = (c) => {
    if (!selObjs.length) { setOpts((o) => ({ ...o, newFill: c ? { type: 'solid', color: c } : { type: 'none' } })); flash(c ? 'New shapes will use this fill' : 'New shapes will have no fill'); return; }
    apply((d) => D.update(d, sel, (o) => (o.type === 'image' ? {} : { fill: c ? { type: 'solid', color: c } : { type: 'none' }, cut: false })));
  };
  const setStrokeColor = (c) => {
    if (!selObjs.length) { setOpts((o) => ({ ...o, newStroke: c ? { color: c, width: 0.5 } : { color: null, width: 0 } })); return; }
    apply((d) => D.update(d, sel, (o) => (o.type === 'image' ? {} : { stroke: c ? { color: c, width: o.stroke?.width > 0 ? o.stroke.width : 0.5 } : { color: null, width: 0 } })));
  };
  const makeCut = () => { if (!needSel()) return; apply((d) => D.update(d, sel, (o) => (o.type === 'image' ? {} : { cut: true, prevFill: o.fill, fill: { type: 'none' }, stroke: { color: D.CUT_COLOR, width: 0 } }))); };
  const pickFrom = (src) => {
    if (!selObjs.length) { setOpts((o) => ({ ...o, newFill: src.fill, newStroke: src.stroke })); flash('Picked — new shapes will use these colors'); return; }
    apply((d) => D.update(d, sel, (o) => (o.type === 'image' ? {} : { fill: src.fill, stroke: src.stroke, cut: src.cut })));
  };

  // ---- picture tracing ----
  const traceImage = async (o, { mode, threshold, offsetMm, asCut }) => {
    const a = await analyzeImage(o.src, 1200);
    const mask = makeMask(a.data, a.w, a.h, { mode, threshold, tolerance: 40 });
    const traced = traceToPaths(mask, a.w, a.h, { widthMm: o.bw, minAreaPx: 30 });
    if (!traced.length) throw new Error('Nothing found — try another setting');
    const placed = traced.map((p) => p.map((q) => D.placePoint(o, q)));
    if (asCut) {
      const out = offsetPaths(placed, Math.max(0.01, offsetMm), { outerOnly: true, corners: 'round' });
      return D.shapeFromPaths(out, { name: 'CutContour', fill: { type: 'none' }, stroke: { color: D.CUT_COLOR, width: 0 }, cut: true });
    }
    return D.shapeFromPaths(placed, { name: `${o.name} (traced)`, fill: { type: 'solid', color: '#000000' }, fillRule: 'evenodd' });
  };

  // ---- menus ----
  const ids = sel;
  const S = (n) => selObjs.length >= n;
  const PD = (id, title, fields, onOk, extra = {}) => setDialog({ kind: 'param', id, title, fields, onOk, ...extra });
  const textObjs = selObjs.filter((o) => o.type === 'text');

  const menus = {
    File: [
      ['New', newDoc, 'Ctrl+N'], ['Open…', open, 'Ctrl+O'], ['Save…', save, 'Ctrl+S'], null,
      ['Import…', () => doImport(false), 'Ctrl+I'], ['Open PDF / AI / EPS as a new design…', () => { if (confirmLose()) doImport(true); }], null,
      ['Export PDF…', () => exportAs('pdf')], ['Export EPS…', () => exportAs('eps')], ['Export SVG…', () => exportAs('svg')], null,
      ['Document setup…', () => { setSel([]); setTab('props'); }],
      ['RIP and Print…', () => openPrint('art'), 'Ctrl+P'], ['RIP and Print the whole page…', () => openPrint('page')], ['Cut / Plot…', () => setDialog({ kind: 'cut' }), 'Ctrl+L'], ['Print & Cut…', () => setDialog({ kind: 'printcut' })], null,
      ['Job info…', () => setDialog({ kind: 'jobinfo' })],
    ],
    Edit: [
      ['Undo', undo, 'Ctrl+Z', !hist.current.canUndo], ['Redo', redo, 'Ctrl+Y', !hist.current.canRedo], null,
      ['Cut', () => { copy(); del(); }, 'Ctrl+X', !S(1)], ['Copy', copy, 'Ctrl+C', !S(1)], ['Paste', paste, 'Ctrl+V', !clip.current], ['Duplicate', dup, 'Ctrl+D', !S(1)], ['Delete', del, 'Del', !S(1)], null,
      ['Select all', () => setSel(doc.objects.filter((o) => !o.locked && !o.hidden).map((o) => o.id)), 'Ctrl+A'],
      ['Select none', () => setSel([]), 'Esc'],
      ['Select same color', () => { const c = JSON.stringify(selObjs[0]?.fill); setSel(doc.objects.filter((o) => JSON.stringify(o.fill) === c && !o.locked && !o.hidden).map((o) => o.id)); }, '', !S(1)],
      ['Select all cut lines', () => setSel(doc.objects.filter((o) => o.cut).map((o) => o.id))],
      ['Invert selection', () => setSel(doc.objects.filter((o) => !sel.includes(o.id) && !o.locked && !o.hidden).map((o) => o.id))],
    ],
    Arrange: [
      ['Group', () => apply((d) => D.group(d, ids)), 'Ctrl+G', !S(2)], ['Ungroup', () => apply((d) => D.ungroup(d, ids)), 'Ctrl+Shift+G', !selObjs.some((o) => o.groupId)],
      ['Compound (join into one shape)', () => fx((d) => FX.compound(d, ids)), 'Ctrl+K', !S(2)], ['Break apart', () => fx((d) => FX.breakApart(d, ids)), 'Ctrl+Shift+K', !S(1)], null,
      ['Bring to front', () => apply((d) => D.reorder(d, ids, 'front')), 'Ctrl+Shift+]', !S(1)], ['Bring forward', () => apply((d) => D.reorder(d, ids, 'forward')), 'Ctrl+]', !S(1)],
      ['Send backward', () => apply((d) => D.reorder(d, ids, 'backward')), 'Ctrl+[', !S(1)], ['Send to back', () => apply((d) => D.reorder(d, ids, 'back')), 'Ctrl+Shift+[', !S(1)], null,
      ['Align left', () => apply((d) => D.align(d, ids, 'left')), '', !S(1)], ['Align centers (horizontal)', () => apply((d) => D.align(d, ids, 'hcenter')), '', !S(1)], ['Align right', () => apply((d) => D.align(d, ids, 'right')), '', !S(1)],
      ['Align top', () => apply((d) => D.align(d, ids, 'top')), '', !S(1)], ['Align middles (vertical)', () => apply((d) => D.align(d, ids, 'vcenter')), '', !S(1)], ['Align bottom', () => apply((d) => D.align(d, ids, 'bottom')), '', !S(1)],
      ['Center on page', () => apply((d) => D.align(D.align(d, ids, 'hcenter', true), ids, 'vcenter', true)), 'Ctrl+E', !S(1)], null,
      ['Distribute across', () => apply((d) => D.distribute(d, ids, 'h')), '', !S(3)], ['Distribute down', () => apply((d) => D.distribute(d, ids, 'v')), '', !S(3)],
      ['Spacing…', () => PD('spacing', 'Spacing', [{ key: 'axis', label: 'Direction', type: 'select', options: [['h', 'Across'], ['v', 'Down']], default: 'h' }, { key: 'gap', label: 'Space between', type: 'in', default: 6.35 }],
        (v) => apply((d) => D.distribute(d, ids, v.axis, v.gap))), '', !S(2)], null,
      ['Rotate 90° right', () => { const b = D.selBounds(selObjs); apply((d) => D.rotateSel(d, ids, 90, { x: b.cx, y: b.cy })); }, '', !S(1)],
      ['Rotate 90° left', () => { const b = D.selBounds(selObjs); apply((d) => D.rotateSel(d, ids, -90, { x: b.cx, y: b.cy })); }, '', !S(1)],
      ['Mirror horizontal', () => apply((d) => D.mirror(d, ids, 'h')), 'Ctrl+M', !S(1)], ['Mirror vertical', () => apply((d) => D.mirror(d, ids, 'v')), '', !S(1)],
      ['Clear transform (straighten)', () => apply((d) => D.update(d, ids, (o) => ({ rot: 0, flipX: false, flipY: false, w: o.bw, h: o.bh }))), '', !S(1)], null,
      ['Lock', () => apply((d) => D.setAll(d, ids, { locked: true })), 'Ctrl+Alt+L', !S(1)], ['Unlock all', () => apply((d) => D.setAll(d, d.objects.map((o) => o.id), { locked: false }))],
      ['Hide', () => { apply((d) => D.setAll(d, ids, { hidden: true })); setSel([]); }, '', !S(1)], ['Show all', () => apply((d) => D.setAll(d, d.objects.map((o) => o.id), { hidden: false }))], null,
      ['Step and repeat…', () => PD('step', 'Step and repeat', [
        { key: 'cols', label: 'Across', type: 'num', default: 3, unit: 'copies' }, { key: 'rows', label: 'Down', type: 'num', default: 2, unit: 'copies' },
        { key: 'gapX', label: 'Space across', type: 'in', default: 6.35 }, { key: 'gapY', label: 'Space down', type: 'in', default: 6.35 },
      ], (v) => fx((d) => D.stepRepeat(d, ids, { cols: Math.max(1, Math.round(v.cols)), rows: Math.max(1, Math.round(v.rows)), gapX: v.gapX, gapY: v.gapY }))), '', !S(1)],
      ['Fill the page with copies…', () => PD('fillpage', 'Fill the page', [{ key: 'gap', label: 'Space between', type: 'in', default: 6.35 }, { key: 'margin', label: 'Page margin', type: 'in', default: 6.35 }],
        (v) => fx((d) => D.fillPage(d, ids, v.gap, v.margin))), '', !S(1)],
      ['Auto serialize…', () => setDialog({ kind: 'serial' }), '', textObjs.length !== 1],
      ['Nest on the page', () => nestSel(), '', !S(2)],
    ],
    Text: [
      ['Edit text', () => { const o = textObjs[0]; if (o) startEditText(o); }, 'Enter', textObjs.length !== 1],
      ['Find and replace…', () => PD('find', 'Find and replace', [{ key: 'find', label: 'Find', type: 'text', default: '' }, { key: 'repl', label: 'Replace with', type: 'text', default: '' }, { key: 'all', label: 'Whole design (not just what\'s selected)', type: 'bool', default: true }],
        async (v) => {
          if (!v.find) throw new Error('Type what to find');
          const targets = docRef.current.objects.filter((o) => o.type === 'text' && (v.all || sel.includes(o.id)) && o.text.includes(v.find));
          if (!targets.length) throw new Error(`“${v.find}” isn't in any text`);
          const made = await Promise.all(targets.map((o) => retext(o, { text: o.text.split(v.find).join(v.repl) })));
          apply((d) => ({ ...d, objects: d.objects.map((o) => made.find((m) => m.id === o.id) || o) }));
          flash(`Replaced in ${made.length} text object${made.length > 1 ? 's' : ''}`);
        }, { okLabel: 'Replace all' })],
      ['UPPER CASE', () => caseAll('upper'), '', !textObjs.length], ['lower case', () => caseAll('lower'), '', !textObjs.length], ['Title Case', () => caseAll('title'), '', !textObjs.length], ['Sentence case', () => caseAll('sentence'), '', !textObjs.length], null,
      ['Convert to outlines', () => toOutlinesIds(ids), 'Ctrl+Q', !textObjs.length], null,
      ['QR code…', () => PD('qr', 'QR code', [{ key: 'text', label: 'Link or text', type: 'textarea', default: 'https://' }, { key: 'size', label: 'Size', type: 'in', default: 50.8 }, { key: 'level', label: 'Error correction', type: 'select', options: [['L', 'Low (7%)'], ['M', 'Medium (15%)'], ['Q', 'Quartile (25%)'], ['H', 'High (30%) — survives scuffs, logos on top']], default: 'M' }, { key: 'color', label: 'Color', type: 'color', default: '#000000' }],
        (v) => { const q = qrPaths(v.text, { sizeMm: v.size, level: v.level }); addCentered(D.shapeFromPaths(q.paths, { name: 'QR code', fill: { type: 'solid', color: v.color } })); })],
      ['Barcode (Code 128)…', () => PD('bar', 'Barcode — Code 128', [{ key: 'text', label: 'What it says', type: 'text', default: '' }, { key: 'w', label: 'Width', type: 'in', default: 63.5 }, { key: 'h', label: 'Bar height', type: 'in', default: 19.05 }, { key: 'color', label: 'Color', type: 'color', default: '#000000' }],
        (v) => { const c = code128Paths(v.text, { widthMm: v.w, heightMm: v.h }); addCentered(D.shapeFromPaths(c.paths, { name: `Barcode ${v.text}`, fill: { type: 'solid', color: v.color } })); })],
    ],
    Effects: [
      ...FX.COMBINE.map((c) => [`Combine › ${c.name}`, () => fx((d) => FX.combine(d, ids, c.id)), c.id === 'weld' ? 'Ctrl+W' : '', !S(c.id === 'weld' || c.id === 'weldColor' || c.id === 'fuse' ? 1 : 2), c.help]),
      null,
      ['Outline…', () => PD('outline', 'Outline', [
        { key: 'dist', label: 'Distance', type: 'in', default: 3.175, help: 'Negative goes inside' }, { key: 'corners', label: 'Corners', type: 'select', options: [['round', 'Round'], ['miter', 'Sharp'], ['square', 'Square']], default: 'round' },
        { key: 'outer', label: 'Outer edge only (fill letter holes)', type: 'bool', default: true }, { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      ], (v) => fx((d) => FX.outline(d, ids, { distMm: v.dist, corners: v.corners, outerOnly: v.outer, color: v.color }))), '', !S(1)],
      ['Contour cut…', () => contourCutDlg(), '', !S(1)],
      ['Rectangle contour cut…', () => PD('rectcut', 'Rectangle contour cut', [{ key: 'margin', label: 'Space around the art', type: 'in', default: 3.175 }, { key: 'radius', label: 'Corner radius', type: 'in', default: 0 }],
        (v) => fx((d) => FX.rectContourCut(d, ids, { marginMm: v.margin, radiusMm: v.radius }))), '', !S(1)],
      ['Page contour cut…', () => PD('pagecut', 'Page contour cut', [{ key: 'margin', label: 'In from the page edge', type: 'in', default: 0 }, { key: 'radius', label: 'Corner radius', type: 'in', default: 0 }],
        (v) => fx((d) => FX.pageContourCut(d, { marginMm: v.margin, radiusMm: v.radius })))],
      null,
      ['Shadow…', () => PD('shadow', 'Shadow', [
        { key: 'kind', label: 'Kind', type: 'select', options: [['drop', 'Drop shadow'], ['block', 'Block (3D extrude)'], ['cast', 'Cast (on the ground)']], default: 'drop' },
        { key: 'dx', label: 'Right', type: 'in', default: 3.175 }, { key: 'dy', label: 'Down', type: 'in', default: 3.175 }, { key: 'color', label: 'Color', type: 'color', default: '#555555' },
      ], (v) => fx((d) => FX.shadow(d, ids, { kind: v.kind, dxMm: v.dx, dyMm: v.dy, color: v.color }))), '', !S(1)],
      ['Blend…', () => PD('blend', 'Blend', [{ key: 'steps', label: 'Steps in between', type: 'num', default: 5 }], (v) => fx((d) => FX.blend(d, ids, { steps: Math.max(1, Math.round(v.steps)) }))), '', selObjs.length !== 2],
      ['Distort…', () => PD('distort', 'Distort (envelope)', [{ key: 'kind', label: 'Shape', type: 'select', options: ENVELOPES.map((e) => [e.id, e.name]), default: 'arch' }, { key: 'amount', label: 'Amount', type: 'num', default: 30, unit: '%' }],
        (v) => fx((d) => FX.distort(toOutlinesDoc(d, ids), ids, v.kind, v.amount))), '', !S(1)],
      ['Stripe…', () => PD('stripe', 'Stripe', [{ key: 'count', label: 'Stripes', type: 'num', default: 3 }, { key: 'gap', label: 'Stripe thickness', type: 'in', default: 3.175 }, { key: 'dir', label: 'Direction', type: 'select', options: [['h', 'Across'], ['v', 'Up and down']], default: 'h' }, { key: 'color', label: 'Color', type: 'color', default: '#ffffff' }],
        (v) => fx((d) => FX.stripe(d, ids, { count: Math.max(1, Math.round(v.count)), gapMm: v.gap, direction: v.dir, color: v.color }))), '', !S(1)],
      ['Reduce nodes…', () => PD('simplify', 'Reduce nodes', [{ key: 'tol', label: 'Tolerance', type: 'in', default: 0.1, step: 0.01, help: 'Bigger = smoother, fewer nodes' }],
        (v) => apply((d) => D.update(d, ids, (o) => (o.type === 'shape' ? { paths: simplify(o.paths, v.tol * (o.bw / o.w || 1)) } : {})))), '', !S(1)],
      null,
      ['Rhinestone fill…', () => PD('stones', 'Rhinestone fill', [{ key: 'hole', label: 'Stone hole', type: 'in', default: 3.1, step: 0.01 }, { key: 'gap', label: 'Space between', type: 'in', default: 0.8, step: 0.01 }, { key: 'mode', label: 'Where', type: 'select', options: [['outline', 'Along the outline'], ['fill', 'Fill inside'], ['both', 'Both']], default: 'outline' }],
        (v) => { const r = fx((d) => FX.rhinestoneFill(d, ids, { holeMm: v.hole, gapMm: v.gap, mode: v.mode })); if (r) flash(`${r.count} stones`); }), '', !S(1)],
      ['Rectangle finisher (grommets)…', () => PD('rfin', 'Rectangle finisher', [
        { key: 'page', label: 'Around the whole page', type: 'bool', default: true }, { key: 'inset', label: 'In from the edge', type: 'in', default: 19.05 },
        { key: 'spacing', label: 'Space between grommets', type: 'in', default: 609.6 }, { key: 'dia', label: 'Mark size', type: 'in', default: 9.525 },
      ], (v) => { const r = fx((d) => FX.rectFinisher(d, ids, { usePage: v.page, insetMm: v.inset, spacingMm: v.spacing, diaMm: v.dia })); if (r) flash(`${r.count} grommet marks`); })],
      ['Shape finisher (grommets)…', () => PD('sfin', 'Shape finisher', [{ key: 'inset', label: 'In from the edge', type: 'in', default: 19.05 }, { key: 'spacing', label: 'Space between grommets', type: 'in', default: 304.8 }, { key: 'dia', label: 'Mark size', type: 'in', default: 9.525 }],
        (v) => { const r = fx((d) => FX.shapeFinisher(d, ids, { insetMm: v.inset, spacingMm: v.spacing, diaMm: v.dia })); if (r) flash(`${r.count} grommet marks`); }), '', !S(1)],
      ['Trim marks…', () => PD('trim', 'Trim marks', [{ key: 'page', label: 'At the page corners', type: 'bool', default: !S(1) }, { key: 'off', label: 'Gap from the art', type: 'in', default: 3.175 }, { key: 'len', label: 'Length', type: 'in', default: 6.35 }],
        (v) => fx((d) => FX.trimMarks(d, ids, { usePage: v.page, offsetMm: v.off, lengthMm: v.len })))],
      null,
      ['Trace picture to shapes…', () => traceDlg(false), '', !(selObjs.length === 1 && selObjs[0].type === 'image')],
    ],
    View: [
      ['Fit page', () => canvas.current?.fit(), 'Ctrl+0'], ['Zoom to selection', () => canvas.current?.fitSelection(), 'Ctrl+2', !S(1)], ['Actual size', () => canvas.current?.actual(), 'Ctrl+1'],
      ['Zoom in', () => canvas.current?.zoomBy(1.4), 'Ctrl+='], ['Zoom out', () => canvas.current?.zoomBy(1 / 1.4), 'Ctrl+-'], null,
      [`${opts.wire ? '✓ ' : ''}Wireframe (outlines only)`, () => setOpts((o) => ({ ...o, wire: !o.wire })), 'Ctrl+Shift+W'],
      [`${opts.showGrid ? '✓ ' : ''}Show grid`, () => setOpts((o) => ({ ...o, showGrid: !o.showGrid }))],
      ['Grid spacing…', () => PD('grid', 'Grid', [{ key: 'g', label: 'Grid spacing', type: 'in', default: 6.35 }], (v) => setOpts((o) => ({ ...o, gridIn: Math.max(0.01, v.g / MM) })))],
      [`${opts.snapGrid ? '✓ ' : ''}Snap to grid`, () => setOpts((o) => ({ ...o, snapGrid: !o.snapGrid }))],
      [`${opts.snapGuides ? '✓ ' : ''}Snap to guides & page`, () => setOpts((o) => ({ ...o, snapGuides: !o.snapGuides }))],
      [`${opts.snapObjects ? '✓ ' : ''}Snap to objects`, () => setOpts((o) => ({ ...o, snapObjects: !o.snapObjects }))], null,
      ['Add guide…', () => PD('guide', 'Add guide', [{ key: 'axis', label: 'Guide', type: 'select', options: [['x', 'Up and down (vertical)'], ['y', 'Across (horizontal)']], default: 'x' }, { key: 'pos', label: 'At', type: 'in', default: 25.4 }],
        (v) => apply((d) => ({ ...d, guides: { ...d.guides, [v.axis]: [...d.guides[v.axis], v.pos] } })))],
      ['Clear guides', () => apply((d) => ({ ...d, guides: { x: [], y: [] } }))],
    ],
  };
  function caseAll(mode) {
    Promise.all(textObjs.map((o) => retext(o, { text: changeCase(o.text, mode) })))
      .then((made) => apply((d) => ({ ...d, objects: d.objects.map((o) => made.find((m) => m.id === o.id) || o) })))
      .catch((e) => flash(e.message));
  }
  function toOutlinesDoc(d, list) { return { ...d, objects: d.objects.map((o) => (list.includes(o.id) && o.type === 'text' ? toOutlines(o) : o)) }; }
  function addCentered(o) {
    const d = docRef.current;
    o.x = (d.page.w - o.w) / 2; o.y = (d.page.h - o.h) / 2;
    apply((x) => ({ ...x, objects: [...x.objects, o] }));
    setSel([o.id]);
  }
  function startEditText(o) {
    setTextEdit({ id: o.id, x: o.x, y: o.y, text: o.text });
  }
  function nestSel() {
    const d = docRef.current;
    const units = [];
    const seen = new Set();
    for (const o of selObjs) {
      if (seen.has(o.id)) continue;
      const u = o.groupId ? selObjs.filter((x) => x.groupId === o.groupId) : [o];
      u.forEach((x) => seen.add(x.id));
      const b = D.selBounds(u);
      units.push({ id: units.length, ids: u.map((x) => x.id), w: b.w, h: b.h, b });
    }
    const gap = 6.35, margin = 6.35;
    const placed = nest(units.map((u) => ({ id: u.id, w: u.h, h: u.w })), d.page.w - 2 * margin, { gap, allowRotate: true });
    let out = d;
    for (const p of placed) {
      const u = units[p.id];
      if (p.rotated) out = D.rotateSel(out, u.ids, 90, { x: u.b.cx, y: u.b.cy });
      const nb = D.selBounds(out.objects.filter((o) => u.ids.includes(o.id)));
      out = D.move(out, u.ids, margin + p.y - nb.minX, margin + p.x - nb.minY);
    }
    apply(() => out);
    const all = D.selBounds(out.objects.filter((o) => sel.includes(o.id)));
    if (all && all.maxY > d.page.h) flash(`Nested — it needs ${(all.maxY / MM).toFixed(1)}″ of height; the page is ${(d.page.h / MM).toFixed(1)}″`);
  }
  function contourCutDlg() {
    const pic = selObjs.length === 1 && selObjs[0].type === 'image' ? selObjs[0] : null;
    if (pic) { traceDlg(true); return; }
    PD('contour', 'Contour cut', [
      { key: 'offset', label: 'Distance from the art', type: 'in', default: 1.5875, help: 'Bleed/border around stickers; 0 cuts on the edge' },
      { key: 'corners', label: 'Corners', type: 'select', options: [['round', 'Round'], ['miter', 'Sharp'], ['square', 'Square']], default: 'round' },
      { key: 'outer', label: 'Outer edge only (no cuts inside letters)', type: 'bool', default: true },
    ], (v) => fx((d) => FX.contourCut(d, ids, { offsetMm: v.offset, corners: v.corners, outerOnly: v.outer })));
  }
  function traceDlg(asCut) {
    const o = selObjs[0];
    PD(asCut ? 'tracecut' : 'trace', asCut ? 'Contour cut around the picture' : 'Trace picture to shapes', [
      { key: 'mode', label: 'Find the shape by', type: 'select', options: [['alpha', 'Transparent background'], ['notbg', 'Not the background color'], ['dark', 'Dark areas']], default: 'notbg' },
      { key: 'threshold', label: 'Threshold', type: 'num', default: 128, help: '0–255' },
      ...(asCut ? [{ key: 'offset', label: 'Distance from the art', type: 'in', default: 1.5875 }, { key: 'frame', label: 'Just cut the picture\'s rectangle', type: 'bool', default: false }] : []),
    ], async (v) => {
      if (asCut && v.frame) { fx((d) => FX.contourCut(d, [o.id], { offsetMm: v.offset, corners: 'miter' })); return; }
      const made = await traceImage(o, { mode: v.mode, threshold: v.threshold, offsetMm: v.offset, asCut });
      apply((d) => {
        const i = d.objects.findIndex((x) => x.id === o.id);
        const objs = d.objects.slice();
        objs.splice(i + 1, 0, made);
        return { ...d, objects: objs };
      });
      setSel([made.id]);
    });
  }

  // ---- keyboard ----
  const handlers = useRef({});
  handlers.current = { openPrint: (w) => openPrint(w), undo, redo, copy, paste, del, dup, save, open, newDoc, doImport, apply, fx, ids, selObjs, textObjs, setDialog, menus };
  useEffect(() => {
    if (!active) return undefined;
    const h = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (document.querySelector('.modal-back')) return;
      const H = handlers.current;
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const run = (fn) => { e.preventDefault(); fn(); };
      if (ctrl) {
        if (k === 'z' && !e.shiftKey) return run(H.undo);
        if (k === 'y' || (k === 'z' && e.shiftKey)) return run(H.redo);
        if (k === 'c') return run(H.copy);
        if (k === 'v') return run(H.paste);
        if (k === 'x') return run(() => { H.copy(); H.del(); });
        if (k === 'd') return run(H.dup);
        if (k === 's') return run(H.save);
        if (k === 'o') return run(H.open);
        if (k === 'n') return run(H.newDoc);
        if (k === 'i') return run(() => H.doImport(false));
        if (k === 'p') return run(() => H.openPrint('art'));
        if (k === 'l' && !e.altKey) return run(() => H.setDialog({ kind: 'cut' }));
        if (k === 'a') return run(() => setSel(docRef.current.objects.filter((o) => !o.locked && !o.hidden).map((o) => o.id)));
        if (k === 'g') return run(() => H.apply((d) => (e.shiftKey ? D.ungroup(d, H.ids) : D.group(d, H.ids))));
        if (k === 'k') return run(() => H.fx((d) => (e.shiftKey ? FX.breakApart(d, H.ids) : FX.compound(d, H.ids))));
        if (k === 'w' && e.shiftKey) return run(() => setOpts((o) => ({ ...o, wire: !o.wire })));
        if (k === 'w') return run(() => H.fx((d) => FX.combine(d, H.ids, 'weld')));
        if (k === 'q') return run(() => toOutlinesIds(H.ids));
        if (k === 'm') return run(() => H.apply((d) => D.mirror(d, H.ids, 'h')));
        if (k === 'e') return run(() => H.apply((d) => D.align(D.align(d, H.ids, 'hcenter', true), H.ids, 'vcenter', true)));
        if (k === '0') return run(() => canvas.current?.fit());
        if (k === '1') return run(() => canvas.current?.actual());
        if (k === '2') return run(() => canvas.current?.fitSelection());
        if (k === '=' || k === '+') return run(() => canvas.current?.zoomBy(1.4));
        if (k === '-') return run(() => canvas.current?.zoomBy(1 / 1.4));
        if (e.key === ']') return run(() => H.apply((d) => D.reorder(d, H.ids, e.shiftKey ? 'front' : 'forward')));
        if (e.key === '[') return run(() => H.apply((d) => D.reorder(d, H.ids, e.shiftKey ? 'back' : 'backward')));
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (tool === 'node' && canvas.current?.hasNode()) return run(() => canvas.current.deleteNode());
        return run(H.del);
      }
      if (e.key === 'Escape') {
        if (canvas.current?.hasPen()) return run(() => canvas.current.cancelPen());
        return run(() => { setSel([]); setTool('select'); });
      }
      if (e.key === 'Enter') {
        if (canvas.current?.hasPen()) return run(() => canvas.current.finishPen(false));
        if (H.textObjs.length === 1) return run(() => startEditText(H.textObjs[0]));
      }
      if (e.key.startsWith('Arrow') && H.ids.length) {
        const step = e.shiftKey ? 25.4 : 2.54;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        return run(() => H.apply((d) => D.move(d, H.ids, dx, dy), 'nudge'));
      }
      if (KEY_TOOLS[k] && !e.altKey) return run(() => setTool(KEY_TOOLS[k]));
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [active, tool]);

  // close menus on outside click
  useEffect(() => {
    if (!menu) return undefined;
    const h = (e) => { if (!e.target.closest('.dz-menubar')) setMenu(null); };
    window.addEventListener('pointerdown', h);
    return () => window.removeEventListener('pointerdown', h);
  }, [menu]);

  // ---- RIP and Print: the art's box (like Flexi) or the whole page, previewed in the Print window ----
  const openPrint = async (what) => {
    const d = docRef.current;
    const vis = d.objects.filter((o) => !o.hidden);
    if (!vis.length) { flash('Nothing to print yet'); return; }
    const whole = what === 'page';
    let scene = toScene(d);
    if (!whole) {
      const b = D.selBounds(vis.filter((o) => !o.cut).length ? vis.filter((o) => !o.cut) : vis);
      scene = cropScene(scene, b);
    }
    setBusy('Getting the job ready…');
    try {
      const preview = await api.design.pdfBytes(scene, 'omit');
      setDialog({ kind: 'printwin', scene, preview, whole });
    } catch (e) { flash(e.message); } finally { setBusy(''); }
  };
  // ---- output helpers ----
  const groupsFor = (what, onlySel, o) => cutPanels(cutGroups(docRef.current, what, onlySel ? sel : null), o);
  const cutLines = doc.objects.filter((o) => o.cut && !o.hidden).flatMap(D.placedPaths);

  const setBox = (box, keepRatio) => apply((d) => D.setSelBox(d, sel, box, keepRatio));
  const sb = D.selBounds(selObjs);
  const textOverlay = textEdit && (() => {
    const left = view.vx + textEdit.x * view.z, top = view.vy + textEdit.y * view.z;
    return (
      <textarea className="dz-textedit" autoFocus ref={(el) => { if (el && document.activeElement !== el) setTimeout(() => el.focus(), 0); }} style={{ left, top }} value={textEdit.text} placeholder="Type, then click away (Ctrl+Enter)"
        onChange={(e) => setTextEdit({ ...textEdit, text: e.target.value })} onBlur={commitTextEdit}
        onKeyDown={(e) => { if (e.key === 'Escape') { setTextEdit(null); } if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.target.blur(); e.stopPropagation(); }} />
    );
  })();

  return (
    <div className="dz" onDragOver={(e) => e.preventDefault()}>
      {/* menu bar */}
      <div className="dz-menubar">
        {Object.entries(menus).map(([name, items]) => (
          <div key={name} className="dz-menu">
            <button className={`dz-menu-btn ${menu === name ? 'on' : ''}`} onClick={() => setMenu(menu === name ? null : name)} onPointerEnter={() => menu && setMenu(name)}>{name}</button>
            {menu === name && (
              <div className="dz-menu-list">
                {items.map((it, i) => (it ? (
                  <button key={i} disabled={!!it[3]} title={it[4] || ''} onClick={() => { setMenu(null); it[1](); }}>
                    <span>{it[0]}</span><small>{it[2] || ''}</small>
                  </button>
                ) : <hr key={i} />))}
              </div>
            )}
          </div>
        ))}
        <div className="dz-title">{doc.name}{dirty ? ' •' : ''}{filePath ? <small> — {filePath}</small> : null}</div>
        <div className="dz-actions">
          <button className="tb-btn" onClick={() => doImport(false)} title="Import PDF, AI, EPS, SVG, DXF or pictures (Ctrl+I)">⤓ Import</button>
          <button className="tb-btn" onClick={() => openPrint('art')} title="RIP and Print (Ctrl+P)">🖨 Print</button>
          <button className="tb-btn" onClick={() => setDialog({ kind: 'cut' })} title="Cut / Plot (Ctrl+L)">✂ Cut</button>
          <button className="tb-btn primary" onClick={() => setDialog({ kind: 'printcut' })} title="Print with registration marks, then contour cut">Print & Cut</button>
        </div>
      </div>

      {/* property bar */}
      <div className="dz-propbar">
        {sb ? (
          <>
            <span className="dz-pb-label">{selObjs.length === 1 ? (selObjs[0].name || selObjs[0].type) : `${selObjs.length} selected`}</span>
            <PB label="X" mm={sb.minX} onCommit={(v) => setBox({ x: v })} />
            <PB label="Y" mm={sb.minY} onCommit={(v) => setBox({ y: v })} />
            <PB label="W" mm={sb.w} onCommit={(v) => setBox({ w: Math.max(0.1, v) }, opts.lockRatio !== false)} />
            <PB label="H" mm={sb.h} onCommit={(v) => setBox({ h: Math.max(0.1, v) }, opts.lockRatio !== false)} />
            <button className={`tb-btn ${opts.lockRatio !== false ? 'on' : ''}`} title="Keep proportions" onClick={() => setOpts((o) => ({ ...o, lockRatio: o.lockRatio === false }))}>🔗</button>
            <span className="dz-pb-sep" />
            <button className="tb-btn" title="Rotate 90° left" onClick={() => apply((d) => D.rotateSel(d, sel, -90, { x: sb.cx, y: sb.cy }))}>⟲</button>
            <button className="tb-btn" title="Rotate 90° right" onClick={() => apply((d) => D.rotateSel(d, sel, 90, { x: sb.cx, y: sb.cy }))}>⟳</button>
            <button className="tb-btn" title="Mirror horizontal" onClick={() => apply((d) => D.mirror(d, sel, 'h'))}>⇋</button>
            <button className="tb-btn" title="Mirror vertical" onClick={() => apply((d) => D.mirror(d, sel, 'v'))}>⇵</button>
            <span className="dz-pb-sep" />
            {[['left', '⫷'], ['hcenter', '⫼'], ['right', '⫸'], ['top', '⊤'], ['vcenter', '⊝'], ['bottom', '⊥']].map(([a, ic]) => (
              <button key={a} className="tb-btn" title={`Align ${a}${selObjs.length === 1 ? ' (to the page)' : ''}`} onClick={() => apply((d) => D.align(d, sel, a))}>{ic}</button>
            ))}
            <span className="dz-pb-sep" />
            <button className="tb-btn" title="Weld (Ctrl+W)" onClick={() => fx((d) => FX.combine(d, sel, 'weld'))}>Weld</button>
            <button className="tb-btn" title="Contour cut" onClick={contourCutDlg}>Contour</button>
            <button className="tb-btn" title="Group (Ctrl+G)" disabled={selObjs.length < 2} onClick={() => apply((d) => D.group(d, sel))}>Group</button>
            <button className="tb-btn" title="Ungroup (Ctrl+Shift+G)" disabled={!selObjs.some((o) => o.groupId)} onClick={() => apply((d) => D.ungroup(d, sel))}>Ungroup</button>
          </>
        ) : (
          <>
            <span className="dz-pb-label">Page</span>
            <PB label="W" mm={doc.page.w} onCommit={(v) => apply((d) => ({ ...d, page: { ...d.page, w: Math.max(5, v) } }))} />
            <PB label="H" mm={doc.page.h} onCommit={(v) => apply((d) => ({ ...d, page: { ...d.page, h: Math.max(5, v) } }))} />
            <span className="muted small">{tool === 'shape' ? '' : 'Draw with the tools on the left, or Import artwork.'}</span>
          </>
        )}
        {tool === 'shape' && (
          <label className="dz-pb-shape">Shape
            <select value={shapeKind} onChange={(e) => setShapeKind(e.target.value)}>{SHAPES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </label>
        )}
      </div>

      {/* tools */}
      <div className="dz-tools">
        {TOOLS.map(([id, ic, tip]) => (
          <button key={id} className={`dz-tool ${tool === id ? 'on' : ''}`} title={tip} onClick={() => setTool(id)}>{ic}</button>
        ))}
        <div className="dz-tool-sep" />
        <button className="dz-tool" title="Undo (Ctrl+Z)" disabled={!hist.current.canUndo} onClick={undo}>↶</button>
        <button className="dz-tool" title="Redo (Ctrl+Y)" disabled={!hist.current.canRedo} onClick={redo}>↷</button>
        <button className="dz-tool" title="Fit page (Ctrl+0)" onClick={() => canvas.current?.fit()}>⛶</button>
      </div>

      {/* canvas */}
      <div className="dz-stage">
        <Canvas ref={canvas} doc={doc} sel={sel} setSel={setSel} tool={tool} setTool={setTool} view={view} setView={setView}
          opts={opts} shapeKind={shapeKind} live={live} begin={begin} commit={commit} onCursor={setCursor} wire={opts.wire} active={active}
          onTextAt={async (p) => { if (textEdit) { await commitTextEdit(); return; } setTextEdit({ x: p.x, y: p.y, text: '' }); }} onEditText={startEditText} onPick={pickFrom} />
        {textOverlay}
        {busy && <div className="dz-busy">{busy}</div>}
        {welcome && !doc.objects.length && !busy && (
          <div className="dz-empty">
            <button className="dz-empty-x" title="Close — start with a blank page" onClick={() => setWelcome(false)}>✕</button>
            <b>New design</b>
            <div className="dz-newsize">
              {[['24 × 12', 24, 12], ['24 × 18 yard sign', 24, 18], ['36 × 24', 36, 24], ['48 × 24 banner', 48, 24], ['72 × 36 banner', 72, 36], ['96 × 48 sheet', 96, 48], ['8.5 × 11', 8.5, 11], ['12 × 18', 12, 18]].map(([l, w, h]) => (
                <button key={l} className={`btn small ${newSize.w === w && newSize.h === h ? 'primary' : ''}`} onClick={() => setNewSize({ w, h })}>{l}</button>
              ))}
            </div>
            <div className="row">
              <label className="dz-pb">W<input type="number" step={0.125} value={newSize.w} onChange={(e) => setNewSize((s) => ({ ...s, w: parseFloat(e.target.value) || 0 }))} /><em>in</em></label>
              <label className="dz-pb">H<input type="number" step={0.125} value={newSize.h} onChange={(e) => setNewSize((s) => ({ ...s, h: parseFloat(e.target.value) || 0 }))} /><em>in</em></label>
              <button className="btn primary" disabled={!(newSize.w > 0.2 && newSize.h > 0.2)} onClick={() => {
                live({ ...docRef.current, page: { ...docRef.current.page, w: newSize.w * MM, h: newSize.h * MM } });
                setWelcome(false); setTimeout(() => canvas.current?.fit(), 30);
              }}>Start</button>
            </div>
            <span className="muted small">or bring in artwork</span>
            <div className="row"><button className="btn" onClick={() => { setWelcome(false); doImport(false); }}>Import artwork…</button><button className="btn" onClick={() => { if (confirmLose()) { setWelcome(false); doImport(true); } }}>Open a PDF / AI / EPS…</button><button className="btn" onClick={() => { setWelcome(false); open(); }}>Open a saved design…</button></div>
            <small className="muted">PDF, AI, EPS, SVG, DXF, PNG and JPG. Text in PDFs comes in as shapes; CutContour lines come in as cut lines.</small>
          </div>
        )}
      </div>

      {/* right panels */}
      <div className="dz-right">
        <div className="seg dz-tabs">
          <button className={tab === 'props' ? 'on' : ''} onClick={() => setTab('props')}>Properties</button>
          <button className={tab === 'fill' ? 'on' : ''} onClick={() => setTab('fill')}>Fill & outline</button>
          <button className={tab === 'objects' ? 'on' : ''} onClick={() => setTab('objects')}>Objects</button>
        </div>
        <div className="dz-right-body">
          {tab === 'props' && (selObjs.length
            ? <ObjectProps objs={selObjs} apply={apply} setBox={setBox} fonts={fonts} onText={(o, p) => { if (p.font) setOpts((x) => ({ ...x, lastFont: { file: p.font, name: p.fontName } })); if (p.sizeMm) setOpts((x) => ({ ...x, lastSize: p.sizeMm })); onText(o, p); }}
              onOutline={toOutlinesIds} onTraceCut={() => traceDlg(true)} />
            : <PageProps doc={doc} setPage={(patch) => apply((d) => ({ ...d, ...patch }), 'page')} stats={stats} />)}
          {tab === 'fill' && <FillStroke objs={selObjs.filter((o) => !o.cut)} apply={apply} swatches={swatches} addSwatch={(c) => setSwatches((s) => (s.includes(c) ? s : [...s, c]))} />}
          {tab === 'objects' && <ObjectList doc={doc} sel={sel} setSel={setSel} apply={apply} />}
        </div>
      </div>

      <SwatchBar swatches={swatches} onFill={setFillColor} onStroke={setStrokeColor} onCut={makeCut} />

      <div className="dz-status">
        <span><em>Cursor</em>{cursor ? `${(cursor.x / MM).toFixed(2)}″, ${(cursor.y / MM).toFixed(2)}″` : '—'}</span>
        <span><em>Zoom</em>{Math.round(((view.z * MM) / 96) * 100)}%</span>
        {sb && <span><em>Selection</em>{(sb.w / MM).toFixed(2)}″ × {(sb.h / MM).toFixed(2)}″</span>}
        <span><em>Page</em>{(doc.page.w / MM).toFixed(2)}″ × {(doc.page.h / MM).toFixed(2)}″</span>
        <span><em>Objects</em>{doc.objects.length}</span>
        {msg && <span className="dz-msg">{msg}</span>}
      </div>

      {dialog?.kind === 'param' && <ParamDialog {...dialog} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'printwin' && (
        <PrintWindow devices={devices} jobs={jobs} source={{ scene: dialog.scene }} previewPdfBase64={dialog.preview} jobSize={{ w: dialog.scene.w, h: dialog.scene.h }}
          name={doc.name} hasCutLines={dialog.scene.items.some((i) => i.cut)} onClose={() => setDialog(null)} onSent={(t) => { flash(t); onJobsSent && onJobsSent(); }} />
      )}
      {dialog?.kind === 'cut' && <CutDialog devices={devices} groupsFor={groupsFor} hasCutLines={cutLines.length > 0} hasSelection={sel.length > 0} defaultName={doc.name} onClose={() => setDialog(null)} onSent={(t) => { flash(t); onJobsSent && onJobsSent(); }} />}
      {dialog?.kind === 'printcut' && (
        <PrintCutDialog devices={devices} doc={doc} sceneFor={(marks) => toScene(docRef.current, { marks })} cutPaths={cutLines} defaultName={doc.name}
          onClose={() => setDialog(null)} onSent={(t) => flash(t)}
          onAddCut={() => { const all = doc.objects.filter((o) => !o.cut && !o.hidden).map((o) => o.id); if (all.length) fx((d) => FX.contourCut(d, all, { offsetMm: 1.5875 })); }} />
      )}
      {dialog?.kind === 'jobinfo' && <JobInfo doc={doc} stats={stats} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'serial' && <SerialDialog obj={textObjs[0]} onClose={() => setDialog(null)} onDone={(objs, first) => { apply((d) => ({ ...d, objects: [...d.objects.map((o) => (o.id === first.id ? first : o)), ...objs] })); setSel([first.id, ...objs.map((o) => o.id)]); }} />}
      {dialog?.kind === 'pdfpages' && (
        <Modal title="Import another page" onClose={() => setDialog(null)} foot={<span />}>
          <p className="muted">{dialog.file.name} has {dialog.pages} pages. Page 1 is on the design. Bring in another page:</p>
          <div className="row dz-wrap">
            {Array.from({ length: Math.min(dialog.pages, 60) }, (_, i) => i + 1).filter((n) => n > 1).map((n) => (
              <button key={n} className="btn small" onClick={async () => { try { const r = await importPdfFile(dialog.file, n); addImported(r.objs, `${dialog.file.name} p${n}`); } catch (e) { flash(e.message); } }}>Page {n}</button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function PB({ label, mm, onCommit }) {
  const fmt = (v) => String(+(v / MM).toFixed(3));
  const [t, setT] = useState(fmt(mm));
  useEffect(() => setT(fmt(mm)), [mm]);
  return (
    <label className="dz-pb">{label}
      <input type="number" step={0.125} value={t} onChange={(e) => setT(e.target.value)}
        onBlur={() => { const v = parseFloat(t); if (Number.isFinite(v) && fmt(mm) !== t) onCommit(v * MM); else setT(fmt(mm)); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setT(fmt(mm)); e.target.blur(); } }} />
      <em>in</em>
    </label>
  );
}

// Auto serialize: copies of a text object with counting numbers (Flexi: Arrange > Auto Serialize)
function SerialDialog({ obj, onClose, onDone }) {
  const [v, setV] = useState({ template: obj.text.includes('#') ? obj.text : `${obj.text} ###`, start: 1, step: 1, count: 10, cols: 5, gapX: 6.35, gapY: 6.35 });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  const go = async () => {
    setErr(''); setBusy(true);
    try {
      const n = Math.max(1, Math.min(2000, Math.round(v.count)));
      const cols = Math.max(1, Math.round(v.cols));
      const first = await retext(obj, { text: serialText(v.template, v, 0) });
      const made = [];
      for (let i = 1; i < n; i++) {
        const t = await retext(obj, { text: serialText(v.template, v, i) });
        made.push({ ...t, id: D.newId(), groupId: null, x: obj.x + (i % cols) * (first.w + v.gapX), y: obj.y + Math.floor(i / cols) * (first.h + v.gapY) });
      }
      onDone(made, first);
      onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const N = (k, label, unit, step = 1) => (
    <label className="dz-field"><span>{label}</span><div className="input-unit"><input type="number" step={step} value={k.startsWith('gap') ? +(v[k] / MM).toFixed(3) : v[k]} onChange={(e) => set(k, k.startsWith('gap') ? (parseFloat(e.target.value) || 0) * MM : parseFloat(e.target.value) || 0)} />{unit && <em>{unit}</em>}</div></label>
  );
  return (
    <Modal title="Auto serialize" onClose={onClose} foot={<><span className="error">{err}</span><div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={go}>{busy ? 'Making…' : 'Make copies'}</button></div></>}>
      <p className="muted">Each # is a digit of the number (### = 001, 002 …). Copies are laid out in rows.</p>
      <div className="dz-form">
        <label className="dz-field"><span>Text</span><input type="text" value={v.template} onChange={(e) => set('template', e.target.value)} /></label>
        {N('start', 'Start at')}{N('step', 'Count by')}{N('count', 'How many', 'copies')}{N('cols', 'Per row')}{N('gapX', 'Space across', 'in', 0.0625)}{N('gapY', 'Space down', 'in', 0.0625)}
      </div>
      <p className="muted small">First: {serialText(v.template, v, 0)} · last: {serialText(v.template, v, Math.max(0, Math.round(v.count) - 1))}</p>
    </Modal>
  );
}
