import { formatMoney } from '@nuggets/shared';
import { centsToAmount, toCents } from './currency';

/** d3's cut-offs between a step of 1, 2, 5 and 10 times a power of ten. */
const E10 = Math.sqrt(50);
const E5 = Math.sqrt(10);
const E2 = Math.sqrt(2);

/** A round step (1, 2 or 5 times a power of ten) that cuts `span` into about `count` parts, as d3 picks one. */
function niceStep(span: number, count: number): number {
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const error = raw / power;
  return (error >= E10 ? 10 : error >= E5 ? 5 : error >= E2 ? 2 : 1) * power;
}

export interface MoneyAxis {
  /** The axis' ends: the ticks' first and last (a scale's `min` and `max`, with `nice` off). */
  min: number;
  max: number;
  /** The ticks: every multiple of the step from below the lowest value to above the highest. */
  tickValues: number[];
  /** A tick's label, as precise as the step needs. */
  format: (value: number) => string;
}

/**
 * A money axis over `values` (a chart's figures): about `count` round ticks, and labels that
 * tell each tick from the next. Compact labels ($950, $1.2K, $3.4M) keep two significant
 * figures, so on a narrow axis (ticks every $20 from $1,000 to $1,200) they read "$1K, $1K,
 * $1.1K, $1.1K…": there the labels are whole dollars ($1,020), or cents for a step under $1.
 */
export function moneyAxis(values: readonly number[], count = 6): MoneyAxis {
  // In whole cents, so the ticks are exact multiples of the step: in dollars, a figure over
  // a step carried a float's error (223709.86 / 0.01 is 22370985.999…) and put a tick outside it.
  const cents = values.filter((v) => Number.isFinite(v)).map(toCents);
  let low = cents.length ? Math.min(...cents) : 0;
  let high = cents.length ? Math.max(...cents) : 0;
  // One figure (or none) has no span to cut: a tenth of it either side (a cent at least). Zero
  // gets $1 above it, not below: an axis of nothing but $0 has no reason to go negative.
  if (low === high) {
    if (low === 0) high = 100;
    else {
      const pad = Math.max(1, Math.round(Math.abs(low) / 10));
      low -= pad;
      high += pad;
    }
  }
  // A whole number of cents: money shows to the cent, so a step under one would repeat its
  // labels ($1.01, $1.02, $1.02).
  const step = Math.max(1, Math.round(niceStep(high - low, count)));
  const tickValues: number[] = [];
  for (let tick = floorTo(low, step); tick <= ceilTo(high, step); tick += step) tickValues.push(centsToAmount(tick));

  const compact = (value: number) => formatMoney(value, { compact: true });
  const labels = tickValues.map(compact);
  const format =
    new Set(labels).size === labels.length
      ? compact
      : step >= 100
        ? (value: number) => formatMoney(value, { wholeUnits: true })
        : (value: number) => formatMoney(value);
  return {
    min: tickValues[0] ?? centsToAmount(low),
    max: tickValues[tickValues.length - 1] ?? centsToAmount(high),
    tickValues,
    format,
  };
}

/** The multiple of `step` at or below `cents` (whole numbers both: exact, no float division). */
const floorTo = (cents: number, step: number): number => cents - (((cents % step) + step) % step);
/** The multiple of `step` at or above `cents`. */
const ceilTo = (cents: number, step: number): number => -floorTo(-cents, step);
