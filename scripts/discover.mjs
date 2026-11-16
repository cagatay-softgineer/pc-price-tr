// Dev helper for adding stores: open each shop's home page in the app's own Chrome
// profile, type a query into its search box, and report where it lands (the search
// URL pattern), the page title, which shop platform it looks like and how many
// prices the results page carries. The result page is saved to .probe/<id>.html
// for scripts/card.py and scripts/try-extract.mjs.
// Usage: node scripts/discover.mjs [--query="rtx 4060"] [--wait=5000] [--suffix=-ssd] id=https://www.shop.com ...
// --wait is the extra time (ms) given to JS-rendered results; the page is scrolled once
// so lazy lists load. --suffix changes the saved file name (.probe/<id><suffix>.html).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const query = args.find((a) => a.startsWith('--query='))?.slice(8) ?? 'rtx 4060';
const wait = Number(args.find((a) => a.startsWith('--wait='))?.slice(7) ?? 5000);
const suffix = args.find((a) => a.startsWith('--suffix='))?.slice(9) ?? '';
const targets = args.filter((a) => !a.startsWith('--')).map((a) => a.split(/=(.+)/));

const PLATFORMS = [
  ['Ticimax', /ticimax/i],
  ['IdeaSoft', /ideasoft|idea-soft|ideacdn/i],
  ['T-Soft', /tsoft|t-soft/i],
  ['Shopify', /cdn\.shopify|shopify\.theme/i],
  ['WooCommerce', /woocommerce|wp-content/i],
  ['OpenCart', /catalog\/view\/theme|opencart/i],
  ['Akinsoft/other', /akinsoft/i],
];
const CHALLENGE = /^(just a moment|bir dakika|attention required)|access denied|403 forbidden/i;

const outDir = path.resolve('.probe');
fs.mkdirSync(outDir, { recursive: true });
const ctx = await chromium.launchPersistentContext(path.resolve(process.env.PCPRICE_PROFILE || '.browser-profile'), {
  channel: 'chrome',
  headless: false,
  locale: 'tr-TR',
  timezoneId: 'Europe/Istanbul',
  viewport: { width: 1366, height: 900 },
  args: ['--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000'],
});

for (const [id, home] of targets) {
  const page = await ctx.newPage();
  const line = { id, home };
  try {
    const resp = await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 45000 });
    line.homeStatus = resp?.status();
    for (let i = 0; i < 12 && CHALLENGE.test(await page.title()); i++) await page.waitForTimeout(1500);
    await page.waitForTimeout(2500);
    line.homeTitle = (await page.title()).slice(0, 70);
    const input = page
      .locator('input[type="search"]:visible, input[name="q"]:visible, input[name="s"]:visible, input[name="ara"]:visible, input[name="search"]:visible, input[placeholder*="ara" i]:visible')
      .first();
    await input.click({ timeout: 8000 });
    await input.fill(query);
    await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), input.press('Enter')]);
    await page.waitForTimeout(wait);
    await page.mouse.wheel(0, 4000).catch(() => {});
    await page.waitForTimeout(1500);
    line.searchUrl = page.url();
    line.title = (await page.title()).slice(0, 70);
    const html = await page.content();
    fs.writeFileSync(path.join(outDir, `${id}${suffix}.html`), html);
    line.platform = PLATFORMS.filter(([, re]) => re.test(html)).map(([n]) => n).join('+') || '?';
    line.prices = (html.match(/\d{1,3}(?:\.\d{3})*(?:,\d{2})?\s?(?:TL|₺)/g) || []).length;
    line.jsonLd = (html.match(/application\/ld\+json/g) || []).length;
    line.queryHits = (html.match(new RegExp(query.split(/\s+/).pop().replace(/[^\w]/g, ''), 'gi')) || []).length;
  } catch (e) {
    line.error = e.message.split('\n')[0].slice(0, 100);
  }
  console.log(JSON.stringify(line));
  await page.close().catch(() => {});
}
await ctx.close();
