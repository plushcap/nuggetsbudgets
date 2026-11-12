import { formatMoney } from '@nuggets/shared';

/**
 * An amount in accounting style: a negative one in parentheses, ($12.50). The app has one money
 * formatter, formatMoney from @nuggets/shared: show an amount with it, and with
 * this for the accounting style; `npm run lint:guard` refuses an Intl currency format written by
 * hand. It never shows a negative zero: -0.004 is $0.00.
 */
export const formatCurrency = (amount: number): string => formatMoney(amount, { negative: 'parentheses' });

/**
 * A dollar amount in whole cents. Most two-decimal amounts have no exact
 * float (0.1 + 0.2 !== 0.3), but their cents are integers, which add and compare
 * exactly: add money in cents, and compare amounts by their cents.
 */
export const toCents = (amount: number): number => Math.round(amount * 100);

/** An amount as the API sends it (pg's NUMERIC text, or a number) in whole cents; 0 when it isn't one. */
export const centsOf = (value: unknown): number => toCents(parseFloat(String(value)) || 0);

/**
 * Whole cents as a dollar amount with at most two decimals: 103031 is 1030.31, the
 * double nearest it, which the box shows and JSON sends as 1030.31, as the API's toCents
 * reads it. A float sum isn't one (1030.3100000000002), and the API refuses it. -0 is 0.
 */
export const centsToAmount = (cents: number): number => cents / 100 || 0;

/**
 * `amount` spread over `months` (at least one), rounded up to the cent, so putting that aside
 * each month does get there. In whole cents, so an exact amount stays exact:
 * Math.ceil(x * 100) / 100 asked for 150.31 of 150.30, whose 150.3 * 100 is 15030.000000000002.
 * Whole cents divided by whole months is exact, or far enough from a whole number to round up.
 */
export const perMonthRoundedUp = (amount: number, months: number): number =>
  centsToAmount(Math.ceil(toCents(amount) / Math.max(1, months)));
