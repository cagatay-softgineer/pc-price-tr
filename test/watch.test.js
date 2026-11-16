import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastChange } from '../src/watch.js';

const pt = (t, min, extra = {}) => ({ t, min, median: min, n: 3, ...extra });

test('no points, or one point, means no change yet', () => {
  assert.equal(lastChange([]), null);
  assert.deepEqual(lastChange([pt(1, 100)]), { now: 100, t: 1, before: null, diff: 0, unsure: false });
});

test('the change is against the last point with a different lowest price', () => {
  const c = lastChange([pt(1, 120), pt(2, 100), pt(3, 100), pt(4, 90)]);
  assert.deepEqual(c, { now: 90, t: 4, before: { price: 100, t: 3 }, diff: -10, unsure: false });
  const flat = lastChange([pt(1, 120), pt(2, 100), pt(3, 100)]);
  assert.deepEqual(flat.before, { price: 120, t: 1 }, 'unchanged since the drop: still reports the drop');
  assert.equal(flat.diff, -20);
});

test('a change is unsure when a store was missing from either point', () => {
  assert.equal(lastChange([pt(1, 100), pt(2, 130, { failed: ['vatan'] })]).unsure, true);
  assert.equal(lastChange([pt(1, 100, { failed: ['n11'] }), pt(2, 90)]).unsure, true);
  assert.equal(lastChange([pt(1, 100), pt(2, 90)]).unsure, false);
});
