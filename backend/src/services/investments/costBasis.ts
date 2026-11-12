/**
 * Pure, DB-free cost-basis engine for the Investment Tracking module.
 *
 * This module contains NO database access by design: it is the unit-test target
 * for lot-selection and realized-gain math (FIFO/LIFO/HIFO/specific-ID/average
 * cost), so it can be exercised exhaustively with hand-calculated fixtures and
 * no Postgres. `HoldingsService` wraps it with persistence via `getDb()`.
 *
 * Its figures are exact: bigints of their column's units, read from the request
 * and the database without a float (utils/decimal.ts), each result rounded once, half
 * away from zero, to the column it is written to:
 *  - shares: millionths of a share (NUMERIC(18,6));
 *  - a price or basis per share: ten-thousandths of a dollar (NUMERIC(12,4));
 *  - money: cents (NUMERIC(12,2)).
 * All amounts are pre-signed in the wider app, but within a single sell the
 * proceeds/basis/gain are computed positively and the gain may be negative (a loss).
 *
 * A sale consumes a lot's remaining total basis pro rata, by design:
 * S of the lot's R remaining shares take its remaining total × S / R, rounded to the cent once,
 * and the sale that takes its last share takes exactly what is left. The lot's basis per share
 * (4 places) is not what a sale is figured from: shares × it can be cents away from the total
 * (1,000,000 shares bought at $0.0012 with $4.95 in fees are $0.0012 a share, $1,204.95 in all),
 * and a lot sold in parts left basis on it or took more than it had. Sales recorded before this
 * stay as they were figured.
 */
import { invalidRequestError } from '../controlPlaneErrors.js';
import { addMonths, daysBetween } from '../../utils/calendarDate.js';
import { CENTS, PER_SHARE, SHARES, centsNumber, divRound, pow10, unitsToNumber, type AnswerDecimal } from '../../utils/decimal.js';
import { costBasisMethod } from '@nuggets/shared';

export type CostBasisMethod = 'fifo' | 'lifo' | 'hifo' | 'specific_id' | 'average_cost';

/**
 * Whether a sale on `saleDate` of shares held since `holdingPeriodStart` is
 * long-term: held MORE than one year (IRS Pub. 550). The holding period starts
 * the day after acquisition and includes the sale day, so a sale on the one-year
 * anniversary is still short-term and the day after it is the first long-term
 * day. The anniversary is calendar arithmetic, not 365 days: a year that spans a
 * Feb 29 has 366, so bought 2023-03-01 and sold 2024-03-01 (366 days) is
 * short-term. A Feb 29 acquisition's anniversary is Feb 28 of the next year
 * (addMonths clamps to the month's last day), so its first long-term day is Mar 1.
 */
export function isLongTermHolding(holdingPeriodStart: string, saleDate: string): boolean {
  return saleDate > addMonths(holdingPeriodStart, 12);
}

/** Round to cents (the read-side reports' floats; the engine itself is exact). */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
/** Round a share quantity to 6 dp (the read-side reports' floats). */
export const round6 = (n: number): number => Math.round((n + Number.EPSILON) * 1e6) / 1e6;

/**
 * A share count times a per-share figure is in 10^-10 dollars: this many of them make a cent.
 */
const SHARE_VALUE_PER_CENT = pow10(SHARES.scale + PER_SHARE.scale - CENTS.scale);

/** The value of `shares` at `perShare`, in cents. */
export function shareValueCents(shares: bigint, perShare: bigint): bigint {
  return divRound(shares * perShare, SHARE_VALUE_PER_CENT);
}

/** `cents` spread over `shares`, per share (ten-thousandths of a dollar); 0 for no shares. */
export function perShareOf(cents: bigint, shares: bigint): bigint {
  return shares > 0n ? divRound(cents * SHARE_VALUE_PER_CENT, shares) : 0n;
}

/** A share count as people read it, for a message: "50", "12.5". */
export function sharesText(shares: bigint): string {
  return String(unitsToNumber(shares, SHARES.scale));
}

const sum = (values: bigint[]): bigint => values.reduce((total, value) => total + value, 0n);
const dollars = (cents: bigint): AnswerDecimal => centsNumber(cents);

export interface OpenLot {
  id: number;
  acquisitionDate: string; // YYYY-MM-DD
  holdingPeriodStart: string; // YYYY-MM-DD (may differ from acquisition for gifts/inheritance)
  /** Millionths of a share. */
  sharesRemaining: bigint;
  /** Ten-thousandths of a dollar, as stored (the lots screen shows it); a sale isn't figured from it. */
  costBasisPerShare: bigint;
  /** Cents: the basis of the shares remaining (tax_lots.total_cost_basis), what a sale consumes. */
  totalCostBasis: bigint;
  /**
   * Whether the lot is covered (tax_lots.is_covered; acquired from 2012 on for stock): an
   * average-cost pool holds one kind only (IRC §1012(c)(2)(A)). Covered when not given.
   */
  isCovered?: boolean | undefined;
}

/** The average-cost pool a lot is in: covered and noncovered lots are kept apart. */
const poolOf = (lot: OpenLot): boolean => lot.isCovered ?? true;

/**
 * A lot after a sale: its shares (millionths), remaining basis (cents) and basis per share
 * (ten-thousandths of a dollar), what the sale writes to it. The per-share basis is the lot's as
 * it was, except after an average-cost sale, which re-bases the pool (planSell).
 */
export interface LotAfterSale {
  sharesRemaining: bigint;
  totalCostBasis: bigint;
  costBasisPerShare: bigint;
}

/**
 * The basis `shares` of a lot's `sharesRemaining` take of its remaining `totalCostBasis`, in
 * cents: pro rata, rounded once, half away from zero; all of it when they are all its shares.
 */
export function proRataBasis(totalCostBasis: bigint, sharesRemaining: bigint, shares: bigint): bigint {
  if (shares >= sharesRemaining) return totalCostBasis;
  return divRound(totalCostBasis * shares, sharesRemaining);
}

/**
 * Compares two lots' remaining basis per share exactly (total ÷ shares, cross-multiplied):
 * negative when `a`'s is lower. A lot with no shares compares as the lowest: it has none to sell,
 * so a highest-first order puts it last.
 */
export function compareBasisPerShare(a: { sharesRemaining: bigint; totalCostBasis: bigint }, b: { sharesRemaining: bigint; totalCostBasis: bigint }): number {
  if (a.sharesRemaining <= 0n || b.sharesRemaining <= 0n) return cmp(a.sharesRemaining > 0n ? 1n : 0n, b.sharesRemaining > 0n ? 1n : 0n);
  return cmp(a.totalCostBasis * b.sharesRemaining, b.totalCostBasis * a.sharesRemaining);
}

/**
 * The lots a sale on `date` can sell: those acquired on or before it (one recorded late doesn't
 * sell a later purchase). A sale of more shares than were held then, when more were acquired
 * after it, is refused with a 400 that says so: "Insufficient shares on 2025-03-01: requested
 * 15, held 10 on that date (10 more were acquired after it)", where the plain "Insufficient
 * shares" read wrong to someone holding 20 today. With none acquired later, planSell answers
 * the plain one.
 */
export function lotsHeldOn<T extends OpenLot>(lots: T[], date: string, sharesToSell = 0n): T[] {
  const held = lots.filter((l) => l.acquisitionDate <= date);
  const heldShares = sum(held.map((l) => l.sharesRemaining));
  const later = sum(lots.filter((l) => l.acquisitionDate > date).map((l) => l.sharesRemaining));
  if (sharesToSell > heldShares && later > 0n) {
    throw invalidRequestError(
      `Insufficient shares on ${date}: requested ${sharesText(sharesToSell)}, held ${sharesText(heldShares)} on that date (${sharesText(later)} more were acquired after it)`
    );
  }
  return held;
}

/** Explicit lot pick for specific-ID sells. */
export interface SpecificLotSelection {
  lotId: number;
  /** Millionths of a share. */
  shares: bigint;
}

/** One lot's part of a sell: shares in millionths, money in cents. */
export interface SellConsumption {
  lotId: number;
  sharesConsumed: bigint;
  basisConsumed: bigint;
  proceeds: bigint;
  realizedGainLoss: bigint;
  holdingPeriodDays: number;
  isLongTerm: boolean;
}

/** A planned sell, money in cents. */
export interface SellPlan {
  consumptions: SellConsumption[];
  totalProceeds: bigint;
  totalBasis: bigint;
  totalRealized: bigint;
  longTermRealized: bigint;
  shortTermRealized: bigint;
  /** Each lot the sale takes shares from, as it leaves it (what the sale writes to it). */
  lotsAfter: Map<number, LotAfterSale>;
}

/** A sell plan in shares and dollars, as an answer gives it. */
/** A sale's plan as an answer gives it; its dollars exact text when a number can't hold them (centsNumber). */
export interface SellPlanAmounts {
  consumptions: Array<{
    lotId: number;
    sharesConsumed: number;
    basisConsumed: AnswerDecimal;
    proceeds: AnswerDecimal;
    realizedGainLoss: AnswerDecimal;
    holdingPeriodDays: number;
    isLongTerm: boolean;
  }>;
  totalProceeds: AnswerDecimal;
  totalBasis: AnswerDecimal;
  totalRealized: AnswerDecimal;
  longTermRealized: AnswerDecimal;
  shortTermRealized: AnswerDecimal;
}

/** `plan` in shares and dollars, for a JSON answer (a bigint has no JSON form). */
export function sellPlanAmounts(plan: SellPlan): SellPlanAmounts {
  return {
    consumptions: plan.consumptions.map((c) => ({
      lotId: c.lotId,
      sharesConsumed: unitsToNumber(c.sharesConsumed, SHARES.scale),
      basisConsumed: dollars(c.basisConsumed),
      proceeds: dollars(c.proceeds),
      realizedGainLoss: dollars(c.realizedGainLoss),
      holdingPeriodDays: c.holdingPeriodDays,
      isLongTerm: c.isLongTerm,
    })),
    totalProceeds: dollars(plan.totalProceeds),
    totalBasis: dollars(plan.totalBasis),
    totalRealized: dollars(plan.totalRealized),
    longTermRealized: dollars(plan.longTermRealized),
    shortTermRealized: dollars(plan.shortTermRealized),
  };
}

export interface SellInput {
  lots: OpenLot[];
  /** Millionths of a share. */
  sharesToSell: bigint;
  /** Ten-thousandths of a dollar. */
  pricePerShare: bigint;
  sellDate: string; // YYYY-MM-DD
  method: CostBasisMethod;
  /** Commission/fees on the sell, in cents; reduce proceeds, allocated pro-rata. None when absent or undefined. */
  fees?: bigint | undefined;
  /** Required when method === 'specific_id'. */
  specificLots?: SpecificLotSelection[] | undefined;
}

/** Order open lots for consumption under the chosen method (does not mutate input). */
export function orderLots(lots: OpenLot[], method: CostBasisMethod): OpenLot[] {
  const copy = [...lots];
  switch (method) {
    case costBasisMethod.enum.lifo:
      return copy.sort((a, b) => cmp(b.acquisitionDate, a.acquisitionDate) || b.id - a.id);
    case costBasisMethod.enum.hifo:
      // The highest remaining basis per share first, compared exactly (total ÷ shares).
      return copy.sort((a, b) => compareBasisPerShare(b, a) || a.id - b.id);
    case costBasisMethod.enum.fifo:
    case costBasisMethod.enum.average_cost:
    case costBasisMethod.enum.specific_id:
    default:
      // FIFO ordering is also used as the holding-period traversal order for
      // average cost, and as a deterministic fallback for specific-ID.
      return copy.sort((a, b) => cmp(a.acquisitionDate, b.acquisitionDate) || a.id - b.id);
  }
}

function cmp<T extends string | bigint>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Weighted-average basis per share across all open lots (IRS average cost), in
 * ten-thousandths of a dollar: their remaining basis over their shares. planSell uses the
 * exact ratio, not this rounding of it.
 */
export function averageBasisPerShare(lots: OpenLot[]): bigint {
  const held = lots.filter((l) => l.sharesRemaining > 0n);
  return perShareOf(sum(held.map((l) => l.totalCostBasis)), sum(held.map((l) => l.sharesRemaining)));
}

/**
 * Plan a sell: select lots, allocate proceeds (net of fees, pro-rata by shares),
 * and compute realized gain/loss with long/short-term classification. Pure and
 * exact: each figure is rounded to cents once.
 *
 * Each pick takes its lot's remaining basis pro rata (proRataBasis), from the lot as the picks
 * before it left it, so a lot picked twice gives what two sales would. Average cost takes the
 * pool's (its open lots' remaining basis over their shares) the same way, and a sale of the
 * whole pool takes all of it. Covered and noncovered lots are separate pools (IRC
 * §1012(c)(2)(A): stock acquired before 2012 is a separate account for average basis), each
 * pick taking its basis from its own lot's pool. Under average cost every share in a pool has
 * the same basis (IRS), so the sale then re-bases each pool it sold from (rebasePool): every lot
 * in it with shares left, those the sale took none from too, gets the pool's remaining basis in
 * proportion to its shares, and what is recorded plus what the lots keep is what each pool
 * held; a pool it didn't sell from is left as it is. The shares still come from the lots oldest
 * first across both pools, for their holding periods (noncovered ones, older, first).
 *
 * @throws if shares are insufficient, or a specific-ID selection is invalid.
 */
export function planSell(input: SellInput): SellPlan {
  const { sharesToSell, pricePerShare, sellDate, method } = input;
  const fees = input.fees ?? 0n;
  if (sharesToSell <= 0n) throw invalidRequestError('sharesToSell must be positive');

  const available = sum(input.lots.map((l) => l.sharesRemaining));
  if (sharesToSell > available) {
    throw invalidRequestError(`Insufficient shares: requested ${sharesText(sharesToSell)}, available ${sharesText(available)}`);
  }

  // Average cost: each pool's remaining basis and shares (covered and noncovered apart),
  // consumed pro rata as one lot. A lot with no shares left isn't in one (a reverse split rounded
  // one to none): it has none to sell.
  let pools: Map<boolean, { basis: bigint; shares: bigint; sold: boolean }> | null = null;
  if (method === costBasisMethod.enum.average_cost) {
    pools = new Map();
    for (const lot of input.lots.filter((l) => l.sharesRemaining > 0n)) {
      const pool = pools.get(poolOf(lot)) ?? { basis: 0n, shares: 0n, sold: false };
      pools.set(poolOf(lot), { ...pool, basis: pool.basis + lot.totalCostBasis, shares: pool.shares + lot.sharesRemaining });
    }
  }

  // Build the ordered (lotId -> shares) consumption list.
  let picks: SpecificLotSelection[];
  if (method === costBasisMethod.enum.specific_id) {
    if (!input.specificLots || input.specificLots.length === 0) {
      throw invalidRequestError('specific_id method requires explicit lot selection');
    }
    const byId = new Map(input.lots.map((l) => [l.id, l]));
    const taken = new Map<number, bigint>();
    for (const sel of input.specificLots) {
      const lot = byId.get(sel.lotId);
      if (!lot) throw invalidRequestError('A selected lot is not open');
      if (sel.shares <= 0n) throw invalidRequestError('A selected lot must give a positive number of shares');
      // A lot picked twice can't give more than it has between the picks.
      const fromLot = (taken.get(sel.lotId) ?? 0n) + sel.shares;
      if (fromLot > lot.sharesRemaining) {
        throw invalidRequestError(`A selected lot has only ${sharesText(lot.sharesRemaining)} shares, ${sharesText(fromLot)} requested`);
      }
      taken.set(sel.lotId, fromLot);
    }
    const selected = sum(input.specificLots.map((sel) => sel.shares));
    if (selected !== sharesToSell) {
      throw invalidRequestError(`Specific-ID shares (${sharesText(selected)}) must equal sharesToSell (${sharesText(sharesToSell)})`);
    }
    picks = input.specificLots;
  } else {
    picks = [];
    let remaining = sharesToSell;
    for (const lot of orderLots(input.lots, method)) {
      if (remaining <= 0n) break;
      const take = lot.sharesRemaining < remaining ? lot.sharesRemaining : remaining;
      if (take > 0n) {
        picks.push({ lotId: lot.id, shares: take });
        remaining -= take;
      }
    }
  }

  const lotById = new Map(input.lots.map((l) => [l.id, l]));
  const lotsAfter = new Map<number, LotAfterSale>();
  const consumptions: SellConsumption[] = [];
  let allocatedFees = 0n;
  picks.forEach((sel, idx) => {
    const lot = lotById.get(sel.lotId)!;
    const shares = sel.shares;
    // Allocate fees pro-rata by shares; put any rounding remainder on the last pick.
    const isLast = idx === picks.length - 1;
    const feeShare = isLast ? fees - allocatedFees : divRound(fees * shares, sharesToSell);
    allocatedFees += feeShare;
    const proceeds = shareValueCents(shares, pricePerShare) - feeShare;
    // The lot as the picks before this one left it, and the basis these shares take of it.
    const before = lotsAfter.get(lot.id) ?? { sharesRemaining: lot.sharesRemaining, totalCostBasis: lot.totalCostBasis, costBasisPerShare: lot.costBasisPerShare };
    const lotBasis = proRataBasis(before.totalCostBasis, before.sharesRemaining, shares);
    lotsAfter.set(lot.id, { sharesRemaining: before.sharesRemaining - shares, totalCostBasis: before.totalCostBasis - lotBasis, costBasisPerShare: before.costBasisPerShare });
    let basisConsumed = lotBasis;
    const pool = pools?.get(poolOf(lot));
    if (pool) {
      basisConsumed = proRataBasis(pool.basis, pool.shares, shares);
      pool.basis -= basisConsumed;
      pool.shares -= shares;
      pool.sold = true;
    }
    consumptions.push({
      lotId: lot.id,
      sharesConsumed: shares,
      basisConsumed,
      proceeds,
      realizedGainLoss: proceeds - basisConsumed,
      holdingPeriodDays: daysBetween(lot.holdingPeriodStart, sellDate),
      isLongTerm: isLongTermHolding(lot.holdingPeriodStart, sellDate),
    });
  });

  // Average cost: what each pool sold from has left is spread over the shares it has left.
  for (const [covered, pool] of pools ?? []) {
    if (pool.sold) rebasePool(input.lots.filter((l) => poolOf(l) === covered), lotsAfter, pool.basis, pool.shares);
  }

  const totalRealized = sum(consumptions.map((c) => c.realizedGainLoss));
  const longTermRealized = sum(consumptions.filter((c) => c.isLongTerm).map((c) => c.realizedGainLoss));
  return {
    consumptions,
    totalProceeds: sum(consumptions.map((c) => c.proceeds)),
    totalBasis: sum(consumptions.map((c) => c.basisConsumed)),
    totalRealized,
    longTermRealized,
    shortTermRealized: totalRealized - longTermRealized,
    lotsAfter,
  };
}

/**
 * After an average-cost sale, give every lot in a pool (`lots`: one pool's open lots; one left with
 * none by a reverse split before v2.1.0 isn't in it) its part of the pool's `remainingBasis`
 * (cents), by its shares left over the pool's `remainingShares`, and the basis per share that is.
 * Each part is rounded down and the cents left over go one each to the lots with the largest
 * remainders (then oldest first), so the parts add up to the remaining basis exactly. A lot the
 * sale took all of keeps none. Writes every pool lot into `lotsAfter`, those the sale didn't
 * touch too.
 */
function rebasePool(lots: OpenLot[], lotsAfter: Map<number, LotAfterSale>, remainingBasis: bigint, remainingShares: bigint): void {
  const held = orderLots(lots.filter((l) => l.sharesRemaining > 0n), 'fifo').map((lot) => ({
    lot,
    shares: lotsAfter.get(lot.id)?.sharesRemaining ?? lot.sharesRemaining,
  }));
  // Each lot's part, rounded down (the remaining basis is never negative), and its remainder.
  const parts = held.map((h, order) => {
    const exact = remainingShares > 0n ? remainingBasis * h.shares : 0n;
    const divisor = remainingShares > 0n ? remainingShares : 1n;
    return { ...h, order, cents: exact / divisor, remainder: exact % divisor };
  });
  let leftover = remainingBasis - sum(parts.map((p) => p.cents));
  for (const p of [...parts].filter((x) => x.shares > 0n).sort((a, b) => cmp(b.remainder, a.remainder) || a.order - b.order)) {
    if (leftover <= 0n) break;
    p.cents += 1n;
    leftover -= 1n;
  }
  for (const p of parts) {
    lotsAfter.set(p.lot.id, {
      sharesRemaining: p.shares,
      totalCostBasis: p.cents,
      costBasisPerShare: p.shares > 0n ? perShareOf(p.cents, p.shares) : (lotsAfter.get(p.lot.id)?.costBasisPerShare ?? p.lot.costBasisPerShare),
    });
  }
}

/**
 * Cost basis for a new buy lot: shares × price plus commission absorbed.
 * Total in cents, per share in ten-thousandths of a dollar.
 */
export function buildBuyLotBasis(shares: bigint, pricePerShare: bigint, fees = 0n): {
  totalCostBasis: bigint;
  costBasisPerShare: bigint;
} {
  if (shares <= 0n) throw invalidRequestError('shares must be positive');
  const totalCostBasis = shareValueCents(shares, pricePerShare) + fees;
  return { totalCostBasis, costBasisPerShare: perShareOf(totalCostBasis, shares) };
}
