// Runs the in-page extractors in real headless Chrome against small HTML cards.
// Skipped when Chrome/Edge is not installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { extractCards, extractIncehesapSuggest, extractJsonLd, scriptInstallments } from '../src/sites.js';

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

async function run(html, cfg) {
  const page = await browser.newPage();
  try {
    await page.setContent(`<body>${html}</body>`);
    return await page.evaluate(extractCards, cfg);
  } finally {
    await page.close();
  }
}

test('extractCards keeps the card text and badge image alt/title for instalment badges', async (t) => {
  if (!browser) return t.skip('no Chrome or Edge installed');
  const items = await run(
    `<div class="c"><a class="t" href="/p/1">MSI RTX 4060</a><span class="p">17.999 TL</span>
       <img src="/b.png" alt="peşin fiyatına 6 taksit"><div title="Vade farksız">x</div></div>
     <div class="c"><a class="t" href="/p/2">Asus RTX 4060</a><span class="p">18.499 TL</span></div>`,
    { card: '.c', title: '.t', price: '.p', link: '.t' },
  );
  assert.equal(items.length, 2);
  assert.match(items[0].text, /peşin fiyatına 6 taksit/i);
  assert.match(items[0].text, /Vade farksız/);
  assert.doesNotMatch(items[1].text, /taksit/i);
  assert.ok(items[1].text.length < 200, 'text stays short');
});

test('extractCards marks cards that print a sold-out notice as out of stock', async (t) => {
  if (!browser) return t.skip('no Chrome or Edge installed');
  const items = await run(
    `<div class="c"><a class="t" href="/p/1">MSI RTX 4060</a><span class="p">29.380 TL</span><a>GELİNCE HABER VER</a></div>
     <div class="c"><a class="t" href="/p/2">Asus RTX 4060</a><span class="p">18.499 TL</span><a>Sepete Ekle</a></div>
     <div class="c"><a class="t" href="/p/3">Gigabyte RTX 4060</a><span class="p">19.999 TL</span><span>Tükendi</span></div>`,
    { card: '.c', title: '.t', price: '.p', link: '.t' },
  );
  assert.deepEqual(items.map((i) => i.inStock), [false, true, false]);
});

test('scriptInstallments finds each product\'s badge in the page\'s inline JSON', async (t) => {
  if (!browser) return t.skip('no Chrome or Edge installed');
  const page = await browser.newPage();
  try {
    // Trendyol style: tags before the escaped url; n11 style: badge object, then the full url.
    await page.setContent(`<body><script>window.__S={"products":[
      {"name":"A","tagDetails":[{"displayName":"Peşin Fiyatına 9 Taksit"}],"url":"\u002Fmsi\u002Frtx-4060-p-1?x=1"},
      {"name":"B","tagDetails":[],"url":"\u002Fasus\u002Frtx-4060-p-2?x=1"},
      {"name":"C","badge":{"description":"PEŞİN FİYATINA 3 TAKSIT rozetli ürün"},"url":"https://www.n11.com/urun/c-3"}
    ]}</script></body>`);
    const out = await page.evaluate(scriptInstallments, [
      'https://www.trendyol.com/msi/rtx-4060-p-1?x=1',
      'https://www.trendyol.com/asus/rtx-4060-p-2?x=1',
      'https://www.n11.com/urun/c-3',
      'https://www.n11.com/urun/not-in-page',
      null,
    ]);
    assert.match(out[0], /Peşin Fiyatına 9 Taksit/);
    assert.equal(out[1], '', 'a product without a badge must not borrow its neighbour\'s');
    assert.match(out[2], /PEŞİN FİYATINA 3 TAKSIT/);
    assert.equal(out[3], '');
    assert.equal(out[4], '');
  } finally {
    await page.close();
  }
});

test('extractJsonLd reads schema.org availability into inStock', async (t) => {
  if (!browser) return t.skip('no Chrome or Edge installed');
  const page = await browser.newPage();
  try {
    const product = (name, availability) => ({ '@type': 'Product', name, offers: { '@type': 'Offer', price: '1000', availability } });
    const ld = { '@type': 'ItemList', itemListElement: [
      { item: product('A', 'https://schema.org/InStock') },
      { item: product('B', 'https://schema.org/OutOfStock') },
      { item: product('C', 'SoldOut') },
      { item: product('D') },
    ] };
    await page.setContent(`<body><script type="application/ld+json">${JSON.stringify(ld)}</script></body>`);
    const items = await page.evaluate(extractJsonLd);
    assert.deepEqual(items.map((i) => i.inStock), [true, false, false, undefined]);
  } finally {
    await page.close();
  }
});

test('extractIncehesapSuggest turns the suggest endpoint JSON into product links and stock', async (t) => {
  if (!browser) return t.skip('no Chrome or Edge installed');
  const page = await browser.newPage();
  try {
    const body = JSON.stringify({ u: [
      { a: 'MSI GeForce RTX 4060 VENTUS 2X BLACK 8G', u: 'msi-geforce-4060-ventus-2x-black-8g-gaming-ekran-karti', id: 64838, r: '/img/a.jpg', satis_durumu: 1 },
      { a: 'PNY RTX 4060 Ti VERTO 8GB', u: 'pny-rtx-4060-ti-verto-8gb', id: 63479, r: '', satis_durumu: 0 },
    ] });
    await page.route('**/*', (r) => r.fulfill({ body, contentType: 'text/html; charset=utf-8' }));
    await page.goto('https://www.incehesap.com/ajax/search.php?q=rtx%204060');
    const items = await page.evaluate(extractIncehesapSuggest);
    assert.equal(items[0].url, 'https://www.incehesap.com/msi-geforce-4060-ventus-2x-black-8g-gaming-ekran-karti-fiyati-64838/');
    assert.equal(items[0].image, 'https://www.incehesap.com/img/a.jpg');
    assert.deepEqual(items.map((i) => [i.title, i.price, i.inStock]), [
      ['MSI GeForce RTX 4060 VENTUS 2X BLACK 8G', null, true],
      ['PNY RTX 4060 Ti VERTO 8GB', null, false],
    ]);
  } finally {
    await page.close();
  }
});
