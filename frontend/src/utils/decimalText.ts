import { trimTrailingZeros } from '@nuggets/shared';

/**
 * Decimal text a form sends as typed. The API reads a share count, a ratio or a
 * percentage exactly, at its column's scale, and refuses one with more decimal places than
 * the column keeps. So a page sends the text, never a float worked out from it:
 * `Number('14.3') / 100` is 0.14300000000000002, which the API refuses (more than 6 places),
 * and `Number('123456789012.123456')` is 123456789012.12346, which it would store.
 */

const PLAIN_DECIMAL = /^(\d*)(?:\.(\d*))?$/;

/**
 * The fraction `percent` is, as exact decimal text: the decimal point moved two places to
 * the left ('14.3' is '0.143', '100' is '1', '0.5' is '0.005'). Null when the text isn't a
 * plain decimal of zero or more ('', '-1', '1e2', '1.2.3').
 */
export function percentToFraction(percent: string): string | null {
  const match = PLAIN_DECIMAL.exec(percent.trim());
  if (!match) return null;
  const [, whole = '', fraction = ''] = match;
  if (whole === '' && fraction === '') return null;
  const digits = `${whole.padStart(3, '0')}${fraction}`;
  const point = digits.length - fraction.length - 2;
  const integer = digits.slice(0, point).replace(/^0+(?=\d)/, '');
  const decimals = trimTrailingZeros(digits.slice(point));
  return decimals ? `${integer}.${decimals}` : integer;
}

/** How many decimal places decimal text has, trailing zeros not counted: '0.1430' has 3. */
export function decimalPlaces(text: string): number {
  const point = text.indexOf('.');
  return point === -1 ? 0 : trimTrailingZeros(text.slice(point + 1)).length;
}

/**
 * Why `text`, typed in a number field (a share count, a split or merger ratio), isn't a
 * number the API takes, as a message for the field; null when it is. A `type="number"`
 * field takes `1e2`, which the API refuses: the form asks for a plain decimal, above
 * zero (or zero, with `allowZero`), with at most `places` decimal places.
 */
export function decimalTextProblem(text: string, places: number, { allowZero = false }: { allowZero?: boolean } = {}): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return 'Enter a number.';
  const match = PLAIN_DECIMAL.exec(trimmed);
  if (!match || (match[1] === '' && (match[2] ?? '') === '')) return 'Enter a plain number, like 12.5, without an exponent or a sign.';
  if (decimalPlaces(trimmed) > places) return `Enter at most ${places} decimal places.`;
  if (!allowZero && !/[1-9]/.test(trimmed)) return 'Enter a number above zero.';
  return null;
}

/**
 * Plain decimal text as a whole number of 10^-places units, exactly ('12.5' at 6 places is
 * 12500000n), to add or compare share counts without a float; null when it isn't a plain
 * decimal with at most `places` decimal places.
 */
export function decimalUnits(text: string, places: number): bigint | null {
  const trimmed = text.trim();
  const match = PLAIN_DECIMAL.exec(trimmed);
  if (!match) return null;
  const [, whole = '', fraction = ''] = match;
  if (whole === '' && fraction === '') return null;
  const kept = trimTrailingZeros(fraction);
  if (kept.length > places) return null;
  return BigInt(`${whole || '0'}${kept.padEnd(places, '0')}`);
}

/** `units` of 10^-places as plain text, without trailing zeros: 12500000n at 6 places is '12.5'. */
export function unitsText(units: bigint, places: number): string {
  const sign = units < 0n ? '-' : '';
  const digits = (units < 0n ? -units : units).toString().padStart(places + 1, '0');
  const fraction = trimTrailingZeros(digits.slice(digits.length - places));
  const whole = digits.slice(0, digits.length - places);
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}
