// Dev helper: cut a saved result page (.probe/<file>.html) down to a few product cards
// and write it to test/fixtures/<id>.html, so extractor tests run offline and stay small.
// Usage: node scripts/make-fixture.mjs <id> <probe-file> "<card selector>" [count=3] [--ld] [--pick=0,1,30]
//   --pick takes those card positions instead of the first <count> (to mix sold-out and in-stock).
//   --ld keeps the page's JSON-LD blocks (for stores that ship products as schema.org data,
//   trimmed to the first <count> products) instead of cards.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const [id, file, cardSel, countArg = '3'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ld = process.argv.includes('--ld');
const pick = process.argv.find((a) => a.startsWith('--pick='))?.slice(7).split(',').map(Number);
const count = Number(countArg);
const html = fs.readFileSync(`.probe/${file}.html`, 'utf8');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.route('**/*', (r) => (r.request().resourceType() === 'document' ? r.fulfill({ body: html, contentType: 'text/html; charset=utf-8' }) : r.abort()));
await page.goto('https://example.invalid/', { waitUntil: 'domcontentloaded' }).catch(() => {});
const body = await page.evaluate(
  ([cardSel, count, ld, pick]) => {
    const scrub = (el) => {
      el.querySelectorAll('script,style,svg,noscript,picture source').forEach((n) => n.remove());
      el.querySelectorAll('img').forEach((i) => {
        for (const a of [...i.attributes]) if (!['src', 'alt', 'title', 'data-src', 'class'].includes(a.name)) i.removeAttribute(a.name);
        if ((i.getAttribute('src') || '').startsWith('data:')) i.removeAttribute('src');
      });
      return el.outerHTML;
    };
    if (ld) {
      const blocks = [];
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const j = JSON.parse(s.textContent);
          const list = j.itemListElement || (j['@graph'] || []).find((n) => n.itemListElement)?.itemListElement;
          if (list) j.itemListElement = list.slice(0, count);
          blocks.push(`<script type="application/ld+json">${JSON.stringify(j)}</script>`);
        } catch {
          /* skip */
        }
      }
      return blocks.join('\n');
    }
    const all = [...document.querySelectorAll(cardSel)];
    return (pick ? pick.map((i) => all[i]).filter(Boolean) : all.slice(0, count)).map((c) => scrub(c.cloneNode(true))).join('\n');
  },
  [cardSel, count, ld, pick],
);
fs.mkdirSync('test/fixtures', { recursive: true });
fs.writeFileSync(`test/fixtures/${id}.html`, `<!doctype html><meta charset="utf-8"><body>\n${body}\n</body>\n`);
console.log(id, 'fixture bytes:', body.length);
await browser.close();
