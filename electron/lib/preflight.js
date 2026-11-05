// Preflight: looks at a print file before it goes to a printer and flags what will come out badly.
// Checks: image resolution at the printed size, RGB/CMYK/spot colors, fonts not embedded,
// stretched artwork, missing bleed, and pages that don't match the job.
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream } = require('pdf-lib');

const LIMITS = {
  wide: { low: 72, ok: 100, label: 'wide format (viewed from a few feet)' },
  press: { low: 150, ok: 240, label: 'close-up print' },
  printcut: { low: 150, ok: 200, label: 'stickers / labels' },
};

function pngInfo(b) {
  if (b.length < 26 || b.readUInt32BE(0) !== 0x89504e47) return null;
  const types = { 0: 'Gray', 2: 'RGB', 3: 'Indexed (RGB)', 4: 'Gray + alpha', 6: 'RGB + alpha' };
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), color: types[b[25]] || 'RGB', alpha: b[25] === 4 || b[25] === 6 };
}

function jpegInfo(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) {
      const comps = b[i + 9];
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), color: comps === 4 ? 'CMYK' : comps === 1 ? 'Gray' : 'RGB', alpha: false };
    }
    i += 2 + len;
  }
  return null;
}

function dpiCheck(out, name, px, inches, purpose) {
  if (!inches) return;
  const dpi = px / inches;
  const L = LIMITS[purpose] || LIMITS.press;
  const t = `${name}: ${Math.round(dpi)} dpi at ${inches.toFixed(1)}" wide`;
  if (dpi < L.low) out.push({ level: 'error', text: `${t} — too low for ${L.label}, will look blurry/blocky (want ${L.ok}+)` });
  else if (dpi < L.ok) out.push({ level: 'warn', text: `${t} — a bit soft for ${L.label} (want ${L.ok}+)` });
  else out.push({ level: 'ok', text: `${t}` });
}

const lookup = (doc, v) => (v instanceof PDFRef ? doc.context.lookup(v) : v);

function colorSpaceName(doc, cs) {
  cs = lookup(doc, cs);
  if (!cs) return null;
  if (cs instanceof PDFName) return cs.decodeText().replace(/^Device/, '');
  if (cs instanceof PDFArray) {
    const kind = lookup(doc, cs.get(0));
    const k = kind instanceof PDFName ? kind.decodeText() : '';
    if (k === 'ICCBased') {
      const s = lookup(doc, cs.get(1));
      const n = s && s.dict ? s.dict.get(PDFName.of('N')) : null;
      const nn = n ? Number(n.toString()) : 3;
      return nn === 4 ? 'CMYK' : nn === 1 ? 'Gray' : 'RGB';
    }
    if (k === 'Separation') { const nm = lookup(doc, cs.get(1)); return `Spot: ${nm instanceof PDFName ? nm.decodeText() : '?'}`; }
    if (k === 'DeviceN') return 'DeviceN (spot channels)';
    if (k === 'Indexed') return colorSpaceName(doc, cs.get(1));
    return k;
  }
  return null;
}

function scanResources(doc, res, acc, depth = 0) {
  res = lookup(doc, res);
  if (!(res instanceof PDFDict) || depth > 4) return;
  const fonts = lookup(doc, res.get(PDFName.of('Font')));
  if (fonts instanceof PDFDict) {
    for (const [, ref] of fonts.entries()) {
      const f = lookup(doc, ref);
      if (!(f instanceof PDFDict)) continue;
      const base = lookup(doc, f.get(PDFName.of('BaseFont')));
      const name = base instanceof PDFName ? base.decodeText().replace(/^[A-Z]{6}\+/, '') : 'font';
      const sub = lookup(doc, f.get(PDFName.of('Subtype')));
      if (sub instanceof PDFName && sub.decodeText() === 'Type3') continue;
      let fd = lookup(doc, f.get(PDFName.of('FontDescriptor')));
      if (!fd) {
        const desc = lookup(doc, f.get(PDFName.of('DescendantFonts')));
        if (desc instanceof PDFArray) { const d0 = lookup(doc, desc.get(0)); fd = d0 instanceof PDFDict ? lookup(doc, d0.get(PDFName.of('FontDescriptor'))) : null; }
      }
      const embedded = fd instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.has(PDFName.of(k)));
      (embedded ? acc.fontsOk : acc.fontsMissing).add(name);
    }
  }
  const cs = lookup(doc, res.get(PDFName.of('ColorSpace')));
  if (cs instanceof PDFDict) for (const [, v] of cs.entries()) { const n = colorSpaceName(doc, v); if (n) acc.spaces.add(n); }
  const xo = lookup(doc, res.get(PDFName.of('XObject')));
  if (xo instanceof PDFDict) {
    for (const [, ref] of xo.entries()) {
      const x = lookup(doc, ref);
      if (!(x instanceof PDFStream)) continue;
      const st = lookup(doc, x.dict.get(PDFName.of('Subtype')));
      const kind = st instanceof PDFName ? st.decodeText() : '';
      if (kind === 'Image') {
        const w = Number(String(x.dict.get(PDFName.of('Width')) || 0)), h = Number(String(x.dict.get(PDFName.of('Height')) || 0));
        const sp = colorSpaceName(doc, x.dict.get(PDFName.of('ColorSpace'))) || 'Mask';
        acc.images.push({ w, h, space: sp });
        acc.spaces.add(sp);
      } else if (kind === 'Form') scanResources(doc, x.dict.get(PDFName.of('Resources')), acc, depth + 1);
    }
  }
}

async function checkPdf(out, name, bytes, { widthIn, heightIn, purpose, bleedIn }) {
  let doc;
  try { doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }); }
  catch { out.push({ level: 'error', text: `${name}: not a readable PDF` }); return; }
  const pages = doc.getPages();
  const p0 = pages[0];
  const pw = p0.getWidth() / 72, ph = p0.getHeight() / 72;
  out.push({ level: 'info', text: `${name}: ${pages.length} page${pages.length === 1 ? '' : 's'}, ${pw.toFixed(2)} × ${ph.toFixed(2)}"` });
  if (widthIn && heightIn) {
    const a = pw / ph, bl = Number(bleedIn) || 0;
    const fits = [widthIn / heightIn, (widthIn + 2 * bl) / (heightIn + 2 * bl)].some((b) => Math.abs(a - b) / b <= 0.02 || Math.abs(1 / a - b) / b <= 0.02);
    if (!fits) out.push({ level: 'warn', text: `${name}: page shape (${pw.toFixed(2)} × ${ph.toFixed(2)}") doesn't match ${widthIn} × ${heightIn}" — it will be stretched or squashed` });
  }
  const acc = { fontsOk: new Set(), fontsMissing: new Set(), spaces: new Set(), images: [] };
  for (const pg of pages.slice(0, 20)) scanResources(doc, pg.node.Resources(), acc);
  if (acc.fontsMissing.size) out.push({ level: 'warn', text: `${name}: fonts not embedded (${[...acc.fontsMissing].slice(0, 4).join(', ')}) — the printer may swap them. Outline the text or embed fonts.` });
  else if (acc.fontsOk.size) out.push({ level: 'ok', text: `${name}: fonts embedded (${acc.fontsOk.size})` });
  const spots = [...acc.spaces].filter((s) => s.startsWith('Spot:'));
  const plain = [...acc.spaces].filter((s) => !s.startsWith('Spot:') && s !== 'Mask');
  if (plain.length) out.push({ level: 'info', text: `${name}: colors ${plain.join(', ')}` });
  if (spots.length) out.push({ level: spots.some((s) => /CutContour/i.test(s)) ? 'info' : 'warn', text: `${name}: spot colors — ${spots.map((s) => s.slice(6)).join(', ')}${spots.some((s) => !/CutContour|White/i.test(s)) ? ' (check they map to the right ink)' : ''}` });
  // Image resolution inside the PDF, assuming each image fills the page width (a rough upper bound)
  const big = acc.images.filter((im) => im.w > 50 && im.h > 50).sort((x, y) => x.w - y.w);
  if (big.length) {
    const scaleIn = widthIn || pw;
    const worst = big[0];
    const dpiFull = worst.w / scaleIn;
    const L = LIMITS[purpose] || LIMITS.press;
    if (dpiFull < L.low) out.push({ level: 'warn', text: `${name}: has a ${worst.w} × ${worst.h} px image — under ${Math.round(dpiFull)} dpi if it covers the page; check it isn't blurry` });
  }
  if (purpose === 'press' && Number(bleedIn) > 0) {
    const media = p0.getMediaBox(), trim = p0.getTrimBox();
    const hasBleed = p0.node.has(PDFName.of('BleedBox')) || media.width - trim.width > 1 || media.height - trim.height > 1;
    if (!hasBleed && widthIn && Math.abs(pw - widthIn) < 0.02) out.push({ level: 'warn', text: `${name}: no bleed in the file (page is exactly the finished size) — colors to the edge may show white slivers after cutting` });
  }
}

async function preflight(items, { purpose = 'press', bleedIn = 0 } = {}) {
  const out = [];
  for (const it of items || []) {
    const bytes = Buffer.from(it.base64 || '', 'base64');
    const name = it.name || 'file';
    const ext = String(it.ext || '').toLowerCase();
    if (ext === 'pdf' || ext === 'ai') { await checkPdf(out, name, bytes, { widthIn: it.widthIn, heightIn: it.heightIn, purpose, bleedIn }); continue; }
    const info = pngInfo(bytes) || jpegInfo(bytes);
    if (!info) { out.push({ level: 'warn', text: `${name}: couldn't read the image` }); continue; }
    dpiCheck(out, name, info.w, Number(it.widthIn) || 0, purpose);
    out.push({ level: 'info', text: `${name}: ${info.w} × ${info.h} px, ${info.color}` });
    if (purpose === 'press' && Number(bleedIn) > 0 && it.hasBleed === false) out.push({ level: 'warn', text: `${name}: no bleed — art should run ${bleedIn}" past the cut on every side` });
  }
  if (!out.some((r) => r.level === 'error' || r.level === 'warn')) out.unshift({ level: 'ok', text: 'Looks good to print.' });
  return out;
}

module.exports = { preflight, pngInfo, jpegInfo };
