import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linearScale, niceTicks, timeTicks, linePath, stepPath } from '../src/chart.js';

test('linearScale maps the domain onto the range, and a flat domain onto the middle', () => {
  const s = linearScale([10, 20], [0, 100]);
  assert.equal(s(10), 0);
  assert.equal(s(15), 50);
  assert.equal(s(20), 100);
  assert.equal(linearScale([5, 5], [0, 100])(5), 50);
});

test('niceTicks gives round values that cover the data', () => {
  const t = niceTicks(7299, 9143, 4);
  assert.ok(t[0] <= 7299 && t.at(-1) >= 9143, `covers: ${t}`);
  assert.ok(t.length >= 3 && t.length <= 6);
  const step = t[1] - t[0];
  assert.ok(t.every((v, i) => i === 0 || Math.abs(v - t[i - 1] - step) < 1e-9), 'even steps');
  assert.ok([1, 2, 2.5, 5].includes(step / 10 ** Math.floor(Math.log10(step))), `round step: ${step}`);
});

test('niceTicks widens a single value so there is something to draw', () => {
  const t = niceTicks(1000, 1000, 4);
  assert.ok(t.length >= 2 && t[0] < 1000 && t.at(-1) > 1000);
});

test('timeTicks picks whole days for a multi-day range and stays within the range', () => {
  const day = 86400_000;
  const t0 = Date.UTC(2026, 10, 1, 8);
  const ticks = timeTicks(t0, t0 + 9 * day, 5);
  assert.ok(ticks.length >= 2 && ticks.length <= 6);
  assert.ok(ticks.every((t) => t >= t0 && t <= t0 + 9 * day));
  assert.ok(ticks.every((t) => new Date(t).getHours() === 0 && new Date(t).getMinutes() === 0));
  assert.ok(ticks.every((t, i) => i === 0 || t > ticks[i - 1]));
});

test('timeTicks on a range shorter than a day still returns ticks', () => {
  const t0 = Date.UTC(2026, 10, 1, 8);
  assert.ok(timeTicks(t0, t0 + 3600_000, 4).length >= 2);
});

test('linePath joins points; stepPath holds each price until the next change', () => {
  assert.equal(linePath([[0, 10], [5, 20]]), 'M0,10L5,20');
  assert.equal(stepPath([[0, 10], [5, 20]], 8), 'M0,10H5V20H8');
  assert.equal(linePath([]), '');
  assert.equal(stepPath([[0, 10]], 0), 'M0,10H0');
});
