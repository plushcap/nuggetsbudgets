/**
 * Pure, DB-free look-through aggregation.
 * Validates composition weight totals and resolves portfolio exposure along a
 * dimension by combining direct holdings (100% to their own classification) and
 * pass-through funds (weighted by their latest composition snapshot).
 *
 * Exact: a market value is read, as the database gives it (SUM(shares) × close) or
 * as a number, at SHARE_VALUE_SCALE (10^-10 dollars), and a weight at its column's 6 places;
 * the allocation and the sums are bigints, and each amount is rounded to cents once. The
 * pieces of a total are rounded together, by largest remainder, so their cents add up to the
 * total's. A percentage is a ratio of those exact sums.
 *
 * Order-free: the rows are put in a fixed order before anything is shared out (a
 * fund's rows by underlying security id, then ticker; a composition's by its value), and the
 * results too (by amount, then security id and ticker, or bucket name), so a 10^-10 dollar or
 * a cent that rounding leaves goes to the same row whatever order the database sent them in.
 */

import type { LookThroughAnswer } from '@nuggets/shared';
import { invalidRequestError } from '../controlPlaneErrors.js';
import {
  CENTS, SHARE_VALUE_SCALE, WEIGHT_PERCENT, centsNumber, numericUnits, percentOf, pow10, requestUnits, shareValueToCents, unitsToNumber,
  type AnswerDecimal, type DecimalValue,
} from '../../utils/decimal.js';
import { present } from '../../utils/present.js';

export const WEIGHT_MIN = 95;
export const WEIGHT_MAX = 105;

export interface CompositionRow {
  dimensionValue: string;
  /** Percent, as the column holds it (text) or a number. */
  weightPercentage: DecimalValue;
}

/** A whole percentage, in the millionths of a percent a weight is read in. */
const percentUnits = (percent: number) => BigInt(percent) * pow10(WEIGHT_PERCENT.scale);
/** A stored weight (or a number), in millionths of a percent. */
const storedWeight = (weight: DecimalValue) => numericUnits(weight, WEIGHT_PERCENT.scale);
/** A market value (the database's text, or a number), in 10^-10 dollars. */
const valueUnits = (value: DecimalValue) => numericUnits(value, SHARE_VALUE_SCALE);
/** 10^-10 dollars as dollars, rounded to cents. */
const dollars = (units: bigint) => centsNumber(shareValueToCents(units));
/** Text in code-unit order: the same on every server, whatever its locale. */
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compareUnits = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
/**
 * By underlying security. Its id decides: a fund's latest snapshot has one row per underlying
 * security (fund_underlying_holdings_natural_key), and its ticker is the securities row's.
 */
const bySecurity = (a: { securityId: number }, b: { securityId: number }) => a.securityId - b.securityId;
/** Floor of `numerator / denominator`, for a positive denominator (BigInt division truncates toward zero). */
const floorDiv = (numerator: bigint, denominator: bigint) => {
  const quotient = numerator / denominator;
  return numerator % denominator !== 0n && numerator < 0n ? quotient - 1n : quotient;
};
/** 10^-10 dollars in a cent. */
const UNITS_PER_CENT = pow10(SHARE_VALUE_SCALE - CENTS.scale);

/**
 * `parts` (10^-10 dollars) in cents that add up to their sum, rounded to cents (largest
 * remainder): each part is rounded down, and the cents still owed go one at a time to
 * the parts with the largest remainders, ties to the earlier one. Rounded each on its own,
 * three thirds of $1.00 were $0.99, and three $0.335 holdings $1.02 of $1.01.
 */
export function centsAddingUp(parts: bigint[]): bigint[] {
  const total = shareValueToCents(parts.reduce((s, p) => s + p, 0n));
  const floor = (units: bigint) => (units >= 0n || units % UNITS_PER_CENT === 0n ? units / UNITS_PER_CENT : units / UNITS_PER_CENT - 1n);
  const shares = parts.map((p, i) => ({ i, cents: floor(p), remainder: p - floor(p) * UNITS_PER_CENT }));
  let owed = total - shares.reduce((s, x) => s + x.cents, 0n);
  const order = [...shares].sort((a, b) => (a.remainder < b.remainder ? 1 : a.remainder > b.remainder ? -1 : a.i - b.i));
  for (const share of order) {
    if (owed <= 0n) break;
    share.cents += 1n;
    owed -= 1n;
  }
  return shares.map((x) => x.cents);
}

/**
 * `value` spread over `weights` in proportion to them, exactly, by largest remainder:
 * each piece is rounded down to the unit, and the units still owed go one each to the pieces
 * with the largest remainders, ties to the earlier one. The pieces add up to `value`, and none
 * is negative when the weights aren't. (The last row used to take what the others left, so
 * which row got the rounding followed the order they came in.) The caller orders the rows.
 */
function allocate(value: bigint, weights: bigint[]): bigint[] {
  const weightSum = weights.reduce((s, w) => s + w, 0n);
  if (weightSum <= 0n) return weights.map(() => 0n);
  const shares = weights.map((w, i) => {
    const piece = floorDiv(value * w, weightSum);
    return { i, piece, remainder: value * w - piece * weightSum };
  });
  let owed = value - shares.reduce((s, x) => s + x.piece, 0n);
  // Shared out exactly: nothing to give by remainder.
  if (owed <= 0n) return shares.map((x) => x.piece);
  const order = [...shares].sort((a, b) => compareUnits(b.remainder, a.remainder) || a.i - b.i);
  for (const share of order) {
    if (owed <= 0n) break;
    share.piece += 1n;
    owed -= 1n;
  }
  return shares.map((x) => x.piece);
}

/**
 * The weights as sent, summed exactly: each read to the column's 6 places,
 * so 20,000 holdings of 0.005% sum to 100, not to a float near it.
 */
function weightUnits(rows: Array<{ weightPercentage: DecimalValue }>): bigint[] {
  return rows.map((r) => requestUnits(r.weightPercentage, 'weight_percentage', WEIGHT_PERCENT));
}

/**
 * Validate that the weights for one (security, dimension, snapshot) sum within
 * the 95–105% tolerance. Returns the sum; throws on failure.
 */
export function validateCompositionWeights(rows: Array<{ dimensionValue?: string; weightPercentage: DecimalValue }>): number {
  const total = weightUnits(rows).reduce((s, w) => s + w, 0n);
  const sum = unitsToNumber(total, WEIGHT_PERCENT.scale);
  if (total < percentUnits(WEIGHT_MIN) || total > percentUnits(WEIGHT_MAX)) {
    throw invalidRequestError(`error: composition weights sum to ${sum}%, must be within ${WEIGHT_MIN}-${WEIGHT_MAX}%`);
  }
  return sum;
}

export interface LookThroughHolding {
  securityId: number;
  ticker: string;
  /** Dollars, as the database gives it (text) or a number. */
  marketValue: DecimalValue;
  isPassThrough: boolean;
  /** Own classification for the requested dimension when not pass-through. */
  ownDimensionValue: string | null;
  /** Latest composition rows for the requested dimension when pass-through. */
  composition: CompositionRow[] | null;
}

/**
 * Aggregate exposure along one dimension. Direct holdings attribute 100% to their
 * own classification; pass-through funds distribute value by composition weights;
 * pass-through funds with no composition land in an 'unknown' bucket.
 * The answer is @nuggets/shared's LookThroughAnswer, which the route completes with its
 * dimension (one type, with its schema, for the backend and the frontend).
 */
export function computeLookThrough(holdings: LookThroughHolding[]): Omit<LookThroughAnswer, 'dimension'> {
  const totals = new Map<string, bigint>();
  let unknownValue = 0n;
  let totalValue = 0n;

  for (const h of holdings) {
    const marketValue = valueUnits(h.marketValue);
    totalValue += marketValue;
    if (!h.isPassThrough) {
      const key = h.ownDimensionValue ?? 'unknown';
      add(totals, key, marketValue);
      if (key === 'unknown') unknownValue += marketValue;
      continue;
    }
    if (!h.composition || h.composition.length === 0) {
      add(totals, 'unknown', marketValue);
      unknownValue += marketValue;
      continue;
    }
    // Normalize by the actual weight sum so off-by-tolerance snapshots still
    // allocate exactly the position's market value. In a fixed order.
    const rows = h.composition
      .map((c) => ({ dimensionValue: c.dimensionValue, weight: storedWeight(c.weightPercentage) }))
      .sort((a, b) => compareText(a.dimensionValue, b.dimensionValue) || compareUnits(a.weight, b.weight));
    const pieces = allocate(marketValue, rows.map((r) => r.weight));
    rows.forEach((r, i) => add(totals, r.dimensionValue, present(pieces[i], 'a piece for each row')));
  }

  // The buckets share out the total exactly, so their cents add up to the total's. Largest
  // first; equal ones by name, so a tied cent goes to the same one every time.
  const sorted = [...totals.entries()]
    .map(([dimensionValue, units]) => ({ dimensionValue, units }))
    .sort((a, b) => compareUnits(b.units, a.units) || compareText(a.dimensionValue, b.dimensionValue));
  const cents = centsAddingUp(sorted.map((b) => b.units));
  const buckets = sorted.map((b, i) => ({ dimensionValue: b.dimensionValue, amount: centsNumber(present(cents[i], 'cents for each bucket')), percentage: percentOf(b.units, totalValue) }));
  // The same figure as the unknown bucket's when it is all of that bucket.
  const unknownIndex = sorted.findIndex((b) => b.dimensionValue === 'unknown');
  const unknown = sorted[unknownIndex];
  const unknownCents = cents[unknownIndex];
  const unknownAmount = unknown && unknownCents !== undefined && unknown.units === unknownValue ? centsNumber(unknownCents) : dollars(unknownValue);

  return { totalValue: dollars(totalValue), buckets, unknownValue: unknownAmount };
}

function add(map: Map<string, bigint>, key: string, amount: bigint): void {
  map.set(key, (map.get(key) ?? 0n) + amount);
}

// ----------------------------------------------------------------------------
// Holdings-level look-through: resolve every position down to the
// individual underlying securities ("all the way to stocks"), recursing through
// funds-of-funds, so "what is my total exposure to ACMEC?" can be answered.
// ----------------------------------------------------------------------------

/** Max recursion depth for fund-of-funds resolution (cycle/runaway guard). */
export const MAX_LOOKTHROUGH_DEPTH = 8;

/** One security a fund holds, as the exposure math reads it (the route's row is @nuggets/shared's UnderlyingHoldingRow). */
export interface UnderlyingWeightRow {
  underlyingSecurityId: number;
  underlyingTicker: string;
  /** Percent, as the column holds it (text) or a number. */
  weightPercentage: DecimalValue;
}

export interface ExposureHolding {
  securityId: number;
  ticker: string;
  /** Dollars, as the database gives it (text) or a number. */
  marketValue: DecimalValue;
  /** True for funds (composition/holdings carriers). Opaque funds → unknown. */
  isPassThrough: boolean;
}

/** Its amounts are answers' (AnswerDecimal: exact text when a number can't hold them). */
export interface UnderlyingExposureBucket {
  securityId: number;
  ticker: string;
  amount: AnswerDecimal;
  percentage: number;
}

export interface UnderlyingExposureResult {
  totalValue: AnswerDecimal;
  /** Value that could not be resolved to a leaf security (opaque funds, residual/cash). */
  unknownValue: AnswerDecimal;
  /** Each security worth a cent or more. */
  exposures: UnderlyingExposureBucket[];
  /** The securities worth less than a cent each, not listed: how many, and their sum. */
  belowACent: { securities: number; amount: AnswerDecimal; percentage: number };
}

/** The most rows one fund's underlying-holdings snapshot may have. */
export const MAX_UNDERLYING_HOLDINGS = 20000;

/**
 * Validate a fund's underlying-holdings weights: each in (0,100], sum ≤ 105%
 * (≤100 normally; the residual under 100% is unaccounted/cash, which is fine and
 * lands in the unknown bucket on look-through). Over 100% (a fund that borrows, or a
 * snapshot that doesn't quite add up) is allowed too; look-through then scales the
 * weights down to 100%, so the fund's exposures add up to its value, not more.
 * Throws on failure. Returns the sum.
 */
export function validateUnderlyingWeights(rows: Array<{ weightPercentage: DecimalValue }>): number {
  if (rows.length === 0) throw invalidRequestError('error: underlying holdings must include at least one row');
  if (rows.length > MAX_UNDERLYING_HOLDINGS) throw invalidRequestError(`error: underlying holdings capped at ${MAX_UNDERLYING_HOLDINGS} rows, got ${rows.length}`);
  const weights = weightUnits(rows);
  for (const w of weights) {
    if (w <= 0n || w > percentUnits(100)) {
      throw invalidRequestError(`error: underlying weight ${unitsToNumber(w, WEIGHT_PERCENT.scale)}% must be > 0 and ≤ 100`);
    }
  }
  const total = weights.reduce((s, w) => s + w, 0n);
  if (total > percentUnits(WEIGHT_MAX)) {
    throw invalidRequestError(`error: underlying weights sum to ${unitsToNumber(total, WEIGHT_PERCENT.scale)}%, must be ≤ ${WEIGHT_MAX}%`);
  }
  return unitsToNumber(total, WEIGHT_PERCENT.scale);
}

/**
 * Resolve portfolio exposure to individual underlying securities. Each position
 * is pushed through `underlyingMap` (latest underlying-holdings snapshot per
 * fund, keyed by securityId); funds-of-funds recurse until a leaf is reached.
 * A leaf that is a non-pass-through security attributes its value to itself; a
 * pass-through fund with no holdings data (or the unallocated residual of a fund
 * whose weights sum < 100%) lands in `unknownValue`. A fund whose weights sum over 100%
 * is spread in proportion to them, scaled to 100%: its pieces add up to its value, so
 * the exposures and the unknown never add up to more than the total (60% + 45%
 * of $100 was $105). A security already on the
 * current resolution path is treated as a leaf (cycle guard), as is anything
 * past MAX_LOOKTHROUGH_DEPTH.
 */
export function computeUnderlyingExposure(
  holdings: ExposureHolding[],
  underlyingMap: Map<number, UnderlyingWeightRow[]>,
  passThroughIds: Set<number>,
): UnderlyingExposureResult {
  const exposure = new Map<number, { ticker: string; amount: bigint }>();
  let unknownValue = 0n;
  let totalValue = 0n;
  const hundredPercent = percentUnits(100);

  const addExposure = (securityId: number, ticker: string, amount: bigint) => {
    const cur = exposure.get(securityId);
    if (!cur) exposure.set(securityId, { ticker, amount });
    else cur.amount += amount;
  };

  // Each fund's rows in their fixed order, with the weights they are shared out by, worked out
  // once per call: a fund held through several funds-of-funds is visited once for each, and
  // read and sorted its rows each time.
  const prepared = new Map<number, { ordered: Array<{ securityId: number; ticker: string }>; shares: bigint[]; shortfall: bigint }>();
  const prepare = (securityId: number, rows: UnderlyingWeightRow[]) => {
    const known = prepared.get(securityId);
    if (known) return known;
    // In a fixed order, so the rounding goes to the same row every time.
    const ordered = rows
      .map((r) => ({ securityId: r.underlyingSecurityId, ticker: r.underlyingTicker, weight: storedWeight(r.weightPercentage) }))
      .sort((a, b) => bySecurity(a, b) || compareUnits(a.weight, b.weight));
    const weights = ordered.map((r) => r.weight);
    const weightSum = weights.reduce((s, w) => s + w, 0n);
    // Weights summing < 100% leave a residual (cash / unaccounted) → unknown: a share of its
    // own, so the pieces and it add up to the value. Over 100%, the weights are scaled to it.
    const shortfall = weightSum < hundredPercent ? hundredPercent - weightSum : 0n;
    const fund = { ordered, shares: shortfall > 0n ? [...weights, shortfall] : weights, shortfall };
    prepared.set(securityId, fund);
    return fund;
  };

  const resolve = (securityId: number, ticker: string, value: bigint, depth: number, path: Set<number>) => {
    const rows = underlyingMap.get(securityId);
    const canExpand = rows && rows.length > 0 && depth < MAX_LOOKTHROUGH_DEPTH && !path.has(securityId);
    if (!canExpand) {
      // Leaf. A pass-through fund we can't see through is opaque → unknown.
      if (passThroughIds.has(securityId)) unknownValue += value;
      else addExposure(securityId, ticker, value);
      return;
    }
    const nextPath = new Set(path);
    nextPath.add(securityId);
    const { ordered, shares, shortfall } = prepare(securityId, rows!);
    const pieces = allocate(value, shares);
    ordered.forEach((r, i) => resolve(r.securityId, r.ticker, present(pieces[i], 'a piece for each row'), depth + 1, nextPath));
    // The shortfall's share is the last piece (prepare adds its weight last).
    if (shortfall > 0n) unknownValue += present(pieces[ordered.length], "the shortfall's piece");
  };

  for (const h of holdings) {
    const marketValue = valueUnits(h.marketValue);
    if (marketValue <= 0n) continue;
    totalValue += marketValue;
    resolve(h.securityId, h.ticker, marketValue, 0, new Set());
  }

  // Largest first; equal ones by security id, then ticker.
  const sorted = [...exposure.entries()]
    .map(([securityId, v]) => ({ securityId, ticker: v.ticker, units: v.amount }))
    .sort((a, b) => compareUnits(b.units, a.units) || bySecurity(a, b));
  // A security worth less than a cent isn't listed (a sliver of a fund, a tiny weight
  // or a small holding spread over many securities, was listed at $0.00). Which ones those are
  // is decided by each one's own value: decided by its rounded cents, of two identical
  // slivers the one with the lower id could get the cent left over and be listed, the other
  // not. They are summed instead, as one piece, so the listed ones, that sum and the unknown
  // share out the total and their cents are rounded together (each listed one has at least
  // its cent), and their percentages, each of the total and each rounded to 2 places on its own,
  // add up to 100 to within that rounding: with the slivers dropped, the listed percentages fell
  // short of it by the slivers' share while their value stayed in what resolved.
  const listed = sorted.filter((e) => e.units >= UNITS_PER_CENT);
  const slivers = sorted.filter((e) => e.units > 0n && e.units < UNITS_PER_CENT);
  const sliverUnits = slivers.reduce((s, e) => s + e.units, 0n);
  const cents = centsAddingUp([...listed.map((e) => e.units), sliverUnits, unknownValue]);
  // One figure per part, in the order given (the ?? only satisfies the index's type).
  const centsAt = (i: number) => centsNumber(cents[i] ?? 0n);
  const exposures: UnderlyingExposureBucket[] = listed.map((e, i) =>
    ({ securityId: e.securityId, ticker: e.ticker, amount: centsAt(i), percentage: percentOf(e.units, totalValue) }));

  return {
    totalValue: dollars(totalValue),
    unknownValue: centsAt(listed.length + 1),
    exposures,
    belowACent: { securities: slivers.length, amount: centsAt(listed.length), percentage: percentOf(sliverUnits, totalValue) },
  };
}
