// What changed in a query's price history: used by the watchlist. Pure, so the
// browser loads it too (served at /lib/watch.js).

/**
 * The latest lowest price against the last earlier point where it was different.
 * `unsure` when a store did not answer at either point: then the "change" may only
 * be that store missing. Returns null without points.
 */
export function lastChange(points) {
  if (!points?.length) return null;
  const last = points.at(-1);
  let j = points.length - 2;
  while (j >= 0 && points[j].min === last.min) j--;
  const prev = j >= 0 ? points[j] : null;
  return {
    now: last.min,
    t: last.t,
    before: prev ? { price: prev.min, t: prev.t } : null,
    diff: prev ? last.min - prev.min : 0,
    unsure: Boolean(last.failed?.length || prev?.failed?.length),
  };
}
