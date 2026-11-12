import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import { createRequire } from 'module';
import { supplyWarnings } from '../src/lib/supplies.js';

const require = createRequire(import.meta.url);
const { parseConsumables } = require('../electron/lib/hpStatus');

test('non-HP and expired supplies from the shop 335\'s own report', () => {
  const st = parseConsumables(fs.readFileSync(new URL('./fixtures/hp/ConsumableConfigDyn.xml', import.meta.url), 'utf8'));
  const w = supplyWarnings(st);
  assert.ok(w.nonHp.includes('optimizer'));
  assert.ok(w.nonHp.includes('black ink'));
  assert.ok(w.nonHp.includes('optimizer head (slot 1)'));
  assert.equal(w.nonHp.filter((x) => / ink$/.test(x)).length, 4, 'K, C, M, Y refilled; LC, LM genuine');
  assert.deepEqual(w.expired, ['light cyan/light magenta head (slot 2)']);
  assert.equal(supplyWarnings({ ink: [{ code: 'K', state: 'ok' }], heads: [] }), null);
  assert.equal(supplyWarnings(null), null);
});
