import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache, mapLimit } from '../src/pool.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('mapLimit never runs more than `limit` tasks at once and keeps the input order', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await tick();
    running--;
    return n * 10;
  });
  assert.equal(peak, 3);
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70]);
});

test('mapLimit starts nothing new once the signal is aborted; skipped items come back as null', async () => {
  const ac = new AbortController();
  const started = [];
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    started.push(n);
    if (n === 2) ac.abort();
    await tick();
    return n;
  }, ac.signal);
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(out, [1, 2, null, null, null]);
});

test('mapLimit with an already aborted signal runs nothing', async () => {
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  assert.deepEqual(await mapLimit([1, 2], 4, async () => calls++, ac.signal), [null, null]);
  assert.equal(calls, 0);
});

test('cache entries expire after the ttl', () => {
  let t = 0;
  const c = createCache({ ttlMs: 100, max: 10, now: () => t });
  c.set('a', 1);
  t = 99;
  assert.equal(c.get('a'), 1);
  t = 101;
  assert.equal(c.get('a'), undefined);
});

test('the cache holds at most `max` entries, dropping the oldest first', () => {
  const c = createCache({ ttlMs: 1000, max: 2, now: () => 0 });
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 3);
  assert.equal(c.size, 2);
});
