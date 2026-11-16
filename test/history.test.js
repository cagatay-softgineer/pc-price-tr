import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHistory, queryKey } from '../src/history.js';

const H = 3600_000;
const T0 = Date.UTC(2026, 10, 1);
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hist-')), 'history.json');
const offer = (price, extra = {}) => ({ site: 'a', title: 'RTX 4060', url: 'https://a.test/p1', price, ...extra });

function clock(start = T0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

test('queryKey ignores case and extra spaces', () => {
  assert.equal(queryKey('  RTX   4060  -Ti '), 'rtx 4060 -ti');
});

test('an offer keeps a point only when its price changes, or after a day of silence', () => {
  const now = clock();
  const h = createHistory({ file: tmpFile(), now });
  h.record('rtx 4060', [offer(100)]);
  now.advance(2 * H);
  h.record('rtx 4060', [offer(100)]);
  assert.equal(h.offer('https://a.test/p1').points.length, 1, 'same price, same day: no new point');
  now.advance(2 * H);
  h.record('rtx 4060', [offer(90)]);
  assert.deepEqual(h.offer('https://a.test/p1').points.map((p) => p[1]), [100, 90]);
  now.advance(25 * H);
  h.record('rtx 4060', [offer(90)]);
  assert.equal(h.offer('https://a.test/p1').points.length, 3, 'a heartbeat point after 24 h shows it is still listed');
});

test('an offer remembers when it was last seen, so the line can reach today', () => {
  const now = clock();
  const h = createHistory({ file: tmpFile(), now });
  h.record('q', [offer(100)]);
  now.advance(5 * H);
  h.record('q', [offer(100)]);
  assert.equal(h.offer('https://a.test/p1').seen, T0 + 5 * H);
});

test('the query series holds the lowest and median price of the offers that count', () => {
  const now = clock();
  const h = createHistory({ file: tmpFile(), now });
  h.record('RTX 4060', [
    offer(100, { url: 'https://a.test/1' }),
    offer(300, { url: 'https://a.test/2' }),
    offer(200, { url: 'https://a.test/3' }),
    offer(5, { url: 'https://a.test/4', flag: 'accessory' }),
  ]);
  const [pt] = h.query('rtx   4060');
  assert.deepEqual({ min: pt.min, median: pt.median, n: pt.n }, { min: 100, median: 200, n: 3 });
});

test('searches less than half an hour apart share one query point; later ones add a point', () => {
  const now = clock();
  const h = createHistory({ file: tmpFile(), now });
  h.record('q', [offer(100)]);
  now.advance(10 * 60_000);
  h.record('q', [offer(90)]);
  assert.deepEqual(h.query('q').map((p) => p.min), [90]);
  now.advance(H);
  h.record('q', [offer(80)]);
  assert.deepEqual(h.query('q').map((p) => p.min), [90, 80]);
});

test('searches over different sets of stores never share a query series', () => {
  const now = clock();
  const h = createHistory({ file: tmpFile(), now });
  h.record('q', [offer(100)], { scope: 'a,b' });
  now.advance(H);
  h.record('q', [offer(300)], { scope: 'a' });
  assert.deepEqual(h.query('q', 'a,b').map((p) => p.min), [100]);
  assert.deepEqual(h.query('q', 'a').map((p) => p.min), [300]);
  assert.deepEqual(h.query('q'), [], 'no scope means the all-stores series, which is still empty');
  assert.equal(h.offer('https://a.test/p1').points.length, 2, 'offers are per URL, whatever the scope');
});

test('a search with no usable offers adds no query point', () => {
  const h = createHistory({ file: tmpFile(), now: clock() });
  h.record('q', []);
  h.record('q', [offer(5, { flag: 'outlier' })]);
  assert.deepEqual(h.query('q'), []);
});

test('history survives a restart', async () => {
  const file = tmpFile();
  const a = createHistory({ file, now: clock() });
  a.record('q', [offer(100)]);
  await a.save();
  const b = createHistory({ file, now: clock() });
  assert.equal(b.query('q')[0].min, 100);
  assert.equal(b.offer('https://a.test/p1').title, 'RTX 4060');
});

test('a missing or corrupt file starts empty instead of crashing', () => {
  const file = tmpFile();
  assert.deepEqual(createHistory({ file }).query('q'), []);
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(createHistory({ file }).query('q'), []);
});

test('offers not seen for the retention period are forgotten', () => {
  const now = clock();
  const h = createHistory({ file: tmpFile(), now, keepMs: 10 * 24 * H });
  h.record('q', [offer(100)]);
  now.advance(11 * 24 * H);
  h.record('other', [offer(50, { url: 'https://a.test/p2' })]);
  assert.equal(h.offer('https://a.test/p1'), null);
  assert.ok(h.offer('https://a.test/p2'));
});

test('a series is capped at maxPoints, newest kept', () => {
  const now = clock();
  const h = createHistory({ file: tmpFile(), now, maxPoints: 5 });
  for (let i = 0; i < 12; i++) {
    h.record('q', [offer(100 + i)]);
    now.advance(H);
  }
  assert.equal(h.offer('https://a.test/p1').points.length, 5);
  assert.equal(h.query('q').length, 5);
  assert.equal(h.query('q').at(-1).min, 111);
});

test('each query point names the cheapest offer that counted', () => {
  const h = createHistory({ file: tmpFile(), now: clock() });
  h.record('q', [
    offer(200, { url: 'https://a.test/1', site: 'a', title: 'dear' }),
    offer(100, { url: 'https://b.test/2', site: 'b', title: 'cheap' }),
    offer(50, { url: 'https://b.test/3', site: 'b', title: 'junk', flag: 'accessory' }),
  ]);
  assert.deepEqual(h.query('q')[0].best, { site: 'b', title: 'cheap' });
});
