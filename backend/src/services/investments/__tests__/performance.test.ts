import { describe, it, expect } from 'vitest';
import { xirr, modifiedDietz, totalReturn, annualize, npv } from '../performance.js';

describe('xirr', () => {
  it('returns ~10% for a one-year double-ish flow', () => {
    // Invest $1000, get back $1100 one year later => 10%.
    const r = xirr([{ date: '2024-01-01', amount: -1000 }, { date: '2025-01-01', amount: 1100 }]);
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(0.1, 2);
  });

  it('handles multiple contributions', () => {
    // Two $1000 buys a year apart, ending value $2200 at year 2.
    const r = xirr([
      { date: '2023-01-01', amount: -1000 },
      { date: '2024-01-01', amount: -1000 },
      { date: '2025-01-01', amount: 2200 },
    ]);
    expect(r).not.toBeNull();
    // NPV at the solved rate should be ~0.
    expect(Math.abs(npv([
      { date: '2023-01-01', amount: -1000 },
      { date: '2024-01-01', amount: -1000 },
      { date: '2025-01-01', amount: 2200 },
    ], r!))).toBeLessThan(1);
  });

  it('returns null when all flows share a sign', () => {
    expect(xirr([{ date: '2024-01-01', amount: -100 }, { date: '2025-01-01', amount: -100 }])).toBeNull();
  });
});

describe('modifiedDietz', () => {
  it('computes period return with a mid-period contribution', () => {
    // Begin $1000, contribute $500 at the midpoint, end $1600 over a year.
    const r = modifiedDietz(1000, 1600, [{ date: '2024-07-01', amount: 500 }], '2024-01-01', '2024-12-31');
    expect(r).not.toBeNull();
    // gain = 1600 - 1000 - 500 = 100; denom ≈ 1000 + ~0.5*500 = 1250 => ~0.08
    expect(r!).toBeCloseTo(0.08, 1);
  });
  it('no-flow case is a simple return', () => {
    expect(modifiedDietz(1000, 1100, [], '2024-01-01', '2024-12-31')).toBeCloseTo(0.1, 4);
  });
});

describe('totalReturn & annualize', () => {
  it('total return', () => {
    expect(totalReturn(1000, 1500)).toBeCloseTo(0.5, 4);
    expect(totalReturn(0, 100)).toBeNull();
  });
  it('annualize a 2-year 21% cumulative -> ~10%', () => {
    expect(annualize(0.21, 730)).toBeCloseTo(0.1, 2);
  });
});
