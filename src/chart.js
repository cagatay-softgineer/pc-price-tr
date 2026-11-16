// Small pure helpers for the price-history chart. The browser loads this file as
// /lib/chart.js, so it must stay free of Node-only code.

/** A function mapping [d0, d1] onto [r0, r1]; a flat domain maps to the middle. */
export function linearScale([d0, d1], [r0, r1]) {
  if (d0 === d1) return () => (r0 + r1) / 2;
  return (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

/** Round tick values (1, 2, 2.5 or 5 times a power of ten) that cover [min, max]. */
export function niceTicks(min, max, count = 4) {
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const ticks = [];
  const first = Math.floor(min / step);
  const last = Math.ceil(max / step);
  for (let i = first; i <= last; i++) ticks.push(Math.round(i * step * 1e9) / 1e9);
  return ticks;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const TIME_STEPS = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY];

/** Evenly spaced times inside [t0, t1], on hour/day boundaries of the local clock. */
export function timeTicks(t0, t1, target = 5) {
  const span = t1 - t0;
  const step = TIME_STEPS.find((s) => span / s <= target) ?? TIME_STEPS.at(-1);
  const offset = new Date(t0).getTimezoneOffset() * 60_000;
  const ticks = [];
  for (let t = Math.ceil((t0 - offset) / step) * step + offset; t <= t1; t += step) ticks.push(t);
  return ticks.length >= 2 ? ticks : [t0, t1];
}

/** SVG path through [x, y] points. */
export function linePath(points) {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join('');
}

/** SVG path that holds each y until the next point, then ends at xEnd. */
export function stepPath(points, xEnd) {
  if (!points.length) return '';
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length; i++) d += `H${points[i][0]}V${points[i][1]}`;
  return `${d}H${Math.max(xEnd, points.at(-1)[0])}`;
}
