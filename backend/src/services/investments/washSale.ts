/**
 * Pure wash-sale matching (IRC §1091). A loss on a sale is disallowed to
 * the extent the taxpayer acquired substantially identical shares within 30 days
 * before or after it (across all of the taxpayer's accounts), and the disallowed
 * loss is added to the basis of those replacement shares. The DB-bound reads and
 * writes live in WashSaleService; this is the unit-testable matching.
 *
 * Matching is share for share (Treas. Reg. §1.1091-1(b), (c)): loss shares in the
 * order they were sold, replacement shares in the order they were acquired. Each
 * replacement share absorbs at most one loss share, and the disallowed part of a
 * loss is the loss × matched shares / shares sold, so 0.4 reinvested shares
 * disallow 0.4 shares' worth of a 100-share loss, not all of it.
 *
 * Shares are millionths (DECIMAL(18,6)) and money cents, both bigints read from the
 * database's text (utils/decimal.ts numericUnits), so share counts are exact at any size the
 * column holds (a double holds whole millionths only up to about 9 billion shares), and
 * the pieces of one loss add up to the whole loss exactly.
 *
 * A replacement lot holds today's shares (a split recorded after it was acquired scaled it); a
 * loss's shares are those of its sale's day, or of the splits a sale recorded in adjusted figures
 * was adjusted for. So a loss counts in replacement shares at `sharesNow`: the
 * splits recorded since that its shares weren't adjusted for. A 2:1 split between a loss of 100
 * shares and a buy of 200 after it is all 200 replacing all 100; counted one for one, the buy's
 * other 100 were left to absorb a second loss.
 */

import { daysBetween } from '../../utils/calendarDate.js';
import { divRound } from '../../utils/decimal.js';

export const WASH_SALE_WINDOW_DAYS = 30;

/** True when `buyDate` is within ±30 days of `sellDate`. */
export function isWithinWashWindow(sellDate: string, buyDate: string): boolean {
  return Math.abs(daysBetween(sellDate, buyDate)) <= WASH_SALE_WINDOW_DAYS;
}

/** The loss shares of one lot consumption by a sale. */
export interface LossShares {
  consumptionId: number;
  saleDate: string; // YYYY-MM-DD
  /** The lot the shares were sold from. Its other shares came in the same purchase and
   *  are never replacements for them (Rev. Rul. 56-602). */
  lotId: number;
  sharesMicro: bigint; // shares sold from the lot, in millionths
  lossCents: bigint; // |realized loss|, positive, in cents
  matchedMicro: bigint; // already matched to replacement shares, in millionths
  disallowedCents: bigint; // already disallowed, in cents
  /**
   * A share sold is `numerator / denominator` of a replacement lot's (both in the ratios' units):
   * the product of the splits recorded since that its shares aren't adjusted for. One for one
   * when not given.
   */
  sharesNow?: { numerator: bigint; denominator: bigint } | undefined;
}

/** A lot whose shares can replace loss shares. */
export interface ReplacementLot {
  lotId: number;
  acquisitionDate: string; // YYYY-MM-DD
  /** Shares not yet matched to a loss, in millionths: at most the shares still held. */
  availableMicro: bigint;
}

export interface WashMatch {
  consumptionId: number;
  replacementLotId: number;
  /** Millionths of a share of the replacement lot (wash_sale_records.replacement_shares). */
  sharesMicro: bigint;
  /** Millionths of a share of the loss they replace, in its own shares (wash_sale_records.loss_shares). */
  lossSharesMicro: bigint;
  /** Cents. */
  disallowedCents: bigint;
}

/**
 * Match loss shares to replacement shares within the ±30-day window. Pure: the
 * inputs aren't changed. A loss already fully matched, or a replacement already
 * used up, takes no part, so running it again on the stored state matches nothing new.
 */
export function matchWashSales(losses: LossShares[], replacements: ReplacementLot[]): WashMatch[] {
  const available = new Map(replacements.map((r) => [r.lotId, r.availableMicro]));
  const byAcquisition = [...replacements].sort((a, b) => cmp(a.acquisitionDate, b.acquisitionDate) || a.lotId - b.lotId);
  const bySale = [...losses].sort((a, b) => cmp(a.saleDate, b.saleDate) || a.consumptionId - b.consumptionId);

  const matches: WashMatch[] = [];
  for (const loss of bySale) {
    let matched = loss.matchedMicro;
    let disallowed = loss.disallowedCents;
    for (const repl of byAcquisition) {
      if (matched >= loss.sharesMicro) break;
      if (repl.lotId === loss.lotId || !isWithinWashWindow(loss.saleDate, repl.acquisitionDate)) continue;
      const free = available.get(repl.lotId) ?? 0n;
      if (free <= 0n) continue;
      const unmatched = loss.sharesMicro - matched;
      // The loss's unmatched shares in the lot's, and the lot's shares it takes back in the loss's,
      // each rounded to the millionth: all of what is unmatched when the lot has that many.
      const { numerator, denominator } = loss.sharesNow ?? { numerator: 1n, denominator: 1n };
      const wanted = divRound(unmatched * numerator, denominator);
      const shares = free < wanted ? free : wanted;
      const lossShares = shares === wanted ? unmatched : min(divRound(shares * denominator, numerator), unmatched);
      if (shares <= 0n || lossShares <= 0n) continue;
      matched += lossShares;
      // The loss disallowed so far, pro rata; all of it once every share is matched.
      const target = matched >= loss.sharesMicro ? loss.lossCents : divRound(loss.lossCents * matched, loss.sharesMicro);
      available.set(repl.lotId, free - shares);
      matches.push({ consumptionId: loss.consumptionId, replacementLotId: repl.lotId, sharesMicro: shares, lossSharesMicro: lossShares, disallowedCents: target - disallowed });
      disallowed = target;
    }
  }
  return matches;
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
