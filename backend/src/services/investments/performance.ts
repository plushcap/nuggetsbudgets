/**
 * Pure, DB-free performance math. Money-weighted return (xIRR
 * via Newton's method with bisection fallback) and time-weighted return
 * (Modified Dietz — a standard single-period TWR approximation that needs only
 * the begin/end values and dated external flows, no daily valuations).
 *
 * Cash-flow sign convention (investor perspective): contributions into the
 * portfolio (buys) are NEGATIVE; distributions out (sells, cash dividends) are
 * POSITIVE; the ending market value is added as a final POSITIVE flow for IRR.
 */

import { daysBetween } from '../../utils/calendarDate.js';

export interface CashFlow {
  date: string; // YYYY-MM-DD
  amount: number;
}

const yearsBetween = (a: string, b: string) => daysBetween(a, b) / 365;

/** Net present value of dated flows at annual rate `r` (first flow = t0). */
export function npv(flows: CashFlow[], r: number): number {
  const [first] = flows;
  if (!first) return 0;
  const t0 = first.date;
  return flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, yearsBetween(t0, f.date)), 0);
}

/**
 * Annualized money-weighted return (xIRR). `flows` must include the ending value
 * as a final positive flow. Returns null when it can't converge or flows are
 * single-signed (no internal rate exists).
 */
export function xirr(flows: CashFlow[]): number | null {
  if (flows.length < 2) return null;
  const hasPos = flows.some((f) => f.amount > 0);
  const hasNeg = flows.some((f) => f.amount < 0);
  if (!hasPos || !hasNeg) return null;

  const sorted = [...flows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const [earliest] = sorted;
  if (!earliest) return null;
  const t0 = earliest.date;

  // Newton's method.
  let rate = 0.1;
  for (let i = 0; i < 100; i++) {
    let f = 0;
    let df = 0;
    for (const cf of sorted) {
      const t = yearsBetween(t0, cf.date);
      const denom = Math.pow(1 + rate, t);
      f += cf.amount / denom;
      df += (-t * cf.amount) / (denom * (1 + rate));
    }
    if (Math.abs(df) < 1e-12) break;
    const next = rate - f / df;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - rate) < 1e-8) return round4(next);
    rate = next > -0.9999 ? next : -0.9999;
  }

  // Bisection fallback over a wide bracket.
  let lo = -0.9999;
  let hi = 100;
  let flo = npv(sorted, lo);
  const fhi = npv(sorted, hi);
  if (flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fmid = npv(sorted, mid);
    if (Math.abs(fmid) < 1e-7) return round4(mid);
    if (flo * fmid < 0) { hi = mid; } else { lo = mid; flo = fmid; }
  }
  return round4((lo + hi) / 2);
}

/** A dollar amount with at most 2 decimal places (a flow or a value), in whole cents. */
const cents = (dollars: number) => Math.round(dollars * 100);

/**
 * Modified Dietz time-weighted return over [startDate, endDate].
 * `contributions` are external flows into the portfolio (buy = +, withdrawal = -),
 * each time-weighted by the fraction of the period remaining after the flow. The values and
 * flows are amounts in dollars and cents: the gain is summed in whole cents, exactly.
 */
export function modifiedDietz(beginValue: number, endValue: number, contributions: CashFlow[], startDate: string, endDate: string): number | null {
  const totalDays = daysBetween(startDate, endDate);
  if (totalDays <= 0) return null;
  const netFlowCents = contributions.reduce((s, c) => s + cents(c.amount), 0);
  const weighted = contributions.reduce((s, c) => {
    const daysFromStart = daysBetween(startDate, c.date);
    const w = (totalDays - daysFromStart) / totalDays;
    return s + w * c.amount;
  }, 0);
  const denom = beginValue + weighted;
  if (denom === 0) return null;
  return round4((cents(endValue) - cents(beginValue) - netFlowCents) / 100 / denom);
}

/** Simple total return given net invested and current value. */
export function totalReturn(netInvested: number, currentValue: number): number | null {
  if (netInvested <= 0) return null;
  return round4((currentValue - netInvested) / netInvested);
}

/** Annualize a cumulative return over a number of days (CAGR). */
export function annualize(cumulativeReturn: number, days: number): number | null {
  if (days <= 0) return null;
  const years = days / 365;
  if (years <= 0) return null;
  return round4(Math.pow(1 + cumulativeReturn, 1 / years) - 1);
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}
