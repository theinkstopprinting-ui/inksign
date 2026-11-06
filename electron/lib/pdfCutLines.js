// Takes cut lines out of a PDF before it's printed — what Flexi's "Don't print cut lines" does.
// Any path painted in a spot color named like CutContour / Thru-cut / Kiss-cut is turned into an
// invisible path (fills that share the path keep their fill). Works on page content and Form XObjects.
const zlib = require('zlib');
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFStream, PDFRef } = require('pdf-lib');

const CUT_NAMES = /^(cut ?contour|thru-?cut|through-?cut|kiss-?cut|die-?cut|cutline|cut)$/i;

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

// Tokens with their byte ranges: { t: 'op'|'name'|'other', v, s, e }
function* tokens(b) {
  let i = 0;
  const n = b.length;
  while (i < n) {
    const c = b[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 0x25) { while (i < n && b[i] !== 0x0a && b[i] !== 0x0d) i++; continue; } // % comment
    const s = i;
    if (c === 0x28) { // (string)
      let depth = 0;
      for (; i < n; i++) {
        if (b[i] === 0x5c) { i++; continue; }
        if (b[i] === 0x28) depth++;
        else if (b[i] === 0x29 && --depth === 0) { i++; break; }
      }
      yield { t: 'other', s, e: i };
      continue;
    }
    if (c === 0x3c && b[i + 1] === 0x3c) { i += 2; yield { t: 'other', s, e: i }; continue; }
    if (c === 0x3e && b[i + 1] === 0x3e) { i += 2; yield { t: 'other', s, e: i }; continue; }
    if (c === 0x3c) { while (i < n && b[i] !== 0x3e) i++; i++; yield { t: 'other', s, e: i }; continue; }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) { i++; yield { t: 'other', s, e: i }; continue; }
    if (c === 0x2f) { i++; while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++; yield { t: 'name', v: Buffer.from(b.subarray(s + 1, i)).toString('latin1'), s, e: i }; continue; }
    while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
    if (i === s) { i++; continue; }
    const word = Buffer.from(b.subarray(s, i)).toString('latin1');
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { yield { t: 'other', s, e: i }; continue; }
    if (word === 'BI') {
      // inline image: skip to EI
      const idx = Buffer.from(b).indexOf('ID', i, 'latin1');
      let j = idx < 0 ? n : idx + 3;
      for (; j < n - 2; j++) if (WS.has(b[j]) && b[j + 1] === 0x45 && b[j + 2] === 0x49 && (j + 3 >= n || WS.has(b[j + 3]))) break;
      i = Math.min(n, j + 3);
      yield { t: 'other', s, e: i };
      continue;
    }
    yield { t: 'op', v: word, s, e: i };
  }
}

const STROKE_OFF = { S: 'n', s: 'n', B: 'f', 'B*': 'f*', b: 'f', 'b*': 'f*' };
const FILL_OFF = { f: 'n', F: 'n', 'f*': 'n', B: 'S', 'B*': 'S', b: 's', 'b*': 's' };

// Rewrites one content stream; cutSpaces = Set of resource names (e.g. "CS0") that are cut colors.
function filterContent(bytes, cutSpaces, state) {
  if (!cutSpaces.size) return { bytes, changed: 0 };
  const edits = [];
  let lastName = null;
  for (const tk of tokens(bytes)) {
    if (tk.t === 'name') { lastName = tk.v; continue; }
    if (tk.t !== 'op') continue;
    const op = tk.v;
    if (op === 'q') state.stack.push([state.stroke, state.fill]);
    else if (op === 'Q') { const p = state.stack.pop(); if (p) [state.stroke, state.fill] = p; }
    else if (op === 'CS') state.stroke = cutSpaces.has(lastName);
    else if (op === 'cs') state.fill = cutSpaces.has(lastName);
    else if (op === 'G' || op === 'RG' || op === 'K') state.stroke = false;
    else if (op === 'g' || op === 'rg' || op === 'k') state.fill = false;
    else {
      let rep = null;
      if (state.stroke && STROKE_OFF[op] && /^[SsBb]\*?$/.test(op)) rep = STROKE_OFF[op];
      if (state.fill && FILL_OFF[op]) rep = rep && rep !== op ? (FILL_OFF[rep] || 'n') : FILL_OFF[op];
      if (rep && rep !== op) edits.push([tk.s, tk.e, rep]);
    }
    lastName = null;
  }
  if (!edits.length) return { bytes, changed: 0 };
  const parts = [];
  let at = 0;
  for (const [s, e, rep] of edits) { parts.push(Buffer.from(bytes.subarray(at, s)), Buffer.from(rep, 'latin1')); at = e; }
  parts.push(Buffer.from(bytes.subarray(at)));
  return { bytes: Buffer.concat(parts), changed: edits.length };
}

function streamBytes(stream) {
  if (stream instanceof PDFRawStream) {
    const filter = stream.dict.get(PDFName.of('Filter'));
    const f = filter instanceof PDFArray ? filter.asArray().map(String) : filter ? [String(filter)] : [];
    if (!f.length) return Buffer.from(stream.contents);
    if (f.length === 1 && f[0] === '/FlateDecode' && !stream.dict.get(PDFName.of('DecodeParms'))) return zlib.inflateSync(Buffer.from(stream.contents));
    return null; // other filters: leave alone
  }
  if (stream instanceof PDFStream && typeof stream.getUnencodedContents === 'function') return Buffer.from(stream.getUnencodedContents());
  return null;
}

function cutColorSpaces(doc, resources) {
  const names = new Set();
  const csDict = resources && doc.context.lookup(resources.get(PDFName.of('ColorSpace')));
  if (!(csDict instanceof PDFDict)) return names;
  for (const [key, val] of csDict.entries()) {
    const cs = doc.context.lookup(val);
    if (!(cs instanceof PDFArray)) continue;
    const kind = String(cs.get(0));
    if (kind === '/Separation' && CUT_NAMES.test(String(cs.get(1)).replace(/^\//, '').replace(/#20/g, ' '))) names.add(key.asString().replace(/^\//, ''));
  }
  return names;
}

function replaceStream(doc, ref, bytes, dict) {
  const d = dict.clone(doc.context);
  d.delete(PDFName.of('Filter'));
  d.delete(PDFName.of('DecodeParms'));
  const comp = zlib.deflateSync(bytes);
  d.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  d.set(PDFName.of('Length'), doc.context.obj(comp.length));
  doc.context.assign(ref, PDFRawStream.of(d, comp));
}

function processXObjects(doc, resources, seen, counter) {
  const xo = resources && doc.context.lookup(resources.get(PDFName.of('XObject')));
  if (!(xo instanceof PDFDict)) return;
  for (const [, val] of xo.entries()) {
    if (!(val instanceof PDFRef) || seen.has(val.toString())) continue;
    seen.add(val.toString());
    const st = doc.context.lookup(val);
    if (!st || !st.dict || String(st.dict.get(PDFName.of('Subtype'))) !== '/Form') continue;
    const res = doc.context.lookup(st.dict.get(PDFName.of('Resources')));
    const cut = cutColorSpaces(doc, res);
    const raw = streamBytes(st);
    if (raw && cut.size) {
      const r = filterContent(raw, cut, { stroke: false, fill: false, stack: [] });
      if (r.changed) { replaceStream(doc, val, r.bytes, st.dict); counter.n += r.changed; }
    }
    processXObjects(doc, res, seen, counter);
  }
}

/** Returns { pdf, removed } — removed = how many cut paths were hidden */
async function removeCutLines(pdfBytes) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const counter = { n: 0 };
  const seen = new Set();
  for (const page of doc.getPages()) {
    const res = page.node.Resources();
    const cut = cutColorSpaces(doc, res);
    const contents = page.node.get(PDFName.of('Contents'));
    const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    const state = { stroke: false, fill: false, stack: [] };
    if (cut.size) {
      for (const ref of refs) {
        if (!(ref instanceof PDFRef)) continue;
        const st = doc.context.lookup(ref);
        const raw = st && streamBytes(st);
        if (!raw) continue;
        const r = filterContent(raw, cut, state);
        if (r.changed) { replaceStream(doc, ref, r.bytes, st.dict); counter.n += r.changed; }
      }
    }
    processXObjects(doc, res, seen, counter);
  }
  if (!counter.n) return { pdf: Buffer.from(pdfBytes), removed: 0 };
  return { pdf: Buffer.from(await doc.save({ useObjectStreams: false })), removed: counter.n };
}

module.exports = { removeCutLines, filterContent, tokens, CUT_NAMES };
