// Fan a query out to every store, normalise and filter what comes back.
import { SITES } from './sites.js';
import { scrape } from './browser.js';
import { classify, cleanTitle, cleanUrl, flagOutliers, matches, parsePrice, parseQuery } from './text.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

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
    if (!price || !url || seen.has(url)) continue;
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
      flag: classify(title, parsed),
    });
  }
  return { offers, dropped };
}

export async function searchSite(site, query, { fresh = false } = {}) {
  const parsed = parseQuery(query);
  const q = storeQuery(query);
  const key = `${site.id}|${q.toLowerCase()}`;
  let raw = cache.get(key);
  let cached = true;
  if (fresh || !raw || Date.now() - raw.at > CACHE_TTL_MS) {
    raw = { at: Date.now(), ...(await scrape(site, q, { keep: (title) => matches(cleanTitle(title), parsed) })) };
    cached = false;
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

/** Search the chosen stores in parallel; onSite fires as each one finishes. */
export async function searchAll(query, { siteIds, onSite, fresh } = {}) {
  if (!parseQuery(query).include.length) throw new Error('Empty query');
  const sites = siteIds?.length ? SITES.filter((s) => siteIds.includes(s.id)) : SITES;
  const results = await Promise.all(
    sites.map(async (site) => {
      const r = await searchSite(site, query, { fresh });
      onSite?.(r);
      return r;
    }),
  );
  const offers = flagOutliers(results.flatMap((r) => r.offers)).sort((a, b) => a.price - b.price);
  return { query, results, offers };
}
