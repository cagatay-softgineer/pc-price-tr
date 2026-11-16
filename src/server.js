#!/usr/bin/env node
// Local web app: http://127.0.0.1:4870
//   GET /api/sites                      stores we search, and the ones we can't
//   GET /api/search?q=..&sites=a,b&fresh=1
//       Server-Sent Events: one `site` event per store as it finishes, then `done`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITES, UNSUPPORTED } from './sites.js';
import { searchAll } from './search.js';
import { closeBrowser, getContext } from './browser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4870);
const HOST = process.env.HOST || '127.0.0.1';

// Static files, plus the pure text helpers shared with the browser UI.
const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/lib/text.js': ['src/text.js', 'text/javascript; charset=utf-8'],
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function handleSearch(req, res, url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return sendJson(res, 400, { error: 'Missing q' });
  const siteIds = url.searchParams.get('sites')?.split(',').filter(Boolean);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const result = await searchAll(q, {
      siteIds,
      fresh: url.searchParams.get('fresh') === '1',
      onSite: (r) => send('site', r),
    });
    send('done', { query: q, offers: result.offers });
  } catch (e) {
    send('fail', { error: e.message });
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/sites') {
      return sendJson(res, 200, {
        sites: SITES.map(({ id, name, kind }) => ({ id, name, kind })),
        unsupported: UNSUPPORTED,
      });
    }
    if (url.pathname === '/api/search') return await handleSearch(req, res, url);
    const file = STATIC[url.pathname];
    if (file) {
      res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-cache' });
      return fs.createReadStream(path.join(ROOT, file[0])).pipe(res);
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`pc-price-tr running at http://${HOST}:${PORT}`);
  // Warm the browser so the first search doesn't pay Chrome's start-up.
  getContext().catch((e) => console.error(e.message));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await closeBrowser();
    process.exit(0);
  });
}
