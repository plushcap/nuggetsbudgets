/**
 * Pure, DB-free tax-planning & advisory math. No DB access — the
 * unit-test target for sell-tax estimation, lot ranking, tax-loss-harvest
 * detection, and concentration. All tax figures are ESTIMATES at the supplied
 * marginal rates and are labeled as such in the UI (the advisory disclaimer).
 *
 * Exact, though nothing here is stored: a lot's shares and basis and a price are the
 * bigint units costBasis.ts works in, money is figured in cents and rounded once, and a
 * percentage is a ratio of exact sums. A double's half-cent error rounded a figure the wrong
 * way (a $1,024.215 market value read $1,024.21).
 *
 * A lot's basis here is its remaining total (tax_lots.total_cost_basis), what a sale of it
 * would take (costBasis.ts, pro rata), not its shares × its 4-place basis per share.
 */

import type { LotObjective } from '@nuggets/shared';
import { readDecimal } from '@nuggets/shared';
import { invalidRequestError } from '../controlPlaneErrors.js';
import { compareBasisPerShare, shareValueCents, type OpenLot, type SellPlan } from './costBasis.js';
import {
  PER_SHARE, SHARES, SHARE_VALUE_SCALE, centsNumber, divRound, numericUnits, percentOf, pow10, shareValueToCents, unitsToNumber,
  type AnswerDecimal, type DecimalValue,
} from '../../utils/decimal.js';

/** An open lot for the what-if estimates here (a ranking, a harvest list), in exact units. */
export type AdvisoryLot = OpenLot;

/** Default marginal rates when the caller supplies none (clearly estimated). */
export const DEFAULT_SHORT_TERM_RATE = 0.24;
export const DEFAULT_LONG_TERM_RATE = 0.15;

/** A rate is read to this many places (0.24 is exactly 0.24). */
const RATE_SCALE = 10;

/** A marginal rate (0.24), exactly, to 10 places; a 400 when it isn't a number. */
function rateUnits(rate: number): bigint {
  const read = Number.isFinite(rate) ? readDecimal(rate.toFixed(RATE_SCALE), RATE_SCALE, 40) : { problem: 'format' as const };
  if ('problem' in read) throw invalidRequestError('A tax rate must be a number');
  return read.units;
}

/** `cents` × `rate`, in cents, rounded once. */
const atRate = (cents: bigint, rate: number) => divRound(cents * rateUnits(rate), pow10(RATE_SCALE));

/** Its dollars are answers' (AnswerDecimal: exact text when a number can't hold them). */
export interface SellTaxEstimate {
  shortTermGain: AnswerDecimal;
  longTermGain: AnswerDecimal;
  estimatedShortTermTax: AnswerDecimal;
  estimatedLongTermTax: AnswerDecimal;
  estimatedTotalTax: AnswerDecimal;
  netProceedsAfterTax: AnswerDecimal;
}

/** Estimate tax on a sell plan (costBasis.planSell's, in cents). Losses produce negative "tax" (an offset). */
export function estimateSellTax(plan: SellPlan, shortTermRate = DEFAULT_SHORT_TERM_RATE, longTermRate = DEFAULT_LONG_TERM_RATE): SellTaxEstimate {
  const shortTermTax = atRate(plan.shortTermRealized, shortTermRate);
  const longTermTax = atRate(plan.longTermRealized, longTermRate);
  return {
    shortTermGain: centsNumber(plan.shortTermRealized),
    longTermGain: centsNumber(plan.longTermRealized),
    estimatedShortTermTax: centsNumber(shortTermTax),
    estimatedLongTermTax: centsNumber(longTermTax),
    estimatedTotalTax: centsNumber(shortTermTax + longTermTax),
    netProceedsAfterTax: centsNumber(plan.totalProceeds - shortTermTax - longTermTax),
  };
}

/** The sell objectives (LOT_OBJECTIVES in @nuggets/shared, which the lot-suggestions query reads). */
export type { LotObjective };

/**
 * A ranked lot as an answer gives it: its shares and basis per share as numbers, its remaining
 * basis and its gain in dollars (exact text when a number can't hold them, centsNumber).
 */
export type RankedLot<T extends AdvisoryLot = AdvisoryLot> = Omit<T, 'sharesRemaining' | 'costBasisPerShare' | 'totalCostBasis'> & {
  sharesRemaining: number;
  costBasisPerShare: number;
  totalCostBasis: AnswerDecimal;
  unrealizedGain: AnswerDecimal;
};

/**
 * A lot's unrealized gain at `price` (ten-thousandths of a dollar), in cents: its market value
 * (shares × price, rounded once) less its remaining basis, what selling it all would realize.
 */
function unrealizedCents(lot: AdvisoryLot, price: bigint): bigint {
  return shareValueCents(lot.sharesRemaining, price) - lot.totalCostBasis;
}

/** Unrealized gain for a lot at the given price (ten-thousandths of a dollar), in dollars. */
export function unrealizedForLot(lot: AdvisoryLot, price: bigint): AnswerDecimal {
  return centsNumber(unrealizedCents(lot, price));
}

const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/** Rank open lots for a sell objective (best candidate first), at `price` (ten-thousandths of a dollar). Pure. */
export function rankLotsForObjective<T extends AdvisoryLot>(lots: T[], price: bigint, objective: LotObjective): RankedLot<T>[] {
  const withGain = lots.map((lot) => ({ lot, gain: unrealizedCents(lot, price) }));
  switch (objective) {
    case 'maximize_loss':
      withGain.sort((a, b) => cmpBig(a.gain, b.gain)); // most negative first
      break;
    case 'minimize_gain':
      // Smallest absolute gain first (closest to break-even), losses ahead of gains.
      withGain.sort((a, b) => cmpBig(a.gain, b.gain));
      break;
    case 'longest_held':
      withGain.sort((a, b) => cmp(a.lot.holdingPeriodStart, b.lot.holdingPeriodStart));
      break;
    case 'highest_cost':
      // The highest remaining basis per share first, compared exactly, as HIFO picks.
      withGain.sort((a, b) => compareBasisPerShare(b.lot, a.lot));
      break;
    default:
      break;
  }
  return withGain.map(({ lot, gain }) => ({
    ...lot,
    sharesRemaining: unitsToNumber(lot.sharesRemaining, SHARES.scale),
    costBasisPerShare: unitsToNumber(lot.costBasisPerShare, PER_SHARE.scale),
    totalCostBasis: centsNumber(lot.totalCostBasis),
    unrealizedGain: centsNumber(gain),
  }));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface TlhCandidate<T extends AdvisoryLot = AdvisoryLot> {
  lot: T;
  marketValue: AnswerDecimal;
  unrealizedLoss: AnswerDecimal; // positive number = size of the loss
  /** The loss in cents, to compare candidates exactly. */
  lossCents: bigint;
}

/**
 * Open lots currently at a loss at `price` (ten-thousandths of a dollar), the loss more
 * than `minLossCents` (tax-loss-harvesting candidates). The loss is the lot's remaining basis
 * less its market value as shown (in cents), so the two figures agree. Pure.
 */
export function tlhCandidates<T extends AdvisoryLot>(lots: T[], price: bigint, minLossCents = 0): TlhCandidate<T>[] {
  // Cents compared as cents: in dollars, 0.29 * 100 is 28.999…, which let a $0.29 loss through.
  const minimum = BigInt(minLossCents);
  return lots
    .map((lot) => {
      const marketValue = shareValueCents(lot.sharesRemaining, price);
      return { lot, marketValue, loss: lot.totalCostBasis - marketValue };
    })
    .filter((c) => c.loss > minimum)
    .sort((a, b) => cmpBig(b.loss, a.loss))
    .map((c) => ({ lot: c.lot, marketValue: centsNumber(c.marketValue), unrealizedLoss: centsNumber(c.loss), lossCents: c.loss }));
}

export interface ConcentrationInput {
  securityId: number;
  ticker: string;
  /** Dollars, as the database gives it (SUM(shares) × close, text) or a number. */
  marketValue: DecimalValue;
}
export interface ConcentrationRow {
  securityId: number;
  ticker: string;
  marketValue: AnswerDecimal;
  portfolioPct: number;
  netWorthPct: number | null;
  exceedsThreshold: boolean;
}

/**
 * Per-security concentration vs the portfolio (and vs net worth when provided).
 * `thresholdPct` flags positions above that share of the portfolio (default 10%).
 */
export function concentration(holdings: ConcentrationInput[], thresholdPct = 10, netWorth: number | null = null): ConcentrationRow[] {
  const values = holdings.map((h) => ({ h, units: numericUnits(h.marketValue, SHARE_VALUE_SCALE) }));
  const total = values.reduce((s, v) => s + v.units, 0n);
  return values
    .sort((a, b) => cmpBig(b.units, a.units))
    .map(({ h, units }) => {
      const cents = shareValueToCents(units);
      const portfolioPct = percentOf(units, total);
      return {
        securityId: h.securityId,
        ticker: h.ticker,
        marketValue: centsNumber(cents),
        portfolioPct,
        netWorthPct: netWorth && netWorth > 0 ? Math.round((Number(cents) / netWorth) * 100) / 100 : null,
        exceedsThreshold: portfolioPct > thresholdPct,
      };
    });
}
