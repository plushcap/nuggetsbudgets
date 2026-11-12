/**
 * Pure reconciliation math. Flags a discrepancy when the calculated
 * holdings value differs from the broker-imported balance by more than the
 * threshold — default max(1%, $50). DB-free and unit-testable.
 *
 * In cents: the two sides are bigints of cents, their difference exact, the threshold
 * compared exactly, and each figure answered is rounded once, half away from zero. Floats
 * rounded a -0.125% difference to -0.12% and lost the half of a large one (95,084.325% was
 * 95,084.32%).
 */

import { centsNumber, divRound, unitsToNumber, type AnswerDecimal } from '../../utils/decimal.js';

export const DEFAULT_PCT = 0.01;
export const DEFAULT_ABS = 50;

/** `pct` is read to the millionth (0.01 is 10,000 millionths). */
const PCT_UNITS = 1_000_000n;

/** Its dollars are answers' (AnswerDecimal: exact text when a number can't hold them). */
export interface ReconcileResult {
  difference: AnswerDecimal; // calculated - imported
  absDifference: AnswerDecimal;
  pctDifference: number | null; // vs imported balance
  threshold: AnswerDecimal; // dollar threshold actually applied
  flagged: boolean;
}

const magnitude = (n: bigint) => (n < 0n ? -n : n);

/**
 * Compare `calculatedCents` with `importedCents`. Not flagged when either side is unknown
 * (null): there is nothing to compare. `pct` is a fraction (0.01 is 1%), `abs` dollars.
 */
export function reconcile(calculatedCents: bigint | null, importedCents: bigint | null, pct = DEFAULT_PCT, abs = DEFAULT_ABS): ReconcileResult {
  if (importedCents == null || calculatedCents == null) {
    return { difference: 0, absDifference: 0, pctDifference: null, threshold: abs, flagged: false };
  }
  const absCents = BigInt(Math.round(abs * 100));
  const pctUnits = BigInt(Math.round(pct * Number(PCT_UNITS)));
  const difference = calculatedCents - importedCents;
  const absDifference = magnitude(difference);
  const imported = magnitude(importedCents);
  // max(abs, |imported| × pct), in millionths of a cent so it isn't rounded before the compare.
  const relative = imported * pctUnits;
  const flagged = absDifference > absCents && absDifference * PCT_UNITS > relative;
  const relativeCents = divRound(relative, PCT_UNITS);
  return {
    difference: centsNumber(difference),
    absDifference: centsNumber(absDifference),
    // difference ÷ |imported| × 100, to the hundredth of a percent.
    pctDifference: imported !== 0n ? unitsToNumber(divRound(difference * 10_000n, imported), 2) : null,
    threshold: centsNumber(relativeCents > absCents ? relativeCents : absCents),
    flagged,
  };
}
