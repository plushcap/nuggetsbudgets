/**
 * Exact money arithmetic, in integer cents.
 *
 * Amounts are DECIMAL(12,2), but most of them have no exact binary float
 * (0.1 + 0.2 !== 0.3), so sums and comparisons of floats drift. A DECIMAL(12,2)
 * value is a whole number of cents below 10^12, which a double holds exactly,
 * so money math here is integer math on cents: parse at the boundary with
 * `toCents`, add and compare cents, and turn the result back into an amount
 * with `centsToAmount` (a string, for the database: pg hands it to NUMERIC as
 * written) or `centsToNumber` (for JSON). Pure, no DB.
 */
import { DECIMAL_TEXT_MAX_LENGTH, trimTrailingZeros } from '@nuggets/shared';

/** The largest |amount| a DECIMAL(12,2) column holds, in cents (9,999,999,999.99). */
export const MAX_AMOUNT_CENTS = 999_999_999_999;

const PLAIN_DECIMAL = /^([+-])?(\d*)(?:\.(\d*))?$/;

/**
 * Why a value isn't an amount: `format`, not a decimal number with at most two decimal
 * places (`45.678`, `abc`, `1e2`, or text longer than DECIMAL_TEXT_MAX_LENGTH, which isn't
 * read); `range`, one beyond what DECIMAL(12,2) holds.
 */
export type AmountProblem = 'format' | 'range';

/** {@link toCents}, saying why when the value isn't an amount. */
export function readCents(value: unknown): { cents: number } | { problem: AmountProblem } {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { problem: 'format' };
    if (Math.abs(value) >= 1e10) return { problem: 'range' };
    // The shortest decimal that reads back as this double: 45.67 -> "45.67". An
    // exponent form (1e-7) has too many decimals, and fails below.
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
    if (text.length > DECIMAL_TEXT_MAX_LENGTH) return { problem: 'format' };
  } else {
    return { problem: 'format' };
  }

  const match = PLAIN_DECIMAL.exec(text);
  if (!match) return { problem: 'format' };
  const [, sign, whole = '', fractionRaw = ''] = match;
  if (whole === '' && fractionRaw === '') return { problem: 'format' };
  const fraction = trimTrailingZeros(fractionRaw);
  if (fraction.length > 2) return { problem: 'format' };
  const digits = whole.replace(/^0+/, '');
  if (digits.length > 10) return { problem: 'range' };

  const cents = Number(digits || '0') * 100 + Number(fraction.padEnd(2, '0'));
  if (cents > MAX_AMOUNT_CENTS) return { problem: 'range' };
  if (cents === 0) return { cents: 0 };
  return { cents: sign === '-' ? -cents : cents };
}

/**
 * The exact number of cents in `value`, a number or a decimal string (pg reads
 * NUMERIC as one). Null when it isn't a finite amount with at most two decimal
 * places that fits DECIMAL(12,2): `45.678` is null rather than rounded, so the
 * caller can reject it before anything is stored or compared.
 */
export function toCents(value: unknown): number | null {
  const read = readCents(value);
  return 'cents' in read ? read.cents : null;
}

/** Whether `cents` fits a DECIMAL(12,2) column (a sum or a difference of amounts may not). */
export function fitsAmount(cents: number): boolean {
  return Math.abs(cents) <= MAX_AMOUNT_CENTS;
}

/** The largest amount, as people read it: "9,999,999,999.99". */
export const MAX_AMOUNT_TEXT = '9,999,999,999.99';

/**
 * The 400 answer for request field `field` that {@link readCents} refused, in the API's
 * error shape: { error, code: 'INVALID_AMOUNT' }.
 */
export function invalidAmountAnswer(field: string, problem: AmountProblem): { error: string; code: 'INVALID_AMOUNT' } {
  return {
    error: problem === 'range'
      ? `${field} must be between -${MAX_AMOUNT_TEXT} and ${MAX_AMOUNT_TEXT}`
      : `${field} must be a number with at most 2 decimal places`,
    code: 'INVALID_AMOUNT',
  };
}

/**
 * The cents in a two-decimal NUMERIC the database computed, such as a SUM, which
 * may be larger than one DECIMAL(12,2) holds; 0 for null. Exact for any such value
 * below about 10^13: the float's error is far under half a cent.
 */
export function numericToCents(value: string | number | null | undefined): number {
  return value == null ? 0 : Math.round(Number(value) * 100);
}

/** `cents` as a decimal string ("-45.67"), exact, for writing to a NUMERIC column. */
export function centsToAmount(cents: number): string {
  const magnitude = Math.abs(cents);
  const whole = Math.floor(magnitude / 100);
  const fraction = String(magnitude % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${whole}.${fraction}`;
}

/** `cents` as a number of dollars (-45.67), for a JSON response or a log line. */
export function centsToNumber(cents: number): number {
  return cents / 100;
}
