// Turns a job (PDF + Fiery-style job properties) into the exact byte stream the Xerox receives:
//   1. lay out the pages on the paper (fit / center / auto-rotate, imposition, covers, inserts,
//      chapter starts, mixed media) -> "prepared" PDF + which paper every output page is on
//   2. Ghostscript -> PostScript (with gray / CMYK color conversion when asked)
//   3. add Xerox's own driver commands from the 7845 PPD: job setup (paper size, type, color, tray,
//      print quality, 2-sided, collate, staple, booklet fold, punch, copies) and page-level paper
//      changes for mixed media
//   4. wrap it in the PPD's PJL job header (job name, owner, banner sheet, B&W accounting)
const { PDFDocument, degrees } = require('pdf-lib');
const ppdLib = require('../lib/ppd');
const { impose } = require('../lib/impose');

const IN = 72;

const DEFAULT_PROPS = {
  copies: 1, collate: true, notes: '',
  media: { catalogId: '', size: 'Letter', customW: 8.5, customH: 11, type: 'PrinterDefault', color: 'White', tray: 'auto' },
  sides: 'one', binding: 'long',
  scale: 'fit', // 'fit' | 'fill' | 'none' (100%, centered) ; documents are auto-rotated to the paper
  rotate180: false,
  layout: { mode: 'none', bleedIn: 0, gapIn: '', cropMarks: true, allowRotate: true, repeatBack: true },
  color: { mode: 'color', manage: false, rgbProfileId: '', cmykProfileId: '', outputProfileId: '', intent: 0, blackText: false, overprint: 'printer' },
  quality: 'Standard',
  finishing: { staple: 'None', fold: 'None', punch: 'None', banner: false },
  mixed: { ranges: [], inserts: [], chapters: '', frontCover: { catalogId: '', content: 'print' }, backCover: { catalogId: '', content: 'print' } },
};

function mergeProps(p = {}) {
  const d = DEFAULT_PROPS;
  return {
    ...d, ...p,
    media: { ...d.media, ...(p.media || {}) },
    layout: { ...d.layout, ...(p.layout || {}) },
    color: { ...d.color, ...(p.color || {}) },
    finishing: { ...d.finishing, ...(p.finishing || {}) },
    mixed: {
      ...d.mixed, ...(p.mixed || {}),
      frontCover: { ...d.mixed.frontCover, ...(p.mixed?.frontCover || {}) },
      backCover: { ...d.mixed.backCover, ...(p.mixed?.backCover || {}) },
      ranges: Array.isArray(p.mixed?.ranges) ? p.mixed.ranges : [],
      inserts: Array.isArray(p.mixed?.inserts) ? p.mixed.inserts : [],
    },
  };
}

// "1-3, 7, 10-" -> set of 1-based page numbers (up to n)
function parseRanges(text, n) {
  const out = new Set();
  for (const part of String(text || '').split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const a = m[1] ? Number(m[1]) : 1, b = m[2] ? Number(m[2]) : n;
      for (let i = Math.max(1, a); i <= Math.min(n, b); i++) out.add(i);
    } else if (/^\d+$/.test(part)) { const i = Number(part); if (i >= 1 && i <= n) out.add(i); }
  }
  return out;
}

// A paper (from the paper catalog, or the job's own Media settings) -> what the printer needs
function resolvePaper(ppd, entry) {
  const size = entry.size || 'Letter';
  let w, h;
  if (size === 'Custom') { w = Number(entry.customW || entry.w) * IN; h = Number(entry.customH || entry.h) * IN; }
  else {
    const s = ppd.sizes[size];
    if (!s) throw new Error(`Paper size ${size} isn't one the printer knows`);
    w = s.w; h = s.h;
  }
  if (!(w > 0 && h > 0)) throw new Error(`Set the custom paper size for ${entry.name || 'this paper'}`);
  // Xerox describes paper portrait (short edge first)
  if (w > h) [w, h] = [h, w];
  return {
    id: entry.id || '', name: entry.name || size, size, w, h,
    type: entry.type || 'PrinterDefault', color: entry.color || 'White', tray: entry.tray || 'auto',
    outputProfileId: entry.outputProfileId || '', costPerSheet: Number(entry.costPerSheet) || 0,
  };
}

const paperKey = (p) => [p.size, Math.round(p.w), Math.round(p.h), p.type, p.color, p.tray].join('|');

// The job's main paper: a catalog entry, or the Media tab's own settings
function jobPaper(ppd, props, catalog) {
  const m = props.media;
  const entry = m.catalogId ? catalog.find((c) => c.id === m.catalogId) : null;
  if (m.catalogId && !entry) throw new Error('The paper picked for this job was removed from the paper catalog');
  return resolvePaper(ppd, entry || { name: 'Job paper', size: m.size, customW: m.customW, customH: m.customH, type: m.type, color: m.color, tray: m.tray });
}
function catalogPaper(ppd, catalog, id, fallback) {
  if (!id) return fallback;
  const e = catalog.find((c) => c.id === id);
  if (!e) throw new Error('A paper used in Mixed media was removed from the paper catalog');
  return resolvePaper(ppd, e);
}

// Embed every page of a document using its visible (crop) box
function embedAll(out, doc) {
  const pages = doc.getPages();
  return out.embedPages(pages, pages.map((p) => {
    const b = p.getCropBox();
    return { left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height };
  }));
}

// Put one source page onto a paper-size page: auto-rotate to match orientation, then fit / fill / 100%
async function placeOnPaper(out, srcPage, emb, paper, scaleMode, rotate180) {
  const pw = paper.w, ph = paper.h;
  const box = srcPage.getCropBox();
  let sw = box.width, sh = box.height;
  const pageRot = (srcPage.getRotation().angle % 360 + 360) % 360;
  if (pageRot === 90 || pageRot === 270) [sw, sh] = [sh, sw];
  const turn = (sw > sh) !== (pw > ph) && Math.abs(sw - sh) > 1; // landscape art on portrait paper
  const vw = turn ? sh : sw, vh = turn ? sw : sh; // size as seen on the paper
  let s = 1;
  if (scaleMode === 'fit') s = Math.min(pw / vw, ph / vh);
  else if (scaleMode === 'fill') s = Math.max(pw / vw, ph / vh);
  const dw = vw * s, dh = vh * s;
  const ox = (pw - dw) / 2, oy = (ph - dh) / 2;
  const page = out.addPage([pw, ph]);
  // total rotation applied to the embedded page content
  // PDF /Rotate turns clockwise, drawPage turns counter-clockwise
  let rot = ((360 - pageRot) + (turn ? 90 : 0) + (rotate180 ? 180 : 0)) % 360;
  // drawPage rotates about the lower-left corner; shift so the result lands in the box
  const ew = emb.width * s, eh = emb.height * s; // un-rotated drawn size
  let x = ox, y = oy;
  if (rot === 90) { x = ox + dw; y = oy; }
  else if (rot === 180) { x = ox + dw; y = oy + dh; }
  else if (rot === 270) { x = ox; y = oy + dh; }
  page.drawPage(emb, { x, y, width: ew, height: eh, rotate: degrees(rot) });
  return page;
}

/**
 * Build the prepared (laid-out) PDF.
 * returns { pdf: Buffer, pages: [{ paper, blank }], paper (job paper), sheets, sides, srcPages, info }
 */
async function preparePdf(srcPdf, rawProps, { ppd, catalog = [] }) {
  const props = mergeProps(rawProps);
  const paper = jobPaper(ppd, props, catalog);
  const duplex = props.sides === 'two';
  const src = await PDFDocument.load(srcPdf, { ignoreEncryption: true });
  const n = src.getPageCount();
  if (!n) throw new Error('The file has no pages');
  const mode = props.layout.mode || 'none';
  const out = await PDFDocument.create();
  out.setCreator('InkSign Print Server');
  const pages = []; // per output page: { paper, blank }
  let info = { mode };

  if (mode === 'none') {
    const m = props.mixed;
    // paper for each source page
    const pagePaper = new Array(n).fill(paper);
    for (const r of m.ranges) {
      const pp = catalogPaper(ppd, catalog, r.catalogId, paper);
      for (const i of parseRanges(r.pages, n)) pagePaper[i - 1] = pp;
    }
    const front = m.frontCover?.catalogId ? catalogPaper(ppd, catalog, m.frontCover.catalogId, paper) : null;
    const back = m.backCover?.catalogId ? catalogPaper(ppd, catalog, m.backCover.catalogId, paper) : null;
    const chapters = parseRanges(m.chapters, n);
    const inserts = new Map();
    for (const ins of m.inserts) {
      const after = Math.max(0, Math.min(n, Math.round(Number(ins.after) || 0)));
      const list = inserts.get(after) || [];
      list.push({ paper: catalogPaper(ppd, catalog, ins.catalogId, paper), count: Math.max(1, Math.round(Number(ins.count) || 1)) });
      inserts.set(after, list);
    }
    const embedded = await embedAll(out, src);
    const seq = []; // { srcIndex | null, paper, newSheet }
    const sheetBreak = () => { if (duplex && seq.length % 2 === 1) seq.push({ srcIndex: null, paper: seq[seq.length - 1].paper, pad: true }); };
    const addBlankSheet = (pp) => { sheetBreak(); seq.push({ srcIndex: null, paper: pp }); if (duplex) seq.push({ srcIndex: null, paper: pp }); };
    const pushPage = (i, pp, forceBreak) => {
      const last = seq[seq.length - 1];
      if (forceBreak || (duplex && last && paperKey(last.paper) !== paperKey(pp))) sheetBreak();
      seq.push({ srcIndex: i, paper: pp });
    };
    // front cover
    let start = 0;
    if (front) {
      if (m.frontCover.content === 'blank') addBlankSheet(front);
      else if (m.frontCover.content === 'front') { pushPage(0, front, true); if (duplex) seq.push({ srcIndex: null, paper: front }); start = 1; }
      else { pushPage(0, front, true); if (duplex && n > 1) seq.push({ srcIndex: 1, paper: front }); start = duplex ? 2 : 1; }
    }
    for (const ins of inserts.get(0) || []) for (let k = 0; k < ins.count; k++) addBlankSheet(ins.paper);
    const backTake = back && m.backCover.content !== 'blank' ? (duplex && m.backCover.content !== 'front' ? 2 : 1) : 0;
    const bodyEnd = Math.max(start, n - backTake);
    for (let i = start; i < bodyEnd; i++) {
      pushPage(i, pagePaper[i], chapters.has(i + 1) || (front && i === start));
      for (const ins of inserts.get(i + 1) || []) for (let k = 0; k < ins.count; k++) addBlankSheet(ins.paper);
    }
    if (back) {
      sheetBreak();
      if (m.backCover.content === 'blank') addBlankSheet(back);
      else {
        const first = bodyEnd;
        if (backTake === 2) { seq.push({ srcIndex: first, paper: back }); seq.push({ srcIndex: first + 1 < n ? first + 1 : null, paper: back }); }
        else { if (duplex) seq.push({ srcIndex: null, paper: back }); seq.push({ srcIndex: first < n ? first : null, paper: back }); }
      }
    }
    if (duplex && seq.length % 2) seq.push({ srcIndex: null, paper: seq[seq.length - 1].paper, pad: true });
    for (const s of seq) {
      if (s.srcIndex == null) out.addPage([s.paper.w, s.paper.h]);
      else await placeOnPaper(out, src.getPage(s.srcIndex), embedded[s.srcIndex], s.paper, props.scale, props.rotate180);
      pages.push({ paper: s.paper, blank: s.srcIndex == null });
    }
    info = { mode, blankPages: seq.filter((s) => s.srcIndex == null).length };
  } else {
    // Imposition on the job paper (step & repeat, n-up, booklet)
    const sheetW = paper.w / IN, sheetH = paper.h / IN;
    const L = props.layout;
    const booklet = mode === 'booklet';
    // Booklet spreads are landscape; other layouts use the sheet as-is (impose rotates pieces to fit)
    const imposed = await impose({ pdf: srcPdf }, {
      mode, sheetW: booklet ? Math.max(sheetW, sheetH) : sheetW, sheetH: booklet ? Math.min(sheetW, sheetH) : sheetH,
      bleedIn: Number(L.bleedIn) || 0, gapIn: L.gapIn === '' || L.gapIn == null ? '' : Number(L.gapIn),
      cropMarks: L.cropMarks !== false, allowRotate: L.allowRotate !== false, duplex: mode === 'repeat' ? (duplex && L.repeatBack !== false) : false, sheets: 1,
    });
    info = { ...imposed.info };
    const imp = await PDFDocument.load(imposed.pdf);
    const embedded = await embedAll(out, imp);
    const front = booklet && props.mixed.frontCover?.catalogId ? catalogPaper(ppd, catalog, props.mixed.frontCover.catalogId, paper) : null;
    for (let i = 0; i < embedded.length; i++) {
      const pp = front && i < 2 ? front : paper; // booklet cover = the outside sheet (pages 1, 2 & last two)
      await placeOnPaper(out, imp.getPage(i), embedded[i], pp, 'none', props.rotate180);
      pages.push({ paper: pp, blank: false });
    }
    if (duplex && pages.length % 2) { out.addPage([paper.w, paper.h]); pages.push({ paper, blank: true }); }
  }
  const pdf = Buffer.from(await out.save());
  const sides = pages.length;
  const sheets = duplex ? Math.ceil(sides / 2) : sides;
  return { pdf, pages, paper, sheets, sides, srcPages: n, info, props };
}

// Which tray: the paper's own tray, else a tray the server says is loaded with that paper, else let the Xerox pick
function trayFor(paper, trays = {}) {
  if (paper.tray && paper.tray !== 'auto') return paper.tray;
  if (paper.id) {
    const hit = Object.entries(trays).find(([, id]) => id === paper.id);
    if (hit) return hit[0];
  }
  return null;
}

function picksFor(ppd, props, paper, trays) {
  const has = (opt, ch) => ppd.options[opt]?.choices.some((c) => c.key === ch);
  const picks = {};
  if (paper.size !== 'Custom' && has('PageSize', paper.size)) picks.PageSize = paper.size;
  if (has('MediaType', paper.type)) picks.MediaType = paper.type;
  if (has('MediaColor', paper.color)) picks.MediaColor = paper.color;
  const tray = trayFor(paper, trays);
  if (tray && has('InputSlot', tray)) picks.InputSlot = tray;
  if (has('OutputMode', props.quality)) picks.OutputMode = props.quality;
  picks.Duplex = props.sides === 'two' ? (props.binding === 'short' || props.layout?.mode === 'booklet' ? 'DuplexTumble' : 'DuplexNoTumble') : 'None';
  picks.Collate = props.collate ? 'True' : 'False';
  const f = props.finishing;
  if (has('StapleLocation', f.staple)) picks.StapleLocation = f.staple;
  if (has('XRFold', f.fold)) picks.XRFold = f.fold;
  if (has('XRPunch', f.punch)) picks.XRPunch = f.punch;
  if (ppd.options.JCLBanner) picks.JCLBanner = f.banner ? 'True' : 'False';
  return picks;
}

// Everything that would stop the job printing right, before it's sent
function check(ppd, rawProps, catalog = [], trays = {}) {
  const props = mergeProps(rawProps);
  const problems = [];
  let paper;
  try { paper = jobPaper(ppd, props, catalog); } catch (e) { return [e.message]; }
  const picks = picksFor(ppd, props, paper, trays);
  for (const c of ppdLib.conflicts(ppd, picks)) problems.push(c.message);
  if (paper.size === 'Custom' && ppd.custom?.maxW) {
    if (paper.w < ppd.custom.minW - 0.5 || paper.w > ppd.custom.maxW + 0.5 || paper.h < ppd.custom.minH - 0.5 || paper.h > ppd.custom.maxH + 0.5) {
      problems.push(`Custom size must be ${(ppd.custom.minW / IN).toFixed(2)}–${(ppd.custom.maxW / IN).toFixed(2)}" wide and ${(ppd.custom.minH / IN).toFixed(2)}–${(ppd.custom.maxH / IN).toFixed(2)}" long`);
    }
  }
  if ((props.finishing.fold !== 'None') && props.layout.mode !== 'booklet') problems.push('Booklet fold needs Layout → Booklet (pages imposed two-up in booklet order)');
  if (props.layout.mode === 'booklet' && props.sides !== 'two') problems.push('A booklet must print 2-sided');
  if (props.layout.mode !== 'none' && (props.mixed.ranges.length || props.mixed.inserts.length || props.mixed.chapters)) problems.push('Mixed media page ranges, inserts and chapter starts work with Layout → Normal only');
  for (const cov of [props.mixed.frontCover, props.mixed.backCover]) {
    if (cov?.catalogId && !catalog.some((c) => c.id === cov.catalogId)) problems.push('The cover paper was removed from the paper catalog');
  }
  for (const ins of props.mixed.inserts) if (ins.catalogId && !catalog.some((c) => c.id === ins.catalogId)) problems.push('An insert paper was removed from the paper catalog');
  for (const r of props.mixed.ranges) {
    try { const pp = catalogPaper(ppd, catalog, r.catalogId, paper); for (const c of ppdLib.conflicts(ppd, { ...picks, PageSize: pp.size, MediaType: pp.type, InputSlot: trayFor(pp, trays) || undefined })) problems.push(`Pages ${r.pages}: ${c.message}`); }
    catch (e) { problems.push(e.message); }
  }
  return [...new Set(problems)];
}

function pjlString(s) { return String(s || '').replace(/["\r\n\x1b]/g, '').slice(0, 80); }

function nonPpdCopies(copies) {
  const n = Math.max(1, Math.min(9999, Math.round(Number(copies) || 1)));
  return `%%BeginNonPPDFeature: NumCopies ${n}\n${n} /languagelevel where {pop languagelevel 2 ge}{false}ifelse {1 dict dup /NumCopies 4 -1 roll put setpagedevice}{userdict /#copies 3 -1 roll put}ifelse\n%%EndNonPPDFeature`;
}

// Add the job setup and page-level paper changes into Ghostscript's PostScript
function injectFeatures(ps, ppd, { setup, pageCode }) {
  let text = ps.toString('latin1');
  const firstPage = text.search(/^%%Page:/m);
  if (firstPage < 0) throw new Error('The converted job has no pages');
  text = `${text.slice(0, firstPage)}%%BeginSetup\n${setup}\n%%EndSetup\n${text.slice(firstPage)}`;
  if (pageCode && pageCode.some(Boolean)) {
    // Ghostscript writes "%%Page:" then its own "%%BeginPageSetup" for every page, before the page's
    // save/restore — paper changes go at the start of that page setup so they stay in effect.
    let idx = 0;
    text = text.replace(/^%%Page:[^\n]*\n(?:%%PageBoundingBox:[^\n]*\n)?(%%BeginPageSetup\n)?/gm, (whole, setupLine) => {
      const code = pageCode[idx++];
      if (!code) return whole;
      return setupLine ? `${whole}${code}\n` : `${whole}%%BeginPageSetup\n${code}\n%%EndPageSetup\n`;
    });
  }
  return Buffer.from(text, 'latin1');
}

/**
 * The full printer stream for a prepared job.
 * ctx: { ppd, gs, trays, profileBytes(id) -> Buffer|null, user, jobName }
 */
async function buildStream(prepared, ctx) {
  const { ppd, gs } = ctx;
  const props = prepared.props;
  const paper = prepared.paper;
  const picks = picksFor(ppd, props, paper, ctx.trays);
  const sizeOverride = paper.size === 'Custom' ? { w: paper.w, h: paper.h } : null;
  const setup = [nonPpdCopies(props.copies), ppdLib.featureCode(ppd, picks, { sizeOverride })].join('\n');
  // Paper changes for mixed media: at each page whose paper differs from the one before it
  const pageCode = [];
  let cur = paperKey(paper);
  prepared.pages.forEach((p, i) => {
    const k = paperKey(p.paper);
    if (k !== cur || (i === 0 && k !== paperKey(paper))) {
      const pp = picksFor(ppd, props, p.paper, ctx.trays);
      const sub = { MediaType: pp.MediaType, MediaColor: pp.MediaColor, InputSlot: pp.InputSlot, PageSize: pp.PageSize };
      for (const key of Object.keys(sub)) if (sub[key] == null) delete sub[key];
      pageCode[i] = ppdLib.featureCode(ppd, sub, { sizeOverride: p.paper.size === 'Custom' ? { w: p.paper.w, h: p.paper.h } : null });
      cur = k;
    }
  });
  const c = props.color;
  const color = { mode: c.mode, convert: !!c.manage && c.mode !== 'gray', intent: c.intent, blackText: c.blackText, overprint: c.overprint };
  if (color.convert && ctx.profileBytes) {
    color.rgbProfile = c.rgbProfileId ? ctx.profileBytes(c.rgbProfileId) : null;
    color.cmykProfile = c.cmykProfileId ? ctx.profileBytes(c.cmykProfileId) : null;
    const outId = c.outputProfileId || paper.outputProfileId;
    color.outputProfile = outId ? ctx.profileBytes(outId) : null;
  }
  const ps = await gs.pdfToPs(prepared.pdf, color);
  const body = injectFeatures(ps, ppd, { setup, pageCode });
  const head = [
    ppd.jcl.begin || '\x1b%-12345X@PJL JOB\n',
    `@PJL COMMENT OID_ATT_JOB_NAME "${pjlString(ctx.jobName)}";\n`,
    ctx.user ? `@PJL COMMENT OID_ATT_JOB_OWNER "${pjlString(ctx.user)}";\n` : '',
    c.mode === 'gray' ? '@PJL COMMENT OID_ATT_COLOR_MODE OID_VAL_COLOR_MODE_BLACK_WHITE;\n' : '',
    ppdLib.jclCode(ppd, picks),
    ppd.jcl.toPs || '@PJL ENTER LANGUAGE = POSTSCRIPT\n',
  ].join('');
  const tail = ppd.jcl.end || '\x1b%-12345X@PJL EOJ\n\x1b%-12345X\n';
  return Buffer.concat([Buffer.from(head, 'latin1'), body, Buffer.from(tail, 'latin1')]);
}

// Read the settings out of a job printed from the Windows Xerox PostScript driver (to the virtual printer)
function readCapturedJob(buf) {
  const text = buf.subarray(0, Math.min(buf.length, 4 * 1024 * 1024)).toString('latin1');
  const pick = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  const name = pick(/OID_ATT_JOB_NAME\s+"([^"]*)"/) || pick(/@PJL JOB NAME\s*=\s*"([^"]*)"/i) || pick(/^%%Title:\s*\(?([^\r\n)]*)\)?/m) || 'Printed job';
  const user = pick(/OID_ATT_JOB_OWNER\s+"([^"]*)"/) || pick(/@PJL SET USERNAME\s*=\s*"([^"]*)"/i) || pick(/^%%For:\s*\(?([^\r\n)]*)\)?/m);
  const feats = {};
  for (const m of text.matchAll(/%%BeginFeature:\s*\*(\w+)\s+([^\r\n]+)/g)) feats[m[1]] = m[2].trim();
  const copies = Number(pick(/%%BeginNonPPDFeature:\s*NumCopies\s+(\d+)/) || pick(/\/NumCopies\s+(\d+)/) || pick(/@PJL SET (?:COPIES|QTY)\s*=\s*(\d+)/i) || 1);
  const props = { copies, media: {}, finishing: {} };
  if (feats.PageSize) props.media.size = feats.PageSize;
  if (feats.MediaType) props.media.type = feats.MediaType;
  if (feats.MediaColor) props.media.color = feats.MediaColor;
  if (feats.InputSlot) props.media.tray = feats.InputSlot;
  if (feats.Duplex) { props.sides = feats.Duplex === 'None' ? 'one' : 'two'; props.binding = feats.Duplex === 'DuplexTumble' ? 'short' : 'long'; }
  if (feats.Collate) props.collate = feats.Collate === 'True';
  if (feats.StapleLocation) props.finishing.staple = feats.StapleLocation;
  if (feats.XRFold) props.finishing.fold = feats.XRFold;
  if (feats.XRPunch) props.finishing.punch = feats.XRPunch;
  if (feats.OutputMode) props.quality = feats.OutputMode;
  const isPdf = /%PDF-/.test(text.slice(0, 4096));
  return { name: name.slice(0, 120), user, props, features: feats, language: isPdf ? 'pdf' : 'ps' };
}

// The document data inside a PJL-wrapped stream (strip the PJL header/trailer)
function stripPjl(buf) {
  const s = buf.toString('latin1');
  let start = 0;
  const enter = s.search(/@PJL ENTER LANGUAGE\s*=\s*\w+[^\n]*\n/i);
  if (enter >= 0) start = enter + s.slice(enter).indexOf('\n') + 1;
  else { const ps = s.search(/%!PS|%PDF-/); if (ps > 0) start = ps; }
  let end = s.length;
  const uel = s.indexOf('\x1b%-12345X', start);
  if (uel >= 0) end = uel;
  return buf.subarray(start, end);
}

module.exports = { DEFAULT_PROPS, mergeProps, parseRanges, preparePdf, buildStream, check, picksFor, readCapturedJob, stripPjl, resolvePaper, jobPaper, trayFor };
