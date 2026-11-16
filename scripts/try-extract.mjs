// Dev harness: run each site's extractor against a saved page in .probe/ with
// the network blocked, and print what it found.
// Usage: node scripts/try-extract.mjs [site...]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { SITES } from '../src/sites.js';
import { parsePrice } from '../src/text.js';

const only = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
for (const site of SITES) {
  if (only.length && !only.includes(site.id)) continue;
  const file = `.probe/${site.id}.html`;
  if (!fs.existsSync(file)) {
    console.log(site.id.padEnd(12), 'no saved page');
    continue;
  }
  const page = await browser.newPage();
  // Serve the saved HTML at the store's real URL so relative links resolve.
  const html = fs.readFileSync(file, 'utf8');
  await page.route('**/*', (r) =>
    r.request().resourceType() === 'document' ? r.fulfill({ body: html, contentType: 'text/html; charset=utf-8' }) : r.abort(),
  );
  await page.goto(site.url('rtx 4060'), { waitUntil: 'domcontentloaded' }).catch(() => {});
  const items = await page.evaluate(site.extract, site.cfg);
  const priced = items.filter((i) => parsePrice(i.price));
  console.log(site.id.padEnd(12), `${items.length} items, ${priced.length} priced, ${items.filter((i) => i.url).length} linked`);
  for (const i of items.slice(0, 3)) console.log('   ', parsePrice(i.price), '|', i.price, '|', i.title.slice(0, 70), '|', i.url?.slice(0, 70), i.offers ?? '');
  await page.close();
}
await browser.close();
