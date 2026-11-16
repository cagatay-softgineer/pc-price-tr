// Each store's extractor runs, in real headless Chrome, against a few product cards
// saved from its live result page (test/fixtures/<id>.html; made by scripts/make-fixture.mjs).
// Skipped when Chrome/Edge is not installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { SITES } from '../src/sites.js';
import { parsePrice } from '../src/text.js';

let browser;
before(async () => {
  for (const channel of ['chrome', 'msedge']) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      return;
    } catch {
      /* try the next one */
    }
  }
});
after(() => browser?.close());

async function extract(id) {
  const site = SITES.find((s) => s.id === id);
  assert.ok(site, `site "${id}" is not registered`);
  const html = fs.readFileSync(new URL(`./fixtures/${id}.html`, import.meta.url), 'utf8');
  const page = await browser.newPage();
  try {
    // Serve the fixture at the store's real search URL so relative links resolve.
    await page.route('**/*', (r) => (r.request().resourceType() === 'document' ? r.fulfill({ body: html, contentType: 'text/html; charset=utf-8' }) : r.abort()));
    await page.goto(site.url('rtx 4060'), { waitUntil: 'domcontentloaded' }).catch(() => {});
    return await page.evaluate(site.extract, site.cfg ?? null);
  } finally {
    await page.close();
  }
}

// id → [item count, first title, first price, first url, in-stock flags]
const EXPECT = {
  tebilon: [3, /MSI MAG INFINITE S3 14NUC5-1437EU I5-14400F/, 78225, /^https:\/\/www\.tebilon\.com\/.+/, [false, false, false]],
  eksen: [3, /^HP 255 G8 4P3L0ES/, 43076.91, /^https:\/\/www\.eksenbilgisayar\.com\//, [true, true, true]],
  pckolik: [3, /^KINGSTON NV3 SNV3S\/1000G/i, 9966, /^https:\/\/pckolik\.com\.tr\/urun\//, [true, true, true]],
  nova: [3, /^KINGSTON NV3 500GB|^TWINMOS Alphapro 512GB/i, 6120.6, /^https:\/\/www\.novabilgisayar\.com\/.+/, [true, true, true]],
  gelbura: [3, /^Kingston NV3 SNV3S\/1000G/, 9639, /^https:\/\/www\.gelbura\.com\//, [true, true, true]],
  teknobiyotik: [3, /^Kingston KC3000 1TB/, 18154.8, /^https:\/\/www\.teknobiyotik\.com\//, [true, true, true]],
  vizyon: [3, /^Kioxia Exceria Basic 2 TB/, 20756, /^https:\/\/www\.vizyonbilgisayar\.com\//, [true, true, true]],
  pazarama: [3, /^Zeiron Mirage X32 Ryzen 7 5700X/, 69794.06, /^https:\/\/www\.pazarama\.com\/.+-p-\d+/, [true, true, true]],
  pttavm: [3, /^OUTLET Acer Nitro 5/, 55859.02, /^https:\/\/www\.pttavm\.com\/.+-p-\d+/, [true, true, true]],
};

for (const [id, [count, title, price, url, stock]] of Object.entries(EXPECT)) {
  test(`${id}: extractor reads title, price, link and stock from a saved result page`, async (t) => {
    if (!browser) return t.skip('no Chrome or Edge installed');
    const items = await extract(id);
    assert.equal(items.length, count);
    assert.match(items[0].title, title);
    assert.equal(parsePrice(items[0].price), price);
    assert.match(items[0].url, url);
    assert.deepEqual(items.map((i) => i.inStock !== false), stock.map((s) => s));
    for (const i of items) assert.ok(i.title.length > 5 && parsePrice(i.price) > 0 && i.url, `complete item: ${JSON.stringify(i).slice(0, 120)}`);
  });
}
