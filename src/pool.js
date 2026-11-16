// Small concurrency and caching helpers for the scraper.

/**
 * Map `items` through async `fn` with at most `limit` calls in flight, keeping
 * the input order. Once `signal` is aborted no new call starts; items that never
 * started come back as null.
 */
export async function mapLimit(items, limit, fn, signal) {
  const out = new Array(items.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < items.length && !signal?.aborted) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

/** A Map with a time-to-live and a size cap (oldest entry dropped first). */
export function createCache({ ttlMs, max, now = Date.now }) {
  const map = new Map();
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      if (now() - e.at > ttlMs) {
        map.delete(key);
        return undefined;
      }
      return e.value;
    },
    set(key, value) {
      map.delete(key); // re-insert at the end: newest
      map.set(key, { at: now(), value });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() {
      return map.size;
    },
  };
}
