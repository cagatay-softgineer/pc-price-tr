import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/server.js';

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

test('a search without q is a 400 and unknown paths are 404', async () => {
  assert.equal((await get('/api/search')).status, 400);
  assert.equal((await get('/nope')).status, 404);
});
