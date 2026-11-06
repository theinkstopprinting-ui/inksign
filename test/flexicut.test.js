// Cutter commands matched byte for byte to what Flexi sent the shop's Titan 3 and Graphtec (5 Nov 2026)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../electron/lib/cutterLang');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'flexi', n), 'latin1');
const UPM = 40;
// The two cut shapes, read back from Flexi's Titan job (absolute points in 1/1016")
function shapes() {
  const titan = fx('titan-printcut-6x4.cap');
  return titan.split('PU;').filter((s) => /PD\d/.test(s)).map((seg) => [...seg.matchAll(/P[UD](\d+),(\d+)/g)].map((m) => ({ x: Number(m[1]) / UPM, y: Number(m[2]) / UPM })));
}

test('Titan 3: InkSign sends exactly what Flexi sent — marks (MK), cut, page feed', () => {
  const out = L.registeredJob(shapes(), { language: 'hpgl', hpglStyle: 'titan', unitsPerMm: UPM, keepOrigin: true, overcutMm: 0,
    regCommands: 'MK0,0,{DX},{DY};', markDxMm: 6543 / UPM, markDyMm: 8575 / UPM });
  assert.equal(out, fx('titan-printcut-6x4.cap'));
});

test('Graphtec CE6000: InkSign sends exactly what Flexi sent — force, speed, relative moves, feed', () => {
  const p = shapes();
  const maxX = Math.max(...p.flat().map((q) => q.x));
  const out = L.toHPGL(p, { hpglStyle: 'graphtec', unitsPerMm: UPM, keepOrigin: true, overcutMm: 0, force: 35, speed: 50, advanceMm: 4064 / UPM - maxX });
  assert.equal(out, fx('graphtec-printcut-6x4.cap'));
});

test('standard HP-GL is unchanged for other cutters', () => {
  const out = L.toHPGL([[{ x: 0, y: 0 }, { x: 10, y: 0 }]], { unitsPerMm: 40, overcutMm: 0, advanceMm: 0 });
  assert.equal(out, 'IN;PA;PU0,0;PD400,0;PU0,0;');
});
