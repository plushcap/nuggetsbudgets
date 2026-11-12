import { describe, it, expect } from 'vitest';
import { planSell, shareValueCents, type OpenLot } from '../costBasis.js';
import {
  estimateSellTax,
  rankLotsForObjective,
  tlhCandidates,
  concentration,
  unrealizedForLot,
} from '../taxPlanning.js';
import { numericUnits } from '../../../utils/decimal.js';

// Lots, prices and plans in exact units, as the sell engine takes them.
const shares = (n: number | string) => numericUnits(String(n), 6);
const price = (n: number | string) => numericUnits(String(n), 4);
/** An open lot; its remaining total is its shares × its basis per share unless given. */
const lot = (id: number, date: string, sharesRemaining: number | string, costBasisPerShare: number | string, totalCostBasis?: number | string): OpenLot => ({
  id, acquisitionDate: date, holdingPeriodStart: date, sharesRemaining: shares(sharesRemaining), costBasisPerShare: price(costBasisPerShare),
  totalCostBasis: totalCostBasis != null ? numericUnits(String(totalCostBasis), 2) : shareValueCents(shares(sharesRemaining), price(costBasisPerShare)),
});

const lots: OpenLot[] = [
  lot(1, '2020-01-15', 100, 10), // big LT gain
  lot(2, '2024-09-01', 50, 60), // ST loss at $50
  lot(3, '2022-06-01', 50, 40), // LT gain
];

describe('estimateSellTax', () => {
  it('applies LT/ST rates to a sell plan', () => {
    // FIFO sell 100 of lot 1 at $50 => LT gain 4000.
    const plan = planSell({ lots, sharesToSell: shares(100), pricePerShare: price(50), sellDate: '2025-06-01', method: 'fifo' });
    const tax = estimateSellTax(plan, 0.24, 0.15);
    expect(tax.longTermGain).toBe(4000);
    expect(tax.shortTermGain).toBe(0);
    expect(tax.estimatedLongTermTax).toBe(600); // 4000 * 0.15
    expect(tax.estimatedTotalTax).toBe(600);
    expect(tax.netProceedsAfterTax).toBe(4400); // 5000 - 600
  });

  it('treats a short-term loss as a negative tax (offset)', () => {
    // specific-ID sell lot 2 (ST) at $50 => loss of 50*(50-60) = -500.
    const plan = planSell({ lots, sharesToSell: shares(50), pricePerShare: price(50), sellDate: '2024-12-01', method: 'specific_id', specificLots: [{ lotId: 2, shares: shares(50) }] });
    const tax = estimateSellTax(plan, 0.24, 0.15);
    expect(tax.shortTermGain).toBe(-500);
    expect(tax.estimatedShortTermTax).toBe(-120); // -500 * 0.24
  });

  it('rounds the tax on the exact cents, once', () => {
    // A $6.10 short-term gain at 35% is $2.135, so $2.14. As doubles, 6.1 x 0.35 is
    // 2.1349999999999998, which rounded to $2.13; the proceeds after it were a cent high.
    const plan = planSell({ lots: [lot(9, '2025-01-02', 1, 1000)], sharesToSell: shares(1), pricePerShare: price('1006.10'), sellDate: '2025-06-02', method: 'fifo' });
    const tax = estimateSellTax(plan, 0.35, 0.15);
    expect(tax).toMatchObject({ shortTermGain: 6.1, estimatedShortTermTax: 2.14, estimatedTotalTax: 2.14, netProceedsAfterTax: 1003.96 });
  });

  it('refuses a rate that is not a number', () => {
    const plan = planSell({ lots, sharesToSell: shares(1), pricePerShare: price(50), sellDate: '2025-06-01', method: 'fifo' });
    expect(() => estimateSellTax(plan, Number.NaN, 0.15)).toThrow(/tax rate must be a number/);
  });
});

describe('rankLotsForObjective', () => {
  it('maximize_loss puts the biggest loss first', () => {
    const ranked = rankLotsForObjective(lots, price(50), 'maximize_loss');
    expect(ranked[0].id).toBe(2); // -500 loss
  });
  it('highest_cost orders by basis desc', () => {
    expect(rankLotsForObjective(lots, price(50), 'highest_cost').map((l) => l.id)).toEqual([2, 3, 1]);
  });
  it('longest_held orders by oldest holding-period start', () => {
    expect(rankLotsForObjective(lots, price(50), 'longest_held')[0].id).toBe(1);
  });
  it('answers the lot in shares and dollars, with its other fields', () => {
    const [first] = rankLotsForObjective([{ ...lot(4, '2021-01-04', '12.5', '8.25'), uuid: 'u4' }], price(10), 'minimize_gain');
    // 12.5 sh at $10 is $125.00; the lot's basis is 12.5 x $8.25 = $103.125, $103.13: selling it
    // all realizes $21.87 (shares x the difference, $21.875, rounded to $21.88, which no sale gives).
    expect(first).toEqual({
      id: 4, uuid: 'u4', acquisitionDate: '2021-01-04', holdingPeriodStart: '2021-01-04', sharesRemaining: 12.5, costBasisPerShare: 8.25, totalCostBasis: 103.13, unrealizedGain: 21.87,
    });
  });
  it('figures each lot from its remaining basis, not shares x its 4-place basis per share', () => {
    // 1,000,000 sh bought at $0.0012 with $4.95 in fees: $1,204.95, $0.0012 a share to 4 places.
    // At $0.0012 it has lost the fees, $4.95; shares x $0.0012 said it had lost nothing.
    const fees = lot(8, '2024-01-02', 1_000_000, '0.0012', '1204.95');
    const plain = lot(9, '2024-01-02', 1_000_000, '0.0012', '1200.00');
    expect(unrealizedForLot(fees, price('0.0012'))).toBe(-4.95);
    expect(tlhCandidates([plain, fees], price('0.0012')).map((c) => [c.lot.id, c.unrealizedLoss])).toEqual([[8, 4.95]]);
    // The higher remaining basis per share first, though both read $0.0012.
    expect(rankLotsForObjective([plain, fees], price('0.0012'), 'highest_cost').map((l) => l.id)).toEqual([8, 9]);
  });
});

describe('unrealizedForLot', () => {
  it('computes gain at a price', () => {
    expect(unrealizedForLot(lots[0], price(50))).toBe(4000);
    expect(unrealizedForLot(lots[1], price(50))).toBe(-500);
  });
  it('rounds the exact gain once', () => {
    // 1 share at $1,024.215 over a $1,000 basis is $24.215, so $24.22. As doubles,
    // 1024.215 - 1000 is 24.215000000000032... but 1024.215 itself is 1024.2149999999999,
    // and the old figure came to $24.21.
    expect(unrealizedForLot(lot(5, '2025-01-02', 1, 1000), price('1024.215'))).toBe(24.22);
  });
});

describe('tlhCandidates', () => {
  it('returns only loss lots, largest loss first', () => {
    const cands = tlhCandidates(lots, price(50));
    expect(cands).toHaveLength(1);
    expect(cands[0].lot.id).toBe(2);
    expect(cands[0].unrealizedLoss).toBe(500);
  });
  it('respects a minimum-loss filter', () => {
    expect(tlhCandidates(lots, price(50), 100_000)).toHaveLength(0);
  });
  it('compares the minimum loss in cents: a loss of exactly the minimum is left out', () => {
    // 1 share bought at $1.29, now $1.00: lost $0.29. In dollars, 0.29 * 100 is 28.999….
    for (const [basis, cents] of [['1.29', 29], ['1.57', 57]] as const) {
      const exact = lot(7, '2025-01-02', 1, basis);
      expect(tlhCandidates([exact], price(1), cents), basis).toHaveLength(0);
      expect(tlhCandidates([exact], price(1), cents - 1), basis).toHaveLength(1);
    }
  });
  it('rounds the market value once, and the loss is the basis less it', () => {
    // 1 share at $1,024.215: $1,024.22 (the double 1024.2149999999999 rounded to $1,024.21),
    // so a $2,000 basis has lost $975.78.
    const [c] = tlhCandidates([lot(6, '2025-01-02', 1, 2000)], price('1024.215'));
    expect(c).toMatchObject({ marketValue: 1024.22, unrealizedLoss: 975.78 });
  });
});

describe('concentration', () => {
  it('computes per-security portfolio % and flags above threshold', () => {
    const rows = concentration(
      [
        { securityId: 1, ticker: 'AAA', marketValue: 8000 },
        { securityId: 2, ticker: 'BBB', marketValue: 2000 },
      ],
      30,
      20000
    );
    expect(rows[0].ticker).toBe('AAA');
    expect(rows[0].portfolioPct).toBe(80);
    expect(rows[0].exceedsThreshold).toBe(true);
    expect(rows[0].netWorthPct).toBe(40); // 8000 / 20000
    expect(rows[1].exceedsThreshold).toBe(false); // 20% < 30%
  });
  it('reads the market values exactly, as SQL gives them', () => {
    // SUM(shares) x close = "1024.2150000000": $1,024.22, where Number() and round2 gave $1,024.21.
    const rows = concentration([{ securityId: 1, ticker: 'AAA', marketValue: '1024.2150000000' }, { securityId: 2, ticker: 'BBB', marketValue: '3072.6450000000' }]);
    expect(rows.map((r) => [r.ticker, r.marketValue, r.portfolioPct])).toEqual([['BBB', 3072.65, 75], ['AAA', 1024.22, 25]]);
  });
});
