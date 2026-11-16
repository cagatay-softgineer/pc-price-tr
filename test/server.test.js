import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/server.js';
import { SITES } from '../src/sites.js';

const [A, B] = [SITES[0].id, SITES[1].id].sort();

let server;
let port;

// A search that never opens a browser.
const fakeSearch = async (query, { onSite }) => {
  const r = { site: 'x', siteName: 'X', status: 'ok', offers: [], found: 0, ms: 1 };
  onSite?.(r);
  return { query, results: [r], offers: [{ site: 'x', title: 'part', price: 1, url: 'https://x.test/p' }] };
};

before(async () => {
  server = createServer({ searchAll: fakeSearch });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => new Promise((resolve) => server.close(resolve)));

/** Raw request, so tests can set Host/Origin and send paths fetch() would normalise. */
function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a malformed request path is answered with 400 and does not kill the server', async () => {
  assert.equal((await get('//')).status, 400);
  assert.equal((await get('/api/sites')).status, 200, 'server still alive');
});

test('requests whose Host is not this machine are refused (DNS rebinding)', async () => {
  assert.equal((await get('/api/sites', { host: 'evil.example' })).status, 403);
  assert.equal((await get('/api/sites', { host: `localhost:${port}` })).status, 200);
  assert.equal((await get('/api/sites', { host: `127.0.0.1:${port + 1}` })).status, 403);
});

test('a foreign Origin cannot start a search', async () => {
  assert.equal((await get('/api/search?q=rtx', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await get('/api/search?q=rtx', { origin: `http://127.0.0.1:${port}` })).status, 200);
});

test('search streams one event per store and then done', async () => {
  const { status, body } = await get('/api/search?q=rtx+4060');
  assert.equal(status, 200);
  assert.match(body, /event: site\n/);
  assert.match(body, /event: done\n/);
});

test('the shared browser modules are served', async () => {
  for (const p of ['/lib/text.js', '/lib/chart.js', '/lib/watch.js']) assert.equal((await get(p)).status, 200, p);
});

test('a search without q is a 400 and unknown paths are 404', async () => {
  assert.equal((await get('/api/search')).status, 400);
  assert.equal((await get('/nope')).status, 404);
});

test('a finished search is recorded, and /api/history serves the series back', async () => {
  const recorded = [];
  const asked = [];
  const history = {
    record: (q, offers, opts) => recorded.push({ q, offers, opts }),
    query: (q, scope) => (asked.push([q.toLowerCase(), scope]), q.toLowerCase() === 'rtx 4060' ? [{ t: 1, min: 1, median: 1, n: 1 }] : []),
    offer: (url) => (url === 'https://x.test/p' ? { site: 'x', title: 'part', seen: 2, points: [[1, 1]] } : null),
    siteCounts: () => ({}),
    priceBefore: () => null,
    save: async () => {},
  };
  const s = createServer({ searchAll: fakeSearch, history });
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const p = s.address().port;
  const call = (path) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: p, path, headers: { host: `127.0.0.1:${p}` } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
  try {
    await call('/api/search?q=rtx+4060');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].q, 'rtx 4060');
    assert.equal(recorded[0].opts.scope, 'all', 'no store filter means every store');
    await call(`/api/search?q=rtx+4060&sites=${B},${A}`);
    assert.equal(recorded[1].opts.scope, `${A},${B}`, 'a store selection is its own series, sorted so the order does not matter');
    await call(`/api/history?q=rtx+4060&sites=${A},${B}`);
    assert.deepEqual(asked.at(-1), ['rtx 4060', `${A},${B}`], 'history is read with the same scope');

    const q = JSON.parse((await call('/api/history?q=RTX+4060')).body);
    assert.equal(q.points.length, 1);
    const o = JSON.parse((await call(`/api/history?url=${encodeURIComponent('https://x.test/p')}`)).body);
    assert.deepEqual(o.points, [[1, 1]]);
    assert.equal((await call('/api/history?url=https%3A%2F%2Fnone.test')).status, 404);
    assert.equal((await call('/api/history')).status, 400);
    assert.deepEqual(recorded[0].opts.results.map((r) => [r.site, r.status]), [['x', 'ok']], 'each store result reaches the history');
    assert.equal(recorded[0].opts.queryPoint, true);
    await call('/api/search?q=rtx+4060&deep=1');
    assert.equal(recorded.at(-1).opts.queryPoint, false, 'a page-2 search adds no point to the query line');
  } finally {
    await new Promise((resolve) => s.close(resolve));
  }
});

/** Start a server for one test and give back a raw GET that resolves with the body. */
async function serve(opts) {
  const s = createServer(opts);
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const p = s.address().port;
  const call = (path) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: p, path, headers: { host: `127.0.0.1:${p}` } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
  return { s, p, call, close: () => new Promise((resolve) => s.close(resolve)) };
}

const events = (body, name) =>
  [...body.matchAll(new RegExp(`event: ${name}\\ndata: (.*)\\n`, 'g'))].map((m) => JSON.parse(m[1]));

test('closing the page cancels the search and nothing partial is recorded', async () => {
  let signal;
  const recorded = [];
  const slowSearch = (q, opts) => {
    signal = opts.signal;
    return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve({ query: q, results: [], offers: [] })));
  };
  const history = { record: (...a) => recorded.push(a), save: async () => {}, siteCounts: () => ({}), priceBefore: () => null };
  const { p, close } = await serve({ searchAll: slowSearch, history });
  try {
    await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: p, path: '/api/search?q=rtx', headers: { host: `127.0.0.1:${p}` } }, () => {
        // The stream is open (headers arrive before any store finishes): now leave.
        req.destroy();
        resolve();
      });
      req.on('error', () => {});
    });
    for (let i = 0; i < 50 && !signal?.aborted; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(signal?.aborted, true, 'the search was told to stop');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(recorded.length, 0);
  } finally {
    await close();
  }
});

test('a store that finds nothing where it used to find offers gets a warning', async () => {
  const search = async (q, { onSite }) => {
    const rs = [
      { site: 'a', siteName: 'A', status: 'ok', found: 0, offers: [] },
      { site: 'b', siteName: 'B', status: 'ok', found: 0, offers: [] },
    ];
    rs.forEach((r) => onSite(r));
    return { query: q, results: rs, offers: [] };
  };
  const history = { record() {}, save: async () => {}, siteCounts: () => ({ a: 7, b: 0 }), priceBefore: () => null };
  const { call, close } = await serve({ searchAll: search, history });
  try {
    const [a, b] = events(await call('/api/search?q=rtx'), 'site');
    assert.match(a.warning, /7 offers/);
    assert.equal(b.warning, undefined, 'it found nothing before either');
  } finally {
    await close();
  }
});

test('offers carry their previous price when it changed', async () => {
  const o = { site: 'a', title: 't', price: 90, url: 'https://a.test/1' };
  const search = async (q, { onSite }) => {
    const r = { site: 'a', siteName: 'A', status: 'ok', found: 1, offers: [o] };
    onSite(r);
    return { query: q, results: [r], offers: [o] };
  };
  const history = {
    record() {},
    save: async () => {},
    siteCounts: () => ({}),
    priceBefore: (url, price) => (url === o.url && price === 90 ? { price: 100, t: 5 } : null),
  };
  const { call, close } = await serve({ searchAll: search, history });
  try {
    const body = await call('/api/search?q=rtx');
    assert.deepEqual(events(body, 'site')[0].offers[0].prev, { price: 100, t: 5 });
    assert.deepEqual(events(body, 'done')[0].offers[0].prev, { price: 100, t: 5 });
  } finally {
    await close();
  }
});
