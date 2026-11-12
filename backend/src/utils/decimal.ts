/**
 * Exact fixed-point arithmetic for the decimals that aren't 2-decimal money: share
 * counts, prices per share, ratios, percentages. A NUMERIC(precision, scale) value is held
 * as a bigint of 10^-scale units (12.5 shares at scale 6 is 12_500_000n), so a product or a
 * quotient is exact until it is rounded, once, to the scale of the column it is written to.
 * utils/money.ts does the same for money in whole cents; a bigint of cents here is the same
 * figure (use `BigInt(cents)` / `Number(cents)` between them).
 *
 * Read a request value with {@link requestUnits} (the shared decimalInput has already
 * checked it), a NUMERIC the database returned with {@link numericUnits}, and write a result
 * with {@link unitsToText} (exact text, which pg hands to NUMERIC as written) or answer it
 * with {@link unitsToNumber}. Pure, no DB.
 */
import { readDecimal, decimalMaxText, decimalProblemMessage } from '@nuggets/shared';
import { ControlPlaneError } from '../services/controlPlaneErrors.js';
import { invalidAmountAnswer, readCents } from './money.js';

/** A request decimal as the shared decimalInput and moneyInput pass it on: a JSON number, or decimal text. */
export type DecimalValue = number | string;

/** A NUMERIC column's shape. */
export interface DecimalColumn {
  precision: number;
  scale: number;
}

/** Share counts and split/merger ratios: tax_lots, holding_events, security_corporate_actions NUMERIC(18,6). */
export const SHARES: DecimalColumn = { precision: 18, scale: 6 };
/** A price or an amount per share: security_prices, holding_events, tax_lots, dividend_records NUMERIC(12,4). */
export const PER_SHARE: DecimalColumn = { precision: 12, scale: 4 };
/** Money: every amount column, NUMERIC(12,2). */
export const CENTS: DecimalColumn = { precision: 12, scale: 2 };
/** A fund weight in percent: fund_compositions, fund_underlying_holdings NUMERIC(9,6). */
export const WEIGHT_PERCENT: DecimalColumn = { precision: 9, scale: 6 };
/** An annual expense ratio in percent: securities NUMERIC(6,4). */
export const EXPENSE_RATIO_PERCENT: DecimalColumn = { precision: 6, scale: 4 };
/** A spinoff's allocation fraction, 0 to 1, read to 6 places (it's kept in event metadata). */
export const FRACTION: DecimalColumn = { precision: 7, scale: 6 };
/** A whole number below 10^18 (security_prices.volume, a bigint). */
export const WHOLE: DecimalColumn = { precision: 18, scale: 0 };
/**
 * The scale of a share count × a per-share figure, 10^-10 dollars: what SQL's
 * SUM(shares_remaining) * close gives, exactly. A report sums market values at this scale and
 * rounds each total to cents once (a lot's basis is its total_cost_basis, in cents).
 */
export const SHARE_VALUE_SCALE = SHARES.scale + PER_SHARE.scale;

/** 10^n. */
export function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/** `numerator / denominator`, rounded half away from zero, as Postgres rounds a NUMERIC. */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('division by zero');
  const n = denominator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d; // truncates toward zero
  const remainder = n % d;
  if (2n * (remainder < 0n ? -remainder : remainder) >= d) return n < 0n ? quotient - 1n : quotient + 1n;
  return quotient;
}

/** `units` at scale `from`, at scale `to`: exact when `to` has more places, else rounded half away from zero. */
export function rescale(units: bigint, from: number, to: number): bigint {
  return to >= from ? units * pow10(to - from) : divRound(units, pow10(from - to));
}

/** `units` of 10^-scale as exact decimal text: unitsToText(125000n, 4) is "12.5000". */
export function unitsToText(units: bigint, scale: number): string {
  const magnitude = units < 0n ? -units : units;
  const sign = units < 0n ? '-' : '';
  if (scale === 0) return `${sign}${magnitude}`;
  const digits = magnitude.toString().padStart(scale + 1, '0');
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** A value of {@link SHARE_VALUE_SCALE} units in cents, rounded once (half away from zero). */
export function shareValueToCents(units: bigint): bigint {
  return rescale(units, SHARE_VALUE_SCALE, CENTS.scale);
}

/**
 * A figure for a JSON answer: a number, or exact decimal text when a number can't hold it.
 * @nuggets/shared's response schemas take either (responseAmount, responseDecimal).
 */
export type AnswerDecimal = number | string;

/**
 * Below this many units a figure has at most 15 significant digits, which a double holds
 * exactly (a decimal of up to 15 digits converts to one and back unchanged, DBL_DIG).
 */
const EXACT_IN_A_DOUBLE = 10n ** 15n;

/**
 * `units` of 10^-scale for a JSON answer: a number while a double holds it exactly, else its
 * exact decimal text. Stored shares at a stored price make up to 10^20 dollars a
 * lot: as a double, a figure past 10^13 dollars lost its cents, and from 10^21 JSON wrote it
 * with an exponent, which every amount schema refused.
 */
export function answerUnits(units: bigint, scale: number): AnswerDecimal {
  const magnitude = units < 0n ? -units : units;
  return magnitude < EXACT_IN_A_DOUBLE ? unitsToNumber(units, scale) : unitsToText(units, scale);
}

/** `cents` as dollars for a JSON answer: a number, or exact text when a double can't hold it (answerUnits). */
export function centsNumber(cents: bigint): AnswerDecimal {
  return answerUnits(cents, CENTS.scale);
}

/**
 * `part` as a percentage of `whole` (both in the same units), to 2 places, for a report:
 * a ratio, not money, so a double, but taken from exact sums. 0 when `whole` isn't positive.
 */
export function percentOf(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  return Math.round((Number(part) / Number(whole)) * 10_000) / 100;
}

/** `units` of 10^-scale as a number (the nearest double), for a JSON answer or a log line. */
export function unitsToNumber(units: bigint, scale: number): number {
  return Number(unitsToText(units, scale));
}

/**
 * A request value for `column`, in units: the decimalInput (or moneyInput) schema checked its
 * form, and this reads it exactly, refusing what that column can't hold as written with a 400
 * (INVALID_NUMBER) that names `field`.
 */
export function requestUnits(value: unknown, field: string, column: DecimalColumn): bigint {
  const read = readDecimal(value, column.scale, column.precision);
  if ('problem' in read) {
    throw new ControlPlaneError(400, 'INVALID_NUMBER', decimalProblemMessage(`${field} must be a number`, read.problem, column.scale, column.precision));
  }
  return read.units;
}

/** Whether `units` fits `column` (a result of arithmetic on values that each did may not). */
export function fitsColumn(units: bigint, column: DecimalColumn): boolean {
  return (units < 0n ? -units : units) < pow10(column.precision);
}

/**
 * Refuse, with a 400, a result too large for the column it would be written to, which
 * Postgres would refuse with an error (a 500): "The lot's cost basis is larger than can be
 * stored (at most 9,999,999,999.99)". INVALID_AMOUNT for money, else INVALID_NUMBER.
 */
export function assertFits(units: bigint, column: DecimalColumn, what: string): void {
  if (fitsColumn(units, column)) return;
  const code = column.scale === CENTS.scale && column.precision === CENTS.precision ? 'INVALID_AMOUNT' : 'INVALID_NUMBER';
  throw new ControlPlaneError(400, code, `${what} is larger than can be stored (at most ${decimalMaxText(column.scale, column.precision)})`);
}

/**
 * A request amount in dollars (moneyInput), in cents as a bigint: readCents reads it, and
 * what it refuses is a 400 INVALID_AMOUNT that names `field` ("fees must be a number with at
 * most 2 decimal places").
 */
export function requestCents(value: unknown, field: string): bigint {
  const read = readCents(value);
  if (!('cents' in read)) {
    const answer = invalidAmountAnswer(field, read.problem);
    throw new ControlPlaneError(400, answer.code, answer.error);
  }
  return BigInt(read.cents);
}

/**
 * A NUMERIC the database returned (pg reads it as text: "100.000000"), in units of `scale`.
 * Exact for a column of that scale; a value with more places is rounded half away from zero.
 */
export function numericUnits(value: string | number, scale: number): bigint {
  const exact = readDecimal(value, scale, 1000);
  if ('units' in exact) return exact.units;
  const wide = readDecimal(value, 1000, 2000);
  // The value stays out of the message, which may be logged.
  if ('problem' in wide) throw new RangeError('The database returned a value that is not a NUMERIC');
  return rescale(wide.units, 1000, scale);
}
