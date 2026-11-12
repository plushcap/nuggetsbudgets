/**
 * Pure, DB-free corporate-action transforms. Each function takes lot
 * state and returns the transformed state, so the basis math is unit-tested
 * without Postgres. `CorporateActionService` applies the results.
 *
 * Exact, as costBasis.ts is: shares and the split, spinoff and merger ratios
 * in millionths, a basis or amount per share in ten-thousandths of a dollar, money in
 * cents, all bigints, each result rounded once (half away from zero) to its column.
 *
 * Total cost basis is always preserved for splits; return-of-capital reduces
 * basis and converts any below-zero excess to long-term capital gain.
 *
 * A lot's basis is its remaining total (tax_lots.total_cost_basis, cents), what a sale of it
 * takes (costBasis.ts, pro rata): an action moves, reduces or disposes of that total, and a
 * per-share basis is it over the shares, rounded. Shares × the 4-place per-share basis can be
 * cents away from it, and after a pro-rata sale they need not agree at all.
 */

import { isLongTermHolding, perShareOf, shareValueCents, sharesText } from './costBasis.js';
import { daysBetween } from '../../utils/calendarDate.js';
import { invalidRequestError } from '../controlPlaneErrors.js';
import { SHARES, divRound, pow10 } from '../../utils/decimal.js';

/** A ratio or fraction of 1, in millionths (as a share count is). */
const ONE = pow10(SHARES.scale);

/**
 * The basis an action moves or disposes of: the lot's remaining total, or none for a lot with
 * no shares. A reverse split could round a lot to none before v2.1.0 and leave it open with its
 * basis; a spinoff or merger doesn't move that basis or realize it as a loss, as when it was
 * figured from shares × the basis per share.
 */
const basisOf = (lot: { sharesRemaining: bigint; totalCostBasis: bigint }): bigint => (lot.sharesRemaining > 0n ? lot.totalCostBasis : 0n);

export interface LotState {
  id: number;
  /** Millionths of a share. */
  sharesRemaining: bigint;
  /** Ten-thousandths of a dollar. */
  costBasisPerShare: bigint;
  /** Cents: the lot's remaining basis. */
  totalCostBasis: bigint;
}

/** What names a lot to people in a refusal: its uuid, its account's name and its acquisition date. */
export interface LotNames {
  uuid?: string | undefined;
  accountName?: string | undefined;
  acquisitionDate?: string | undefined;
}

/** A lot a split applies to, with what names it in a refusal. */
export interface SplitLot extends LotState, LotNames {}

/**
 * A lot as a refusal names it: "The lot of 0.4 shares acquired 2024-06-03 in the account
 * "Brokerage" (lot …)", or by its shares alone for a caller that has no names for it. A small
 * reinvested dividend can leave a sliver in any account, so the shares alone don't find it.
 */
function lotName(lot: LotNames & { sharesRemaining: bigint }): string {
  return lot.uuid && lot.accountName && lot.acquisitionDate
    ? `The lot of ${sharesText(lot.sharesRemaining)} shares acquired ${lot.acquisitionDate} in the account "${lot.accountName}" (lot ${lot.uuid})`
    : `A lot of ${sharesText(lot.sharesRemaining)} shares`;
}

/** What to do about a lot an action would leave with no shares: sell them first (the cash in lieu). */
const sellSliverFirst = (action: string) => `Record a sale of those shares (the cash in lieu) first, then apply the ${action}.`;

export interface SplitResult {
  lotId: number;
  sharesRemaining: bigint;
  costBasisPerShare: bigint;
}

/**
 * Apply a split expressed as newShares : oldShares (e.g. 4:1 forward, 1:10
 * reverse), both in millionths. Multiplies shares by the ratio and divides
 * per-share basis, preserving total basis. A lot whose shares round to none
 * (under a millionth, a reverse split of a sliver) is refused, as a spinoff's and a stock
 * merger's are: it was left open with no shares and all its basis. The refusal names the lot
 * ({@link lotName}) and what to do: record the sale of those shares, the cash in lieu, then the split.
 */
export function applySplit(lot: SplitLot, numerator: bigint, denominator: bigint): SplitResult {
  if (numerator <= 0n || denominator <= 0n) throw invalidRequestError('split ratio must be positive');
  const newShares = divRound(lot.sharesRemaining * numerator, denominator);
  if (newShares === 0n && lot.sharesRemaining > 0n) {
    throw invalidRequestError(`${lotName(lot)} would have no shares after this split (less than 0.000001). ${sellSliverFirst('split')}`);
  }
  // Preserve total basis: the total stays as it is, and the per-share basis is it over the new shares.
  return { lotId: lot.id, sharesRemaining: newShares, costBasisPerShare: perShareOf(lot.totalCostBasis, newShares) };
}

export interface RocLotResult {
  lotId: number;
  costBasisPerShare: bigint;
  /** The lot's remaining basis after it, in cents: its shares × the reduced basis per share. */
  totalCostBasis: bigint;
  /** LTCG realized on this lot, in cents, when ROC drove basis below zero. */
  realizedLongTermGain: bigint;
}

export interface RocOutcome {
  lots: RocLotResult[];
  totalRealizedLongTermGain: bigint;
}

/**
 * Apply a return-of-capital distribution of `amountPerShare` (ten-thousandths of a
 * dollar) to each open lot. The lot's remaining basis drops by what it was paid (its shares
 * × the amount, in cents), and its per-share basis by the amount; if the payment is more
 * than the basis, the excess is recorded as long-term capital gain and basis floors at zero.
 */
export function applyReturnOfCapital(lots: LotState[], amountPerShare: bigint): RocOutcome {
  if (amountPerShare <= 0n) throw invalidRequestError('return of capital amount must be positive');
  const results: RocLotResult[] = lots.map((lot) => {
    const remaining = lot.totalCostBasis - shareValueCents(lot.sharesRemaining, amountPerShare);
    if (remaining >= 0n) {
      const reduced = lot.costBasisPerShare - amountPerShare;
      // At the edges (a total a cent off shares × basis), the per-share basis is the total's.
      const costBasisPerShare = reduced >= 0n && remaining > 0n ? reduced : perShareOf(remaining, lot.sharesRemaining);
      return { lotId: lot.id, costBasisPerShare, totalCostBasis: remaining, realizedLongTermGain: 0n };
    }
    // The payment beyond the basis.
    return { lotId: lot.id, costBasisPerShare: 0n, totalCostBasis: 0n, realizedLongTermGain: -remaining };
  });
  const totalRealizedLongTermGain = results.reduce((s, r) => s + r.realizedLongTermGain, 0n);
  return { lots: results, totalRealizedLongTermGain };
}

// --- spinoff ----------------------------------------------------------------
export interface SpinoffSourceLot extends LotNames {
  id: number;
  sharesRemaining: bigint;
  costBasisPerShare: bigint;
  /** Cents: the lot's remaining basis. */
  totalCostBasis: bigint;
  holdingPeriodStart: string; // YYYY-MM-DD — inherited by the spun-off lot
}
export interface SpinoffLotResult {
  sourceLotId: number;
  sourceNewCostBasisPerShare: bigint; // reduced source basis
  /** The source lot's remaining basis after it, in cents: its basis less what moved. */
  sourceNewTotalCostBasis: bigint;
  newShares: bigint; // shares of the spun-off security
  newCostBasisPerShare: bigint;
  /** Cents. */
  newTotalCostBasis: bigint;
  holdingPeriodStart: string;
}

/**
 * Spinoff: move `allocationFraction` (0–1, in millionths) of each
 * source lot's basis into a new security, creating `sharesRemaining × shareRatio`
 * new shares that inherit the source holding period. Source per-share basis is
 * reduced accordingly; total basis (source + new) is preserved. A lot whose new shares round
 * to none (under a millionth) while it moves basis is refused: the basis left the
 * source lot and reached no new one. The refusal names the lot and what to do, as a split's
 * does.
 */
export function applySpinoff(sourceLots: SpinoffSourceLot[], allocationFraction: bigint, shareRatio: bigint): SpinoffLotResult[] {
  if (allocationFraction < 0n || allocationFraction > ONE) throw invalidRequestError('allocationFraction must be between 0 and 1');
  if (shareRatio <= 0n) throw invalidRequestError('shareRatio must be positive');
  return sourceLots.map((lot) => {
    // The lot's remaining basis, split so the moved part and what's left add up to it.
    const movedBasis = divRound(basisOf(lot) * allocationFraction, ONE);
    const remainingBasis = lot.totalCostBasis - movedBasis;
    const newShares = divRound(lot.sharesRemaining * shareRatio, ONE);
    if (newShares === 0n && movedBasis !== 0n) {
      throw invalidRequestError(
        `${lotName(lot)} gets no shares of the new security at this share ratio (less than 0.000001), so the basis the spinoff moves to it would be lost. ${sellSliverFirst('spinoff')}`
      );
    }
    return {
      sourceLotId: lot.id,
      sourceNewCostBasisPerShare: perShareOf(remainingBasis, lot.sharesRemaining),
      sourceNewTotalCostBasis: remainingBasis,
      newShares,
      newCostBasisPerShare: perShareOf(movedBasis, newShares),
      newTotalCostBasis: movedBasis,
      holdingPeriodStart: lot.holdingPeriodStart,
    };
  });
}

// --- mergers ----------------------------------------------------------------
export interface MergerSourceLot extends LotNames {
  id: number;
  sharesRemaining: bigint;
  costBasisPerShare: bigint;
  /** Cents: the lot's remaining basis. */
  totalCostBasis: bigint;
  holdingPeriodStart: string;
}
export interface MergerCashConsumption {
  lotId: number;
  sharesConsumed: bigint;
  /** Cents, as are proceeds and realizedGainLoss. */
  basisConsumed: bigint;
  proceeds: bigint;
  realizedGainLoss: bigint;
  holdingPeriodDays: number;
  isLongTerm: boolean;
}

/**
 * Cash merger: full disposal at `cashPerShare`; realized G/L per lot. Each lot is
 * sold whole, so it consumes all its remaining basis, as a sale of its last share does.
 */
export function mergerCashDisposal(lots: MergerSourceLot[], cashPerShare: bigint, mergerDate: string): MergerCashConsumption[] {
  if (cashPerShare < 0n) throw invalidRequestError('cashPerShare must be non-negative');
  return lots.map((lot) => {
    const proceeds = shareValueCents(lot.sharesRemaining, cashPerShare);
    const basisConsumed = basisOf(lot);
    return {
      lotId: lot.id,
      sharesConsumed: lot.sharesRemaining,
      basisConsumed,
      proceeds,
      realizedGainLoss: proceeds - basisConsumed,
      holdingPeriodDays: daysBetween(lot.holdingPeriodStart, mergerDate),
      isLongTerm: isLongTermHolding(lot.holdingPeriodStart, mergerDate),
    };
  });
}

export interface MergerStockResult {
  sourceLotId: number;
  newShares: bigint;
  newCostBasisPerShare: bigint;
  /** Cents. */
  newTotalCostBasis: bigint;
  holdingPeriodStart: string;
}

/** Stock-for-stock merger: convert lots at `exchangeRatio` (millionths),
 *  preserving total basis and holding period; source lots are closed by the caller. A lot
 *  whose new shares round to none (under a millionth) is refused: it would be closed
 *  into no lot, its shares and basis lost. The refusal names the lot and what to do, as a
 *  split's does. */
export function mergerStockConversion(lots: MergerSourceLot[], exchangeRatio: bigint): MergerStockResult[] {
  if (exchangeRatio <= 0n) throw invalidRequestError('exchangeRatio must be positive');
  return lots.map((lot) => {
    const totalBasis = basisOf(lot);
    const newShares = divRound(lot.sharesRemaining * exchangeRatio, ONE);
    if (newShares === 0n && lot.sharesRemaining > 0n) {
      throw invalidRequestError(
        `${lotName(lot)} converts to no shares of the acquirer at this exchange ratio (less than 0.000001), so its shares and basis would be lost. ${sellSliverFirst('merger')}`
      );
    }
    return {
      sourceLotId: lot.id,
      newShares,
      newCostBasisPerShare: perShareOf(totalBasis, newShares),
      newTotalCostBasis: totalBasis,
      holdingPeriodStart: lot.holdingPeriodStart,
    };
  });
}
