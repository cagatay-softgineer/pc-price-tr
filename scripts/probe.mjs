// Dev probe: open each store's search page in real Chrome and report whether
// we got through Cloudflare, plus which JSON responses the page loaded.
// Usage: node scripts/probe.mjs [query] [--headful] [site...]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const headful = args.includes('--headful');
const rest = args.filter((a) => !a.startsWith('--'));
const query = rest[0] ?? 'rtx 4060';
const only = rest.slice(1);
const q = encodeURIComponent(query);
const slug = query.trim().toLowerCase().replace(/\s+/g, '-');

const sites = {
  akakce: `https://www.akakce.com/arama/?q=${q}`,
  cimri: `https://www.cimri.com/arama?q=${q}`,
  epey: `https://www.epey.com/ara/?ara=${q}`,
  trendyol: `https://www.trendyol.com/sr?q=${q}`,
  hepsiburada: `https://www.hepsiburada.com/ara?q=${q}`,
  n11: `https://www.n11.com/arama?q=${q}`,
  amazon: `https://www.amazon.com.tr/s?k=${q}`,
  itopya: `https://www.itopya.com/ara?bul=${q}`,
  incehesap: `https://www.incehesap.com/q/${slug}/`,
  vatan: `https://www.vatanbilgisayar.com/arama/${q}/`,
  teknosa: `https://www.teknosa.com/arama/?s=${q}`,
  mediamarkt: `https://www.mediamarkt.com.tr/tr/search.html?query=${q}`,
  sinerji: `https://www.sinerji.gen.tr/${slug}-s`,
  gaming: `https://www.gaming.gen.tr/?s=${q}&post_type=product&dgwt_wcas=1`,
  pttavm: `https://www.pttavm.com/arama?q=${q}`,
  pazarama: `https://www.pazarama.com/arama?q=${q}`,
  tebilon: `https://www.tebilon.com/arama/?a=${q}`,
  eksen: `https://www.eksenbilgisayar.com/arama?urunAra=${q}`,
  pckolik: `https://pckolik.com.tr/arama?q=${q}`,
  nova: `https://www.novabilgisayar.com/${slug}-arama-sonuclari`,
  gelbura: `https://www.gelbura.com/ara?q=${q}`,
  teknobiyotik: `https://www.teknobiyotik.com/catalogsearch/result/?q=${q}`,
  vizyon: `https://www.vizyonbilgisayar.com/arama?k=${q}`,
};

const outDir = path.resolve('.probe');
fs.mkdirSync(outDir, { recursive: true });
const ctx = await chromium.launchPersistentContext(path.resolve('.browser-profile'), {
  channel: 'chrome',
  headless: !headful,
  locale: 'tr-TR',
  viewport: { width: 1366, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
});

for (const [name, url] of Object.entries(sites)) {
  if (only.length && !only.includes(name)) continue;
  const page = await ctx.newPage();
  const json = [];
  page.on('response', async (r) => {
    const ct = r.headers()['content-type'] ?? '';
    if (ct.includes('json') && r.request().resourceType() !== 'image') {
      json.push(`${r.status()} ${r.url().slice(0, 160)}`);
    }
  });
  let status = 'ERR';
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    status = resp?.status();
    // Give a Cloudflare challenge time to clear and the app time to render.
    for (let i = 0; i < 12; i++) {
      const t = await page.title();
      if (!/just a moment|attention required|bir dakika/i.test(t)) break;
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(3000);
    const html = await page.content();
    fs.writeFileSync(path.join(outDir, `${name}.html`), html);
    fs.writeFileSync(path.join(outDir, `${name}.json.txt`), json.join('\n'));
    console.log(name.padEnd(12), status, (await page.title()).slice(0, 60).padEnd(62), html.length, `json:${json.length}`);
  } catch (e) {
    console.log(name.padEnd(12), status, 'FAILED', e.message.split('\n')[0]);
  }
  await page.close();
}
await ctx.close();
