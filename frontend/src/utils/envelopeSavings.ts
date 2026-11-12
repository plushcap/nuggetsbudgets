import { centsToAmount, perMonthRoundedUp, toCents } from './currency';

/**
 * What an envelope needs saved each month to reach its target by its target
 * date: what's left to save, spread over the months from `today` until then.
 *
 * Months are counted the way the bill form counts them to a payment date
 * (calendar months between the two, at least one), so a target this month or
 * already past asks for everything that's left now. Returns null without a
 * target amount or a target date — there is nothing to check against.
 */
export function requiredMonthlySavings(
  targetAmount: number,
  balance: number,
  targetDate: string | null | undefined,
  today: Date = new Date(),
): { amount: number; remaining: number; months: number } | null {
  if (!(targetAmount > 0) || !targetDate) return null;
  const [year, month] = targetDate.split('-').map(Number);
  if (!year || !month) return null;

  const months = Math.max(1, (year - today.getFullYear()) * 12 + (month - 1 - today.getMonth()));
  // In whole cents: 1000 − 849.70 is 150.29999999999995 in floats, and 150.30 left is 150.30.
  const remaining = centsToAmount(Math.max(0, toCents(targetAmount) - toCents(balance)));
  // Round up to the cent, so saving this much each month does get there.
  const amount = perMonthRoundedUp(remaining, months);
  return { amount, remaining, months };
}
