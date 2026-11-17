// Poll size: the questions asked of the cutter and how its answer becomes a media size
const test = require('node:test');
const assert = require('node:assert/strict');
const { sizeQueries, parseSizeReplies } = require('../electron/lib/cutterLang');

test('HP-GL cutters are asked OH; and the hard-clip answer becomes mm (40 units per mm)', () => {
  assert.deepEqual(sizeQueries({ language: 'hpgl' }), ['OH;']);
  const r = parseSizeReplies(['0,0,2000000,23368\r'], { language: 'hpgl', unitsPerMm: 40 });
  assert.equal(r.acrossMm, 584.2);   // 23 in between the pinch rollers
  assert.equal(r.alongMm, 50000);    // a roll
});

test('GP-GL cutters are asked for the two corners', () => {
  assert.deepEqual(sizeQueries({ language: 'gpgl' }), ['[\x03', 'U\x03']);
  const r = parseSizeReplies(['-100,-50\x03', '15000,5792\x03'], { language: 'gpgl' });
  assert.equal(r.acrossMm, 584.2);
  assert.equal(r.alongMm, 1510);
});

test('no answer and nonsense answers are explained', () => {
  assert.throws(() => parseSizeReplies([''], {}), /did not answer/);
  assert.throws(() => parseSizeReplies(['CE6000\r'], {}), /not a size/);
  assert.throws(() => parseSizeReplies(['0,0,100,100\r'], { unitsPerMm: 40 }), /not a usable width/);
});

test('the Graphtec answers in 0.1 mm steps: the size matches its CUT AREA screen', () => {
  const r = parseSizeReplies(['0,0,50000,2976\r'], { language: 'hpgl', hpglStyle: 'graphtec', unitsPerMm: 40 });
  assert.ok(Math.abs(r.alongMm / 25.4 - 196.85) < 0.01);
  assert.ok(Math.abs(r.acrossMm / 25.4 - 11.717) < 0.01);
});
