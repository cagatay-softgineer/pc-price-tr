// Store registry. Each entry says where a store's search page is and how to read
// products off it. Extractors run INSIDE the page (page.evaluate), so every
// function here must be self-contained: no closures over module scope.
//
// Extractor result items: { title, price, url, image?, offers?, inStock?, text? }
// `text` is the card's visible text and badge alt/title, read for instalment badges.
// `price` may be a number or the store's printed text; src/text.js parses it.
// A site with `details` returns items without prices; the matching ones are
// then opened one by one and priced by `details.extract`.

/** Generic card reader driven by CSS selectors; `cfg` may be a list of layouts. */
export function extractCards(cfg) {
  if (Array.isArray(cfg)) return cfg.flatMap((c) => extractCards(c));
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const abs = (u) => {
    try {
      return u ? new URL(u, location.href).href : null;
    } catch {
      return null;
    }
  };
  const one = (root, sel) => (!sel ? null : sel === ':scope' ? root : root.querySelector(sel));
  const out = [];
  for (const card of document.querySelectorAll(cfg.card)) {
    const tEl = one(card, cfg.title);
    const title = clean((cfg.titleAttr && tEl?.getAttribute(cfg.titleAttr)) || tEl?.textContent);
    const prices = [...card.querySelectorAll(cfg.price)].map((e) => clean(e.textContent)).filter((t) => /\d/.test(t));
    const lEl = one(card, cfg.link ?? 'a[href]');
    const img = card.querySelector('img');
    const image = img && (img.getAttribute('data-src') || img.getAttribute('src'));
    const offers = cfg.offers ? clean(one(card, cfg.offers)?.textContent) : undefined;
    if (!title || !prices.length) continue;
    // Card text plus badge images' alt/title: where stores print "Peşin Fiyatına 9 Taksit".
    const badges = [...card.querySelectorAll('img[alt], [title]')].map((e) => e.getAttribute('alt') || e.getAttribute('title'));
    out.push({
      title,
      price: cfg.lastPrice ? prices[prices.length - 1] : prices[0],
      url: abs(lEl?.getAttribute('href')),
      image: image && !image.startsWith('data:') ? abs(image) : null,
      offers,
      text: clean(`${card.textContent} ${badges.join(' ')}`).slice(0, 600),
    });
  }
  return out;
}

/** schema.org JSON-LD: ItemList → items, or bare Product nodes. */
export function extractJsonLd() {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const type = [].concat(node['@type'] || []);
    if (type.includes('Product') && node.name) {
      const offer = [].concat(node.offers || [])[0] || {};
      const price = offer.price ?? offer.lowPrice;
      if (price != null) {
        const img = [].concat(node.image || [])[0];
        out.push({
          title: node.name,
          price: String(price),
          url: node.url || offer.url || null,
          image: typeof img === 'string' ? img : img?.url || null,
        });
      }
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      walk(JSON.parse(s.textContent));
    } catch {
      /* malformed block: skip */
    }
  }
  return out;
}

/** Akakçe ships search results as Astro island props ([type, value] pairs). */
export function extractAkakce() {
  const rev = (v) => {
    if (!Array.isArray(v)) return v;
    const [t, d] = v;
    if (t === 1 && Array.isArray(d)) return d.map(rev);
    if (t === 0 && d && typeof d === 'object' && !Array.isArray(d)) {
      return Object.fromEntries(Object.entries(d).map(([k, x]) => [k, rev(x)]));
    }
    return d;
  };
  const out = [];
  const seen = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.name === 'string' && typeof n.price === 'number' && typeof n.url === 'string' && n.code) {
      if (!seen.has(n.code)) {
        seen.add(n.code);
        out.push({
          title: n.name,
          price: n.price,
          url: new URL(n.url, location.origin).href,
          image: n.imageUrl || null,
          offers: n.countOfPrices ? `${n.countOfPrices} satıcı` : undefined,
        });
      }
    }
    Object.values(n).forEach(walk);
  };
  for (const el of document.querySelectorAll('astro-island[props]')) {
    try {
      walk(rev([0, JSON.parse(el.getAttribute('props'))]));
    } catch {
      /* not a data island */
    }
  }
  return out;
}

/**
 * İncehesap's search page redirects to keyword landing pages, often the wrong
 * one (7800x3d → the 7800 XT GPU page). Its search box instead calls
 * /ajax/search.php, which we open directly: products, but no prices. Prices
 * then come from each product page (see `details`).
 */
export function extractIncehesapSuggest() {
  const data = JSON.parse(document.body.innerText);
  return (data.u || []).map((p) => ({
    title: p.a,
    price: null,
    url: new URL(`/${p.u}-fiyati-${p.id}/`, location.origin).href,
    image: p.r ? new URL(p.r, location.origin).href : null,
    inStock: p.satis_durumu === 1,
  }));
}

/** Price from a single product page: JSON-LD, then microdata, then meta tags. */
export function extractProductPage() {
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const nodes = [].concat(JSON.parse(s.textContent));
      for (const n of nodes.flatMap((x) => [x, ...[].concat(x['@graph'] || [])])) {
        const offer = [].concat(n?.offers || [])[0];
        if ([].concat(n?.['@type']).includes('Product') && offer && (offer.price ?? offer.lowPrice) != null) {
          return { price: String(offer.price ?? offer.lowPrice) };
        }
      }
    } catch {
      /* skip */
    }
  }
  const el = document.querySelector('[itemprop="price"]');
  const v = el?.getAttribute('content') || el?.textContent;
  if (v && /\d/.test(v)) return { price: v.trim() };
  const meta = document.querySelector('meta[property="product:price:amount"], meta[property="og:price:amount"]');
  return meta?.content ? { price: meta.content } : { price: null };
}

/**
 * Some stores keep the instalment badge only in the page's inline JSON, next to
 * the product's url (Trendyol `tagDetails`, n11 `badge`). For each url, returns
 * the "…taksit…" phrases found between the previous product's url and this one,
 * or '' when there are none. Runs in the page, so it must stay self-contained.
 */
export function scriptInstallments(urls) {
  const text = [...document.querySelectorAll('script:not([src])')]
    .map((s) => s.textContent || '')
    .filter((t) => /taksit/i.test(t))
    .map((t) => t.replace(/\\u002f/gi, '/').replace(/\\\//g, '/').replace(/\\"/g, '"'))
    .join('\n');
  const find = (p) => {
    for (let i = text.indexOf(p); i >= 0; i = text.indexOf(p, i + 1)) {
      if (!/[\w-]/.test(text[i + p.length] || '')) return i; // not a longer path
    }
    return -1;
  };
  const pos = urls.map((u) => {
    try {
      return u ? find(new URL(u).pathname) : -1;
    } catch {
      return -1;
    }
  });
  const sorted = pos.filter((p) => p >= 0).sort((a, b) => a - b);
  return pos.map((p) => {
    if (p < 0) return '';
    const prev = sorted.filter((q) => q < p).pop() ?? -1;
    const seg = text.slice(Math.max(prev + 1, p - 6000), p);
    return (seg.match(/[^"{}[\],]{0,40}taksit[^"{}[\],]{0,40}/gi) || []).join(' ');
  });
}

const enc = encodeURIComponent;
const slug = (q) => q.trim().toLowerCase().replace(/\s+/g, '-');

export const SITES = [
  {
    id: 'akakce',
    name: 'Akakçe',
    kind: 'aggregator',
    url: (q) => `https://www.akakce.com/arama/?q=${enc(q)}`,
    waitFor: 'astro-island[props]',
    extract: extractAkakce,
  },
  {
    id: 'epey',
    name: 'Epey',
    kind: 'aggregator',
    url: (q) => `https://www.epey.com/ara/?ara=${enc(q)}`,
    waitFor: '.fiyat, ul.metin',
    extract: extractCards,
    cfg: [
      // Free-text results grid
      { card: 'a.cell', title: '.adi', price: '.fiyat', link: ':scope', offers: '.fiyatsayi' },
      // A query that maps to a category opens that category's table, filtered
      { card: 'ul.metin.row', title: 'a.urunadi', price: 'li.fiyat', link: 'a.urunadi' },
    ],
  },
  {
    id: 'trendyol',
    name: 'Trendyol',
    kind: 'store',
    url: (q) => `https://www.trendyol.com/sr?q=${enc(q)}`,
    waitFor: 'a.product-card',
    scriptBadges: scriptInstallments,
    extract: extractCards,
    cfg: {
      card: 'a.product-card',
      title: '[data-testid="product-card-name"], .product-name, .prdct-desc-cntnr-name, h3, h2',
      price: '[data-testid="price-section"], .price-section, .prc-box-dscntd, .price-value',
      link: ':scope',
      lastPrice: true,
    },
  },
  {
    id: 'hepsiburada',
    name: 'Hepsiburada',
    kind: 'store',
    url: (q) => `https://www.hepsiburada.com/ara?q=${enc(q)}`,
    waitFor: 'article[class*="productCard-module_article"]',
    extract: extractCards,
    cfg: {
      card: 'article[class*="productCard-module_article"]',
      title: '[class*="title-module_titleText"]',
      price: '[class*="price-module_finalPrice__"]',
      link: 'a[href]',
    },
  },
  {
    id: 'n11',
    name: 'n11',
    kind: 'store',
    url: (q) => `https://www.n11.com/arama?q=${enc(q)}`,
    waitFor: 'script[type="application/ld+json"]',
    scriptBadges: scriptInstallments,
    extract: extractJsonLd,
  },
  {
    id: 'amazon',
    name: 'Amazon TR',
    kind: 'store',
    url: (q) => `https://www.amazon.com.tr/s?k=${enc(q)}`,
    waitFor: 'div[data-component-type="s-search-result"]',
    extract: extractCards,
    cfg: {
      card: 'div[data-component-type="s-search-result"]',
      title: 'h2',
      titleAttr: 'aria-label',
      price: '.a-price:not(.a-text-price) .a-offscreen',
      link: 'a.a-link-normal[href*="/dp/"], h2 a, a[href]',
    },
  },
  {
    id: 'itopya',
    name: 'İtopya',
    kind: 'store',
    url: (q) => `https://www.itopya.com/ara?bul=${enc(q)}`,
    waitFor: '.product',
    extract: extractCards,
    cfg: { card: 'div.product', title: 'a.title', price: '.product-price strong, .product-price', link: 'a.title' },
  },
  {
    id: 'incehesap',
    name: 'İncehesap',
    kind: 'store',
    url: (q) => `https://www.incehesap.com/ajax/search.php?q=${enc(q)}`,
    waitFor: 'body',
    extract: extractIncehesapSuggest,
    // Matching suggestions are opened (in parallel) to read their price.
    details: { limit: 6, extract: extractProductPage },
  },
  {
    id: 'vatan',
    name: 'Vatan Bilgisayar',
    kind: 'store',
    url: (q) => `https://www.vatanbilgisayar.com/arama/${enc(q)}/`,
    waitFor: '.product-list',
    extract: extractCards,
    cfg: {
      card: '.product-list.product-list--list-page',
      title: '.product-list__product-name',
      price: '.product-list__price',
      link: 'a.product-list-link',
    },
  },
  {
    id: 'mediamarkt',
    name: 'MediaMarkt',
    kind: 'store',
    url: (q) => `https://www.mediamarkt.com.tr/tr/search.html?query=${enc(q)}`,
    waitFor: 'script[type="application/ld+json"]',
    extract: extractJsonLd,
  },
  {
    id: 'sinerji',
    name: 'Sinerji',
    kind: 'store',
    url: (q) => `https://www.sinerji.gen.tr/${enc(slug(q))}-s`,
    waitFor: 'article.product',
    extract: extractCards,
    cfg: { card: 'article.product', title: '.title a', price: '.price', link: '.title a' },
  },
];

/**
 * Stores we checked and cannot read today. Shown in the UI so a missing store
 * is an explained gap, not a silent one. Akakçe/Epey list most of their offers.
 */
export const UNSUPPORTED = [
  { id: 'cimri', name: 'Cimri', reason: 'Cloudflare blocks automated Chrome ("Attention Required")' },
  { id: 'teknosa', name: 'Teknosa', reason: 'Cloudflare blocks automated Chrome ("Attention Required")' },
  { id: 'gaming', name: 'Gaming.gen.tr', reason: 'Search redirects to a single product page' },
];
