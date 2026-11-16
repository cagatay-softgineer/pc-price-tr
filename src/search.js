// Fan a query out to every store, normalise and filter what comes back.
import { SITES } from './sites.js';
import { scrape as browserScrape } from './browser.js';
import { createCache, mapLimit } from './pool.js';
import { classify, cleanTitle, cleanUrl, flagOutliers, matches, parseInstallment, parsePrice, parseQuery } from './text.js';

// Store pages open at once. More is faster but heavier on the machine, and
// looks more like a bot to the stores.
const TABS = Number(process.env.PCPRICE_TABS) || 5;
const cache = createCache({ ttlMs: 10 * 60 * 1000, max: 300 });

/** 'all' for every store, else the chosen store ids sorted: the key of a history series. */
export function scopeOf(siteIds) {
  const ids = [...new Set(siteIds ?? [])].filter((id) => SITES.some((s) => s.id === id));
  return !ids.length || ids.length === SITES.length ? 'all' : ids.sort().join(',');
}

/** The words sent to the stores: the query minus "-exclusions". */
export function storeQuery(query) {
  return String(query)
    .split(/\s+/)
    .filter((w) => w && !w.startsWith('-'))
    .join(' ');
}

/**
 * Turn raw extractor items into offers: parse prices, drop items without a
 * price or link, de-duplicate by URL, keep only titles that contain every
 * query word (and none of the excluded ones), and flag accessories/systems.
 */
export function toOffers(site, rawItems, parsed) {
  const seen = new Set();
  const offers = [];
  let dropped = 0;
  for (const item of rawItems) {
    const price = parsePrice(item.price);
    const url = item.url && cleanUrl(item.url);
    if (!price || !url || item.inStock === false || seen.has(url)) continue;
    seen.add(url);
    const title = cleanTitle(item.title);
    if (!matches(title, parsed)) {
      dropped++;
      continue;
    }
    offers.push({
      site: site.id,
      siteName: site.name,
      kind: site.kind,
      title,
      price,
      url,
      image: item.image ?? null,
      offers: item.offers ?? null,
      installment: parseInstallment(item.installmentText ?? item.text),
      flag: classify(title, parsed),
    });
  }
  return { offers, dropped };
}

/** One store. `deep` also reads its second result page, where the store supports it. */
export async function searchSite(site, query, { fresh = false, deep = false, signal, scrape = browserScrape } = {}) {
  const parsed = parseQuery(query);
  const q = storeQuery(query);
  const pages = deep ? 2 : 1;
  const key = `${site.id}|${pages}|${q.toLowerCase()}`;
  let raw = fresh ? undefined : cache.get(key);
  const cached = Boolean(raw);
  if (!raw) {
    raw = await scrape(site, q, { keep: (title) => matches(cleanTitle(title), parsed), pages, signal });
    if (raw.status === 'ok') cache.set(key, raw);
  }
  const { offers, dropped } = toOffers(site, raw.items, parsed);
  return {
    site: site.id,
    siteName: site.name,
    status: raw.status,
    error: raw.error,
    ms: raw.ms,
    cached,
    found: raw.items.length,
    dropped,
    offers,
  };
}

/**
 * Search the chosen stores, `tabs` at a time; onSite fires as each one finishes.
 * Once `signal` aborts, no further store is opened and nothing more is reported.
 */
export async function searchAll(query, { siteIds, onSite, fresh, deep, signal, tabs = TABS, scrape } = {}) {
  if (!parseQuery(query).include.length) throw new Error('Empty query');
  const sites = siteIds?.length ? SITES.filter((s) => siteIds.includes(s.id)) : SITES;
  const done = await mapLimit(
    sites,
    tabs,
    async (site) => {
      const r = await searchSite(site, query, { fresh, deep, signal, scrape });
      if (signal?.aborted) return null;
      onSite?.(r);
      return r;
    },
    signal,
  );
  const results = done.filter(Boolean);
  const offers = flagOutliers(results.flatMap((r) => r.offers)).sort((a, b) => a.price - b.price);
  return { query, results, offers };
}
