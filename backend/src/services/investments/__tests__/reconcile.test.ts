import { describe, it, expect } from 'vitest';
import { reconcile } from '../reconcile.js';

/** Dollars as the cents reconcile takes. */
const c = (dollars: string) => BigInt(Math.round(Number(dollars) * 100));

describe('reconcile', () => {
  it('does not flag a match within the $50/1% threshold', () => {
    const r = reconcile(c('10000'), c('9970')); // $30 diff, threshold = max(50, 99.70) = 99.70
    expect(r.flagged).toBe(false);
    expect(r.difference).toBe(30);
    expect(r.threshold).toBe(99.7);
  });
  it('flags a difference beyond 1% on a large balance', () => {
    const r = reconcile(c('110000'), c('100000')); // $10k diff, threshold = 1000
    expect(r.flagged).toBe(true);
    expect(r.pctDifference).toBe(10);
  });
  it('uses the $50 floor on small balances', () => {
    const r = reconcile(c('1100'), c('1000')); // $100 diff, threshold = max(50, 10) = 50
    expect(r.flagged).toBe(true);
  });
  it('does not flag a $40 diff on a small balance (under $50 floor)', () => {
    expect(reconcile(c('1040'), c('1000')).flagged).toBe(false);
  });
  it('handles a missing imported balance (not flagged)', () => {
    const r = reconcile(c('5000'), null);
    expect(r.flagged).toBe(false);
    expect(r.pctDifference).toBeNull();
  });
  it('does not flag when the calculated value is unknown (no cash figure)', () => {
    const r = reconcile(null, c('6000'));
    expect(r.flagged).toBe(false);
    expect(r.difference).toBe(0);
  });

  it('works in cents, and rounds each figure once, half away from zero', () => {
    // -$0.01 of $8.00 is -0.125%: -0.13%, where the float arithmetic made it -0.12%.
    expect(reconcile(c('7.99'), c('8.00')).pctDifference).toBe(-0.13);
    // $798,708.33 more than $840 is 95,084.325%: 95,084.33%, not 95,084.32%.
    expect(reconcile(c('799548.33'), c('840')).pctDifference).toBe(95084.33);
    // The 1% of $12,345.65 is $123.4565, shown as $123.46.
    expect(reconcile(c('12345.65'), c('12345.65')).threshold).toBe(123.46);
    // A difference of exactly the threshold isn't over it: $123.4565 isn't rounded before the compare.
    expect(reconcile(c('12469.11'), c('12345.65')).flagged).toBe(true); // $123.46 > $123.4565
    expect(reconcile(c('12469.10'), c('12345.65')).flagged).toBe(false); // $123.45
    expect(reconcile(c('10100'), c('10000')).flagged).toBe(false); // $100 of a $100 threshold
    // Large balances keep every cent: $9,999,999,999.99 against $0.01.
    expect(reconcile(c('9999999999.99'), c('0.01'))).toMatchObject({ difference: 9999999999.98, flagged: true });
    // A negative imported balance compares by its size.
    expect(reconcile(c('-1100'), c('-1000'))).toMatchObject({ difference: -100, pctDifference: -10, threshold: 50, flagged: true });
  });
});
