import { describe, it, expect } from 'vitest';
import {
  centsAddingUp,
  validateCompositionWeights,
  computeLookThrough,
  validateUnderlyingWeights,
  computeUnderlyingExposure,
  type LookThroughHolding,
  type ExposureHolding,
  type UnderlyingWeightRow,
} from '../lookThrough.js';

/** No security worth less than a cent. */
const NONE_BELOW_A_CENT = { securities: 0, amount: 0, percentage: 0 };

describe('validateCompositionWeights', () => {
  it('accepts a sum within 95-105%', () => {
    expect(validateCompositionWeights([{ dimensionValue: 'a', weightPercentage: 60 }, { dimensionValue: 'b', weightPercentage: 40 }])).toBe(100);
  });
  it('accepts 96% (cash drag tolerance)', () => {
    expect(validateCompositionWeights([{ dimensionValue: 'a', weightPercentage: 96 }])).toBe(96);
  });
  it('rejects a sum below tolerance', () => {
    expect(() => validateCompositionWeights([{ dimensionValue: 'a', weightPercentage: 80 }])).toThrow(/must be within/);
  });
  it('rejects a sum above tolerance', () => {
    expect(() => validateCompositionWeights([{ dimensionValue: 'a', weightPercentage: 110 }])).toThrow(/must be within/);
  });
  it('compares the exact sum with the bounds', () => {
    // Three thirds to 6 places: 99.999999, in tolerance; 105.000001 is not, by a millionth.
    expect(validateCompositionWeights(['33.333333', '33.333333', '33.333333'].map((w) => ({ weightPercentage: w })))).toBe(99.999999);
    expect(() => validateCompositionWeights([{ weightPercentage: '100' }, { weightPercentage: '5.000001' }])).toThrow(/sum to 105.000001%/);
    expect(validateCompositionWeights([{ weightPercentage: '100' }, { weightPercentage: '5.000000' }])).toBe(105);
  });
});

describe('computeLookThrough', () => {
  it('attributes direct holdings 100% to their own classification', () => {
    const holdings: LookThroughHolding[] = [
      { securityId: 1, ticker: 'ACMEC', marketValue: 10000, isPassThrough: false, ownDimensionValue: 'technology', composition: null },
      { securityId: 2, ticker: 'BANKX', marketValue: 5000, isPassThrough: false, ownDimensionValue: 'financials', composition: null },
    ];
    const r = computeLookThrough(holdings);
    expect(r.totalValue).toBe(15000);
    expect(r.buckets.find((b) => b.dimensionValue === 'technology')!.amount).toBe(10000);
    expect(r.buckets.find((b) => b.dimensionValue === 'technology')!.percentage).toBeCloseTo(66.67, 1);
  });

  it('distributes a pass-through fund by composition weights', () => {
    const holdings: LookThroughHolding[] = [
      {
        securityId: 3, ticker: 'STKIDX', marketValue: 10000, isPassThrough: true, ownDimensionValue: null,
        composition: [
          { dimensionValue: 'technology', weightPercentage: 30 },
          { dimensionValue: 'financials', weightPercentage: 20 },
          { dimensionValue: 'healthcare', weightPercentage: 50 },
        ],
      },
    ];
    const r = computeLookThrough(holdings);
    expect(r.buckets.find((b) => b.dimensionValue === 'technology')!.amount).toBe(3000);
    expect(r.buckets.find((b) => b.dimensionValue === 'healthcare')!.amount).toBe(5000);
  });

  it('combines direct + indirect tech exposure across holdings', () => {
    const holdings: LookThroughHolding[] = [
      { securityId: 1, ticker: 'ACMEC', marketValue: 10000, isPassThrough: false, ownDimensionValue: 'technology', composition: null },
      { securityId: 3, ticker: 'STKIDX', marketValue: 10000, isPassThrough: true, ownDimensionValue: null, composition: [{ dimensionValue: 'technology', weightPercentage: 30 }, { dimensionValue: 'other', weightPercentage: 70 }] },
    ];
    const r = computeLookThrough(holdings);
    // tech = 10000 direct + 3000 via STKIDX = 13000 of 20000 = 65%
    expect(r.buckets.find((b) => b.dimensionValue === 'technology')!.amount).toBe(13000);
    expect(r.buckets.find((b) => b.dimensionValue === 'technology')!.percentage).toBe(65);
  });

  it('routes pass-through funds with no composition to an unknown bucket', () => {
    const holdings: LookThroughHolding[] = [
      { securityId: 4, ticker: 'XYZ', marketValue: 8000, isPassThrough: true, ownDimensionValue: null, composition: null },
    ];
    const r = computeLookThrough(holdings);
    expect(r.unknownValue).toBe(8000);
    expect(r.buckets.find((b) => b.dimensionValue === 'unknown')!.amount).toBe(8000);
  });

  it('normalizes when weights sum slightly off 100%', () => {
    const holdings: LookThroughHolding[] = [
      { securityId: 5, ticker: 'BONDIX', marketValue: 10000, isPassThrough: true, ownDimensionValue: null, composition: [{ dimensionValue: 'treasuries', weightPercentage: 48 }, { dimensionValue: 'corp', weightPercentage: 48 }] },
    ];
    const r = computeLookThrough(holdings); // sum 96 -> normalized to full 10000
    const total = r.buckets.reduce((s, b) => s + Number(b.amount), 0);
    expect(total).toBeCloseTo(10000, 2);
  });
});

describe('validateUnderlyingWeights', () => {
  it('accepts weights summing to 100%', () => {
    expect(validateUnderlyingWeights([{ weightPercentage: 60 }, { weightPercentage: 40 }])).toBe(100);
  });
  it('accepts a sum under 100% (residual is cash/unaccounted)', () => {
    expect(validateUnderlyingWeights([{ weightPercentage: 30 }, { weightPercentage: 20 }])).toBe(50);
  });
  it('rejects a sum above 105%', () => {
    expect(() => validateUnderlyingWeights([{ weightPercentage: 60 }, { weightPercentage: 50 }])).toThrow(/must be ≤/);
  });
  it('rejects a non-positive or >100 single weight', () => {
    expect(() => validateUnderlyingWeights([{ weightPercentage: 0 }])).toThrow(/must be > 0/);
    expect(() => validateUnderlyingWeights([{ weightPercentage: 101 }])).toThrow(/must be > 0/);
  });
  it('rejects empty and over-cap inputs', () => {
    expect(() => validateUnderlyingWeights([])).toThrow(/at least one/);
    expect(() => validateUnderlyingWeights(Array.from({ length: 20001 }, () => ({ weightPercentage: 0.001 })))).toThrow(/capped at 20000/);
  });
  it('accepts a large holdings list up to the cap', () => {
    // 20000 holdings at 0.005% each sum to 100% — a full total-market fund.
    // Summed exactly: 100, not a float near it.
    expect(validateUnderlyingWeights(Array.from({ length: 20000 }, () => ({ weightPercentage: 0.005 })))).toBe(100);
  });
  it('reads the weights as sent, and refuses more places than the column keeps', () => {
    // 21 × 5.000001 = 105.000021 is over 105; as text or as numbers, the same.
    expect(() => validateUnderlyingWeights(Array.from({ length: 21 }, () => ({ weightPercentage: '5.000001' })))).toThrow(/sum to 105.000021%/);
    expect(validateUnderlyingWeights(Array.from({ length: 21 }, () => ({ weightPercentage: 5 })))).toBe(105);
    expect(() => validateUnderlyingWeights([{ weightPercentage: '10.1234567' }])).toThrow(/at most 6 decimal places/);
  });
});

describe('computeUnderlyingExposure', () => {
  const PT = (...ids: number[]) => new Set(ids);
  const map = (entries: Array<[number, UnderlyingWeightRow[]]>) => new Map(entries);

  it('attributes a directly-held stock to itself', () => {
    const holdings: ExposureHolding[] = [{ securityId: 1, ticker: 'ACMEC', marketValue: 10000, isPassThrough: false }];
    const r = computeUnderlyingExposure(holdings, map([]), PT());
    expect(r.totalValue).toBe(10000);
    expect(r.exposures).toEqual([{ securityId: 1, ticker: 'ACMEC', amount: 10000, percentage: 100 }]);
    expect(r.unknownValue).toBe(0);
  });

  it('sees through a fund to its underlying stocks by weight', () => {
    // STKIDX (id 10) = 30% ACMEC(1), 20% WIDGT(2), 50% other-stock(3)
    const holdings: ExposureHolding[] = [{ securityId: 10, ticker: 'STKIDX', marketValue: 10000, isPassThrough: true }];
    const um = map([[10, [
      { underlyingSecurityId: 1, underlyingTicker: 'ACMEC', weightPercentage: 30 },
      { underlyingSecurityId: 2, underlyingTicker: 'WIDGT', weightPercentage: 20 },
      { underlyingSecurityId: 3, underlyingTicker: 'OILCO', weightPercentage: 50 },
    ]]]);
    const r = computeUnderlyingExposure(holdings, um, PT(10));
    expect(r.exposures.find((e) => e.ticker === 'ACMEC')!.amount).toBe(3000);
    expect(r.exposures.find((e) => e.ticker === 'OILCO')!.amount).toBe(5000);
    expect(r.unknownValue).toBe(0);
  });

  it('aggregates the same stock held directly and via a fund', () => {
    const holdings: ExposureHolding[] = [
      { securityId: 1, ticker: 'ACMEC', marketValue: 5000, isPassThrough: false },
      { securityId: 10, ticker: 'STKIDX', marketValue: 10000, isPassThrough: true },
    ];
    const um = map([[10, [{ underlyingSecurityId: 1, underlyingTicker: 'ACMEC', weightPercentage: 30 }, { underlyingSecurityId: 2, underlyingTicker: 'WIDGT', weightPercentage: 70 }]]]);
    const r = computeUnderlyingExposure(holdings, um, PT(10));
    // ACMEC = 5000 direct + 3000 via STKIDX = 8000 of 15000
    const acmec = r.exposures.find((e) => e.ticker === 'ACMEC')!;
    expect(acmec.amount).toBe(8000);
    expect(acmec.percentage).toBeCloseTo(53.33, 1);
  });

  it('recurses through a fund-of-funds', () => {
    // Holding: fund A (100). A = 100% fund B. B = 50% ACMEC, 50% WIDGT.
    const holdings: ExposureHolding[] = [{ securityId: 20, ticker: 'AAA', marketValue: 10000, isPassThrough: true }];
    const um = map([
      [20, [{ underlyingSecurityId: 21, underlyingTicker: 'BBB', weightPercentage: 100 }]],
      [21, [{ underlyingSecurityId: 1, underlyingTicker: 'ACMEC', weightPercentage: 50 }, { underlyingSecurityId: 2, underlyingTicker: 'WIDGT', weightPercentage: 50 }]],
    ]);
    const r = computeUnderlyingExposure(holdings, um, PT(20, 21));
    expect(r.exposures.find((e) => e.ticker === 'ACMEC')!.amount).toBe(5000);
    expect(r.exposures.find((e) => e.ticker === 'WIDGT')!.amount).toBe(5000);
    expect(r.exposures.some((e) => e.ticker === 'BBB')).toBe(false); // fully resolved
  });

  it('routes an opaque pass-through fund to unknown', () => {
    const holdings: ExposureHolding[] = [{ securityId: 30, ticker: 'OPQ', marketValue: 7000, isPassThrough: true }];
    const r = computeUnderlyingExposure(holdings, map([]), PT(30));
    expect(r.unknownValue).toBe(7000);
    expect(r.exposures).toHaveLength(0);
  });

  it('routes a fund residual (weights < 100%) to unknown', () => {
    const holdings: ExposureHolding[] = [{ securityId: 10, ticker: 'STKIDX', marketValue: 10000, isPassThrough: true }];
    const um = map([[10, [{ underlyingSecurityId: 1, underlyingTicker: 'ACMEC', weightPercentage: 90 }]]]);
    const r = computeUnderlyingExposure(holdings, um, PT(10));
    expect(r.exposures.find((e) => e.ticker === 'ACMEC')!.amount).toBe(9000);
    expect(r.unknownValue).toBe(1000); // 10% cash residual
  });

  it('guards against a composition cycle', () => {
    // A -> B -> A. Resolution must terminate; the repeated node becomes a leaf.
    const holdings: ExposureHolding[] = [{ securityId: 40, ticker: 'AAA', marketValue: 10000, isPassThrough: true }];
    const um = map([
      [40, [{ underlyingSecurityId: 41, underlyingTicker: 'BBB', weightPercentage: 100 }]],
      [41, [{ underlyingSecurityId: 40, underlyingTicker: 'AAA', weightPercentage: 100 }]],
    ]);
    const r = computeUnderlyingExposure(holdings, um, PT(40, 41));
    // Cannot expand AAA again (on path) → opaque pass-through leaf → unknown.
    expect(r.totalValue).toBe(10000);
    expect(r.unknownValue).toBe(10000);
  });

  it("rounds the exposures and the unknown together, so their cents add up to the total's", () => {
    // A $1.00 fund, 33.333333% in each of three stocks: $0.3333333300 each, and $0.0000000100
    // unaccounted. Each rounded alone, the stocks were $0.33 x 3 of $1.00.
    const holdings: ExposureHolding[] = [{ securityId: 10, ticker: 'FND', marketValue: '1.00', isPassThrough: true }];
    const um = map([[10, [1, 2, 3].map((id) => ({ underlyingSecurityId: id, underlyingTicker: `S${id}`, weightPercentage: '33.333333' }))]]);
    const r = computeUnderlyingExposure(holdings, um, PT(10));
    expect(r.totalValue).toBe(1);
    expect(r.exposures.map((e) => e.amount)).toEqual([0.34, 0.33, 0.33]);
    expect(r.unknownValue).toBe(0);
  });

  it('reads the market values exactly and rounds each figure once', () => {
    // SUM(shares) x close as SQL gives it: $1,024.215, which Number() reads as
    // 1024.2149999999999 and round2 made $1,024.21. Three funds of it, each all one stock.
    const holdings: ExposureHolding[] = [10, 11, 12].map((id) => ({ securityId: id, ticker: `F${id}`, marketValue: '1024.2150000000', isPassThrough: true }));
    const um = map([10, 11, 12].map((id) => [id, [{ underlyingSecurityId: 1, underlyingTicker: 'ACMEC', weightPercentage: '100.000000' }]]));
    const r = computeUnderlyingExposure(holdings, um, PT(10, 11, 12));
    // 3 x 1,024.215 = 3,072.645: $3,072.65 (the doubles summed to 3,072.6449999999995).
    expect(r).toEqual({
      totalValue: 3072.65, unknownValue: 0, exposures: [{ securityId: 1, ticker: 'ACMEC', amount: 3072.65, percentage: 100 }], belowACent: NONE_BELOW_A_CENT,
    });
  });

  // A security a fund holds a sliver of came to no cents, and was listed at $0.00.
  it('leaves out an exposure worth less than a cent, and counts it below a cent', () => {
    // $100.00 of a fund that is 0.000001% TINY: $0.000001.
    const holdings: ExposureHolding[] = [{ securityId: 10, ticker: 'FND', marketValue: '100.00', isPassThrough: true }];
    const um = map([[10, [
      { underlyingSecurityId: 1, underlyingTicker: 'ACMEC', weightPercentage: '99.999999' },
      { underlyingSecurityId: 2, underlyingTicker: 'TINY', weightPercentage: '0.000001' },
    ]]]);
    const r = computeUnderlyingExposure(holdings, um, PT(10));
    expect(r).toEqual({
      totalValue: 100, unknownValue: 0, exposures: [{ securityId: 1, ticker: 'ACMEC', amount: 100, percentage: 100 }],
      belowACent: { securities: 1, amount: 0, percentage: 0 },
    });
  });

  // Of three identical slivers, the two with the lower ids were listed with the two cents.
  it('sums a holding spread thinner than a cent each below a cent, whatever ids its securities have', () => {
    // $0.02 of a fund in three stocks: two thirds of a cent each.
    const holdings: ExposureHolding[] = [{ securityId: 10, ticker: 'FND', marketValue: '0.02', isPassThrough: true }];
    const um = map([[10, [1, 2, 3].map((id) => ({ underlyingSecurityId: id, underlyingTicker: `S${id}`, weightPercentage: '33.333334' }))]]);
    const r = computeUnderlyingExposure(holdings, um, PT(10));
    expect(r.exposures).toEqual([]);
    expect(r.belowACent).toEqual({ securities: 3, amount: 0.02, percentage: 100 });
    expect(r.totalValue).toBe(0.02);
    expect(r.unknownValue).toBe(0);
  });

  // The slivers were dropped, their fraction of a cent given to whichever came first by
  // id; the listed percentages then fell short of 100% while what resolved was the whole total.
  it('lists the percentages that, with the slivers and the unknown, add up to 100', () => {
    // $10.00 of a fund: 50% AAA, 48% over 2,000 stocks at 0.024% each ($0.0024), 2% unaccounted.
    const holdings: ExposureHolding[] = [{ securityId: 10, ticker: 'FND', marketValue: '10.00', isPassThrough: true }];
    const um = map([[10, [
      { underlyingSecurityId: 1, underlyingTicker: 'AAA', weightPercentage: '50' },
      ...Array.from({ length: 2000 }, (_, i) => ({ underlyingSecurityId: 100 + i, underlyingTicker: `S${i}`, weightPercentage: '0.024' })),
    ]]]);
    const r = computeUnderlyingExposure(holdings, um, PT(10));
    expect(r.exposures).toEqual([{ securityId: 1, ticker: 'AAA', amount: 5, percentage: 50 }]);
    expect(r.belowACent).toEqual({ securities: 2000, amount: 4.8, percentage: 48 });
    expect(r.unknownValue).toBe(0.2);
    const listed = r.exposures.reduce((s, e) => s + e.percentage, 0) + r.belowACent.percentage;
    expect(listed + (Number(r.unknownValue) / Number(r.totalValue)) * 100).toBe(100);
    expect(cents(r.exposures.reduce((s, e) => s + Number(e.amount), 0)) + cents(r.belowACent.amount) + cents(r.unknownValue)).toBe(cents(r.totalValue));
  });
});

describe('computeLookThrough, exactly', () => {
  it('rounds each bucket\'s exact sum once', () => {
    const r = computeLookThrough([
      { securityId: 1, ticker: 'AAA', marketValue: '1024.2150000000', isPassThrough: false, ownDimensionValue: 'equity', composition: null },
      { securityId: 2, ticker: 'BBB', marketValue: '2048.4300000000', isPassThrough: false, ownDimensionValue: 'bond', composition: null },
    ]);
    // $1,024.215 is $1,024.22; the total, $3,072.645, $3,072.65.
    expect(r.totalValue).toBe(3072.65);
    expect(r.buckets).toEqual([
      { dimensionValue: 'bond', amount: 2048.43, percentage: 66.67 },
      { dimensionValue: 'equity', amount: 1024.22, percentage: 33.33 },
    ]);
  });

  it('spreads a fund over its weights so the pieces add up to its value', () => {
    // $100 over three thirds (33.333333% each, normalized): each piece is rounded down to
    // 10^-10 dollars and the unit left goes to the first of the tied rows by name, so
    // the pieces add up to exactly $100. In cents they add up too: each rounded alone,
    // they were $33.33 x 3, $99.99.
    const r = computeLookThrough([{
      securityId: 1, ticker: 'F', marketValue: 100, isPassThrough: true, ownDimensionValue: null,
      composition: ['c', 'a', 'b'].map((v) => ({ dimensionValue: v, weightPercentage: '33.333333' })),
    }]);
    expect(r.totalValue).toBe(100);
    // 'a' got that unit, so it has the largest remainder, and the cent.
    expect(r.buckets.map((b) => [b.dimensionValue, b.amount])).toEqual([['a', 33.34], ['b', 33.33], ['c', 33.33]]);
    expect(r.buckets.map((b) => b.percentage)).toEqual([33.33, 33.33, 33.33]);
  });

  it("rounds the buckets together, so their cents add up to the total's", () => {
    // Three holdings of $0.335: each rounded alone, $0.34 x 3 = $1.02 of a $1.005 total ($1.01).
    const r = computeLookThrough(['a', 'b', 'c'].map((v, i) => ({
      securityId: i + 1, ticker: v.toUpperCase(), marketValue: '0.3350000000', isPassThrough: false, ownDimensionValue: v, composition: null,
    })));
    expect(r.totalValue).toBe(1.01);
    expect(r.buckets.map((b) => b.amount)).toEqual([0.34, 0.34, 0.33]);
    // The unknown bucket and unknownValue are one figure when they are the same value.
    const u = computeLookThrough([
      ...['a', 'b'].map((v, i) => ({ securityId: i + 1, ticker: v, marketValue: '0.3350000000', isPassThrough: false, ownDimensionValue: v, composition: null })),
      { securityId: 9, ticker: 'U', marketValue: '0.3350000000', isPassThrough: true, ownDimensionValue: null, composition: null },
    ]);
    expect(u.buckets.reduce((s, b) => s + Math.round(Number(b.amount) * 100), 0)).toBe(101);
    expect(u.unknownValue).toBe(u.buckets.find((b) => b.dimensionValue === 'unknown')!.amount);
  });
});

/** Every order of `items` (for a handful). */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

/** A small deterministic generator, so a failing case can be run again. */
function lcg(seed: number) {
  let state = seed >>> 0;
  return (below: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % below;
  };
}

/** An answer's dollars (a number, or exact text past 15 digits) in cents. */
const cents = (amount: number | string) => Math.round(Number(amount) * 100);

describe('look-through ties', () => {
  const PT = (...ids: number[]) => new Set(ids);

  it("gives a tied cent by security id, whatever order the holdings and a fund's rows come in", () => {
    // Two stocks of $0.015 each: one of them shows $0.02. And a $0.0300000001 fund 50/50 in
    // two stocks: its last 10^-10 dollar, and with it the cent, went to whichever row came first.
    const direct: ExposureHolding[] = [
      { securityId: 7, ticker: 'BBB', marketValue: '0.0150000000', isPassThrough: false },
      { securityId: 3, ticker: 'AAA', marketValue: '0.0150000000', isPassThrough: false },
      { securityId: 50, ticker: 'FND', marketValue: '0.0300000001', isPassThrough: true },
    ];
    const rows: UnderlyingWeightRow[] = [
      { underlyingSecurityId: 12, underlyingTicker: 'DDD', weightPercentage: '50.000000' },
      { underlyingSecurityId: 11, underlyingTicker: 'CCC', weightPercentage: '50.000000' },
    ];
    const answers = permutations(direct).flatMap((holdings) =>
      permutations(rows).map((fundRows) => computeUnderlyingExposure(holdings, new Map([[50, fundRows]]), PT(50))));
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    // CCC, the lower id, has the fund's last 10^-10 dollar and the larger remainder; of the
    // three left tied, AAA has the lowest id. (A security worth less than a cent isn't listed
    // at all, whatever its id.)
    expect(answers[0].exposures).toEqual([
      { securityId: 11, ticker: 'CCC', amount: 0.02, percentage: 25 },
      { securityId: 3, ticker: 'AAA', amount: 0.02, percentage: 25 },
      { securityId: 7, ticker: 'BBB', amount: 0.01, percentage: 25 },
      { securityId: 12, ticker: 'DDD', amount: 0.01, percentage: 25 },
    ]);
    expect(answers[0]).toMatchObject({ totalValue: 0.06, unknownValue: 0, belowACent: NONE_BELOW_A_CENT });
  });

  it('gives a tied cent in the allocation report by bucket name, whatever order the rows come in', () => {
    const holdings: LookThroughHolding[] = [
      { securityId: 1, ticker: 'A', marketValue: '0.0050000000', isPassThrough: false, ownDimensionValue: 'bond', composition: null },
      { securityId: 2, ticker: 'B', marketValue: '0.0050000000', isPassThrough: false, ownDimensionValue: 'equity', composition: null },
      {
        securityId: 3, ticker: 'F', marketValue: '0.0100000001', isPassThrough: true, ownDimensionValue: null,
        composition: [{ dimensionValue: 'us', weightPercentage: '50' }, { dimensionValue: 'intl', weightPercentage: '50' }],
      },
    ];
    const answers = permutations(holdings).flatMap((list) => [list, list.map((h) => (h.composition ? { ...h, composition: [...h.composition].reverse() } : h))])
      .map((list) => computeLookThrough(list));
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    // 'intl' sorts before 'us', so it has the fund's last 10^-10 dollar; then 'bond' by name.
    expect(answers[0].buckets.map((b) => [b.dimensionValue, b.amount])).toEqual([['intl', 0.01], ['bond', 0.01], ['equity', 0], ['us', 0]]);
  });
});

describe('a fund whose underlying weights add up to more than 100%', () => {
  const PT = (...ids: number[]) => new Set(ids);

  it("scales its exposures to the fund's value", () => {
    // 60% + 45% of $100 was $60 + $45 = $105 of a $100 portfolio.
    const holdings: ExposureHolding[] = [{ securityId: 10, ticker: 'FND', marketValue: 100, isPassThrough: true }];
    const um = new Map([[10, [
      { underlyingSecurityId: 1, underlyingTicker: 'AAA', weightPercentage: '60' },
      { underlyingSecurityId: 2, underlyingTicker: 'BBB', weightPercentage: '45' },
    ]]]);
    const r = computeUnderlyingExposure(holdings, um, PT(10));
    expect(r).toEqual({
      totalValue: 100,
      unknownValue: 0,
      exposures: [
        { securityId: 1, ticker: 'AAA', amount: 57.14, percentage: 57.14 },
        { securityId: 2, ticker: 'BBB', amount: 42.86, percentage: 42.86 },
      ],
      belowACent: NONE_BELOW_A_CENT,
    });
  });

  it('scales inside a fund of funds too, and leaves a shortfall under 100% unknown', () => {
    // A $90 fund: 105% across a fund (B) and a stock; B is 70% ACMEC, 35% WIDGT.
    const holdings: ExposureHolding[] = [{ securityId: 20, ticker: 'AAA', marketValue: 90, isPassThrough: true }];
    const um = new Map([
      [20, [{ underlyingSecurityId: 21, underlyingTicker: 'BBB', weightPercentage: '70' }, { underlyingSecurityId: 3, underlyingTicker: 'OILCO', weightPercentage: '35' }]],
      [21, [{ underlyingSecurityId: 1, underlyingTicker: 'ACMEC', weightPercentage: '70' }, { underlyingSecurityId: 2, underlyingTicker: 'WIDGT', weightPercentage: '20' }]],
    ]);
    const r = computeUnderlyingExposure(holdings, um, PT(20, 21));
    // B gets 90 × 70/105 = $60, OILCO $30; B is 90% known: ACMEC $42, WIDGT $12, $6 unknown.
    expect(r.exposures.map((e) => [e.ticker, e.amount])).toEqual([['ACMEC', 42], ['OILCO', 30], ['WIDGT', 12]]);
    expect(r.unknownValue).toBe(6);
  });

  it('never shows more than the total, and the cents always add up to it', () => {
    const next = lcg(671);
    for (let run = 0; run < 300; run++) {
      const funds = 1 + next(3);
      const holdings: ExposureHolding[] = [];
      const um = new Map<number, UnderlyingWeightRow[]>();
      for (let f = 0; f < funds; f++) {
        const id = 100 + f;
        holdings.push({ securityId: id, ticker: `F${f}`, marketValue: `${next(100000)}.${String(next(1e10)).padStart(10, '0')}`, isPassThrough: true });
        // Up to 7 rows, each up to 30%, kept to the 105% the write allows.
        const rows: UnderlyingWeightRow[] = [];
        let left = 105_000_000;
        for (let r = 0, n = 1 + next(7); r < n && left > 0; r++) {
          const w = Math.min(left, 1 + next(30_000_000));
          left -= w;
          rows.push({ underlyingSecurityId: 1 + next(6), underlyingTicker: 'S', weightPercentage: (w / 1e6).toFixed(6) });
        }
        um.set(id, rows);
      }
      const r = computeUnderlyingExposure(holdings, um, new Set(holdings.map((h) => h.securityId)));
      const shown = r.exposures.reduce((s, e) => s + cents(e.amount), 0) + cents(r.belowACent.amount) + cents(r.unknownValue);
      expect(shown).toBe(cents(r.totalValue));
      // Each one listed is worth a cent or more.
      for (const e of r.exposures) expect(e.amount).toBeGreaterThanOrEqual(0.01);
      expect(r.unknownValue).toBeGreaterThanOrEqual(0);
      expect(r.exposures.reduce((s, e) => s + e.percentage, 0)).toBeLessThanOrEqual(100 + 0.005 * r.exposures.length);
      // With the slivers and the unknown, the percentages make 100 to within each one's rounding
      // to 2 places (the schema's doc says so), the unknown's worked out as a page does.
      if (Number(r.totalValue) > 0) {
        const all = r.exposures.reduce((s, e) => s + e.percentage, 0) + r.belowACent.percentage + (Number(r.unknownValue) / Number(r.totalValue)) * 100;
        expect(Math.abs(all - 100)).toBeLessThanOrEqual(0.005 * (r.exposures.length + 1) + 1e-6);
      }
    }
  });
});

describe('centsAddingUp', () => {
  const units = (dollars: string) => BigInt(dollars.replace('.', '')) * 10n ** BigInt(10 - (dollars.split('.')[1]?.length ?? 0));
  it('gives the cents still owed to the largest remainders, ties to the earlier', () => {
    expect(centsAddingUp(['0.335', '0.335', '0.335'].map(units))).toEqual([34n, 34n, 33n]);
    expect(centsAddingUp(['0.3333333333', '0.3333333333', '0.3333333334'].map(units))).toEqual([33n, 33n, 34n]);
    expect(centsAddingUp(['0.004', '0.004', '0.004'].map(units))).toEqual([1n, 0n, 0n]);
    expect(centsAddingUp([])).toEqual([]);
  });
  it('rounds negative parts down too, to the total rounded half away from zero', () => {
    // -0.335 x 3 = -1.005, which is -1.01: each is -0.34 rounded down, and one gets a cent back.
    expect(centsAddingUp(['-0.335', '-0.335', '-0.335'].map(units))).toEqual([-33n, -34n, -34n]);
  });
});
