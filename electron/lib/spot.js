// Spot color layers in a PDF (white ink, varnish…): a named Separation color the RIP turns into its own ink channel.
const { PDFName, PDFNumber, PDFOperator } = require('pdf-lib');

// alt = how it shows on screen / non-spot printers (light cyan by default, so a white layer is visible).
function spotColorSpace(doc, page, name, alt = [0.25, 0, 0, 0]) {
  const fn = doc.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: alt, N: 1 });
  const cs = doc.context.register(doc.context.obj([PDFName.of('Separation'), PDFName.of(name), PDFName.of('DeviceCMYK'), fn]));
  const { Resources } = page.node.normalizedEntries();
  let dict = Resources.lookup(PDFName.of('ColorSpace'));
  if (!dict) { dict = doc.context.obj({}); Resources.set(PDFName.of('ColorSpace'), dict); }
  const key = `CSSpot${String(name).replace(/[^A-Za-z0-9]/g, '') || 'X'}`;
  dict.set(PDFName.of(key), cs);
  return key;
}

const n = (v) => PDFNumber.of(Math.round(v * 1000) / 1000);

// Fill closed paths (already in PDF points) with the spot at 100%. Even-odd, so holes stay open.
function fillSpot(page, csKey, paths) {
  const ops = [PDFOperator.of('q'), PDFOperator.of('cs', [PDFName.of(csKey)]), PDFOperator.of('scn', [n(1)])];
  let any = false;
  for (const p of paths) {
    if (p.length < 3) continue;
    any = true;
    ops.push(PDFOperator.of('m', [n(p[0].x), n(p[0].y)]));
    for (let i = 1; i < p.length; i++) ops.push(PDFOperator.of('l', [n(p[i].x), n(p[i].y)]));
    ops.push(PDFOperator.of('h'));
  }
  if (!any) return;
  ops.push(PDFOperator.of('f*'), PDFOperator.of('Q'));
  page.pushOperators(...ops);
}

module.exports = { spotColorSpace, fillSpot };
