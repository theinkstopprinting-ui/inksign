const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { preflight, pngInfo } = require('../electron/lib/preflight');
const { embedCmyk, drawCmyk } = require('../electron/lib/pdfCmyk');

// 600x400 px RGBA PNG header is all preflight needs for size; build a real tiny one via pdf-lib-free bytes
function fakePng(w, h, colorType = 6) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = colorType;
  return b;
}

test('image resolution at print size', async () => {
  assert.deepStrictEqual(pngInfo(fakePng(600, 400)), { w: 600, h: 400, color: 'RGB + alpha', alpha: true });
  const lowBanner = await preflight([{ name: 'logo.png', ext: 'png', base64: fakePng(600, 400).toString('base64'), widthIn: 48 }], { purpose: 'wide' });
  assert.ok(lowBanner.some((r) => r.level === 'error' && /13 dpi/.test(r.text)), JSON.stringify(lowBanner));
  const okSticker = await preflight([{ name: 's.png', ext: 'png', base64: fakePng(900, 900).toString('base64'), widthIn: 3 }], { purpose: 'printcut' });
  assert.strictEqual(okSticker[0].text, 'Looks good to print.');
});

test('PDF: fonts not embedded, page shape, no bleed, spot colors', async () => {
  const d = await PDFDocument.create();
  const pg = d.addPage([3.5 * 72, 2 * 72]);
  pg.drawText('HELLO', { font: await d.embedFont(StandardFonts.Helvetica), size: 12, x: 10, y: 10 });
  const bytes = Buffer.from(await d.save());
  const r = await preflight([{ name: 'card.pdf', ext: 'pdf', base64: bytes.toString('base64'), widthIn: 3.5, heightIn: 2 }], { purpose: 'press', bleedIn: 0.125 });
  assert.ok(r.some((x) => x.level === 'warn' && /fonts not embedded \(Helvetica\)/.test(x.text)), JSON.stringify(r));
  assert.ok(r.some((x) => x.level === 'warn' && /no bleed/.test(x.text)));
  const r2 = await preflight([{ name: 'card.pdf', ext: 'pdf', base64: bytes.toString('base64'), widthIn: 4, heightIn: 4 }], { purpose: 'press' });
  assert.ok(r2.some((x) => /stretched or squashed/.test(x.text)));
  // CutContour spot from our own print & cut PDF is reported as info
  const { buildPrintCutPdf } = require('../electron/lib/printCutPdf');
  const pc = await buildPrintCutPdf({ sheetW: 100, sheetH: 100, cutPaths: [[{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }, { x: 10, y: 10 }]], cutContour: true });
  const r3 = await preflight([{ name: 'pc.pdf', ext: 'pdf', base64: pc.toString('base64') }], { purpose: 'printcut' });
  assert.ok(r3.some((x) => /spot colors — CutContour/.test(x.text)), JSON.stringify(r3));
});

test('CMYK images embed and render with the right color', async () => {
  const d = await PDFDocument.create();
  const pg = d.addPage([72, 72]);
  const red = Buffer.alloc(4 * 4); for (let i = 0; i < 4; i++) red.set([0, 255, 255, 0], i * 4);
  drawCmyk(pg, embedCmyk(d, { w: 2, h: 2, bytes: red }), { x: 0, y: 0, width: 72, height: 72 });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-')), 'c.pdf');
  fs.writeFileSync(file, await d.save());
  const r = await preflight([{ name: 'c.pdf', ext: 'pdf', base64: fs.readFileSync(file).toString('base64') }]);
  assert.ok(r.some((x) => /colors CMYK/.test(x.text)), JSON.stringify(r));
  try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); } catch { return; }
  execFileSync('pdftoppm', ['-r', '10', '-singlefile', file, file.replace('.pdf', '')]);
  const ppm = fs.readFileSync(file.replace('.pdf', '.ppm'));
  const px = ppm.subarray(ppm.length - 3);
  assert.ok(px[0] > 200 && px[1] < 80 && px[2] < 80, `rendered ${[...px]}`);
});

test('white ink layer is a fillable spot color under the art', async () => {
  const { buildPrintCutPdf } = require('../electron/lib/printCutPdf');
  const sq = [{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 40 }, { x: 10, y: 40 }, { x: 10, y: 10 }];
  const pdf = await buildPrintCutPdf({ sheetW: 100, sheetH: 100, white: { spot: 'White', paths: [sq] } });
  const r = await preflight([{ name: 'w.pdf', ext: 'pdf', base64: pdf.toString('base64') }], { purpose: 'printcut' });
  assert.ok(r.some((x) => /spot colors — White/.test(x.text)), JSON.stringify(r));
  const zlib = require('zlib');
  const s = pdf.toString('latin1');
  let content = '';
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) { try { content += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { content += m[1]; } }
  assert.ok(/\/CSSpotWhite cs\s+1 scn/.test(content) && /f\*/.test(content), 'filled with the spot');
});
