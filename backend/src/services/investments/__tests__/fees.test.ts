import { describe, it, expect } from 'vitest';
import { expenseRatioDrag, costOfOwnership } from '../fees.js';

describe('expenseRatioDrag', () => {
  it('computes annual drag', () => {
    // $100k at 0.03% for a full year = $30
    expect(expenseRatioDrag(100000, 0.03)).toBe(30);
  });
  it('prorates by days held', () => {
    expect(expenseRatioDrag(100000, 0.03, 182.5)).toBe(15); // half year
  });
  it('is zero for non-fund / missing ratio / zero value', () => {
    expect(expenseRatioDrag(0, 0.03)).toBe(0);
    expect(expenseRatioDrag(100000, 0)).toBe(0);
  });
});

describe('costOfOwnership', () => {
  it('combines explicit fees and imputed drag into effective cost %', () => {
    // $50k at 0.25% advisory + a 0.04% fund expense ratio for a year
    const r = costOfOwnership({ averageHoldingValue: 50000, expenseRatioPct: 0.04, explicitFees: 125 });
    expect(r.imputedDrag).toBe(20); // 50000 * 0.0004
    expect(r.explicitFees).toBe(125);
    expect(r.totalCost).toBe(145);
    expect(r.effectiveCostPct).toBeCloseTo(0.29, 2);
  });
  it('handles a fund with no expense ratio (drag = 0)', () => {
    const r = costOfOwnership({ averageHoldingValue: 10000, expenseRatioPct: null, explicitFees: 0 });
    expect(r.imputedDrag).toBe(0);
    expect(r.totalCost).toBe(0);
  });
  it('figures the drag in exact cents, rounded once', () => {
    // $137 at 1.5% is $2.055: $2.06. As doubles 137 x 0.015 is 2.0549999999999997, so $2.05.
    expect(expenseRatioDrag(137, 1.5)).toBe(2.06);
    // The value as SQL gives it (SUM(shares) x close), and the fees as a SUM.
    const r = costOfOwnership({ averageHoldingValue: '137.0000000000', expenseRatioPct: '1.5000', explicitFees: '0.10' });
    expect(r).toEqual({ explicitFees: 0.1, imputedDrag: 2.06, totalCost: 2.16, effectiveCostPct: 1.58 });
  });
});
