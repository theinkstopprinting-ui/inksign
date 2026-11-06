// Gets customer artwork ready to edit in the Design workspace:
//  - EPS and older Illustrator (.ai saved without "PDF compatible") -> PDF, via Ghostscript
//  - text turned into outlines (Ghostscript pdfwrite -dNoOutputFonts), so lettering opens as shapes
//    even when the font isn't installed — the same thing Flexi does on import
//  - CutContour / Thru-cut spot colors re-tinted to a marker color (#FE01FE) so the editor can tell
//    cut lines from art after pdf.js converts every color to RGB
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef } = require('pdf-lib');
const { CUT_NAMES } = require('./pdfCutLines');

const CUT_MARK_RGB = [254 / 255, 1 / 255, 254 / 255];

const isPdf = (buf) => buf.subarray(0, 1024).toString('latin1').includes('%PDF');
const isPs = (buf) => {
  const head = buf.subarray(0, 64);
  if (head[0] === 0xc5 && head[1] === 0xd0 && head[2] === 0xd3 && head[3] === 0xc6) return true; // DOS EPS binary header
  return head.toString('latin1').startsWith('%!');
};

// DOS EPS files wrap the PostScript with a preview; take the PostScript part
function epsBody(buf) {
  if (buf[0] === 0xc5 && buf[1] === 0xd0 && buf[2] === 0xd3 && buf[3] === 0xc6) {
    const off = buf.readUInt32LE(4), len = buf.readUInt32LE(8);
    return buf.subarray(off, off + len);
  }
  return buf;
}

// Re-tint the cut separations: the tint transform becomes "any tint -> marker RGB"
async function markCutSeparations(pdfBytes) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const ctx = doc.context;
  let n = 0;
  const seen = new Set();
  const fix = (arr) => {
    if (!(arr instanceof PDFArray) || String(arr.get(0)) !== '/Separation') return false;
    const name = String(arr.get(1)).replace(/^\//, '').replace(/#20/g, ' ');
    if (!CUT_NAMES.test(name)) return false;
    const fn = ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: CUT_MARK_RGB, C1: CUT_MARK_RGB, N: 1 });
    arr.set(2, PDFName.of('DeviceRGB'));
    arr.set(3, fn);
    return true;
  };
  const walkRes = (res) => {
    if (!(res instanceof PDFDict)) return;
    const cs = ctx.lookup(res.get(PDFName.of('ColorSpace')));
    if (cs instanceof PDFDict) for (const [, v] of cs.entries()) if (fix(ctx.lookup(v))) n++;
    const xo = ctx.lookup(res.get(PDFName.of('XObject')));
    if (xo instanceof PDFDict) for (const [, v] of xo.entries()) {
      if (!(v instanceof PDFRef) || seen.has(v.toString())) continue;
      seen.add(v.toString());
      const st = ctx.lookup(v);
      if (st && st.dict) walkRes(ctx.lookup(st.dict.get(PDFName.of('Resources'))));
    }
  };
  for (const page of doc.getPages()) walkRes(page.node.Resources());
  if (!n) return { pdf: Buffer.from(pdfBytes), cutSpaces: 0 };
  return { pdf: Buffer.from(await doc.save({ useObjectStreams: false })), cutSpaces: n };
}

/**
 * buf (any of pdf / ai / eps) -> { pdf: Buffer, notes: [] }
 * gs = the ghostscript module (injected so tests can run it in node)
 */
async function prepareArt(buf, ext, gs, { outlineText = true } = {}) {
  const notes = [];
  let pdf;
  if (isPdf(buf) && ext !== 'eps') pdf = buf;
  else if (isPs(buf) || ext === 'eps' || ext === 'ai') {
    const ps = epsBody(buf);
    const r = await gs.run(['-sDEVICE=pdfwrite', '-dEPSCrop', '-dAutoRotatePages=/None', '-dNoOutputFonts', '-sOutputFile=/out/art.pdf', '/in/art.eps'],
      { files: { '/in/art.eps': ps }, outputs: ['/out/art.pdf'] });
    pdf = r.out['/out/art.pdf'];
    if (r.code !== 0 || !pdf || pdf.length < 100) throw new Error(`Couldn't read this ${ext.toUpperCase()} file — try saving it as PDF from Illustrator.`);
    notes.push(`${ext.toUpperCase()} converted`);
    outlineText = false; // already done
  } else throw new Error('This file is not a PDF, AI or EPS file.');

  if (outlineText) {
    try {
      const r = await gs.run(['-sDEVICE=pdfwrite', '-dAutoRotatePages=/None', '-dNoOutputFonts', '-sOutputFile=/out/art.pdf', '/in/art.pdf'],
        { files: { '/in/art.pdf': pdf }, outputs: ['/out/art.pdf'] });
      const out = r.out['/out/art.pdf'];
      if (r.code === 0 && out && out.length > 100) pdf = out;
    } catch { notes.push('text kept as-is'); }
  }
  try {
    const m = await markCutSeparations(pdf);
    pdf = m.pdf;
    if (m.cutSpaces) notes.push('cut lines found');
  } catch { /* leave colors */ }
  return { pdf: Buffer.from(pdf), notes };
}

module.exports = { prepareArt, markCutSeparations, isPdf, isPs, epsBody, CUT_MARK_HEX: '#fe01fe' };
