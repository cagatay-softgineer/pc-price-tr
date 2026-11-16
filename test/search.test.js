import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchAll } from '../src/search.js';
import { SITES } from '../src/sites.js';

const tick = () => new Promise((r) => setTimeout(r, 5));
let n = 0;
const uniqueQuery = () => `rtx 4060 q${++n}`; // the module cache is shared between tests

/** A fake scraper that never opens Chrome: one matching item per store. */
function fakeScrape(log = {}) {
  log.running = 0;
  log.peak = 0;
  log.calls = [];
  return async (site, q, opts) => {
    log.calls.push({ site: site.id, opts });
    log.running++;
    log.peak = Math.max(log.peak, log.running);
    await tick();
    log.running--;
    return { status: 'ok', ms: 1, items: [{ title: `${q} ${site.id}`, price: '1.000 TL', url: `https://${site.id}.test/p` }] };
  };
}

test('searchAll keeps at most `tabs` stores open at once', async () => {
  const log = {};
  const r = await searchAll(uniqueQuery(), { tabs: 3, scrape: fakeScrape(log) });
  assert.equal(log.peak, 3);
  assert.equal(r.results.length, SITES.length);
  assert.equal(r.offers.length, SITES.length);
});

test('after the signal aborts, no more stores are opened or reported', async () => {
  const ac = new AbortController();
  const log = {};
  const reported = [];
  const r = await searchAll(uniqueQuery(), {
    tabs: 2,
    signal: ac.signal,
    scrape: fakeScrape(log),
    onSite: (x) => {
      reported.push(x.site);
      ac.abort();
    },
  });
  assert.ok(log.calls.length <= 3, `opened ${log.calls.length} stores`);
  assert.equal(reported.length, 1);
  assert.ok(r.results.length < SITES.length);
  assert.ok(log.calls.every((c) => c.opts.signal === ac.signal), 'the scraper gets the signal to close its tab');
});

test('a deep search asks for more pages and is cached apart from a normal one', async () => {
  const q = uniqueQuery();
  const log = {};
  const scrape = fakeScrape(log);
  const sites = [SITES[0].id];
  await searchAll(q, { siteIds: sites, scrape });
  await searchAll(q, { siteIds: sites, scrape });
  assert.equal(log.calls.length, 1, 'the second normal search came from the cache');
  await searchAll(q, { siteIds: sites, scrape, deep: true });
  assert.equal(log.calls.length, 2);
  assert.equal(log.calls[1].opts.pages, 2);
  assert.equal(log.calls[0].opts.pages, 1);
});

test('stores whose page 2 was checked to give new results have a page URL', () => {
  const paged = SITES.filter((s) => s.page).map((s) => s.id).sort();
  assert.deepEqual(paged, ['akakce', 'amazon', 'hepsiburada', 'mediamarkt', 'n11', 'pazarama', 'pttavm', 'sinerji', 'teknobiyotik', 'trendyol', 'vatan']);
  for (const s of SITES.filter((x) => x.page)) {
    const u = s.page('ssd 1tb', 2);
    assert.notEqual(u, s.url('ssd 1tb'), s.id);
    assert.ok(u.startsWith(s.url('ssd 1tb')), `${s.id}: page 2 is the search URL plus a page number`);
    assert.match(u, /2$/, s.id);
  }
});
