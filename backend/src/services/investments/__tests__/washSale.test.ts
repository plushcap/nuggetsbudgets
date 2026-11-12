import { describe, it, expect } from 'vitest';
import { isWithinWashWindow, matchWashSales, type LossShares, type ReplacementLot } from '../washSale.js';

describe('isWithinWashWindow', () => {
  it('true within 30 days before or after', () => {
    expect(isWithinWashWindow('2025-02-01', '2025-01-15')).toBe(true); // 17 days before
    expect(isWithinWashWindow('2025-02-01', '2025-02-25')).toBe(true); // 24 days after
    expect(isWithinWashWindow('2025-02-01', '2025-02-01')).toBe(true); // same day
  });
  it('false beyond 30 days', () => {
    expect(isWithinWashWindow('2025-02-01', '2024-12-01')).toBe(false);
    expect(isWithinWashWindow('2025-02-01', '2025-04-01')).toBe(false);
  });
});

// Shares are millionths, money cents, as bigints.
const SH = 1_000_000n;
const loss = (over: Partial<LossShares> & Pick<LossShares, 'consumptionId' | 'lotId'>): LossShares => ({
  saleDate: '2025-01-20', sharesMicro: 100n * SH, lossCents: 100_000n, matchedMicro: 0n, disallowedCents: 0n, ...over,
});
/** `micro` millionths of a share. */
const repl = (lotId: number, acquisitionDate: string, micro: bigint): ReplacementLot => ({ lotId, acquisitionDate, availableMicro: micro });

describe('matchWashSales', () => {
  it('never matches a loss to the lot it was sold from', () => {
    // Bought 100 on Jan 2 (lot 1), sold all 100 on Jan 20 at a $1,000 loss, nothing else
    // bought: the purchase of the sold shares is not a replacement. No wash sale.
    expect(matchWashSales([loss({ consumptionId: 1, lotId: 1 })], [repl(1, '2025-01-02', 100n * SH)])).toEqual([]);
  });

  it('disallows only the matched shares of a loss: a 0.4-share DRIP disallows $4 of $1,000', () => {
    // 100 sh sold at a $1,000 loss; a $15 dividend reinvested 0.4 sh within 30 days.
    // Disallowed = $1,000 x 0.4 / 100 = $4.00.
    expect(matchWashSales([loss({ consumptionId: 1, lotId: 1 })], [repl(7, '2025-02-10', 400_000n)])).toEqual([
      { consumptionId: 1, replacementLotId: 7, sharesMicro: 400_000n, lossSharesMicro: 400_000n, disallowedCents: 400n },
    ]);
  });

  it('a replacement share absorbs one loss share; losses take them in the order sold', () => {
    // Two 100-sh loss sales ($1,000 on Jan 20, $500 on Jan 22) and one 150-sh replacement:
    // the first takes 100 (all $1,000), the second the other 50 ($500 x 50/100 = $250).
    const matches = matchWashSales(
      [loss({ consumptionId: 2, lotId: 2, saleDate: '2025-01-22', lossCents: 50_000n }), loss({ consumptionId: 1, lotId: 1 })],
      [repl(9, '2025-01-25', 150n * SH)]
    );
    expect(matches).toEqual([
      { consumptionId: 1, replacementLotId: 9, sharesMicro: 100n * SH, lossSharesMicro: 100n * SH, disallowedCents: 100_000n },
      { consumptionId: 2, replacementLotId: 9, sharesMicro: 50n * SH, lossSharesMicro: 50n * SH, disallowedCents: 25_000n },
    ]);
  });

  it('takes replacements in the order acquired, and its pieces add up to the whole loss', () => {
    // $999.99 loss on 100 sh, replaced by 40 (Jan 28), 30 (Jan 10), 30 (Jan 15) sh.
    // In acquisition order: Jan 10: 30 sh -> round(99,999 x 0.3) = 30,000c;
    // Jan 15: 60 sh in all -> round(99,999 x 0.6) = 59,999c, so 29,999c;
    // Jan 28: all 100 -> 99,999c, so 40,000c. 30,000 + 29,999 + 40,000 = 99,999.
    const matches = matchWashSales(
      [loss({ consumptionId: 1, lotId: 1, lossCents: 99_999n })],
      [repl(30, '2025-01-28', 40n * SH), repl(10, '2025-01-10', 30n * SH), repl(20, '2025-01-15', 30n * SH)]
    );
    expect(matches.map((m) => [m.replacementLotId, m.sharesMicro / SH, m.disallowedCents])).toEqual([
      [10, 30n, 30_000n],
      [20, 30n, 29_999n],
      [30, 40n, 40_000n],
    ]);
    expect(matches.reduce((s, m) => s + m.disallowedCents, 0n)).toBe(99_999n);
  });

  it('only within 30 days of the sale', () => {
    expect(matchWashSales([loss({ consumptionId: 1, lotId: 1 })], [repl(5, '2025-02-20', 100n * SH)])).toEqual([]); // 31 days after
    expect(matchWashSales([loss({ consumptionId: 1, lotId: 1 })], [repl(5, '2025-02-19', 100n * SH)])).toHaveLength(1); // 30 days after
  });

  it('matches nothing again once a loss is fully matched, and continues a partial one', () => {
    const done = loss({ consumptionId: 1, lotId: 1, matchedMicro: 100n * SH, disallowedCents: 100_000n });
    expect(matchWashSales([done], [repl(5, '2025-01-25', 100n * SH)])).toEqual([]);
    // 40 of 100 sh matched before ($400 of $1,000): 60 more sh take the remaining $600.
    const partial = loss({ consumptionId: 1, lotId: 1, matchedMicro: 40n * SH, disallowedCents: 40_000n });
    expect(matchWashSales([partial], [repl(5, '2025-01-25', 100n * SH)])).toEqual([
      { consumptionId: 1, replacementLotId: 5, sharesMicro: 60n * SH, lossSharesMicro: 60n * SH, disallowedCents: 60_000n },
    ]);
  });

  it('counts shares exactly past 9 billion, where a double has no whole millionths', () => {
    // 10,000,000,000.000001 shares sold at a $9,999,999,999.99 loss, replaced by
    // 10,000,000,000 shares: one millionth of a share is unmatched. As doubles both counts
    // were 1e16, so the loss read as fully matched and could never be matched again.
    const big = loss({ consumptionId: 1, lotId: 1, sharesMicro: 10_000_000_000_000_001n, lossCents: 999_999_999_999n });
    const matches = matchWashSales([big], [repl(5, '2025-01-25', 10_000_000_000_000_000n)]);
    expect(matches).toEqual([{ consumptionId: 1, replacementLotId: 5, sharesMicro: 10_000_000_000_000_000n, lossSharesMicro: 10_000_000_000_000_000n, disallowedCents: 999_999_999_999n }]);
    // The last millionth is still there to match, and takes what's left of the loss (nothing, in cents).
    const rest = loss({ ...big, matchedMicro: 10_000_000_000_000_000n, disallowedCents: 999_999_999_999n });
    expect(matchWashSales([rest], [repl(6, '2025-01-26', SH)])).toEqual([{ consumptionId: 1, replacementLotId: 6, sharesMicro: 1n, lossSharesMicro: 1n, disallowedCents: 0n }]);
  });

  it('disallows the pro-rata part of a loss exactly: no float ratio', () => {
    // 3 of 22 shares of a $9,999,999,999.99 loss: 999,999,999,999 x 3 / 22 is 136,363,636,363.5
    // cents, so 136,363,636,364. Math.round(999,999,999,999 x (3 / 22)) gave ...363: the double
    // 3 / 22 is a little under it.
    const matches = matchWashSales([loss({ consumptionId: 1, lotId: 1, sharesMicro: 22n * SH, lossCents: 999_999_999_999n })], [repl(5, '2025-01-25', 3n * SH)]);
    expect(matches[0].disallowedCents).toBe(136_363_636_364n);
  });
});

describe('matchWashSales across a split', () => {
  // A 2:1 split recorded since the loss: one share sold then is two of a replacement lot's now.
  const twoForOne = { numerator: 2n * SH, denominator: SH };

  it('counts a loss in the replacement lot\'s shares: 200 shares after a 2:1 split replace all 100 sold before it', () => {
    expect(matchWashSales([loss({ consumptionId: 1, lotId: 1, sharesNow: twoForOne })], [repl(7, '2025-02-10', 200n * SH)])).toEqual([
      { consumptionId: 1, replacementLotId: 7, sharesMicro: 200n * SH, lossSharesMicro: 100n * SH, disallowedCents: 100_000n },
    ]);
  });

  it('a smaller lot replaces its shares\' worth: 50 shares after the split are 25 sold before it, a quarter of the loss', () => {
    // The loss's other 75 shares are matched by the next lot, which takes 150 of its 300.
    expect(matchWashSales([loss({ consumptionId: 1, lotId: 1, sharesNow: twoForOne })], [repl(7, '2025-02-01', 50n * SH), repl(8, '2025-02-02', 300n * SH)])).toEqual([
      { consumptionId: 1, replacementLotId: 7, sharesMicro: 50n * SH, lossSharesMicro: 25n * SH, disallowedCents: 25_000n },
      { consumptionId: 1, replacementLotId: 8, sharesMicro: 150n * SH, lossSharesMicro: 75n * SH, disallowedCents: 75_000n },
    ]);
  });

  it('after a reverse split, 10 shares replace all 100 sold before a 1:10', () => {
    const oneForTen = { numerator: SH, denominator: 10n * SH };
    expect(matchWashSales([loss({ consumptionId: 1, lotId: 1, sharesNow: oneForTen })], [repl(7, '2025-02-10', 40n * SH)])).toEqual([
      { consumptionId: 1, replacementLotId: 7, sharesMicro: 10n * SH, lossSharesMicro: 100n * SH, disallowedCents: 100_000n },
    ]);
  });

  it('counts what a loss has matched already in its own shares', () => {
    // 40 of the 100 sold matched before (80 of a lot's shares then): 60 left are 120 now.
    expect(matchWashSales([loss({ consumptionId: 1, lotId: 1, sharesNow: twoForOne, matchedMicro: 40n * SH, disallowedCents: 40_000n })], [repl(7, '2025-02-10', 500n * SH)])).toEqual([
      { consumptionId: 1, replacementLotId: 7, sharesMicro: 120n * SH, lossSharesMicro: 60n * SH, disallowedCents: 60_000n },
    ]);
  });
});
