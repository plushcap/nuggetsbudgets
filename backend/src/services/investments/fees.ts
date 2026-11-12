/**
 * Pure fee / cost-of-ownership math. Imputed expense-ratio drag is an
 * ESTIMATE (clearly labeled in reports) of annual fund operating cost:
 *   averageHoldingValue × (expenseRatioPct / 100) × (daysHeld / 365)
 *
 * Exact: a holding's value is read at SHARE_VALUE_SCALE (as SQL's SUM(shares) × close
 * gives it), the ratio and the days as decimals, and the drag is figured in cents, rounded
 * once; the effective cost is a ratio of exact figures.
 */

import type { CostOfOwnershipFiguresAnswer } from '@nuggets/shared';
import {
  CENTS, EXPENSE_RATIO_PERCENT, SHARE_VALUE_SCALE, centsNumber, divRound, numericUnits, pow10, shareValueToCents, type AnswerDecimal, type DecimalValue,
} from '../../utils/decimal.js';

export const DAYS_PER_YEAR = 365;
/** Days held are read to this many places (182.5 is half a year). */
const DAYS_SCALE = 6;

/** The drag in cents: value (10^-10 $) × ratio (10^-4 %) / 100 × days (10^-6) / 365, as cents. */
function dragCents(value: bigint, ratio: bigint, days: bigint): bigint {
  if (value <= 0n || ratio <= 0n || days <= 0n) return 0n;
  // cents = value/10^10 × ratio/10^4 / 100 × days/10^6 / 365 × 100.
  return divRound(value * ratio * days, pow10(SHARE_VALUE_SCALE + EXPENSE_RATIO_PERCENT.scale + DAYS_SCALE) * BigInt(DAYS_PER_YEAR));
}

/** Imputed expense-ratio drag in dollars for a holding over a period. */
export function expenseRatioDrag(averageHoldingValue: DecimalValue, expenseRatioPct: DecimalValue, daysHeld: DecimalValue = DAYS_PER_YEAR): AnswerDecimal {
  return centsNumber(dragCents(
    numericUnits(averageHoldingValue, SHARE_VALUE_SCALE),
    numericUnits(expenseRatioPct, EXPENSE_RATIO_PERCENT.scale),
    numericUnits(daysHeld, DAYS_SCALE),
  ));
}

export interface CostOfOwnershipInput {
  /** Dollars, as the database gives it (text) or a number. */
  averageHoldingValue: DecimalValue;
  expenseRatioPct: DecimalValue | null;
  /** Dollars (a SUM of amounts, or a number). */
  explicitFees: DecimalValue;
  daysHeld?: DecimalValue;
}

/** A holding's explicit fees, imputed drag, their total, and that as a % of its average value (@nuggets/shared). */
export type { CostOfOwnershipFigures, CostOfOwnershipFiguresAnswer } from '@nuggets/shared';

/** Combine explicit fees with imputed drag into a total cost of ownership. */
export function costOfOwnership(input: CostOfOwnershipInput): CostOfOwnershipFiguresAnswer {
  const value = numericUnits(input.averageHoldingValue, SHARE_VALUE_SCALE);
  const imputedDrag = input.expenseRatioPct != null
    ? dragCents(value, numericUnits(input.expenseRatioPct, EXPENSE_RATIO_PERCENT.scale), numericUnits(input.daysHeld ?? DAYS_PER_YEAR, DAYS_SCALE))
    : 0n;
  const explicitFees = numericUnits(input.explicitFees, CENTS.scale);
  const totalCost = explicitFees + imputedDrag;
  // The total cost (cents) as a percentage of the value (10^-10 $): a ratio, to 2 places.
  const effectiveCostPct = value > 0n ? Math.round((Number(totalCost * pow10(SHARE_VALUE_SCALE - CENTS.scale)) / Number(value)) * 10_000) / 100 : 0;
  return { explicitFees: centsNumber(explicitFees), imputedDrag: centsNumber(imputedDrag), totalCost: centsNumber(totalCost), effectiveCostPct };
}

/** A holding's value (10^-10 $, as text or a number) in dollars, to the cent. */
export function holdingValueDollars(value: DecimalValue): AnswerDecimal {
  return centsNumber(shareValueToCents(numericUnits(value, SHARE_VALUE_SCALE)));
}
