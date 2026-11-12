import { describe, it, expect } from 'vitest';
import { applySplit, applyReturnOfCapital, applySpinoff, mergerCashDisposal, mergerStockConversion, type LotState } from '../corporateActions.js';
import { shareValueCents } from '../costBasis.js';
import { numericUnits } from '../../../utils/decimal.js';

// The transforms are exact: shares and ratios in millionths, per-share figures in
// ten-thousandths of a dollar, money in cents. Fixtures and expectations are written in
// shares and dollars and converted.
const shares = (n: number | string) => numericUnits(String(n), 6);
const perShare = (n: number | string) => numericUnits(String(n), 4);
const cents = (n: number | string) => numericUnits(String(n), 2);
const ratio = shares;
/**
 * A lot: its shares, basis per share and remaining total, the total its shares × its basis
 * per share unless given (a lot never sold or adjusted keeps its exact cost, which can differ).
 */
const lotOf = (id: number, sh: number | string, ps: number | string, total?: number | string): LotState => ({
  id, sharesRemaining: shares(sh), costBasisPerShare: perShare(ps), totalCostBasis: total != null ? cents(total) : shareValueCents(shares(sh), perShare(ps)),
});
/** A lot's total basis in 10^-10 dollars: shares × basis per share. */
const basisOf = (r: { sharesRemaining: bigint; costBasisPerShare: bigint }) => r.sharesRemaining * r.costBasisPerShare;
const dollarsOfBasis = (b: bigint) => Number(b) / 1e10;

describe('applySplit', () => {
  const lot: LotState = lotOf(1, 100, 40);

  it('4:1 forward split quadruples shares, quarters basis, preserves total', () => {
    const r = applySplit(lot, ratio(4), ratio(1));
    expect(r.sharesRemaining).toBe(shares(400));
    expect(r.costBasisPerShare).toBe(perShare(10));
    expect(basisOf(r)).toBe(basisOf(lot));
  });

  it('1:10 reverse split divides shares, multiplies basis, preserves total', () => {
    const r = applySplit(lot, ratio(1), ratio(10));
    expect(r.sharesRemaining).toBe(shares(10));
    expect(r.costBasisPerShare).toBe(perShare(400));
    expect(basisOf(r)).toBe(basisOf(lot));
  });

  it('3:2 split preserves total basis', () => {
    const r = applySplit(lot, ratio(3), ratio(2));
    expect(r.sharesRemaining).toBe(shares(150));
    // $4000 / 150 = $26.6666…, the column's nearest 4 places. (A split leaves the lot's
    // total_cost_basis, $4000.00, as it is.)
    expect(r.costBasisPerShare).toBe(perShare('26.6667'));
    expect(dollarsOfBasis(basisOf(r))).toBeCloseTo(4000, 1);
  });

  it('a 3:1 split of a share at $10 rounds once, to the columns', () => {
    // 1.000001 shares × 3 = 3.000003 shares; basis $10.000010 / 3.000003 = $3.3333... -> $3.3333.
    const r = applySplit(lotOf(2, '1.000001', 10), ratio(3), ratio(1));
    expect(r.sharesRemaining).toBe(shares('3.000003'));
    expect(r.costBasisPerShare).toBe(perShare('3.3333'));
  });

  it('rejects non-positive ratios', () => {
    expect(() => applySplit(lot, 0n, ratio(1))).toThrow();
  });

  it('refuses a lot whose shares round to none', () => {
    // 0.000004 sh in a 1:10 reverse split is 0.0000004 sh, which rounds to 0: the lot stayed
    // open with no shares and its $0.01 basis.
    const sliver = { ...lotOf(5, '0.000004', 2500, '0.01'), uuid: '01900000-0000-7000-8000-000000000005', accountName: 'Brokerage', acquisitionDate: '2024-06-03' };
    expect(() => applySplit(sliver, ratio(1), ratio(10))).toThrow(
      'The lot of 0.000004 shares acquired 2024-06-03 in the account "Brokerage" (lot 01900000-0000-7000-8000-000000000005) would have no shares after this split (less than 0.000001). Record a sale of those shares (the cash in lieu) first, then apply the split.'
    );
    // Without its names (a caller that has none), by its shares.
    expect(() => applySplit(lotOf(5, '0.000004', 2500, '0.01'), ratio(1), ratio(10))).toThrow(/^A lot of 0\.000004 shares would have no shares after this split/);
    // Half a millionth rounds up to one.
    expect(applySplit(lotOf(5, '0.000005', 2000, '0.01'), ratio(1), ratio(10))).toMatchObject({ sharesRemaining: 1n, costBasisPerShare: perShare(10000) });
    // A lot that had no shares already isn't refused (there is nothing more to lose).
    expect(applySplit(lotOf(6, 0, 0, '0.01'), ratio(1), ratio(10))).toMatchObject({ sharesRemaining: 0n, costBasisPerShare: 0n });
  });

  it('spreads the lot\'s remaining total over the new shares', () => {
    // 1,000,000 sh at $0.0012 with $4.95 in fees ($1,204.95); 1:1000 reverse: 1,000 sh at
    // $1.20495, $1.2050, where shares x $0.0012 gave $1.2000.
    expect(applySplit(lotOf(7, 1_000_000, '0.0012', '1204.95'), ratio(1), ratio(1000)).costBasisPerShare).toBe(perShare('1.2050'));
  });
});

describe('applyReturnOfCapital', () => {
  const lots: LotState[] = [
    lotOf(1, 100, 5),
    lotOf(2, 50, 1),
  ];

  it('reduces basis without going negative when sufficient', () => {
    const out = applyReturnOfCapital([lots[0]], perShare(2));
    expect(out.lots[0].costBasisPerShare).toBe(perShare(3));
    expect(out.totalRealizedLongTermGain).toBe(0n);
  });

  it('floors basis at zero and records LTCG for the excess', () => {
    // lot 2 basis $1/sh, ROC $1.50/sh -> $0.50/sh excess * 50 sh = $25 LTCG
    const out = applyReturnOfCapital([lots[1]], perShare(1.5));
    expect(out.lots[0].costBasisPerShare).toBe(0n);
    expect(out.lots[0].realizedLongTermGain).toBe(cents(25));
    expect(out.totalRealizedLongTermGain).toBe(cents(25));
  });

  it('handles a mix of lots in one distribution', () => {
    const out = applyReturnOfCapital(lots, perShare(1.5));
    expect(out.lots[0].costBasisPerShare).toBe(perShare(3.5)); // 5 - 1.5
    expect(out.lots[1].costBasisPerShare).toBe(0n);
    expect(out.totalRealizedLongTermGain).toBe(cents(25));
  });

  it('takes what it pays off the lot\'s remaining total', () => {
    // $1,204.95 on 1,000,000 sh ($0.0012 a share), paid $0.0010 a share: $1,000.00 off, $204.95
    // left, where shares x ($0.0012 - $0.0010) gave $200.00 and dropped the fees.
    const [r] = applyReturnOfCapital([lotOf(1, 1_000_000, '0.0012', '1204.95')], perShare('0.0010')).lots;
    expect(r).toMatchObject({ totalCostBasis: cents('204.95'), costBasisPerShare: perShare('0.0002'), realizedLongTermGain: 0n });
    // Paid $0.0013 a share ($1,300.00): $95.05 beyond the basis is gain, not $100.00.
    const [over] = applyReturnOfCapital([lotOf(1, 1_000_000, '0.0012', '1204.95')], perShare('0.0013')).lots;
    expect(over).toMatchObject({ totalCostBasis: 0n, costBasisPerShare: 0n, realizedLongTermGain: cents('95.05') });
    // 3 sh for $0.20 ($0.0667 a share, rounded up) paid $0.0666 a share, $0.20: no basis left,
    // and no basis per share either (not $0.0001).
    const [all] = applyReturnOfCapital([lotOf(1, 3, '0.0667', '0.20')], perShare('0.0666')).lots;
    expect(all).toMatchObject({ totalCostBasis: 0n, costBasisPerShare: 0n, realizedLongTermGain: 0n });
  });
});

describe('applySpinoff', () => {
  const src = [{ ...lotOf(1, 100, 50), holdingPeriodStart: '2020-01-15' }];
  it('moves a basis fraction to a new security, preserving total basis & holding period', () => {
    // 20% of $5000 basis = $1000 moves; 0.5 new shares per source share => 50 shares.
    const [r] = applySpinoff(src, ratio(0.2), ratio(0.5));
    expect(r.newShares).toBe(shares(50));
    expect(r.newTotalCostBasis).toBe(cents(1000));
    expect(r.newCostBasisPerShare).toBe(perShare(20));
    expect(r.sourceNewCostBasisPerShare).toBe(perShare(40)); // remaining $4000 / 100
    expect(r.holdingPeriodStart).toBe('2020-01-15');
    // total basis preserved: 100*40 + 50*20 = 5000
    expect(shares(100) * r.sourceNewCostBasisPerShare + r.newShares * r.newCostBasisPerShare).toBe(basisOf(src[0]));
  });
  it('splits the basis exactly: the moved part and what is left add up to the lot', () => {
    // 3 shares at $33.3333 ($99.9999); a third moves: $33.3333 -> $33.33, leaving $66.67.
    const [r] = applySpinoff([{ ...lotOf(2, 3, '33.3333'), holdingPeriodStart: '2020-01-15' }], ratio('0.333333'), ratio(1));
    expect(r.newTotalCostBasis).toBe(cents('33.33'));
    expect(r.sourceNewCostBasisPerShare).toBe(perShare('22.2233')); // $66.67 / 3
  });
  it('refuses a lot whose new shares round to none while it moves basis', () => {
    // 0.4 shares at $100 and 0.000001 new shares each: 0.0000004, which rounds to 0. Half its
    // $40 basis left it ($20 a share) for no new lot.
    const tiny = [{ ...lotOf(3, '0.4', 100), holdingPeriodStart: '2020-01-01' }];
    expect(() => applySpinoff(tiny, ratio('0.5'), ratio('0.000001'))).toThrow(
      'A lot of 0.4 shares gets no shares of the new security at this share ratio (less than 0.000001), so the basis the spinoff moves to it would be lost. Record a sale of those shares (the cash in lieu) first, then apply the spinoff.'
    );
    // Named as a split's refusal names it, when the caller has its names.
    const named = [{ ...tiny[0], uuid: '01900000-0000-7000-8000-000000000003', accountName: 'IRA', acquisitionDate: '2020-01-01' }];
    expect(() => applySpinoff(named, ratio('0.5'), ratio('0.000001'))).toThrow(
      'The lot of 0.4 shares acquired 2020-01-01 in the account "IRA" (lot 01900000-0000-7000-8000-000000000003) gets no shares of the new security at this share ratio (less than 0.000001), so the basis the spinoff moves to it would be lost. Record a sale of those shares (the cash in lieu) first, then apply the spinoff.'
    );
    // Moving no basis, it loses nothing: the source lot keeps all of it.
    expect(applySpinoff(tiny, 0n, ratio('0.000001'))[0]).toMatchObject({ newShares: 0n, newTotalCostBasis: 0n, sourceNewCostBasisPerShare: perShare(100) });
    // Half a millionth rounds up to one.
    expect(applySpinoff([{ ...tiny[0], ...lotOf(3, '0.5', 100) }], ratio('0.5'), ratio('0.000001'))[0].newShares).toBe(1n);
  });

  it('rejects out-of-range allocation', () => {
    expect(() => applySpinoff(src, ratio(1.5), ratio(0.5))).toThrow();
  });

  it('moves nothing from a lot with no shares, and isn\'t refused for it', () => {
    // An open lot a reverse split rounded to no shares before v2.1.0, its $5 basis left on it.
    const [r] = applySpinoff([{ ...lotOf(9, 0, 0, '5.00'), holdingPeriodStart: '2020-01-15' }], ratio('0.5'), ratio(1));
    expect(r).toMatchObject({ newShares: 0n, newTotalCostBasis: 0n, sourceNewTotalCostBasis: cents(5) });
  });

  it('moves part of the lot\'s remaining total, and leaves the rest as its total', () => {
    // $1,204.95 on 1,000,000 sh, a fifth moved: $240.99, leaving $963.96 (shares x $0.0012 split $1,200.00).
    const [r] = applySpinoff([{ ...lotOf(1, 1_000_000, '0.0012', '1204.95'), holdingPeriodStart: '2020-01-15' }], ratio('0.2'), ratio(1));
    expect(r).toMatchObject({ newTotalCostBasis: cents('240.99'), sourceNewTotalCostBasis: cents('963.96'), sourceNewCostBasisPerShare: perShare('0.0010') });
  });
});

describe('mergerCashDisposal', () => {
  const lots = [{ ...lotOf(1, 100, 30), holdingPeriodStart: '2020-01-15' }];
  it('records realized gain vs cash proceeds, long-term', () => {
    const [c] = mergerCashDisposal(lots, perShare(50), '2025-06-01');
    expect(c.proceeds).toBe(cents(5000));
    expect(c.basisConsumed).toBe(cents(3000));
    expect(c.realizedGainLoss).toBe(cents(2000));
    expect(c.isLongTerm).toBe(true);
  });

  it('classifies a merger on the leap-year anniversary as short-term', () => {
    // Held 2024-01-15 -> 2025-01-15: 366 days, but exactly one year, so not more than one.
    const [c] = mergerCashDisposal([{ ...lots[0], holdingPeriodStart: '2024-01-15' }], perShare(50), '2025-01-15');
    expect(c.isLongTerm).toBe(false);
    expect(c.holdingPeriodDays).toBe(366); // stored on the consumption (was always 0)
    const [next] = mergerCashDisposal([{ ...lots[0], holdingPeriodStart: '2024-01-15' }], perShare(50), '2025-01-16');
    expect(next.isLongTerm).toBe(true);
  });

  it('rounds the proceeds half away from zero', () => {
    // 90 shares at $1.2345 is $111.105: $111.11 (a float product, 111.10499999999999, gave $111.10).
    const [c] = mergerCashDisposal([{ ...lots[0], ...lotOf(1, 90, 30) }], perShare('1.2345'), '2025-06-01');
    expect(c.proceeds).toBe(cents('111.11'));
  });

  it('realizes nothing on a lot with no shares', () => {
    // Its $5 left by a reverse split before v2.1.0 isn't sold for $0: no loss.
    const [c] = mergerCashDisposal([{ ...lots[0], ...lotOf(9, 0, 0, '5.00') }], perShare(50), '2025-06-01');
    expect(c).toMatchObject({ sharesConsumed: 0n, basisConsumed: 0n, proceeds: 0n, realizedGainLoss: 0n });
    expect(mergerStockConversion([{ ...lots[0], ...lotOf(9, 0, 0, '5.00') }], ratio(2))[0]).toMatchObject({ newShares: 0n, newTotalCostBasis: 0n });
  });

  it('disposes of all the lot\'s remaining basis, as a sale of its last share does', () => {
    const [c] = mergerCashDisposal([{ ...lots[0], ...lotOf(1, 1_000_000, '0.0012', '1204.95') }], perShare('0.0012'), '2025-06-01');
    expect(c).toMatchObject({ basisConsumed: cents('1204.95'), proceeds: cents(1200), realizedGainLoss: cents('-4.95') });
  });
});

describe('mergerStockConversion', () => {
  const lots = [{ ...lotOf(1, 100, 30), holdingPeriodStart: '2020-01-15' }];
  it('refuses a lot whose new shares round to none', () => {
    // 0.4 shares × 0.000001 rounds to 0: the lot closed into no lot, its $40 basis gone.
    const tiny = [{ ...lotOf(4, '0.4', 100), holdingPeriodStart: '2020-01-01' }];
    expect(() => mergerStockConversion(tiny, ratio('0.000001'))).toThrow(
      'A lot of 0.4 shares converts to no shares of the acquirer at this exchange ratio (less than 0.000001), so its shares and basis would be lost. Record a sale of those shares (the cash in lieu) first, then apply the merger.'
    );
    // Named as a split's refusal names it, when the caller has its names.
    const named = [{ ...tiny[0], uuid: '01900000-0000-7000-8000-000000000004', accountName: 'Brokerage', acquisitionDate: '2020-01-01' }];
    expect(() => mergerStockConversion(named, ratio('0.000001'))).toThrow(
      'The lot of 0.4 shares acquired 2020-01-01 in the account "Brokerage" (lot 01900000-0000-7000-8000-000000000004) converts to no shares of the acquirer at this exchange ratio (less than 0.000001), so its shares and basis would be lost. Record a sale of those shares (the cash in lieu) first, then apply the merger.'
    );
    expect(mergerStockConversion([{ ...tiny[0], ...lotOf(4, '0.5', 100) }], ratio('0.000001'))[0]).toMatchObject({ newShares: 1n, newTotalCostBasis: cents(50) });
  });

  it('converts at the exchange ratio, preserving total basis & holding period', () => {
    const [r] = mergerStockConversion(lots, ratio(1.5));
    expect(r.newShares).toBe(shares(150));
    expect(r.newTotalCostBasis).toBe(cents(3000));
    expect(r.newCostBasisPerShare).toBe(perShare(20)); // 3000 / 150
    expect(r.holdingPeriodStart).toBe('2020-01-15');
  });

  it('carries the lot\'s remaining total, not shares x its basis per share', () => {
    const [r] = mergerStockConversion([{ ...lots[0], ...lotOf(1, 1_000_000, '0.0012', '1204.95') }], ratio('0.001'));
    expect(r).toMatchObject({ newShares: shares(1000), newTotalCostBasis: cents('1204.95'), newCostBasisPerShare: perShare('1.2050') });
  });
});
