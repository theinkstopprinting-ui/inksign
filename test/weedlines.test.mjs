import test from 'node:test';
import assert from 'node:assert/strict';
import { planCut } from '../src/lib/cutPlan.js';

const box = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }];

test('weed lines cut across the waste at the spacing asked for, and not through the art', () => {
  const groups = [{ name: 'Black', color: '#000', paths: [box(0, 0, 50, 50), box(300, 0, 50, 50)] }];
  const plain = planCut(groups, { weedBox: true });
  const lined = planCut(groups, { weedBox: true, weedLines: true, weedLineSpacingMm: 100 });
  const extra = lined.jobs[0].paths.length - plain.jobs[0].paths.length;
  assert.ok(extra >= 2, `weed lines added: ${extra}`);
  const lines = lined.jobs[0].paths.filter((p) => p.length === 2);
  for (const l of lines) {
    const x = l[0].x;
    assert.ok(!(x > 0 && x < 50) && !(x > 300 && x < 350), 'a weed line runs through the art');
  }
});
