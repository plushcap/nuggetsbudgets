import { describe, it, expect } from 'vitest';
import { moneyAxis } from '../moneyAxis';

const labels = (values: number[], count?: number) => {
  const axis = moneyAxis(values, count);
  return axis.tickValues.map(axis.format);
};

describe('moneyAxis', () => {
  // Compact labels keep two significant figures, so a narrow axis (every $20 from $1,000
  // to $1,200) read "$1K, $1K, $1K, $1.1K, $1.1K, …".
  it('labels a narrow axis in whole dollars, each tick its own', () => {
    const axis = moneyAxis([1003, 1061, 1188], 10);
    expect(axis.tickValues).toEqual([1000, 1020, 1040, 1060, 1080, 1100, 1120, 1140, 1160, 1180, 1200]);
    const shown = axis.tickValues.map(axis.format);
    expect(shown.slice(0, 3)).toEqual(['$1,000', '$1,020', '$1,040']);
    expect(new Set(shown).size).toBe(shown.length);
  });

  it('keeps the compact form where it tells the ticks apart', () => {
    expect(labels([0, 2400, 9800])).toEqual(['$0', '$2K', '$4K', '$6K', '$8K', '$10K']);
    expect(labels([-2000, 1_500_000], 3)).toEqual(['-$500K', '$0', '$500K', '$1M', '$1.5M']);
  });

  it('labels a step under a dollar in cents', () => {
    expect(labels([0.1, 0.3], 2)).toEqual(['$0.10', '$0.20', '$0.30']);
  });

  // A span of a few cents took a step under a cent ($0.005), which two decimals can't show:
  // "$1.01, $1.02, $1.02, $1.03, $1.03…".
  it('steps at least a cent, so a span of a few cents labels each tick once', () => {
    expect(labels([1.01, 1.04])).toEqual(['$1.01', '$1.02', '$1.03', '$1.04']);
    expect(labels([100.01, 100.04])).toEqual(['$100.01', '$100.02', '$100.03', '$100.04']);
    expect(labels([0.05, 0.07])).toEqual(['$0.05', '$0.06', '$0.07']);
    expect(labels([0.01])).toEqual(['$0.00', '$0.01', '$0.02']);
  });

  // An epsilon on dollars ÷ step fails near 1e7 steps: 223709.86 / 0.01 is
  // 22370985.999…, which put a stray tick a cent below or above the figures. Worked in cents, none.
  it('puts no tick outside the figures for large amounts', () => {
    expect(labels([223709.86, 223709.87])).toEqual(['$223,709.86', '$223,709.87']);
    expect(labels([1237032.86, 1237032.87])).toEqual(['$1,237,032.86', '$1,237,032.87']);
    expect(labels([4000000.3, 4000000.9])).toEqual(
      ['$4,000,000.30', '$4,000,000.40', '$4,000,000.50', '$4,000,000.60', '$4,000,000.70', '$4,000,000.80', '$4,000,000.90'],
    );
    const axis = moneyAxis([223709.86, 223709.87]);
    expect([axis.min, axis.max]).toEqual([223709.86, 223709.87]);
  });

  // Nothing but zero (a goal with nothing saved yet) padded by $1 either way, -$1.00 to $1.00.
  it('puts an axis of nothing but zero from $0 up, not below it', () => {
    expect(labels([0, 0])).toEqual(['$0.00', '$0.20', '$0.40', '$0.60', '$0.80', '$1.00']);
    expect(labels([])).toEqual(['$0.00', '$0.20', '$0.40', '$0.60', '$0.80', '$1.00']);
    // A single figure other than zero still has a tenth of it either side.
    expect(labels([-3])).toEqual(['-$3.30', '-$3.20', '-$3.10', '-$3.00', '-$2.90', '-$2.80', '-$2.70']);
  });

  it('runs from a tick below the lowest figure to one above the highest, and pads a single figure', () => {
    const axis = moneyAxis([1003, 1188], 10);
    expect([axis.min, axis.max]).toEqual([1000, 1200]);
    const one = moneyAxis([1000.1]);
    expect(one.min).toBeLessThan(1000.1);
    expect(one.max).toBeGreaterThan(1000.1);
    expect(moneyAxis([]).tickValues.length).toBeGreaterThan(1);
  });
});
