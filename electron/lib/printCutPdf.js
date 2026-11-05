// Builds the print file for print & cut:
//  - placed images
//  - InkSign registration marks: four Graphtec-style L marks around each frame
//    (a sheet is one frame; a long roll job is split into frames / "segments")
//  - printed guide lines (alignment test targets)
//  - cut lines as a "CutContour" spot color (Flexi / RIP route)
//
// All sheet coordinates are mm with a top-left origin.
const { PDFDocument, PDFName, PDFNumber, PDFOperator, rgb } = require('pdf-lib');

const PT = 72 / 25.4;

// Outer corners of a frame's marks.
function markBox(sheetW, frame, margin) {
  return { x0: margin, y0: frame.y0 + margin, x1: sheetW - margin, y1: frame.y0 + frame.h - margin };
}

// Rectangles [x, y, w, h] for the four L marks of one frame, arms pointing inward.
function markRects(sheetW, sheetH, { margin = 10, size = 10, thickness = 0.5 } = {}, frame = { y0: 0, h: sheetH }) {
  const { x0, y0, x1, y1 } = markBox(sheetW, frame, margin);
  const s = size, t = thickness;
  return [
    [x0, y0, s, t], [x0, y0, t, s],                 // top-left
    [x1 - s, y0, s, t], [x1 - t, y0, t, s],         // top-right
    [x0, y1 - t, s, t], [x0, y1 - s, t, s],         // bottom-left (origin)
    [x1 - s, y1 - t, s, t], [x1 - t, y1 - s, t, s], // bottom-right
  ];
}

async function buildPrintCutPdf({
  sheetW, sheetH, images = [], cutPaths = [], printPaths = [], marks = null, frames = null,
  cutContour = false, title = 'InkSign print & cut', labels = [], white = null,
}) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('InkSign');
  const page = doc.addPage([sheetW * PT, sheetH * PT]);
  const H = sheetH * PT;

  // White ink (or any spot) layer under the art, for clear / colored media on printers with white
  if (white && white.paths && white.paths.length) {
    const { spotColorSpace, fillSpot } = require('./spot');
    const key = spotColorSpace(doc, page, white.spot || 'White');
    fillSpot(page, key, white.paths.map((p) => p.map(({ x, y }) => ({ x: x * PT, y: H - y * PT }))));
  }

  const cache = new Map();
  const { embedCmyk, drawCmyk } = require('./pdfCmyk');
  for (const im of images) {
    if (im.cmyk) {
      let c = cache.get(im.cmykKey);
      if (!c) { c = embedCmyk(doc, { w: im.cmyk.w, h: im.cmyk.h, bytes: Buffer.from(im.cmyk.base64, 'base64') }); cache.set(im.cmykKey, c); }
      drawCmyk(page, c, { x: im.x * PT, y: H - (im.y + im.h) * PT, width: im.w * PT, height: im.h * PT });
      continue;
    }
    let emb = cache.get(im.dataUrl);
    if (!emb) {
      const [head, b64] = im.dataUrl.split(',');
      const bytes = Buffer.from(b64, 'base64');
      emb = /png/i.test(head) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      cache.set(im.dataUrl, emb);
    }
    page.drawImage(emb, { x: im.x * PT, y: H - (im.y + im.h) * PT, width: im.w * PT, height: im.h * PT });
  }

  if (marks && marks.size > 0) {
    for (const f of frames && frames.length ? frames : [{ y0: 0, h: sheetH }]) {
      for (const [x, y, w, h] of markRects(sheetW, sheetH, marks, f)) {
        page.drawRectangle({ x: x * PT, y: H - (y + h) * PT, width: w * PT, height: h * PT, color: rgb(0, 0, 0) });
      }
    }
  }

  const n = (v) => PDFNumber.of(Math.round(v * 1000) / 1000);
  const strokeOps = (paths) => {
    const ops = [];
    for (const p of paths) {
      if (p.length < 2) continue;
      ops.push(PDFOperator.of('m', [n(p[0].x * PT), n(H - p[0].y * PT)]));
      for (let i = 1; i < p.length; i++) ops.push(PDFOperator.of('l', [n(p[i].x * PT), n(H - p[i].y * PT)]));
      ops.push(PDFOperator.of('S'));
    }
    return ops;
  };

  if (printPaths.length) {
    // Thin black guide lines (alignment test targets).
    page.pushOperators(PDFOperator.of('q'), PDFOperator.of('RG', [n(0), n(0), n(0)]), PDFOperator.of('w', [n(0.3 * PT)]), ...strokeOps(printPaths), PDFOperator.of('Q'));
  }

  if (labels.length) {
    const font = await doc.embedFont('Helvetica');
    for (const l of labels) {
      page.drawText(String(l.text), { x: l.x * PT, y: H - l.y * PT, size: (l.sizeMm || 3) * PT, font, color: rgb(0, 0, 0) });
    }
  }

  if (cutContour && cutPaths.length) {
    // Spot color "CutContour" (shown as 100% magenta) that Flexi/ONYX/Caldera read as the cut line.
    const fn = doc.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 });
    const cs = doc.context.register(doc.context.obj([PDFName.of('Separation'), PDFName.of('CutContour'), PDFName.of('DeviceCMYK'), fn]));
    const { Resources } = page.node.normalizedEntries();
    let csDict = Resources.lookup(PDFName.of('ColorSpace'));
    if (!csDict) { csDict = doc.context.obj({}); Resources.set(PDFName.of('ColorSpace'), csDict); }
    csDict.set(PDFName.of('CSCut'), cs);
    page.pushOperators(
      PDFOperator.of('q'), PDFOperator.of('CS', [PDFName.of('CSCut')]), PDFOperator.of('SCN', [PDFNumber.of(1)]), PDFOperator.of('w', [n(0.25)]),
      ...strokeOps(cutPaths), PDFOperator.of('Q'),
    );
  }
  return Buffer.from(await doc.save());
}

// Sheet coordinates → cutter coordinates for one frame: measured from the outer corner of
// the frame's bottom-left mark, X along the sheet width, Y up the sheet.
// Then the cutter's own correction: rotate within the mark box, and nudge by the offset
// found with the alignment test.
function toMarkOrigin(paths, sheetW, frame, margin, cal = {}) {
  const { x0, y0, x1, y1 } = markBox(sheetW, frame, margin);
  const W = x1 - x0, Hh = y1 - y0;
  const rot = ((Number(cal.rotate) || 0) % 360 + 360) % 360;
  const dx = Number(cal.offsetXmm) || 0, dy = Number(cal.offsetYmm) || 0;
  return paths.map((p) => p.map(({ x, y }) => {
    let u = x - x0, v = y1 - y;
    if (rot === 90) [u, v] = [v, W - u];
    else if (rot === 180) [u, v] = [W - u, Hh - v];
    else if (rot === 270) [u, v] = [Hh - v, u];
    return { x: u + dx, y: v + dy };
  }));
}

// Distance between the outer corners of a frame's marks (what the cutter panel asks for).
function markDistances(sheetW, frame, margin) {
  const { x0, y0, x1, y1 } = markBox(sheetW, frame, margin);
  return { dx: x1 - x0, dy: y1 - y0 };
}

module.exports = { buildPrintCutPdf, markRects, markBox, markDistances, toMarkOrigin };
