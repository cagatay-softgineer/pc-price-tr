// Dev helper: type a query into a store's own search box and print the URL it lands on.
// Usage: node scripts/find-search-url.mjs "rtx 4060" https://www.itopya.com ...
import { chromium } from 'playwright-core';
import path from 'node:path';

const [query, ...homes] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext(path.resolve('.browser-profile'), {
  channel: 'chrome',
  headless: false,
  locale: 'tr-TR',
  args: ['--disable-blink-features=AutomationControlled', '--window-position=-2400,0'],
});
for (const home of homes) {
  const page = await ctx.newPage();
  try {
    await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    const input = page.locator('input[type="search"]:visible, input[name="q"]:visible, input[name="s"]:visible, input[placeholder*="ara" i]:visible').first();
    await input.click({ timeout: 10000 });
    await input.fill(query);
    await input.press('Enter');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(4000);
    console.log(home, '->', page.url());
  } catch (e) {
    console.log(home, 'FAILED', e.message.split('\n')[0]);
  }
  await page.close();
}
await ctx.close();
