// Price history: what each search saw, kept on disk so the UI can draw it over time.
//
// The stores don't publish their past prices, so the history only starts the first
// time you search for something and grows with every search after that. Two kinds
// of series are kept:
//   - per offer (by URL): a point whenever its price changes, plus one a day as a
//     "still listed" heartbeat, and the time it was last seen;
//   - per query and store selection: the lowest and median price of the offers that
//     count, at most one point per half hour. A different set of stores is a
//     different series, because switching a store off changes the lowest price.
import fs from 'node:fs';
import path from 'node:path';
import { median } from './text.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const QUERY_GAP_MS = 30 * 60_000;
const MAX_QUERIES = 100;

/** One key for "RTX  4060 -Ti" and "rtx 4060 -ti". */
export function queryKey(query) {
  return String(query).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Series key: the query, plus the store selection unless it is every store. */
const seriesKey = (query, scope) => (scope && scope !== 'all' ? `${queryKey(query)}|${scope}` : queryKey(query));

export function createHistory({ file, now = Date.now, maxPoints = 400, keepMs = 180 * DAY } = {}) {
  let data = { offers: {}, queries: {} };
  let saving = Promise.resolve();

  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded && typeof loaded.offers === 'object' && typeof loaded.queries === 'object') data = loaded;
  } catch {
    // No file yet, or it is damaged: start empty.
  }

  function recordOffers(offers, t) {
    for (const o of offers) {
      let e = data.offers[o.url];
      if (!e) e = data.offers[o.url] = { site: o.site, title: o.title, seen: t, points: [] };
      e.site = o.site;
      e.title = o.title;
      e.seen = t;
      const last = e.points.at(-1);
      if (!last || last[1] !== o.price || t - last[0] >= DAY) {
        e.points.push([t, o.price]);
        if (e.points.length > maxPoints) e.points.splice(0, e.points.length - maxPoints);
      }
    }
  }

  function recordQuery(query, scope, offers, t) {
    const counted = offers.filter((o) => !o.flag);
    if (!counted.length) return;
    const prices = counted.map((o) => o.price);
    const cheapest = counted.reduce((a, b) => (b.price < a.price ? b : a));
    const key = seriesKey(query, scope);
    const series = (data.queries[key] ??= []);
    const point = {
      t,
      min: cheapest.price,
      median: median(prices),
      n: prices.length,
      best: { site: cheapest.site, title: cheapest.title },
    };
    if (series.length && t - series.at(-1).t < QUERY_GAP_MS) series[series.length - 1] = point;
    else series.push(point);
    if (series.length > maxPoints) series.splice(0, series.length - maxPoints);
  }

  function prune(t) {
    for (const [url, e] of Object.entries(data.offers)) if (t - e.seen > keepMs) delete data.offers[url];
    const keys = Object.keys(data.queries);
    if (keys.length > MAX_QUERIES) {
      keys
        .sort((a, b) => data.queries[a].at(-1).t - data.queries[b].at(-1).t)
        .slice(0, keys.length - MAX_QUERIES)
        .forEach((k) => delete data.queries[k]);
    }
  }

  return {
    /** Add what a search found. `scope` names the stores searched ('all', or their ids joined by commas). */
    record(query, offers, { scope = 'all' } = {}) {
      const t = now();
      recordOffers(offers, t);
      recordQuery(query, scope, offers, t);
      prune(t);
    },
    query: (query, scope = 'all') => data.queries[seriesKey(query, scope)] ?? [],
    offer: (url) => data.offers[url] ?? null,
    /** Write to disk; writes queue up so two searches never interleave. */
    save() {
      const json = JSON.stringify(data);
      saving = saving
        .catch(() => {})
        .then(async () => {
          await fs.promises.mkdir(path.dirname(file), { recursive: true });
          const tmp = `${file}.tmp`;
          await fs.promises.writeFile(tmp, json);
          await fs.promises.rename(tmp, file);
        });
      return saving;
    },
  };
}
