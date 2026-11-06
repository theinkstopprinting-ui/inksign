import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MM, bounds, normalize, scale, translate, mapPaths, sortCutOrder, weedBorder, weedLines, tileJob, totalLength,
} from '../lib/geometry.js';
import { importSvg } from '../lib/importSvg.js';
import { importPdf, importDxf } from '../lib/importVector.js';
import { analyzeImage } from '../lib/image.js';
import { makeMask, traceToPaths } from '../lib/trace.js';
import { loadFont, textToPaths, textOnArc } from '../lib/text.js';
import { offsetPaths } from '../lib/offset.js';
import { SHAPES } from '../lib/shapes.js';
import { nest } from '../lib/nest.js';
import MaterialsEditor from './MaterialsEditor.jsx';
import CutterControl from './CutterControl.jsx';
import ProofButton from './ProofButton.jsx';
import QuoteDialog from './QuoteDialog.jsx';
import Icon from './shell/Icon.jsx';
import { stencilBridges, knockout, rhinestones, weedBoxes, STONES, boolean, weld } from '../lib/cuttools.js';
import { simplify, nodeCount, envelope, ENVELOPES, dropShadow, TEMPLATES, stackLines } from '../lib/design.js';

const api = window.inksign;
const GAP = 12.7; // 1/2" between pieces
const DEFAULT_COLOR = '#000000';
let nextId = 1;

const inch = (mm) => (mm / MM).toFixed(2);
const toMm = (v) => (Number(v) || 0) * MM;

function makeBase(paths, colors) {
  const n = normalize(paths);
  const b = bounds(n);
  return { paths: n, colors: colors || n.map(() => DEFAULT_COLOR), w: b.w, h: b.h };
}

function placed(o) {
  const sx = o.base.w ? o.widthMm / o.base.w : 1;
  const sy = o.base.h ? o.heightMm / o.base.h : 1;
  return { paths: translate(scale(o.base.paths, sx, sy), o.x, o.y), colors: o.base.colors };
}

function NumIn({ label, value, onChange, step = 0.1, min }) {
  const [txt, setTxt] = useState(value);
  useEffect(() => setTxt(value), [value]);
  const commit = () => { if (txt !== '' && !Number.isNaN(Number(txt))) onChange(Number(txt)); };
  return (
    <label className="mini-field">
      <span>{label}</span>
      <input type="number" step={step} min={min} value={txt}
        onChange={(e) => setTxt(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); e.stopPropagation(); }} />
    </label>
  );
}

function Section({ title, children, open: startOpen = true, right }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <div className="tool-box">
      <div className="box-head" onClick={() => setOpen(!open)}>
        <span className="box-title">{open ? '▾' : '▸'} {title}</span>{right}
      </div>
      {open && children}
    </div>
  );
}

const NAMED = { '#000000': 'Black', '#ffffff': 'White', '#ff0000': 'Red', '#0000ff': 'Blue', '#2f80ed': 'Outline blue' };
const BASIC = [['Black', 0, 0, 0], ['White', 255, 255, 255], ['Red', 220, 30, 30], ['Blue', 30, 60, 200], ['Green', 30, 150, 60], ['Yellow', 250, 210, 0], ['Orange', 245, 130, 20], ['Purple', 120, 50, 160], ['Gray', 128, 128, 128]];
let LIBRARY = [];
function colorName(c) {
  const lib = LIBRARY.find((x) => x.hex.toLowerCase() === String(c).toLowerCase());
  if (lib) return lib.name;
  if (NAMED[c]) return NAMED[c];
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c || '');
  if (!m) return c;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  const best = BASIC.reduce((a, x) => { const d = (x[1] - r) ** 2 + (x[2] - g) ** 2 + (x[3] - b) ** 2; return d < a.d ? { n: x[0], d } : a; }, { n: c, d: Infinity });
  return `${best.n} (${c})`;
}

export default function CutStudio({ devices, jobs = [], onJobsSent, incoming }) {
  const [order, setOrder] = useState(null);
  const cutters = devices.filter((d) => d.kind === 'cutter');
  const [deviceId, setDeviceId] = useState(cutters[0]?.id || '');
  const device = cutters.find((d) => d.id === deviceId);
  const cutWidthMm = toMm(device?.config?.mediaWidthIn || 24);

  const [objects, setObjects] = useState([]);
  const [selId, setSelId] = useState(null);
  const sel = objects.find((o) => o.id === selId);
  const [leftTab, setLeftTab] = useState('add');

  const [jobName, setJobName] = useState('Vinyl job');
  const [border, setBorder] = useState(true);
  const [borderIn, setBorderIn] = useState(0.25);
  const [lines, setLines] = useState(true);
  const [lineSpacingIn, setLineSpacingIn] = useState(4);
  const [lineDir, setLineDir] = useState('vertical');
  const [overlapIn, setOverlapIn] = useState(0.5);
  const [panelLenIn, setPanelLenIn] = useState(0);
  const [showPanels, setShowPanels] = useState(true);
  const [colorsOff, setColorsOff] = useState([]);
  const [weedPerPiece, setWeedPerPiece] = useState(false);
  const [holdColors, setHoldColors] = useState(true);
  // Special cuts
  const [bridgeMm, setBridgeMm] = useState(3);
  const [bridgeDir, setBridgeDir] = useState('vertical');
  const [koMarginIn, setKoMarginIn] = useState(0.5);
  const [koRadiusIn, setKoRadiusIn] = useState(0);
  const [stoneId, setStoneId] = useState('ss10');
  const [stoneGapMm, setStoneGapMm] = useState(0.8);
  const [stoneMode, setStoneMode] = useState('outline');
  // Design tools
  const [multi, setMulti] = useState([]); // extra pieces picked with Shift+click
  const [nodeEdit, setNodeEdit] = useState(false);
  const [simplifyMm, setSimplifyMm] = useState(0.1);
  const [envKind, setEnvKind] = useState('arch');
  const [envAmt, setEnvAmt] = useState(30);
  const [shadowIn, setShadowIn] = useState(0.125);
  const [shadowColor, setShadowColor] = useState('#1f3f9a');
  const [library, setLibrary] = useState([]);
  const [libName, setLibName] = useState('');
  const [libCat, setLibCat] = useState('Logos');
  const [tplId, setTplId] = useState(TEMPLATES[0].id);
  const [tplFields, setTplFields] = useState({});
  const hist = useRef([]);
  const [splitColors, setSplitColors] = useState(true);
  const [msg, setMsg] = useState('');
  // InkFlow roll stock: which roll each vinyl color comes off ('_all' = the whole job)
  const [rolls, setRolls] = useState([]);
  const [rollMap, setRollMap] = useState({});
  const [quoting, setQuoting] = useState(false);
  useEffect(() => { api.shopflow.rolls().then(setRolls).catch(() => setRolls([])); }, []);

  // Settings: materials + pricing
  const [settings, setSettings] = useState(null);
  const [materialId, setMaterialId] = useState('calendared');
  const [editMaterials, setEditMaterials] = useState(false);
  useEffect(() => { api.settings.get().then(setSettings); }, []);
  const material = settings?.materials.find((m) => m.id === materialId) || settings?.materials[0];
  LIBRARY = settings?.colors || [];

  // Text tool
  const [fonts, setFonts] = useState([]);
  const [fontFilter, setFontFilter] = useState('');
  const [fontFile, setFontFile] = useState('');
  const [text, setText] = useState('THE INK STOP');
  const [capIn, setCapIn] = useState(2);
  const [spacing, setSpacing] = useState(0);
  const [align, setAlign] = useState('left');
  const [arc, setArc] = useState('none');
  const [radiusIn, setRadiusIn] = useState(8);

  // Shape tool
  const [shapeId, setShapeId] = useState('rect');
  const [shapeW, setShapeW] = useState(4);
  const [shapeH, setShapeH] = useState(4);
  const [starPoints, setStarPoints] = useState(5);

  // Edit tools
  const [offsetIn, setOffsetIn] = useState(0.125);
  const [offsetCorners, setOffsetCorners] = useState('round');
  const [offsetSolid, setOffsetSolid] = useState(true);
  const [copies, setCopies] = useState(10);
  const [copyGapIn, setCopyGapIn] = useState(0.25);
  const [allowRotate, setAllowRotate] = useState(true);
  const [nestGapIn, setNestGapIn] = useState(0.25);

  useEffect(() => {
    api.fonts.list().then((f) => {
      setFonts(f);
      const pick = f.find((x) => /^arial black$/i.test(x.name)) || f.find((x) => /^arial bold$/i.test(x.name)) || f.find((x) => /^arial$/i.test(x.name)) || f[0];
      if (pick) setFontFile(pick.file);
    });
  }, []);
  useEffect(() => { if (!cutters.some((c) => c.id === deviceId) && cutters[0]) setDeviceId(cutters[0].id); }, [devices]);

  const nextX = (objs) => (objs.length ? Math.max(...objs.map((o) => o.x + o.widthMm)) + GAP : 0);
  const update = (id, patch) => setObjects((objs) => objs.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  // Undo: a snapshot before each change that reshapes or removes pieces (Ctrl+Z)
  const objectsRef = useRef(objects);
  objectsRef.current = objects;
  const pushHist = () => { hist.current.push(objectsRef.current); if (hist.current.length > 60) hist.current.shift(); };
  const undo = () => { const prev = hist.current.pop(); if (prev) { setObjects(prev); setNodeEdit(false); } };
  useEffect(() => { api.library.list().then(setLibrary); }, []);

  const addObject = (name, paths, extra = {}, colors) => {
    const base = makeBase(paths, colors);
    if (!base.paths.length) return;
    setObjects((objs) => {
      const o = { id: nextId++, name, base, widthMm: base.w, heightMm: base.h, lock: true, x: nextX(objs), y: 0, ...extra };
      setSelId(o.id);
      return [...objs, o];
    });
    setLeftTab('edit');
  };

  // ---- Add: import / text / shapes ----
  const traceImage = (a, t) => {
    const mask = makeMask(a.data, a.w, a.h, { mode: t.mode, threshold: t.threshold, tolerance: t.tolerance });
    return traceToPaths(mask, a.w, a.h, { widthMm: toMm(t.widthIn), minAreaPx: t.minArea, smoothing: t.smoothing });
  };
  useEffect(() => {
    if (!incoming || incoming.target !== 'studio') return;
    // The canvas holds an earlier order's job: start fresh. Unlinked work stays and the art is added to it.
    if (order) { setObjects([]); setSelId(null); setCam(null); }
    setOrder(incoming.inkflow ? { ...incoming.inkflow, label: incoming.label } : null);
    setJobName(incoming.name || 'Vinyl job');
    importFiles(incoming.files.map((f) => {
      if (f.ext === 'svg' || f.ext === 'dxf') return { name: f.name, ext: f.ext, text: f.text };
      if (f.ext === 'png' || f.ext === 'jpg') return { name: f.name, ext: f.ext, dataUrl: `data:image/${f.ext === 'png' ? 'png' : 'jpeg'};base64,${f.base64}` };
      if (f.ext === 'pdf' || f.ext === 'ai') return { name: f.name, ext: f.ext, base64: f.base64 };
      return { name: f.name, ext: f.ext, error: `InkSign can't cut from .${f.ext} files — save it as PDF or SVG.` };
    }));
  }, [incoming]);
  const importArt = async () => importFiles(await api.files.openArt());
  const importFiles = async (files) => {
    setMsg('');
    for (const f of files) {
      try {
        if (f.error) throw new Error(f.error);
        if (f.ext === 'svg') { const r = importSvg(f.text); addObject(f.name, r.paths, {}, r.colors); }
        else if (f.ext === 'dxf') {
          const r = importDxf(f.text);
          addObject(f.name, r.paths, {}, r.colors);
          if (r.assumedInches) setMsg(`${f.name}: DXF has no units set — read it as inches. Resize if needed.`);
        } else if (f.ext === 'pdf' || f.ext === 'ai') {
          const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
          const r = await importPdf(bytes);
          addObject(f.name, r.paths, {}, r.colors);
        } else {
          const a = await analyzeImage(f.dataUrl, 1200);
          const t = { mode: a.hasAlpha ? 'alpha' : 'dark', threshold: 128, tolerance: 40, widthIn: 6, minArea: 20, smoothing: 2 };
          const paths = traceImage(a, t);
          if (!paths.length) throw new Error('Nothing found to trace — try a different trace setting in Edit.');
          addObject(`${f.name} (traced)`, paths, { trace: { ...t, dataUrl: f.dataUrl } });
        }
      } catch (e) { setMsg(`${f.name}: ${e.message}`); }
    }
  };
  const retrace = async (t) => {
    if (!sel?.trace) return;
    const a = await analyzeImage(sel.trace.dataUrl, 1200);
    const paths = traceImage(a, { ...t, widthIn: sel.widthMm / MM });
    if (!paths.length) return setMsg('Nothing found with those settings.');
    const base = makeBase(paths, paths.map(() => sel.base.colors[0] || DEFAULT_COLOR));
    update(sel.id, { base, widthMm: base.w, heightMm: base.h, trace: { ...sel.trace, ...t } });
  };

  const textProps = () => ({ value: text, fontFile, capIn, spacing, align, arc, radiusIn });
  const buildText = async (t = textProps()) => {
    const font = await loadFont(t.fontFile);
    if (t.arc !== 'none') return textOnArc(font, t.value, { heightMm: toMm(t.capIn), radiusMm: toMm(t.radiusIn), position: t.arc, letterSpacing: t.spacing / 100 });
    return textToPaths(font, t.value, { heightMm: toMm(t.capIn), letterSpacing: t.spacing / 100, align: t.align });
  };
  const addText = async () => {
    setMsg('');
    if (!text.trim() || !fontFile) return;
    try { addObject(text.split('\n')[0].slice(0, 30), await buildText(), { text: textProps() }); }
    catch (e) { setMsg(`Font problem: ${e.message}`); }
  };
  // Variable names: every line of the text box becomes its own piece (team names, name decals).
  const addTextLines = async () => {
    setMsg('');
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return setMsg('Type one name per line first.');
    try {
      pushHist();
      const font = await loadFont(fontFile);
      const made = [];
      let y = 0;
      for (const line of lines) {
        const paths = arc !== 'none'
          ? textOnArc(font, line, { heightMm: toMm(capIn), radiusMm: toMm(radiusIn), position: arc, letterSpacing: spacing / 100 })
          : textToPaths(font, line, { heightMm: toMm(capIn), letterSpacing: spacing / 100, align });
        const base = makeBase(paths);
        if (!base.paths.length) continue;
        made.push({ id: nextId++, name: line.slice(0, 30), base, widthMm: base.w, heightMm: base.h, lock: true, x: 0, y, text: { ...textProps(), value: line } });
        y += base.h + GAP / 2;
      }
      setObjects((objs) => {
        const x0 = nextX(objs);
        return [...objs, ...made.map((o) => ({ ...o, x: x0 }))];
      });
      setMsg(`${made.length} pieces — use Layout → Nest to pack them on the roll.`);
    } catch (e) { setMsg(`Font problem: ${e.message}`); }
  };
  const updateText = async () => {
    if (!sel?.text) return;
    try {
      const base = makeBase(await buildText());
      update(sel.id, { base, widthMm: base.w, heightMm: base.h, name: text.split('\n')[0].slice(0, 30), text: textProps() });
    } catch (e) { setMsg(`Font problem: ${e.message}`); }
  };
  // Load a selected text object's settings into the text tool
  useEffect(() => {
    if (sel?.text) {
      const t = sel.text;
      setText(t.value); setFontFile(t.fontFile); setCapIn(t.capIn); setSpacing(t.spacing); setAlign(t.align);
      setArc(t.arc || 'none'); setRadiusIn(t.radiusIn || 8);
    }
  }, [selId]);

  const addShape = () => {
    const s = SHAPES.find((x) => x.id === shapeId);
    addObject(s.name, s.make(toMm(shapeW), toMm(shapeH), { points: starPoints }));
  };

  // ---- Edit tools ----
  const setSize = (o, key, inches) => {
    const v = toMm(inches);
    if (v <= 0) return;
    if (o.lock) {
      const r = key === 'widthMm' ? v / o.widthMm : v / o.heightMm;
      update(o.id, { widthMm: o.widthMm * r, heightMm: o.heightMm * r });
    } else update(o.id, { [key]: v });
  };

  const bakedPaths = (o) => scale(o.base.paths, o.base.w ? o.widthMm / o.base.w : 1, o.base.h ? o.heightMm / o.base.h : 1);

  const transformSel = (fn) => {
    if (!sel) return;
    pushHist();
    const base = makeBase(mapPaths(bakedPaths(sel), fn), sel.base.colors);
    update(sel.id, { base, widthMm: base.w, heightMm: base.h, text: undefined });
  };

  const setColor = (color) => {
    if (!sel) return;
    update(sel.id, { base: { ...sel.base, colors: sel.base.colors.map(() => color) } });
  };

  const duplicate = () => {
    if (!sel) return;
    setObjects((objs) => {
      const o = { ...sel, id: nextId++, x: nextX(objs) };
      setSelId(o.id);
      return [...objs, o];
    });
  };

  const remove = () => {
    if (!sel) return;
    pushHist();
    setObjects((objs) => objs.filter((o) => o.id !== sel.id));
    setSelId(null);
  };

  const makeOffset = () => {
    if (!sel) return;
    pushHist();
    const d = toMm(offsetIn);
    const p = offsetPaths(bakedPaths(sel), d, { corners: offsetCorners, outerOnly: offsetSolid });
    if (!p.length) return setMsg('Offset made nothing — try a smaller inset.');
    const base = makeBase(p, p.map(() => '#2f80ed'));
    const b = bounds(translate(p, sel.x, sel.y));
    setObjects((objs) => {
      const o = { id: nextId++, name: `${sel.name} outline`, base, widthMm: base.w, heightMm: base.h, lock: true, x: b.minX, y: b.minY };
      setSelId(o.id);
      return [...objs, o];
    });
  };

  // ---- Special cuts ----
  const replaceSel = (paths, extra = {}) => {
    pushHist();
    const base = makeBase(paths, paths.map(() => sel.base.colors[0] || DEFAULT_COLOR));
    const b = bounds(translate(paths, sel.x, sel.y));
    update(sel.id, { base, widthMm: base.w, heightMm: base.h, x: b.minX, y: b.minY, text: undefined, ...extra });
  };
  const makeBridges = () => {
    if (!sel) return;
    const r = stencilBridges(bakedPaths(sel), { widthMm: bridgeMm, direction: bridgeDir });
    if (!r.bridged) return setMsg('No islands to bridge in this piece (no letters like O, A, B, D, R).');
    replaceSel(r.paths, { name: `${sel.name} (stencil)` });
    setMsg(`Added bridges to ${r.bridged} island${r.bridged === 1 ? '' : 's'}.`);
  };
  const makeKnockout = () => {
    if (!sel) return;
    pushHist();
    const p = knockout(bakedPaths(sel), { marginMm: toMm(koMarginIn), radiusMm: toMm(koRadiusIn) });
    if (!p.length) return setMsg('Knockout needs closed shapes.');
    const b0 = bounds(bakedPaths(sel));
    const base = makeBase(p, p.map(() => sel.base.colors[0] || DEFAULT_COLOR));
    update(sel.id, { base, widthMm: base.w, heightMm: base.h, x: sel.x + b0.minX - toMm(koMarginIn), y: sel.y + b0.minY - toMm(koMarginIn), text: undefined, name: `${sel.name} (knockout)` });
  };
  const makeStones = () => {
    if (!sel) return;
    pushHist();
    const stone = STONES.find((s) => s.id === stoneId);
    const r = rhinestones(bakedPaths(sel), { holeMm: stone.hole, gapMm: stoneGapMm, mode: stoneMode });
    if (!r.count) return setMsg('No room for stones — make the piece bigger or use a smaller stone.');
    const base = makeBase(r.paths, r.paths.map(() => '#a8a9ad'));
    const b = bounds(translate(r.paths, sel.x, sel.y));
    setObjects((objs) => {
      const o = { id: nextId++, name: `${sel.name} — ${r.count} × ${stone.name.split(' ')[0]}`, base, widthMm: base.w, heightMm: base.h, lock: true, x: b.minX, y: b.minY, stones: { count: r.count, stone: stone.id } };
      setSelId(o.id);
      return [...objs.map((x) => (x.id === sel.id ? { ...x, x: x.x } : x)), o];
    });
    setMsg(`${r.count} stones (${stone.name}). The original artwork is kept — turn its color off or delete it before cutting the template.`);
  };

  // ---- Design: combine, nodes, effects, shadow, library, templates ----
  const picked = sel ? [sel, ...objects.filter((o) => multi.includes(o.id) && o.id !== sel.id)] : [];
  const absPaths = (o) => placed(o).paths;
  const addAbs = (name, paths, colors, extra = {}) => {
    const b = bounds(paths);
    const base = makeBase(paths, colors);
    return { id: nextId++, name, base, widthMm: base.w, heightMm: base.h, lock: true, x: b.minX, y: b.minY, ...extra };
  };
  const combine = (op) => {
    if (picked.length < 2) return setMsg('Shift+click a second piece to combine with.');
    pushHist();
    const [first, ...rest] = picked;
    const color = first.base.colors[0] || DEFAULT_COLOR;
    let paths, colors;
    if (op === 'group') {
      paths = picked.flatMap(absPaths); colors = picked.flatMap((o) => o.base.colors);
    } else {
      const a = absPaths(first), others = rest.flatMap(absPaths);
      paths = op === 'weld' ? weld([...a, ...others]) : boolean(a, others, op === 'subtract' ? 'difference' : 'intersection');
      colors = paths.map(() => color);
    }
    if (!paths.length) { hist.current.pop(); return setMsg(op === 'intersect' ? 'Those pieces don\'t overlap.' : 'Nothing left after that.'); }
    const names = { weld: 'welded', subtract: 'trimmed', intersect: 'overlap', group: 'group' };
    const o = addAbs(`${first.name} (${names[op]})`, paths, colors);
    const gone = new Set(picked.map((x) => x.id));
    setObjects((objs) => [...objs.filter((x) => !gone.has(x.id)), o]);
    setSelId(o.id); setMulti([]);
  };
  const startNodeEdit = () => {
    if (!sel) return;
    if (!nodeEdit) {
      pushHist();
      const base = makeBase(bakedPaths(sel), sel.base.colors);
      update(sel.id, { base, widthMm: base.w, heightMm: base.h, text: undefined });
    }
    setNodeEdit(!nodeEdit);
  };
  const doSimplify = () => {
    if (!sel) return;
    pushHist();
    const sx = sel.base.w ? sel.widthMm / sel.base.w : 1, sy = sel.base.h ? sel.heightMm / sel.base.h : 1;
    const before = nodeCount(sel.base.paths);
    const base = makeBase(simplify(sel.base.paths, simplifyMm / sx), sel.base.colors);
    update(sel.id, { base, widthMm: base.w * sx, heightMm: base.h * sy });
    setMsg(`Nodes: ${before} → ${nodeCount(base.paths)}.`);
  };
  const applyEnvelope = () => {
    if (!sel) return;
    pushHist();
    const p = envelope(bakedPaths(sel), envKind, envAmt);
    const base = makeBase(p, sel.base.colors);
    const b = bounds(p);
    update(sel.id, { base, widthMm: base.w, heightMm: base.h, x: sel.x + b.minX, y: sel.y + b.minY, text: undefined });
  };
  const makeShadow = () => {
    if (!sel) return;
    pushHist();
    const d = toMm(shadowIn);
    const p = dropShadow(absPaths(sel), d, d);
    const o = addAbs(`${sel.name} shadow`, p, p.map(() => shadowColor));
    setObjects((objs) => { const i = objs.findIndex((x) => x.id === sel.id); const out = objs.slice(); out.splice(Math.max(0, i), 0, o); return out; });
    setMsg('Shadow added under the piece, in its own color — it cuts as a separate layer.');
  };
  const saveToLibrary = async () => {
    if (!picked.length) return;
    const paths = picked.flatMap(absPaths), colors = picked.flatMap((o) => o.base.colors);
    const base = makeBase(paths, colors);
    const it = await api.library.save({ name: libName.trim() || picked[0].name, category: libCat.trim() || 'Logos', paths: base.paths, colors: base.colors, w: base.w, h: base.h });
    setLibrary(await api.library.list());
    setLibName('');
    setMsg(`Saved "${it.name}" to the library.`);
  };
  const insertFromLibrary = (it) => {
    pushHist();
    addObject(it.name, it.paths, {}, it.colors);
  };
  const tpl = TEMPLATES.find((t) => t.id === tplId);
  const tplValue = (k, d) => (tplFields[`${tplId}.${k}`] ?? d);
  const makeTemplate = async () => {
    if (!fontFile) return setMsg('Pick a font in Add → Text first.');
    const f = Object.fromEntries(tpl.fields.map(([k, , d]) => [k, tplValue(k, d)]));
    try {
      const font = await loadFont(fontFile);
      const rendered = [];
      for (const line of tpl.lines(f)) {
        if (!String(line.text).trim()) continue;
        const h = toMm(line.heightIn);
        let paths;
        if (line.spaceAsLetter) {
          // Boat numbers: the gap between groups equals one letter width (USCG)
          const letterW = bounds(textToPaths(font, 'A', { heightMm: h })).w;
          paths = []; let x = 0;
          for (const grp of String(line.text).split(/\s+/).filter(Boolean)) {
            const g = textToPaths(font, grp, { heightMm: h });
            const gb = bounds(g);
            paths.push(...translate(g, x - gb.minX, 0));
            x += gb.w + letterW;
          }
        } else paths = textToPaths(font, line.text, { heightMm: h });
        const b = bounds(paths);
        rendered.push({ paths: translate(paths, -b.minX, -b.minY), w: b.w, h: b.h });
      }
      if (!rendered.length) return setMsg('Fill in the template first.');
      let out = stackLines(rendered, { align: tpl.align, gapMm: toMm(0.5), frame: tpl.frame });
      if (tpl.maxWidthIn) {
        const b = bounds(out);
        if (b.w > toMm(tpl.maxWidthIn)) out = scale(out, toMm(tpl.maxWidthIn) / b.w);
      }
      pushHist();
      addObject(tpl.name, out);
      setMsg(tpl.copies ? `${tpl.name} added. Make ${tpl.copies} copies (Edit → Copies) — one for each side.` : `${tpl.name} added.`);
    } catch (e) { setMsg(`Template problem: ${e.message}`); }
  };

  // Step and repeat: fill across the roll, then along it
  const stepRepeat = () => {
    if (!sel || copies < 2) return;
    pushHist();
    const gap = toMm(copyGapIn);
    const perCol = Math.max(1, Math.floor((cutWidthMm + gap) / (sel.heightMm + gap)));
    setObjects((objs) => {
      const others = objs.filter((o) => o.id !== sel.id);
      const startX = sel.x, made = [];
      for (let i = 0; i < copies; i++) {
        const col = Math.floor(i / perCol), row = i % perCol;
        made.push({ ...sel, id: i === 0 ? sel.id : nextId++, x: startX + col * (sel.widthMm + gap), y: row * (sel.heightMm + gap) });
      }
      // push other pieces out of the way
      const end = startX + Math.ceil(copies / perCol) * (sel.widthMm + gap);
      return [...others.map((o) => (o.x >= startX ? { ...o, x: o.x + (end - startX) } : o)), ...made];
    });
  };

  const autoNest = () => {
    pushHist();
    const gap = toMm(nestGapIn);
    const res = nest(objects.map((o) => ({ id: o.id, w: o.widthMm, h: o.heightMm })), cutWidthMm, { gap, allowRotate });
    setObjects((objs) => objs.map((o) => {
      const r = res.find((x) => x.id === o.id);
      if (!r) return o;
      if (!r.rotated) return { ...o, x: r.x, y: r.y };
      const base = makeBase(mapPaths(bakedPaths(o), ({ x, y }) => ({ x: -y, y: x })), o.base.colors);
      return { ...o, base, widthMm: base.w, heightMm: base.h, x: r.x, y: r.y, text: undefined };
    }));
  };

  // ---- Keyboard ----
  useEffect(() => {
    const onKey = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
      if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { undo(); e.preventDefault(); return; }
      if (e.key === 'Escape') { setMulti([]); setNodeEdit(false); return; }
      if (!sel) return;
      const step = e.shiftKey ? MM : MM / 16;
      if (e.key === 'Delete' || e.key === 'Backspace') { remove(); e.preventDefault(); }
      else if (e.key === 'd' && (e.ctrlKey || e.metaKey)) { duplicate(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') update(sel.id, { x: sel.x - step });
      else if (e.key === 'ArrowRight') update(sel.id, { x: sel.x + step });
      else if (e.key === 'ArrowUp') update(sel.id, { y: sel.y - step });
      else if (e.key === 'ArrowDown') update(sel.id, { y: sel.y + step });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Let the Mockup page borrow the current design (visible colors only, placed in mm).
  useEffect(() => {
    window.__inksignDesign = () => {
      const paths = [], colors = [];
      for (const o of objectsRef.current) {
        const pl = placed(o);
        pl.paths.forEach((pp, i) => { if (!colorsOff.includes(pl.colors[i])) { paths.push(pp); colors.push(pl.colors[i]); } });
      }
      return { name: jobName, paths, colors };
    };
  }, [colorsOff, jobName]);

  // ---- Build the job ----
  const allColors = useMemo(() => [...new Set(objects.flatMap((o) => o.base.colors))], [objects]);

  const job = useMemo(() => {
    const art = [], artColors = [], artObj = [];
    for (const o of objects) {
      const p = placed(o);
      p.paths.forEach((path, i) => {
        if (colorsOff.includes(p.colors[i])) return;
        art.push(path); artColors.push(p.colors[i]); artObj.push(o.id);
      });
    }
    if (!art.length) return null;
    const groups = splitColors && allColors.filter((c) => !colorsOff.includes(c)).length > 1
      ? allColors.filter((c) => !colorsOff.includes(c)).map((c) => ({ color: c, paths: art.filter((_, i) => artColors[i] === c), objs: artObj.filter((_, i) => artColors[i] === c) })).filter((g) => g.paths.length)
      : [{ color: null, paths: art, objs: artObj }];

    const out = groups.map((g) => {
      const extra = [];
      if (lines) extra.push(...weedLines(g.paths, { marginMm: border ? toMm(borderIn) : 0, spacingMm: toMm(lineSpacingIn), direction: lineDir }));
      if (border) extra.push(weedBorder(g.paths, toMm(borderIn)));
      if (weedPerPiece) {
        const ids = [...new Set(g.objs)];
        if (ids.length > 1) extra.push(...weedBoxes(ids.map((id) => g.paths.filter((_, i) => g.objs[i] === id)), toMm(Math.max(0.0625, borderIn / 2))));
      }
      const all = [...g.paths, ...extra];
      const b = bounds(all);
      const panels = tileJob(translate(all, -b.minX, -b.minY), { maxAcrossMm: cutWidthMm, maxAlongMm: toMm(panelLenIn), overlapMm: toMm(overlapIn) })
        .map((p) => ({ ...p, name: g.color ? `${colorName(g.color)}${p.name === 'Full job' ? '' : ' ' + p.name}` : p.name, paths: sortCutOrder(p.paths) }));
      return { ...g, extra, all, b, panels, length: totalLength(all) };
    });
    const panels = out.flatMap((g) => g.panels);
    const length = out.reduce((a, g) => a + g.length, 0);
    const vinylFt = out.reduce((a, g) => a + (g.panels.reduce((s, p) => s + (p.rect.x1 - p.rect.x0), 0) / MM / 12 + 0.25), 0);
    const b = bounds(out.flatMap((g) => g.all));
    return { groups: out, panels, length, vinylFt, b };
  }, [objects, border, borderIn, lines, lineSpacingIn, lineDir, overlapIn, panelLenIn, cutWidthMm, colorsOff, splitColors, allColors, weedPerPiece]);

  const estimate = useMemo(() => {
    if (!job || !settings || !material) return null;
    const pr = settings.pricing;
    const materialCost = job.vinylFt * (Number(material.costPerFt) || 0);
    const laborMin = (Number(pr.setupMin) || 0) + (job.length / MM / 12) * (Number(pr.weedMinPerFt) || 0);
    const labor = (laborMin / 60) * (Number(pr.laborPerHour) || 0);
    const price = Math.max(Number(pr.minimum) || 0, (materialCost + labor) * (Number(pr.markup) || 1));
    return { materialCost, laborMin, labor, price };
  }, [job, settings, material]);

  // HTV and other "mirror" materials cut mirrored, on top of whatever the cutter's own mirror setting is.
  const overrides = material ? { speed: material.speed, force: material.force, overcutMm: material.overcutMm, mirror: !!device?.config?.mirror !== !!material.mirror } : {};
  // Each new vinyl color after the first waits in the queue until it's loaded.
  const rollFor = (g) => rollMap[g.color || '_all'] || rollMap._all || '';
  const panelsOut = () => job.groups.flatMap((g, gi) => g.panels.map((p, pi) => {
    // Feet of vinyl this panel uses (+3" lead on the first panel of each color), its material cost and cut length
    const feet = (p.rect.x1 - p.rect.x0) / MM / 12 + (pi === 0 ? 0.25 : 0);
    const costCents = Math.round(feet * (Number(material?.costPerFt) || 0) * 100);
    return {
      name: p.name, paths: p.paths,
      hold: holdColors && g.color && gi > 0 && pi === 0,
      holdMessage: g.color ? `Load ${colorName(g.color)} vinyl, then press Release` : undefined,
      meta: { rollId: rollFor(g) || undefined, feet, costCents, costNote: `${material?.name || 'Vinyl'} ${feet.toFixed(1)} ft — ${p.name}`, cutMm: totalLength(p.paths) },
    };
  }));
  const quoteLines = () => [{
    description: `${jobName || 'Vinyl lettering / decal'}${job.groups.length > 1 ? ` (${job.groups.length} colors)` : ''}`,
    quantity: 1, unitPriceCents: Math.round((estimate?.price || 0) * 100),
    widthIn: Math.round((job.b.w / MM) * 100) / 100, heightIn: Math.round((job.b.h / MM) * 100) / 100,
    material: material?.name || '', notes: `${job.vinylFt.toFixed(1)} ft vinyl, ${(job.length / MM / 12).toFixed(0)} ft cut`,
  }];

  const send = async () => {
    setMsg('');
    if (!job || !device) return;
    try {
      await api.jobs.sendCut(device.id, { name: jobName || 'Vinyl job', panels: panelsOut(), overrides, inkflow: order });
      onJobsSent();
    } catch (e) { setMsg(e.message); }
  };
  const saveFile = async () => {
    setMsg('');
    if (!job || !device) return;
    try {
      const files = await api.files.saveCut(device.id, { name: jobName || 'Vinyl job', panels: panelsOut(), overrides });
      if (files.length) setMsg(`Saved ${files.length} file${files.length > 1 ? 's' : ''}.`);
    } catch (e) { setMsg(e.message); }
  };

  // Proof picture: the design filled in its vinyl colors on white, with sizes — for customer approval.
  const renderProof = () => {
    const vis = objects.map((o) => ({ o, p: placed(o) }));
    const all = vis.flatMap(({ p }) => p.paths.filter((_, i) => !colorsOff.includes(p.colors[i])));
    const b = bounds(all);
    const W = 1800, pad = 120, top = 170, k = (W - 2 * pad) / Math.max(b.w, 1);
    const H = Math.round(top + b.h * k + pad + 60);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#111'; ctx.font = 'bold 44px Segoe UI, Arial'; ctx.fillText(jobName || 'Vinyl job', pad, 70);
    ctx.font = '28px Segoe UI, Arial'; ctx.fillStyle = '#555';
    ctx.fillText(`${inch(b.w)}" wide × ${inch(b.h)}" tall · ${new Date().toLocaleDateString()}`, pad, 115);
    const colorsUsed = [...new Set(vis.flatMap(({ p }) => p.colors.filter((cc) => !colorsOff.includes(cc))))];
    ctx.fillText(`Colors: ${colorsUsed.map(colorName).join(', ')}`, pad, 152);
    for (const { p } of vis) {
      const byC = new Map();
      p.paths.forEach((pp, i) => { if (colorsOff.includes(p.colors[i])) return; if (!byC.has(p.colors[i])) byC.set(p.colors[i], []); byC.get(p.colors[i]).push(pp); });
      for (const [color, paths] of byC) {
        const path = new Path2D();
        for (const pp of paths) pp.forEach((q, i) => (i ? path.lineTo : path.moveTo).call(path, pad + (q.x - b.minX) * k, top + (q.y - b.minY) * k));
        ctx.fillStyle = color === '#ffffff' ? '#f4f4f4' : color; ctx.fill(path, 'evenodd');
        if (color === '#ffffff') { ctx.strokeStyle = '#999'; ctx.lineWidth = 1; ctx.stroke(path); }
      }
    }
    // dimension line under the design
    const y = top + b.h * k + 40;
    ctx.strokeStyle = '#888'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.moveTo(pad, y - 12); ctx.lineTo(pad, y + 12); ctx.moveTo(W - pad, y - 12); ctx.lineTo(W - pad, y + 12); ctx.stroke();
    ctx.fillStyle = '#555'; ctx.font = '26px Segoe UI, Arial'; ctx.textAlign = 'center'; ctx.fillText(`${inch(b.w)}"`, W / 2, y + 38);
    return c.toDataURL('image/png');
  };

  const saveJob = async () => {
    const data = {
      app: 'InkSign', version: 1, jobName, objects, materialId, deviceId,
      settings: { border, borderIn, lines, lineSpacingIn, lineDir, overlapIn, panelLenIn, colorsOff, splitColors },
    };
    const p = await api.files.saveJob(jobName, data);
    if (p) setMsg('Job saved.');
  };
  const openJob = async () => {
    const r = await api.files.openJob();
    if (!r) return;
    const d = r.data;
    if (d.app !== 'InkSign') return setMsg('Not an InkSign job file.');
    nextId = Math.max(nextId, ...d.objects.map((o) => o.id + 1));
    setObjects(d.objects); setJobName(d.jobName || 'Vinyl job'); setSelId(null);
    if (d.materialId) setMaterialId(d.materialId);
    if (d.deviceId && cutters.some((c) => c.id === d.deviceId)) setDeviceId(d.deviceId);
    const s = d.settings || {};
    if (s.border !== undefined) setBorder(s.border);
    if (s.borderIn !== undefined) setBorderIn(s.borderIn);
    if (s.lines !== undefined) setLines(s.lines);
    if (s.lineSpacingIn !== undefined) setLineSpacingIn(s.lineSpacingIn);
    if (s.lineDir) setLineDir(s.lineDir);
    if (s.overlapIn !== undefined) setOverlapIn(s.overlapIn);
    if (s.panelLenIn !== undefined) setPanelLenIn(s.panelLenIn);
    if (s.colorsOff) setColorsOff(s.colorsOff);
    if (s.splitColors !== undefined) setSplitColors(s.splitColors);
    setCam(null);
  };
  const newJob = () => {
    if (objects.length && !confirm('Start a new job? Unsaved changes will be lost.')) return;
    setObjects([]); setSelId(null); setJobName('Vinyl job'); setCam(null);
  };

  // ---- Canvas: zoom / pan / drag ----
  const svgRef = useRef(null);
  const drag = useRef(null);
  const [cam, setCam] = useState(null); // null = fit to job

  const fitView = useMemo(() => {
    const content = objects.length ? bounds(objects.flatMap((o) => placed(o).paths)) : { minX: 0, minY: 0, maxX: 300, maxY: 0 };
    const pad = 25 + (border ? toMm(borderIn) : 0);
    const minX = Math.min(0, content.minX) - pad, minY = Math.min(0, content.minY) - pad;
    const maxX = Math.max(content.maxX, 300) + pad, maxY = Math.max(content.maxY, cutWidthMm) + pad;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }, [objects, cutWidthMm, border, borderIn]);
  const view = cam || fitView;

  const toSvgPt = (e) => {
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  };
  const onWheel = useCallback((e) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const p = toSvgPt(e);
    const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    setCam((c) => {
      const v = c || fitView;
      const w = Math.min(Math.max(v.w * f, 20), 50000), h = v.h * (w / v.w);
      return { x: p.x - (p.x - v.x) * (w / v.w), y: p.y - (p.y - v.y) * (h / v.h), w, h };
    });
  }, [fitView]);
  useEffect(() => {
    const svg = svgRef.current;
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  const onDownObj = (e, o) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.shiftKey && sel && o.id !== sel.id) {
      setMulti((m) => (m.includes(o.id) ? m.filter((x) => x !== o.id) : [...m, o.id]));
      return;
    }
    if (o.id !== selId) { setMulti([]); setNodeEdit(false); }
    setSelId(o.id);
    const p = toSvgPt(e);
    pushHist();
    drag.current = { mode: 'move', id: o.id, dx: p.x - o.x, dy: p.y - o.y };
    svgRef.current.setPointerCapture?.(e.pointerId);
  };
  const onDownBg = (e) => {
    drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, v: view, moved: false };
    svgRef.current.setPointerCapture?.(e.pointerId);
  };
  const isClosedP = (path) => path.length > 3 && Math.hypot(path[0].x - path[path.length - 1].x, path[0].y - path[path.length - 1].y) < 0.05;
  const scaleOf = (o) => [o.base.w ? o.widthMm / o.base.w : 1, o.base.h ? o.heightMm / o.base.h : 1];
  const onDownNode = (e, pi, qi) => {
    e.stopPropagation();
    pushHist();
    drag.current = { mode: 'node', pi, qi };
    svgRef.current.setPointerCapture?.(e.pointerId);
  };
  // Re-measure a piece after its nodes changed (it may have grown or shrunk).
  const remeasure = (o, paths) => {
    const [sx, sy] = scaleOf(o);
    const b = bounds(paths);
    const base = makeBase(paths, o.base.colors);
    return { base, widthMm: base.w * sx, heightMm: base.h * sy, x: o.x + b.minX * sx, y: o.y + b.minY * sy };
  };
  const deleteNode = (pi, qi) => {
    if (!sel) return;
    const p = sel.base.paths[pi];
    const closed = isClosedP(p);
    if (p.length <= (closed ? 4 : 2)) return setMsg('That shape needs its remaining nodes.');
    pushHist();
    let np;
    if (closed) {
      const ring = p.slice(0, -1), drop = qi === p.length - 1 ? 0 : qi;
      const r2 = ring.filter((_, i) => i !== drop);
      np = [...r2, { ...r2[0] }];
    } else np = p.filter((_, i) => i !== qi);
    update(sel.id, remeasure(sel, sel.base.paths.map((q, i) => (i === pi ? np : q))));
  };
  const onMove = (e) => {
    const d = drag.current;
    if (!d) return;
    if (d.mode === 'node' && sel) {
      const p = toSvgPt(e);
      const [sx, sy] = scaleOf(sel);
      const pt = { x: (p.x - sel.x) / sx, y: (p.y - sel.y) / sy };
      const path = sel.base.paths[d.pi], last = path.length - 1, closed = isClosedP(path);
      const np = path.map((q, i) => (i === d.qi || (closed && ((d.qi === 0 && i === last) || (d.qi === last && i === 0))) ? pt : q));
      update(sel.id, { base: { ...sel.base, paths: sel.base.paths.map((q, i) => (i === d.pi ? np : q)) } });
      d.moved = true;
      return;
    }
    if (d.mode === 'move') {
      const p = toSvgPt(e);
      update(d.id, { x: Math.round((p.x - d.dx) * 4) / 4, y: Math.round((p.y - d.dy) * 4) / 4 });
    } else {
      const svg = svgRef.current, r = svg.getBoundingClientRect();
      const k = Math.max(d.v.w / r.width, d.v.h / r.height);
      const dx = (e.clientX - d.sx) * k, dy = (e.clientY - d.sy) * k;
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
      if (d.moved) setCam({ ...d.v, x: d.v.x - dx, y: d.v.y - dy });
    }
  };
  const onUp = () => {
    const d = drag.current;
    if (d?.mode === 'pan' && !d.moved) { setSelId(null); setMulti([]); setNodeEdit(false); }
    if (d?.mode === 'node' && sel) {
      if (d.moved) update(sel.id, remeasure(sel, sel.base.paths));
      else hist.current.pop();
    }
    if (d?.mode === 'move') {
      const o = objectsRef.current.find((x) => x.id === d.id);
      const before = hist.current[hist.current.length - 1]?.find((x) => x.id === d.id);
      if (o && before && o.x === before.x && o.y === before.y) hist.current.pop(); // a click, not a move
    }
    drag.current = null;
  };

  const ptsAttr = (p) => p.map((q) => `${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(' ');
  const shownFonts = fonts.filter((f) => !fontFilter || f.name.toLowerCase().includes(fontFilter.toLowerCase())).slice(0, 400);
  const sw = view.w / 900;
  const showColor = (c) => (c === '#ffffff' ? '#dddddd' : c === '#000000' ? '#e7e9ee' : c);

  return (
    <div className="studio">
      <div className="studio-left">
        <div className="studio-title">
          <h1>Cut Studio</h1>
          <div className="row">
            <button className="btn small" onClick={newJob}>New</button>
            <button className="btn small" onClick={openJob}>Open</button>
            <button className="btn small" onClick={saveJob} disabled={!objects.length}>Save</button>
          </div>
        </div>
        <div className="seg">
          <button className={leftTab === 'add' ? 'on' : ''} onClick={() => setLeftTab('add')}>Add</button>
          <button className={leftTab === 'edit' ? 'on' : ''} onClick={() => setLeftTab('edit')}>Edit {sel ? '•' : ''}</button>
          <button className={leftTab === 'layout' ? 'on' : ''} onClick={() => setLeftTab('layout')}>Layout</button>
          <button className={leftTab === 'library' ? 'on' : ''} onClick={() => setLeftTab('library')}>Library</button>
        </div>

        {leftTab === 'add' && (<>
          <div className="tool-box">
            <button className="btn primary wide" onClick={importArt}>Import artwork…</button>
            <div className="help">SVG, PDF, AI (PDF-compatible), DXF — colors come across for separating. PNG/JPG logos are traced into cut lines. Convert text to outlines first.</div>
          </div>

          <Section title="Text">
            <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} />
            <input type="text" placeholder="Search fonts…" value={fontFilter} onChange={(e) => setFontFilter(e.target.value)} />
            <select value={fontFile} onChange={(e) => setFontFile(e.target.value)} size={5} className="font-list">
              {shownFonts.map((f) => <option key={f.file} value={f.file}>{f.name}</option>)}
            </select>
            <div className="mini-row">
              <NumIn label="Letter height (in)" value={capIn} onChange={setCapIn} />
              <NumIn label="Spacing %" value={spacing} onChange={setSpacing} step={1} />
            </div>
            <div className="mini-row">
              <label className="mini-field"><span>Shape</span>
                <select value={arc} onChange={(e) => setArc(e.target.value)}>
                  <option value="none">Straight</option><option value="top">Arc — over top</option><option value="bottom">Arc — under bottom</option>
                </select>
              </label>
              {arc === 'none'
                ? <label className="mini-field"><span>Align</span><select value={align} onChange={(e) => setAlign(e.target.value)}>
                    <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
                : <NumIn label="Arc radius (in)" value={radiusIn} onChange={setRadiusIn} step={0.5} />}
            </div>
            {sel?.text
              ? <div className="mini-row"><button className="btn" onClick={updateText}>Update text</button><button className="btn ghost" onClick={addText}>Add as new</button></div>
              : <button className="btn" onClick={addText}>Add text</button>}
            {text.split(/\r?\n/).filter((l) => l.trim()).length > 1 && <button className="btn small" onClick={addTextLines}>Each line as its own piece (names)</button>}
          </Section>

          <Section title="Shapes">
            <div className="shape-grid">
              {SHAPES.map((s) => <button key={s.id} className={`chip ${shapeId === s.id ? 'on' : ''}`} onClick={() => setShapeId(s.id)}>{s.name}</button>)}
            </div>
            <div className="mini-row">
              <NumIn label="Width (in)" value={shapeW} onChange={setShapeW} />
              <NumIn label="Height (in)" value={shapeH} onChange={setShapeH} />
              {shapeId === 'star' && <NumIn label="Points" value={starPoints} onChange={(v) => setStarPoints(Math.max(3, Math.round(v)))} step={1} />}
            </div>
            <button className="btn" onClick={addShape}>Add shape</button>
          </Section>
        </>)}

        {leftTab === 'edit' && !sel && <div className="empty small">Click a piece on the canvas to edit it.</div>}
        {leftTab === 'edit' && sel && (<>
          <Section title={`Selected: ${sel.name}`}>
            <div className="mini-row">
              <NumIn label="Width (in)" value={inch(sel.widthMm)} onChange={(v) => setSize(sel, 'widthMm', v)} />
              <NumIn label="Height (in)" value={inch(sel.heightMm)} onChange={(v) => setSize(sel, 'heightMm', v)} />
            </div>
            <label className="check"><input type="checkbox" checked={sel.lock} onChange={(e) => update(sel.id, { lock: e.target.checked })} /> Keep proportions</label>
            <div className="mini-row">
              <NumIn label="X (in)" value={inch(sel.x)} onChange={(v) => update(sel.id, { x: toMm(v) })} />
              <NumIn label="Y (in)" value={inch(sel.y)} onChange={(v) => update(sel.id, { y: toMm(v) })} />
            </div>
            <div className="btn-row">
              <button className="btn small" onClick={() => transformSel(({ x, y }) => ({ x: -x, y }))}>Mirror</button>
              <button className="btn small" onClick={() => transformSel(({ x, y }) => ({ x, y: -y }))}>Flip</button>
              <button className="btn small" onClick={() => transformSel(({ x, y }) => ({ x: -y, y: x }))}>Rotate 90°</button>
              <button className="btn small" onClick={duplicate}>Duplicate</button>
              <button className="btn small danger" onClick={remove}>Delete</button>
            </div>
            <div className="mini-row">
              <label className="mini-field"><span>Vinyl color</span>
                <input type="color" value={sel.base.colors[0] || '#000000'} onChange={(e) => setColor(e.target.value)} />
              </label>
            </div>
            {!!settings?.colors?.length && (
              <div className="swatches">
                {settings.colors.map((c) => (
                  <button key={c.name} title={c.name} className={`swatch ${sel.base.colors[0] === c.hex ? 'on' : ''}`} style={{ background: c.hex }} onClick={() => setColor(c.hex)} />
                ))}
              </div>
            )}
            <div className="help">Arrow keys nudge 1/16" (Shift = 1"). Delete removes. Ctrl+D duplicates. Ctrl+Z undoes. Shift+click picks more pieces.</div>
          </Section>

          <Section key={picked.length > 1 ? 'combine-on' : 'combine-off'} title={`Combine${picked.length > 1 ? ` (${picked.length} pieces)` : ''}`} open={picked.length > 1}>
            {picked.length < 2
              ? <div className="help">Shift+click other pieces on the canvas to pick them too.</div>
              : <div className="help">The first piece you picked ({sel.name}) is the one others are cut from.</div>}
            <div className="btn-row">
              <button className="btn small" disabled={picked.length < 2} onClick={() => combine('weld')} title="Overlapping pieces become one outline">Weld</button>
              <button className="btn small" disabled={picked.length < 2} onClick={() => combine('subtract')} title="Cut the other pieces out of the first">Trim</button>
              <button className="btn small" disabled={picked.length < 2} onClick={() => combine('intersect')} title="Keep only where they overlap">Overlap</button>
              <button className="btn small" disabled={picked.length < 2} onClick={() => combine('group')} title="Move and size them together">Group</button>
            </div>
          </Section>

          <Section title="Nodes" open={false}>
            <div className="mini-row">
              <button className={`btn small ${nodeEdit ? 'primary' : ''}`} onClick={startNodeEdit}>{nodeEdit ? 'Done editing nodes' : 'Edit nodes'}</button>
              <span className="muted small">{nodeCount(sel.base.paths)} nodes</span>
            </div>
            {nodeEdit && <div className="help">Drag a node to move it. Double-click a node to delete it. Esc when done.</div>}
            <div className="mini-row">
              <NumIn label="Smooth by (mm)" value={simplifyMm} onChange={(v) => setSimplifyMm(Math.max(0.01, v))} step={0.05} />
              <button className="btn small" onClick={doSimplify}>Reduce nodes</button>
            </div>
            <div className="help">Reducing nodes cleans up traced logos and makes cuts smoother and faster.</div>
          </Section>

          <Section title="Text effects" open={false}>
            <div className="mini-row">
              <label className="mini-field"><span>Effect</span>
                <select value={envKind} onChange={(e) => setEnvKind(e.target.value)}>{ENVELOPES.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
              </label>
              <NumIn label="Amount (−100–100)" value={envAmt} onChange={(v) => setEnvAmt(Math.max(-100, Math.min(100, v)))} step={5} />
            </div>
            <button className="btn small" onClick={applyEnvelope}>Apply effect</button>
            <div className="mini-row" style={{ marginTop: 6 }}>
              <NumIn label="Shadow offset (in)" value={shadowIn} onChange={setShadowIn} step={0.0625} />
              <label className="mini-field"><span>Shadow color</span><input type="color" value={shadowColor} onChange={(e) => setShadowColor(e.target.value)} /></label>
            </div>
            <button className="btn small" onClick={makeShadow}>Add drop shadow</button>
            <div className="help">Outlined text: use Outline / offset below. Effects work on any piece — text becomes shapes.</div>
          </Section>

          {sel.trace && (
            <Section title="Trace settings">
              <div className="mini-row">
                <label className="mini-field"><span>Find the art by</span>
                  <select value={sel.trace.mode} onChange={(e) => retrace({ ...sel.trace, mode: e.target.value })}>
                    <option value="dark">Dark parts</option><option value="notbg">Different from background</option><option value="alpha">Transparency</option>
                  </select>
                </label>
                {sel.trace.mode === 'notbg'
                  ? <NumIn label="Tolerance" value={sel.trace.tolerance} onChange={(v) => retrace({ ...sel.trace, tolerance: v })} step={5} />
                  : <NumIn label="Threshold" value={sel.trace.threshold} onChange={(v) => retrace({ ...sel.trace, threshold: v })} step={8} />}
              </div>
              <div className="mini-row">
                <NumIn label="Ignore specks (px)" value={sel.trace.minArea} onChange={(v) => retrace({ ...sel.trace, minArea: v })} step={10} />
                <NumIn label="Smoothing (0–3)" value={sel.trace.smoothing} onChange={(v) => retrace({ ...sel.trace, smoothing: Math.max(0, Math.min(3, Math.round(v))) })} step={1} />
              </div>
              <div className="help">Tip: for a white logo on a dark background choose "Different from background".</div>
            </Section>
          )}

          <Section title="Outline / offset">
            <div className="mini-row">
              <NumIn label="Distance (in, − = inset)" value={offsetIn} onChange={setOffsetIn} step={0.0625} />
              <label className="mini-field"><span>Corners</span>
                <select value={offsetCorners} onChange={(e) => setOffsetCorners(e.target.value)}>
                  <option value="round">Round</option><option value="square">Square</option><option value="miter">Sharp</option>
                </select>
              </label>
            </div>
            <label className="check"><input type="checkbox" checked={offsetSolid} onChange={(e) => setOffsetSolid(e.target.checked)} /> Solid (fill holes) — for shadows/backers</label>
            <button className="btn" onClick={makeOffset}>Make outline</button>
            <div className="help">The outline gets its own color so it cuts as a separate layer.</div>
          </Section>

          <Section title="Copies (step & repeat)">
            <div className="mini-row">
              <NumIn label="Total copies" value={copies} onChange={(v) => setCopies(Math.max(1, Math.round(v)))} step={1} />
              <NumIn label="Gap (in)" value={copyGapIn} onChange={setCopyGapIn} step={0.0625} />
            </div>
            <button className="btn" onClick={stepRepeat}>Make copies</button>
            <div className="help">Fills across the {inch(cutWidthMm)}" roll first, then along it.</div>
          </Section>

          <Section title="Stencil bridges" open={false}>
            <div className="mini-row">
              <NumIn label="Bridge width (mm)" value={bridgeMm} onChange={(v) => setBridgeMm(Math.max(0.5, v))} step={0.5} />
              <label className="mini-field"><span>Bridges run</span>
                <select value={bridgeDir} onChange={(e) => setBridgeDir(e.target.value)}><option value="vertical">Up & down</option><option value="horizontal">Left & right</option></select>
              </label>
            </div>
            <button className="btn" onClick={makeBridges}>Add bridges</button>
            <div className="help">Keeps the middles of O, A, B, D, R… joined to the stencil, for paint and sandblast masks.</div>
          </Section>

          <Section title="Knockout (reverse)" open={false}>
            <div className="mini-row">
              <NumIn label="Margin (in)" value={koMarginIn} onChange={setKoMarginIn} step={0.125} />
              <NumIn label="Corner radius (in)" value={koRadiusIn} onChange={setKoRadiusIn} step={0.125} />
            </div>
            <button className="btn" onClick={makeKnockout}>Make knockout</button>
            <div className="help">Turns the piece into a solid block with the design cut out — reverse lettering, or a frame of vinyl around the art.</div>
          </Section>

          <Section title="Rhinestones" open={false}>
            <div className="mini-row">
              <label className="mini-field"><span>Stone</span>
                <select value={stoneId} onChange={(e) => setStoneId(e.target.value)}>{STONES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              </label>
              <NumIn label="Gap (mm)" value={stoneGapMm} onChange={(v) => setStoneGapMm(Math.max(0.2, v))} step={0.1} />
            </div>
            <label className="mini-field"><span>Fill</span>
              <select value={stoneMode} onChange={(e) => setStoneMode(e.target.value)}>
                <option value="outline">Outline only</option><option value="fill">Fill (honeycomb)</option><option value="both">Outline + fill</option>
              </select>
            </label>
            <button className="btn" onClick={makeStones}>Make stone template</button>
            <div className="help">Cuts holes slightly bigger than the stone for template material. Pick the rhinestone material for the right force.</div>
          </Section>
        </>)}

        {leftTab === 'library' && (<>
          <Section title="Templates">
            <select value={tplId} onChange={(e) => setTplId(e.target.value)}>{TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            {tpl.fields.map(([k, label, d]) => (
              <label key={k} className="mini-field"><span>{label}</span>
                <input type="text" value={tplValue(k, d)} onChange={(e) => setTplFields((f) => ({ ...f, [`${tplId}.${k}`]: e.target.value }))} />
              </label>
            ))}
            <button className="btn primary" onClick={makeTemplate}>Make it</button>
            <div className="help">{tpl.help} Uses the font picked in Add → Text.</div>
          </Section>
          <Section title="Save to library">
            {picked.length ? (<>
              <div className="mini-row">
                <label className="mini-field"><span>Name</span><input type="text" placeholder={picked[0].name} value={libName} onChange={(e) => setLibName(e.target.value)} /></label>
                <label className="mini-field"><span>Category</span><input type="text" value={libCat} onChange={(e) => setLibCat(e.target.value)} /></label>
              </div>
              <button className="btn small" onClick={saveToLibrary}>Save {picked.length > 1 ? `${picked.length} pieces` : 'selected piece'}</button>
            </>) : <div className="help">Select a piece (Shift+click for more) to save it — customer logos, borders, clip-art.</div>}
          </Section>
          {[...new Set(library.map((x) => x.category || 'Other'))].sort().map((cat) => (
            <Section key={cat} title={`${cat} (${library.filter((x) => (x.category || 'Other') === cat).length})`}>
              <div className="lib-grid">
                {library.filter((x) => (x.category || 'Other') === cat).map((it) => (
                  <div key={it.id} className="lib-item" title={`${it.name} — ${inch(it.w)} × ${inch(it.h)}"`}>
                    <button className="lib-thumb" onClick={() => insertFromLibrary(it)}>
                      <svg viewBox={`${-2} ${-2} ${it.w + 4} ${it.h + 4}`} preserveAspectRatio="xMidYMid meet">
                        {it.paths.map((pp, i) => <polyline key={i} points={pp.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ')} style={{ stroke: showColor(it.colors[i]) }} strokeWidth={Math.max(it.w, it.h) / 120} fill="none" />)}
                      </svg>
                    </button>
                    <div className="lib-name">{it.name}</div>
                    <button className="btn ghost small" onClick={async () => { await api.library.remove(it.id); setLibrary(await api.library.list()); }}>✕</button>
                  </div>
                ))}
              </div>
            </Section>
          ))}
        </>)}

        {leftTab === 'layout' && (<>
          <Section title="Nesting">
            <div className="mini-row">
              <NumIn label="Gap (in)" value={nestGapIn} onChange={setNestGapIn} step={0.0625} />
            </div>
            <label className="check"><input type="checkbox" checked={allowRotate} onChange={(e) => setAllowRotate(e.target.checked)} /> Allow rotating pieces 90°</label>
            <button className="btn primary" onClick={autoNest} disabled={!objects.length}>Nest to save vinyl</button>
            {job && <div className="help">Currently uses {job.vinylFt.toFixed(2)} ft of roll.</div>}
          </Section>
          <Section title={`Pieces (${objects.length})`}>
            {objects.map((o) => (
              <button key={o.id} className={`piece ${o.id === selId ? 'on' : ''}`} onClick={() => { setSelId(o.id); }}>
                <span><i className="dot" style={{ background: showColor(o.base.colors[0]) }} />{o.name}</span>
                <span className="muted small">{inch(o.widthMm)} × {inch(o.heightMm)}"</span>
              </button>
            ))}
          </Section>
        </>)}
      </div>

      <div className="studio-canvas">
        <svg ref={svgRef} viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} onPointerMove={onMove} onPointerUp={onUp}
          onPointerDown={onDownBg} preserveAspectRatio="xMidYMid meet">
          <rect x={view.x - view.w} y={0} width={view.w * 3} height={cutWidthMm} className="media" />
          <line x1={view.x - view.w} x2={view.x + view.w * 2} y1={cutWidthMm} y2={cutWidthMm} className="media-edge" strokeWidth={sw * 1.5} strokeDasharray={`${6 * sw} ${4 * sw}`} />
          <line x1={view.x - view.w} x2={view.x + view.w * 2} y1={0} y2={0} className="media-edge" strokeWidth={sw} />
          {Array.from({ length: Math.min(600, Math.ceil(view.w / MM) + 2) }, (_, i) => {
            const x = Math.floor(view.x / MM) * MM + i * MM, major = Math.round(x / MM) % 12 === 0;
            return <line key={i} x1={x} x2={x} y1={0} y2={(major ? 10 : 4) * sw} className="tick" strokeWidth={sw} />;
          })}
          {job && job.groups.flatMap((g, gi) => g.extra.map((p, i) => (
            <polyline key={`w${gi}-${i}`} points={ptsAttr(p)} className="weed" strokeWidth={sw} />
          )))}
          {objects.map((o) => {
            const p = placed(o);
            return (
              <g key={o.id} onPointerDown={(e) => onDownObj(e, o)} className={`obj ${o.id === selId ? 'sel' : ''}`}>
                <rect x={o.x} y={o.y} width={o.widthMm} height={o.heightMm} className="hit" />
                {p.paths.map((path, i) => (
                  <polyline key={i} points={ptsAttr(path)} strokeWidth={sw * 1.2}
                    style={{ stroke: showColor(p.colors[i]), opacity: colorsOff.includes(p.colors[i]) ? 0.2 : 1 }} />
                ))}
                {(o.id === selId || multi.includes(o.id)) && <rect x={o.x} y={o.y} width={o.widthMm} height={o.heightMm} className={o.id === selId ? 'sel-box' : 'sel-box multi'} strokeWidth={sw} strokeDasharray={`${4 * sw} ${3 * sw}`} />}
              </g>
            );
          })}
          {nodeEdit && sel && nodeCount(sel.base.paths) <= 2500 && (() => {
            const [sx, sy] = scaleOf(sel), r = 3 * sw;
            return sel.base.paths.map((path, pi) => {
              const closed = isClosedP(path);
              return path.map((q, qi) => (closed && qi === path.length - 1 ? null : (
                <rect key={`n${pi}-${qi}`} className="node" x={sel.x + q.x * sx - r} y={sel.y + q.y * sy - r} width={r * 2} height={r * 2} strokeWidth={sw * 0.8}
                  onPointerDown={(e) => onDownNode(e, pi, qi)} onDoubleClick={(e) => { e.stopPropagation(); deleteNode(pi, qi); }} />
              )));
            });
          })()}
          {showPanels && job && job.groups.map((g) => g.panels.length > 1 && g.panels.map((p) => (
            <g key={p.name}>
              <rect x={p.rect.x0 + g.b.minX} y={p.rect.y0 + g.b.minY} width={p.rect.x1 - p.rect.x0} height={p.rect.y1 - p.rect.y0} className="panel" strokeWidth={sw * 1.5} strokeDasharray={`${10 * sw} ${6 * sw}`} />
              <text x={p.rect.x0 + g.b.minX + 6 * sw} y={p.rect.y0 + g.b.minY + 16 * sw} className="panel-label" fontSize={13 * sw}>{p.name}</text>
            </g>
          )))}
        </svg>
        <div className="canvas-hud">
          <span>{device ? `${device.name} · ${inch(cutWidthMm)}" roll` : 'No cutter'}</span>
          <button className="btn small" onClick={() => setCam(null)}>Fit</button>
          <button className="btn small" onClick={() => setCam((c) => { const v = c || fitView; return { x: v.x + v.w * 0.15, y: v.y + v.h * 0.15, w: v.w * 0.7, h: v.h * 0.7 }; })}>+</button>
          <button className="btn small" onClick={() => setCam((c) => { const v = c || fitView; return { x: v.x - v.w * 0.2, y: v.y - v.h * 0.2, w: v.w * 1.4, h: v.h * 1.4 }; })}>−</button>
        </div>
        {!objects.length && <div className="canvas-empty">Import an SVG, add text, or add a shape to start.<br /><span className="small">Scroll to zoom · drag empty space to pan</span></div>}
      </div>

      <div className="studio-right">
        <Section title="Cutter & material">
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            {cutters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {settings && (
            <div className="mini-row">
              <select value={materialId} onChange={(e) => setMaterialId(e.target.value)}>
                {settings.materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <button className="btn small" style={{ flex: '0 0 auto' }} onClick={() => setEditMaterials(true)}>Edit…</button>
            </div>
          )}
          {material && <div className="help">{[material.force !== '' && material.force != null ? `Force ${material.force}` : 'Force: cutter panel', material.speed !== '' && material.speed != null ? `Speed ${material.speed}` : 'Speed: cutter panel', `Overcut ${material.overcutMm}mm`].join(' · ')}{material.note ? ` — ${material.note}` : ''}</div>}
          <label className="mini-field"><span>Job name</span><input type="text" value={jobName} onChange={(e) => setJobName(e.target.value)} /></label>
          {order && <div className="order-tag">InkFlow order {order.label} — marked {order.status} there when the job finishes. <button className="btn ghost small" onClick={() => setOrder(null)}>Unlink</button></div>}
        </Section>

        {allColors.length > 1 && (
          <Section title="Colors">
            {allColors.map((c) => (
              <label key={c} className="check">
                <input type="checkbox" checked={!colorsOff.includes(c)} onChange={(e) => setColorsOff((off) => (e.target.checked ? off.filter((x) => x !== c) : [...off, c]))} />
                <i className="dot" style={{ background: showColor(c) }} /> {colorName(c)}
              </label>
            ))}
            <label className="check"><input type="checkbox" checked={splitColors} onChange={(e) => setSplitColors(e.target.checked)} /> Cut each color as its own job</label>
            {splitColors && <label className="check"><input type="checkbox" checked={holdColors} onChange={(e) => setHoldColors(e.target.checked)} /> Wait for me to load each color (Release in the queue)</label>}
          </Section>
        )}

        <Section title="Weeding">
          <label className="check"><input type="checkbox" checked={border} onChange={(e) => setBorder(e.target.checked)} /> Weed border</label>
          {border && <NumIn label="Border margin (in)" value={borderIn} onChange={setBorderIn} step={0.05} />}
          <label className="check"><input type="checkbox" checked={weedPerPiece} onChange={(e) => setWeedPerPiece(e.target.checked)} /> Weed box around each piece</label>
          <label className="check"><input type="checkbox" checked={lines} onChange={(e) => setLines(e.target.checked)} /> Weed lines</label>
          {lines && (
            <div className="mini-row">
              <NumIn label="Every (in)" value={lineSpacingIn} onChange={setLineSpacingIn} step={0.5} />
              <label className="mini-field"><span>Direction</span>
                <select value={lineDir} onChange={(e) => setLineDir(e.target.value)}>
                  <option value="vertical">Across roll</option><option value="horizontal">Along roll</option>
                </select>
              </label>
            </div>
          )}
        </Section>

        <Section title="Tiling" open={false}>
          <div className="mini-row">
            <NumIn label="Overlap (in)" value={overlapIn} onChange={setOverlapIn} step={0.125} />
            <NumIn label="Max panel length (in)" value={panelLenIn} onChange={setPanelLenIn} step={6} />
          </div>
          <label className="check"><input type="checkbox" checked={showPanels} onChange={(e) => setShowPanels(e.target.checked)} /> Show panels</label>
          <div className="help">Jobs wider than the cutter split into panels automatically. Panel length 0 = no limit.</div>
        </Section>

        <Section title="Cutter control" open={false}>
          <CutterControl cutter={device} jobs={jobs} />
        </Section>

        {job && (
          <div className="tool-box stats">
            <div><span>Job size</span><b>{inch(job.b.w)} × {inch(job.b.h)}"</b></div>
            <div><span>Vinyl used</span><b>{job.vinylFt.toFixed(2)} ft</b></div>
            <div><span>Cut length</span><b>{(job.length / MM / 12).toFixed(1)} ft</b></div>
            <div><span>Jobs / panels</span><b>{job.panels.length}</b></div>
            {estimate && (<>
              <hr />
              <div><span>Material</span><b>${estimate.materialCost.toFixed(2)}</b></div>
              <div><span>Labor (~{Math.round(estimate.laborMin)} min)</span><b>${estimate.labor.toFixed(2)}</b></div>
              <div className="price"><span>Suggested price</span><b>${estimate.price.toFixed(2)}</b></div>
            </>)}
          </div>
        )}

        {rolls.length > 0 && job && (
          <div className="mini-field" style={{ margin: '8px 0' }}>
            <span>Take vinyl off InkFlow roll</span>
            {(job.groups.length > 1 && job.groups.some((g) => g.color) ? job.groups : [{ color: null }]).map((g) => (
              <select key={g.color || '_all'} value={rollMap[g.color || '_all'] || ''} onChange={(e) => setRollMap((m) => ({ ...m, [g.color || '_all']: e.target.value }))} style={{ marginTop: 4 }}>
                <option value="">{g.color ? `${colorName(g.color)}: don't track` : "Don't track"}</option>
                {rolls.map((r) => <option key={r.id} value={r.id}>{g.color ? `${colorName(g.color)}: ` : ''}{r.widthIn}" {r.materialName}{r.color ? ` ${r.color}` : ''} — {Math.round(r.remainingFeet)} ft left</option>)}
              </select>
            ))}
          </div>
        )}
        <div className="action-dock">
          <button className="print-btn" disabled={!job || !device} onClick={send}>
            <Icon name="cutter" /> Cut on {device?.name || 'cutter'}{job && job.panels.length > 1 ? ` (${job.panels.length} jobs)` : ''}
          </button>
          <div className="dock-more">
            <button className="btn small" disabled={!job || !device} onClick={saveFile}>Save .plt</button>
            <ProofButton order={order} disabled={!job} makeProof={async () => ({ kind: 'png', name: `${jobName || 'Vinyl job'} proof.png`, note: 'Vinyl design proof from InkSign', payload: { dataUrl: renderProof() } })} />
            <button className="btn small" disabled={!job || !estimate} onClick={() => setQuoting(true)}>Quote…</button>
          </div>
        </div>
        {quoting && job && <QuoteDialog lines={quoteLines()} defaultName={jobName} onClose={() => setQuoting(false)}
          makeProof={async () => ({ kind: 'png', name: `${jobName || 'Vinyl job'} proof.png`, note: 'Vinyl design proof from InkSign', payload: { dataUrl: renderProof() } })} />}
        {msg && <div className="studio-msg">{msg}</div>}
      </div>

      {editMaterials && settings && (
        <MaterialsEditor settings={settings} onClose={() => setEditMaterials(false)}
          onSave={async (patch) => { setSettings(await api.settings.save(patch)); setEditMaterials(false); }} />
      )}
    </div>
  );
}
