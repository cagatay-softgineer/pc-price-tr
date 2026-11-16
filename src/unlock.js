#!/usr/bin/env node
// Open the scraper's own Chrome profile in a visible window, on each store,
// so you can pass any "Gerçek kişi olduğunuzu doğrulayın" check by hand.
// The clearance cookies stay in .browser-profile and later searches reuse them.
// Usage: npm run unlock [-- incehesap trendyol ...]
process.env.PCPRICE_SHOW = '1';
process.env.PCPRICE_HEADLESS = '0';

const { getContext } = await import('./browser.js');
const { SITES, UNSUPPORTED } = await import('./sites.js');

const wanted = process.argv.slice(2);
const sites = wanted.length ? SITES.filter((s) => wanted.includes(s.id)) : SITES;
const ctx = await getContext();
for (const site of sites) {
  const page = await ctx.newPage();
  page.goto(new URL(site.url('ekran kartı')).origin, { waitUntil: 'domcontentloaded' }).catch(() => {});
}
for (const page of ctx.pages()) if (page.url() === 'about:blank') await page.close().catch(() => {});

console.log(`Opened ${sites.length} stores in Chrome.`);
console.log('Tick any Cloudflare/"robot değilim" box you see, then close the Chrome window.');
if (!wanted.length) console.log(`(Not included, they block automation outright: ${UNSUPPORTED.map((u) => u.name).join(', ')})`);
await new Promise((resolve) => ctx.on('close', resolve));
console.log('Saved. Searches will now reuse this session.');
