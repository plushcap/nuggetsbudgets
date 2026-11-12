import { describe, it, expect } from 'vitest';
import {
  planSell,
  lotsHeldOn,
  buildBuyLotBasis,
  orderLots,
  averageBasisPerShare,
  isLongTermHolding,
  sellPlanAmounts,
  shareValueCents,
  type OpenLot,
  type SellInput,
} from '../costBasis.js';
import { estimateSellTax } from '../taxPlanning.js';
import { numericUnits } from '../../../utils/decimal.js';
import { daysBetween } from '../../../utils/calendarDate.js';

/**
 * Pure-calc unit tests — the correctness backbone of the cost-basis engine.
 * No database required; every figure is hand-calculated.
 *
 * The engine is exact: shares in millionths, per-share figures in ten-thousandths
 * of a dollar, money in cents. The fixtures are written in shares and dollars, and the
 * plans are read back the same way (sellPlanAmounts, what an answer gives).
 */
const shares = (n: number | string) => numericUnits(String(n), 6);
const perShare = (n: number | string) => numericUnits(String(n), 4);
const cents = (n: number | string) => numericUnits(String(n), 2);
/** An open lot; its remaining total is its shares × its basis per share unless given. */
const lot = (id: number, date: string, sharesRemaining: number | string, costBasisPerShare: number | string, totalCostBasis?: number | string): OpenLot => ({
  id, acquisitionDate: date, holdingPeriodStart: date, sharesRemaining: shares(sharesRemaining), costBasisPerShare: perShare(costBasisPerShare),
  totalCostBasis: totalCostBasis != null ? numericUnits(String(totalCostBasis), 2) : shareValueCents(shares(sharesRemaining), perShare(costBasisPerShare)),
});
/** planSell in shares and dollars. */
const sell = (input: Omit<SellInput, 'sharesToSell' | 'pricePerShare' | 'fees' | 'specificLots'> & {
  sharesToSell: number | string; pricePerShare: number | string; fees?: number | string; specificLots?: Array<{ lotId: number; shares: number | string }>;
}) => sellPlanAmounts(planSell({
  ...input,
  sharesToSell: shares(input.sharesToSell),
  pricePerShare: perShare(input.pricePerShare),
  fees: input.fees != null ? cents(input.fees) : undefined,
  specificLots: input.specificLots?.map((s) => ({ lotId: s.lotId, shares: shares(s.shares) })),
}));

const lots: OpenLot[] = [
  // Oldest, cheapest
  lot(1, '2020-01-15', 100, 10),
  // Middle, priciest
  lot(2, '2022-06-01', 50, 40),
  // Newest, mid-price
  lot(3, '2024-03-10', 50, 25),
];


describe('holding period days (calendarDate.daysBetween) & long-term', () => {
  it('counts whole calendar days', () => {
    expect(daysBetween('2024-01-01', '2024-01-02')).toBe(1);
    expect(daysBetween('2023-01-01', '2024-01-01')).toBe(365);
    expect(daysBetween('2024-01-01', '2025-01-01')).toBe(366); // leap year
  });
});

// Long-term means held MORE than one year. Counting starts the day
// after acquisition and the sale day counts (IRS Pub. 550), so a sale on the one-year
// anniversary is short-term and the next day is long-term, whatever the day count.
describe('isLongTermHolding — the one-year anniversary, not 365 days', () => {
  it('a sale on the anniversary is short-term even when the year has 366 days', () => {
    // 2023-03-01 -> 2024-03-01 spans 2024-02-29: 366 days, but exactly one year.
    expect(daysBetween('2023-03-01', '2024-03-01')).toBe(366);
    expect(isLongTermHolding('2023-03-01', '2024-03-01')).toBe(false);
    expect(isLongTermHolding('2023-03-01', '2024-03-02')).toBe(true);
    // 2024-01-15 -> 2025-01-15 spans 2024-02-29: 366 days, exactly one year.
    expect(daysBetween('2024-01-15', '2025-01-15')).toBe(366);
    expect(isLongTermHolding('2024-01-15', '2025-01-15')).toBe(false);
    expect(isLongTermHolding('2024-01-15', '2025-01-16')).toBe(true);
  });

  it('in a year without Feb 29 the anniversary is day 365', () => {
    expect(isLongTermHolding('2022-06-10', '2023-06-10')).toBe(false); // 365 days
    expect(isLongTermHolding('2022-06-10', '2023-06-11')).toBe(true); // 366 days
  });

  it('a Feb 29 acquisition turns long-term on Mar 1 of the next year', () => {
    // Its anniversary is Feb 28, 2025 (there is no Feb 29): held from Mar 1, 2024
    // through Feb 28, 2025 is exactly one year, so Mar 1, 2025 is the first day past it.
    expect(isLongTermHolding('2024-02-29', '2025-02-28')).toBe(false);
    expect(isLongTermHolding('2024-02-29', '2025-03-01')).toBe(true);
  });

  it('a sell on a leap-year anniversary is planned and taxed as short-term', () => {
    // 100 sh bought 2023-03-01 at $10, sold 2024-03-01 at $15: gain 100 * (15 - 10) = $500,
    // short-term (one year to the day), so the 24% rate applies: $120, not 15% = $75.
    const plan = sell({ lots: [lot(9, '2023-03-01', 100, 10)], sharesToSell: 100, pricePerShare: 15, sellDate: '2024-03-01', method: 'fifo' });
    expect(plan.consumptions[0].holdingPeriodDays).toBe(366);
    expect(plan.consumptions[0].isLongTerm).toBe(false);
    expect(plan.shortTermRealized).toBe(500);
    expect(plan.longTermRealized).toBe(0);
    // The tax is figured on the exact plan.
    const tax = estimateSellTax(planSell({ lots: [lot(9, '2023-03-01', 100, 10)], sharesToSell: shares(100), pricePerShare: perShare(15), sellDate: '2024-03-01', method: 'fifo' }), 0.24, 0.15);
    expect(tax.estimatedShortTermTax).toBe(120);
    expect(tax.estimatedLongTermTax).toBe(0);
  });
});

describe('buildBuyLotBasis (commission absorbed into basis)', () => {
  it('absorbs commission into total and per-share basis', () => {
    const { totalCostBasis, costBasisPerShare } = buildBuyLotBasis(shares(100), perShare(50), cents(4.95));
    expect(totalCostBasis).toBe(cents('5004.95'));
    expect(costBasisPerShare).toBe(perShare('50.0495'));
  });

  it('rounds the total once, half away from zero, as Postgres does', () => {
    // 90 × $1.2345 is $111.105 exactly: $111.11. As floats it was 111.10499999999999, so $111.10.
    expect(buildBuyLotBasis(shares(90), perShare('1.2345')).totalCostBasis).toBe(cents('111.11'));
    // Fractional shares at a 4-place price: 0.123456 × $1,234.5678 = $152.41480... -> $152.41,
    // and the basis per share is that total over the shares, to the column's 4 places.
    const fractional = buildBuyLotBasis(shares('0.123456'), perShare('1234.5678'), cents('0.99'));
    expect(fractional.totalCostBasis).toBe(cents('153.40'));
    expect(fractional.costBasisPerShare).toBe(perShare('1242.5480')); // 153.40 / 0.123456 = 1242.547952...
  });

  it('holds share counts a float can\'t: 123,456,789,012.123456 shares', () => {
    // As a double that count is 123456789012.12346; in millionths it is exact.
    const big = buildBuyLotBasis(shares('123456789012.123456'), perShare('0.0001'));
    expect(big.totalCostBasis).toBe(cents('12345678.90')); // 12,345,678.9012123456 -> .90
  });
});

describe('orderLots', () => {
  it('FIFO oldest-first, LIFO newest-first, HIFO highest-basis-first', () => {
    expect(orderLots(lots, 'fifo').map((l) => l.id)).toEqual([1, 2, 3]);
    expect(orderLots(lots, 'lifo').map((l) => l.id)).toEqual([3, 2, 1]);
    expect(orderLots(lots, 'hifo').map((l) => l.id)).toEqual([2, 3, 1]);
  });
});

describe('planSell — FIFO', () => {
  it('consumes oldest lot first and classifies long-term', () => {
    const plan = sell({ lots, sharesToSell: 60, pricePerShare: 50, sellDate: '2025-01-15', method: 'fifo' });
    expect(plan.consumptions).toHaveLength(1);
    const c = plan.consumptions[0];
    expect(c.lotId).toBe(1);
    expect(c.sharesConsumed).toBe(60);
    expect(c.basisConsumed).toBe(600); // 60 * 10
    expect(c.proceeds).toBe(3000); // 60 * 50
    expect(c.realizedGainLoss).toBe(2400);
    expect(c.isLongTerm).toBe(true);
    expect(plan.totalRealized).toBe(2400);
    expect(plan.longTermRealized).toBe(2400);
    expect(plan.shortTermRealized).toBe(0);
  });

  it('spans multiple lots when one is insufficient', () => {
    const plan = sell({ lots, sharesToSell: 120, pricePerShare: 50, sellDate: '2025-01-15', method: 'fifo' });
    expect(plan.consumptions.map((c) => c.lotId)).toEqual([1, 2]);
    expect(plan.consumptions[1].sharesConsumed).toBe(20);
    // basis: 100*10 + 20*40 = 1800; proceeds 120*50 = 6000; gain 4200
    expect(plan.totalBasis).toBe(1800);
    expect(plan.totalProceeds).toBe(6000);
    expect(plan.totalRealized).toBe(4200);
  });
});

describe('planSell — LIFO / HIFO', () => {
  it('LIFO consumes newest first (short-term)', () => {
    const plan = sell({ lots, sharesToSell: 50, pricePerShare: 50, sellDate: '2024-09-10', method: 'lifo' });
    expect(plan.consumptions[0].lotId).toBe(3);
    expect(plan.consumptions[0].isLongTerm).toBe(false); // ~184 days
    expect(plan.totalRealized).toBe(1250); // 50*(50-25)
  });

  it('HIFO consumes highest-basis lot first to minimize gain', () => {
    const plan = sell({ lots, sharesToSell: 50, pricePerShare: 50, sellDate: '2025-01-15', method: 'hifo' });
    expect(plan.consumptions[0].lotId).toBe(2);
    expect(plan.totalRealized).toBe(500); // 50*(50-40)
  });
});

describe('planSell — average cost', () => {
  it('uses portfolio weighted-average basis per share', () => {
    // avg = (100*10 + 50*40 + 50*25) / 200 = (1000+2000+1250)/200 = 4250/200 = 21.25
    expect(averageBasisPerShare(lots)).toBe(perShare('21.25'));
    const plan = sell({ lots, sharesToSell: 100, pricePerShare: 50, sellDate: '2025-01-15', method: 'average_cost' });
    expect(plan.totalBasis).toBe(2125); // 100 * 21.25
    expect(plan.totalProceeds).toBe(5000);
    expect(plan.totalRealized).toBe(2875);
  });
});

describe('planSell — specific ID', () => {
  it('consumes exactly the selected lots', () => {
    const plan = sell({
      lots,
      sharesToSell: 70,
      pricePerShare: 50,
      sellDate: '2025-01-15',
      method: 'specific_id',
      specificLots: [
        { lotId: 2, shares: 50 },
        { lotId: 3, shares: 20 },
      ],
    });
    expect(plan.consumptions.map((c) => c.lotId)).toEqual([2, 3]);
    // basis 50*40 + 20*25 = 2500; proceeds 3500; gain 1000
    expect(plan.totalBasis).toBe(2500);
    expect(plan.totalRealized).toBe(1000);
  });

  it('rejects a selection that does not sum to sharesToSell', () => {
    expect(() =>
      sell({
        lots,
        sharesToSell: 70,
        pricePerShare: 50,
        sellDate: '2025-01-15',
        method: 'specific_id',
        specificLots: [{ lotId: 2, shares: 50 }],
      })
    ).toThrow(/must equal/);
  });

  it('rejects over-consuming a lot', () => {
    expect(() =>
      sell({
        lots,
        sharesToSell: 200,
        pricePerShare: 50,
        sellDate: '2025-01-15',
        method: 'specific_id',
        specificLots: [{ lotId: 2, shares: 200 }],
      })
    ).toThrow(/has only 50 shares/);
  });
});

describe('planSell — fees reduce proceeds', () => {
  it('allocates fees pro-rata across consumptions, remainder on last', () => {
    const plan = sell({ lots, sharesToSell: 120, pricePerShare: 50, sellDate: '2025-01-15', method: 'fifo', fees: 10 });
    expect(plan.totalProceeds).toBe(5990); // 6000 - 10
    // fee split: 100/120*10 = 8.33 on lot1, remainder 1.67 on lot2
    expect(plan.consumptions[0].proceeds).toBe(4991.67);
    expect(plan.consumptions[1].proceeds).toBe(998.33);
  });
});

describe('planSell — losses', () => {
  it('produces a negative realized gain', () => {
    const plan = sell({ lots, sharesToSell: 50, pricePerShare: 30, sellDate: '2025-01-15', method: 'hifo' });
    expect(plan.consumptions[0].lotId).toBe(2);
    expect(plan.totalRealized).toBe(-500); // 50*(30-40)
  });
});

describe('lotsHeldOn — the lots a sale on a day can sell', () => {
  const twoLots = [lot(1, '2025-01-02', 10, 10), lot(2, '2025-03-10', '10.5', 30)];
  it('keeps those acquired on or before the day', () => {
    expect(lotsHeldOn(twoLots, '2025-03-01').map((l) => l.id)).toEqual([1]);
    expect(lotsHeldOn(twoLots, '2025-03-10').map((l) => l.id)).toEqual([1, 2]);
  });
  it('says, for a sale of more than was held then, what was held and what came after', () => {
    expect(() => lotsHeldOn(twoLots, '2025-03-01', shares(15))).toThrow(
      'Insufficient shares on 2025-03-01: requested 15, held 10 on that date (10.5 more were acquired after it)'
    );
    // What was held then is enough, or nothing came after: no refusal here (planSell's own
    // "Insufficient shares" answers the second).
    expect(lotsHeldOn(twoLots, '2025-03-01', shares(10)).map((l) => l.id)).toEqual([1]);
    expect(lotsHeldOn(twoLots, '2025-03-10', shares(25)).map((l) => l.id)).toEqual([1, 2]);
  });
});

describe('planSell — validation', () => {
  it('throws on insufficient total shares', () => {
    expect(() => sell({ lots, sharesToSell: 1000, pricePerShare: 50, sellDate: '2025-01-15', method: 'fifo' })).toThrow(
      /Insufficient shares/
    );
  });
});

describe('planSell — exact figures', () => {
  it('rounds each consumption once, so the lots add up to the sale', () => {
    // 3 lots of 1/3 share each at $10.0001 basis, sold at $33.3333: every figure in cents.
    const thirds = [lot(1, '2020-01-01', '0.333333', '10.0001'), lot(2, '2021-01-01', '0.333333', '10.0001'), lot(3, '2022-01-01', '0.333334', '10.0001')];
    const p = sell({ lots: thirds, sharesToSell: 1, pricePerShare: '33.3333', sellDate: '2025-01-15', method: 'fifo', fees: '0.10' });
    expect(p.consumptions.map((c) => c.sharesConsumed)).toEqual([0.333333, 0.333333, 0.333334]);
    // Gross 0.333333 × 33.3333 = 11.11108888... -> 11.11; fee 0.10 × 0.333333 = 0.0333333 -> 0.03.
    expect(p.consumptions.map((c) => c.proceeds)).toEqual([11.08, 11.08, 11.07]);
    expect(p.totalProceeds).toBe(33.23); // 33.33 gross less the 0.10 fee, allocated 0.03 + 0.03 + 0.04
    expect(p.consumptions.map((c) => c.basisConsumed)).toEqual([3.33, 3.33, 3.33]);
    expect(p.totalBasis).toBe(9.99);
  });

  it('sells the average basis of an average-cost pool, rounded once per consumption', () => {
    // Pool: 1 share at $10 and 2 at $10.0001: average $10.0000666..., 3 shares sold at $11.
    const pool = [lot(1, '2020-01-01', 1, 10), lot(2, '2021-01-01', 2, '10.0001')];
    const p = sell({ lots: pool, sharesToSell: 3, pricePerShare: 11, sellDate: '2025-01-15', method: 'average_cost' });
    expect(p.consumptions.map((c) => c.basisConsumed)).toEqual([10, 20]); // 10.0000667, 20.0001333
    expect(p.totalRealized).toBe(3);
  });

  it('refuses one lot picked twice for more than it holds', () => {
    expect(() => sell({
      lots, sharesToSell: 60, pricePerShare: 50, sellDate: '2025-01-15', method: 'specific_id',
      specificLots: [{ lotId: 2, shares: 30 }, { lotId: 2, shares: 30 }],
    })).toThrow(/has only 50 shares, 60 requested/);
  });
});

/**
 * A sale takes a lot's remaining basis pro rata: S of R shares take total × S / R,
 * rounded once, and the last share takes what is left. It was figured from the 4-place basis per
 * share, which left basis on a lot sold in parts, took more than it had, or missed the fees.
 */
describe('planSell — pro-rata remaining basis', () => {
  /** Sells `count` shares at a time, each sale from the lot as the one before left it. */
  const sellInParts = (start: OpenLot, parts: number[]) => {
    let current = start;
    const basis: bigint[] = [];
    for (const part of parts) {
      const plan = planSell({ lots: [current], sharesToSell: shares(part), pricePerShare: perShare(1), sellDate: '2025-01-15', method: 'fifo' });
      basis.push(plan.consumptions[0].basisConsumed);
      const after = plan.lotsAfter.get(current.id)!;
      current = { ...current, ...after };
    }
    return { basis, after: current };
  };

  it('takes the fees in a lot\'s basis: $1,204.95, not 1,000,000 x $0.0012', () => {
    // 1,000,000 sh at $0.0012 with $4.95 in fees: $0.0012 a share to 4 places. Sold whole at
    // $0.0012, it lost the fees; from the per-share basis it realized $0.00.
    const fees = lot(1, '2024-01-02', 1_000_000, '0.0012', '1204.95');
    const p = sell({ lots: [fees], sharesToSell: 1_000_000, pricePerShare: '0.0012', sellDate: '2025-01-15', method: 'fifo' });
    expect(p.consumptions[0]).toMatchObject({ basisConsumed: 1204.95, proceeds: 1200, realizedGainLoss: -4.95 });
    // Half of it takes half its basis: $602.475, $602.48, and leaves $602.47.
    const half = planSell({ lots: [fees], sharesToSell: shares(500_000), pricePerShare: perShare('0.0012'), sellDate: '2025-01-15', method: 'fifo' });
    expect(half.consumptions[0].basisConsumed).toBe(cents('602.48'));
    expect(half.lotsAfter.get(1)).toEqual({ sharesRemaining: shares(500_000), totalCostBasis: cents('602.47'), costBasisPerShare: perShare('0.0012') });
  });

  it('leaves no basis on a lot sold a share at a time: $100.00 in three sales', () => {
    // 3 sh for $100.00, $33.3333 a share. Sold one at a time, the per-share basis took $33.33
    // three times, $99.99, and closed the lot with the last cent on it.
    const { basis, after } = sellInParts(lot(1, '2024-01-02', 3, '33.3333', '100.00'), [1, 1, 1]);
    expect(basis).toEqual([cents('33.33'), cents('33.34'), cents('33.33')]); // $66.67 / 2 = $33.335: $33.34
    expect(basis.reduce((a, b) => a + b, 0n)).toBe(cents('100.00'));
    expect(after).toMatchObject({ sharesRemaining: 0n, totalCostBasis: 0n });
  });

  it('never takes more than the lot has: $0.20 in three sales, not $0.21', () => {
    // 3 sh for $0.20, $0.0667 a share: $0.07 a sale from the per-share basis, $0.21 in all.
    const { basis, after } = sellInParts(lot(1, '2024-01-02', 3, '0.0667', '0.20'), [1, 1, 1]);
    expect(basis).toEqual([cents('0.07'), cents('0.07'), cents('0.06')]); // $0.13 / 2 = $0.065: $0.07
    expect(after).toMatchObject({ sharesRemaining: 0n, totalCostBasis: 0n });
  });

  it('a lot picked twice in one sale gives what two sales of it would', () => {
    const third = lot(1, '2024-01-02', 3, '33.3333', '100.00');
    const p = planSell({
      lots: [third], sharesToSell: shares(2), pricePerShare: perShare(40), sellDate: '2025-01-15', method: 'specific_id',
      specificLots: [{ lotId: 1, shares: shares(1) }, { lotId: 1, shares: shares(1) }],
    });
    expect(p.consumptions.map((c) => c.basisConsumed)).toEqual([cents('33.33'), cents('33.34')]);
    expect(p.lotsAfter.get(1)).toEqual({ sharesRemaining: shares(1), totalCostBasis: cents('33.33'), costBasisPerShare: perShare('33.3333') });
  });

  it('a sale of some of several lots leaves each the basis it didn\'t take', () => {
    const p = planSell({ lots, sharesToSell: shares(120), pricePerShare: perShare(50), sellDate: '2025-01-15', method: 'fifo' });
    expect([...p.lotsAfter]).toEqual([
      [1, { sharesRemaining: 0n, totalCostBasis: 0n, costBasisPerShare: perShare(10) }],
      [2, { sharesRemaining: shares(30), totalCostBasis: cents(1200), costBasisPerShare: perShare(40) }], // $2,000 less 20 x $40
    ]);
  });

  it('average cost takes the pool\'s remaining basis, and a sale of the whole pool takes all of it', () => {
    // $1,204.95 and $1,200.00, each 1,000,000 sh at $0.0012 a share: the pool is $2,404.95.
    const pool = [lot(1, '2024-01-02', 1_000_000, '0.0012', '1204.95'), lot(2, '2024-02-01', 1_000_000, '0.0012', '1200.00')];
    expect(averageBasisPerShare(pool)).toBe(perShare('0.0012')); // $0.001202475
    expect(sell({ lots: pool, sharesToSell: 2_000_000, pricePerShare: 1, sellDate: '2025-01-15', method: 'average_cost' }).totalBasis).toBe(2404.95);
    // Half the pool: $1,202.475, $1,202.48.
    expect(sell({ lots: pool, sharesToSell: 1_000_000, pricePerShare: 1, sellDate: '2025-01-15', method: 'average_cost' }).totalBasis).toBe(1202.48);
    // A lot with no shares left (a reverse split rounded one to none before v2.1.0) adds nothing.
    const stranded = lot(3, '2023-01-02', 0, 0, '50.00');
    expect(sell({ lots: [...pool, stranded], sharesToSell: 2_000_000, pricePerShare: 1, sellDate: '2025-01-15', method: 'average_cost' }).totalBasis).toBe(2404.95);
  });

  it('an average-cost sale re-bases the pool: $10 and $20 lots, one share sold, $15 recorded and $15 kept', () => {
    // The shares come from the $10 lot (oldest first), the basis from the pool: $15. Each lot
    // then gave up its own basis, so the $10 lot closed and the $20 one kept $20: $5 was gone.
    const pool = [lot(1, '2024-01-02', 1, 10), lot(2, '2024-02-01', 1, 20)];
    const p = planSell({ lots: pool, sharesToSell: shares(1), pricePerShare: perShare(25), sellDate: '2025-01-15', method: 'average_cost' });
    expect(p.consumptions.map((c) => [c.lotId, c.basisConsumed])).toEqual([[1, cents(15)]]);
    expect([...p.lotsAfter]).toEqual([
      [1, { sharesRemaining: 0n, totalCostBasis: 0n, costBasisPerShare: perShare(10) }],
      [2, { sharesRemaining: shares(1), totalCostBasis: cents(15), costBasisPerShare: perShare(15) }],
    ]);
  });

  it('an average-cost pool sold in two steps keeps every cent: recorded and kept add up to what it held', () => {
    // Three lots, $4,000.01 in all, 183.333333 sh: an awkward average ($21.8182 a share).
    const start = [
      lot(1, '2020-01-02', 100, 10, '1000.00'),
      lot(2, '2021-01-04', 50, '40.0002', '2000.01'),
      lot(3, '2022-01-03', '33.333333', 30, '1000.00'),
    ];
    const held = cents('4000.01');
    const total = (ls: Array<{ totalCostBasis: bigint }>) => ls.reduce((t, l) => t + l.totalCostBasis, 0n);
    const step = (ls: OpenLot[], n: number | string) =>
      planSell({ lots: ls, sharesToSell: shares(n), pricePerShare: perShare(20), sellDate: '2025-01-15', method: 'average_cost' });

    const first = step(start, 70);
    expect(first.consumptions.map((c) => c.lotId)).toEqual([1]); // oldest first, for the holding period
    const recorded1 = first.totalBasis;
    expect(recorded1).toBe(cents('1527.28')); // $4,000.01 x 70 / 183.333333 = $1,527.2766...
    // Every lot of the pool, the two it took nothing from too, has the pool's basis a share:
    // $2,472.73 / 113.333333 = $21.8182. Each lot's total is whole cents ($654.55 on 30 sh,
    // $1,090.91 on 50, $727.27 on 33.333333), so its total over its shares is a ten-thousandth
    // either side of it.
    expect([...first.lotsAfter.keys()]).toEqual([1, 2, 3]);
    expect(recorded1 + total([...first.lotsAfter.values()])).toBe(held);
    expect([...first.lotsAfter.values()].map((l) => l.totalCostBasis)).toEqual([cents('654.55'), cents('1090.91'), cents('727.27')]);
    expect([...first.lotsAfter.values()].map((l) => l.costBasisPerShare)).toEqual([perShare('21.8183'), perShare('21.8182'), perShare('21.8181')]);

    const after1 = start.map((l) => ({ ...l, ...first.lotsAfter.get(l.id)! }));
    const second = step(after1, 80);
    expect(second.consumptions.map((c) => [c.lotId, c.sharesConsumed])).toEqual([[1, shares(30)], [2, shares(50)]]);
    expect(recorded1 + second.totalBasis + total([...second.lotsAfter.values()])).toBe(held);
    expect(second.lotsAfter.get(3)).toMatchObject({ sharesRemaining: shares('33.333333') });
    expect(second.lotsAfter.get(1)).toMatchObject({ sharesRemaining: 0n, totalCostBasis: 0n });
    expect(second.lotsAfter.get(2)).toMatchObject({ sharesRemaining: 0n, totalCostBasis: 0n });
  });

  it('an average-cost re-base spreads the cents so the lots add up exactly', () => {
    // $10.00 over three lots of one share each: $3.33 each and a cent left, to the oldest.
    const pool = [lot(1, '2024-01-02', 1, 5), lot(2, '2024-01-03', 1, 3), lot(3, '2024-01-04', 1, 3), lot(4, '2024-01-05', 1, '3.0000', '3.00')];
    // Sell 1 of 4 shares ($14.00 pool): $3.50 recorded, $10.50 left over 3 shares: $3.50 each.
    const even = planSell({ lots: pool, sharesToSell: shares(1), pricePerShare: perShare(1), sellDate: '2025-01-15', method: 'average_cost' });
    expect([...even.lotsAfter.values()].map((l) => l.totalCostBasis)).toEqual([0n, cents('3.50'), cents('3.50'), cents('3.50')]);
    const odd = [lot(1, '2024-01-02', 1, 5), lot(2, '2024-01-03', 1, 3), lot(3, '2024-01-04', 1, 3), lot(4, '2024-01-05', 1, '2.0100', '2.01')];
    // $13.01 pool: $3.25 recorded ($3.2525), $9.76 left: $3.25 each and a cent to the oldest.
    const p = planSell({ lots: odd, sharesToSell: shares(1), pricePerShare: perShare(1), sellDate: '2025-01-15', method: 'average_cost' });
    expect(p.totalBasis).toBe(cents('3.25'));
    expect([...p.lotsAfter.values()].map((l) => l.totalCostBasis)).toEqual([0n, cents('3.26'), cents('3.25'), cents('3.25')]);
  });

  it('a sale of the whole average-cost pool leaves every lot at nothing', () => {
    const pool = [lot(1, '2024-01-02', 1, 10), lot(2, '2024-02-01', 2, '10.0001', '20.00'), lot(3, '2024-03-01', '0.5', 7, '3.50')];
    const p = planSell({ lots: pool, sharesToSell: shares('3.5'), pricePerShare: perShare(1), sellDate: '2025-01-15', method: 'average_cost' });
    expect(p.totalBasis).toBe(cents('33.50'));
    expect([...p.lotsAfter.values()].map((l) => [l.sharesRemaining, l.totalCostBasis])).toEqual([[0n, 0n], [0n, 0n], [0n, 0n]]);
  });

  describe('average cost keeps covered and noncovered lots in separate pools (IRC §1012(c)(2)(A))', () => {
    // Noncovered (before 2012): 10 sh for $100 and 10 for $300, $20 a share. Covered: 10 for
    // $500 and 10 for $700, $60 a share. One pool of all four is $40 a share.
    const mixed = [
      { ...lot(1, '2010-01-04', 10, 10), isCovered: false },
      { ...lot(2, '2011-01-03', 10, 30), isCovered: false },
      lot(3, '2015-01-02', 10, 50),
      lot(4, '2016-01-04', 10, 70),
    ];
    const sale = (n: number) => planSell({ lots: mixed, sharesToSell: shares(n), pricePerShare: perShare(40), sellDate: '2025-01-15', method: 'average_cost' });
    const kept = (p: ReturnType<typeof sale>, ids: number[]) => ids.reduce((t, id) => t + (p.lotsAfter.get(id)?.totalCostBasis ?? mixed[id - 1].totalCostBasis), 0n);

    it('a sale across both takes each pick\'s basis from its own pool, and re-bases each', () => {
      // 25 sh, oldest first: both noncovered lots (all of their pool, $400), then 5 covered
      // ($1,200 x 5 / 20 = $300): $700, where one pool took 25 x $40 = $1,000.
      const p = sale(25);
      expect(p.consumptions.map((c) => [c.lotId, c.sharesConsumed, c.basisConsumed])).toEqual([[1, shares(10), cents(200)], [2, shares(10), cents(200)], [3, shares(5), cents(300)]]);
      expect(p.totalBasis).toBe(cents(700));
      // The covered pool's $900 left over its 15 shares, $60 a share.
      expect(p.lotsAfter.get(3)).toEqual({ sharesRemaining: shares(5), totalCostBasis: cents(300), costBasisPerShare: perShare(60) });
      expect(p.lotsAfter.get(4)).toEqual({ sharesRemaining: shares(10), totalCostBasis: cents(600), costBasisPerShare: perShare(60) });
      // Recorded plus kept is what each pool held.
      const recorded = (ids: number[]) => p.consumptions.filter((c) => ids.includes(c.lotId)).reduce((t, c) => t + c.basisConsumed, 0n);
      expect(recorded([1, 2]) + kept(p, [1, 2])).toBe(cents(400));
      expect(recorded([3, 4]) + kept(p, [3, 4])).toBe(cents(1200));
    });

    it('a sale within one pool leaves the other as it is', () => {
      // 5 sh from the oldest (noncovered) lot: $400 x 5 / 20 = $100; its pool's $300 left over
      // 15 shares, $20 a share. The covered lots aren't touched.
      const p = sale(5);
      expect(p.totalBasis).toBe(cents(100));
      expect([...p.lotsAfter]).toEqual([
        [1, { sharesRemaining: shares(5), totalCostBasis: cents(100), costBasisPerShare: perShare(20) }],
        [2, { sharesRemaining: shares(10), totalCostBasis: cents(200), costBasisPerShare: perShare(20) }],
      ]);
    });
  });

  it('a lot with no shares stays out of the re-based pool', () => {
    // A lot a reverse split rounded to no shares before v2.1.0 keeps its $50 and isn't written.
    const pool = [lot(1, '2024-01-02', 1, 10), lot(2, '2024-02-01', 1, 20), lot(3, '2023-01-02', 0, 0, '50.00')];
    const p = planSell({ lots: pool, sharesToSell: shares(1), pricePerShare: perShare(25), sellDate: '2025-01-15', method: 'average_cost' });
    expect(p.totalBasis).toBe(cents(15));
    expect(p.lotsAfter.has(3)).toBe(false);
    expect(p.lotsAfter.get(2)).toMatchObject({ totalCostBasis: cents(15) });
  });

  it('HIFO takes the higher remaining basis per share first, compared exactly', () => {
    const fees = lot(2, '2024-02-01', 1_000_000, '0.0012', '1204.95');
    const plain = lot(1, '2024-01-02', 1_000_000, '0.0012', '1200.00');
    expect(orderLots([plain, fees], 'hifo').map((l) => l.id)).toEqual([2, 1]);
    // A lot with no shares goes last: it has none to give.
    expect(orderLots([lot(3, '2023-01-02', 0, 0, '50.00'), plain], 'hifo').map((l) => l.id)).toEqual([1, 3]);
  });
});
