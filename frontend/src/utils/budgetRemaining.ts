/**
 * The period's "Actual" remaining: `@nuggets/shared`'s calculateActualRemaining,
 * which the Budget page, Close-Out, the Dashboard card and the MCP server all use, so they show
 * one figure, worked out in whole cents.
 */
export { calculateActualRemaining, type ActualRemaining } from '@nuggets/shared';

/**
 * What an expense item spent in a period, as the positive amount the goal cards show as
 * "Previously Spent", or undefined when it spent nothing. Its actual is pre-signed, so spending
 * is negative, and a period of net refunds (positive) spent nothing. A `> 0` test hid
 * the line for every expense that had spent.
 */
export function amountSpent(calculatedActual: number): number | undefined {
  return calculatedActual < 0 ? -calculatedActual : undefined;
}
