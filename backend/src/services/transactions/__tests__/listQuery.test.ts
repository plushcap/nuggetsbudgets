import { describe, it, expect } from 'vitest';
import { transactionListQuerySchema } from '@nuggets/shared';

/**
 * The list's amount filters take a decimal number, as parseFloat reads it. Their
 * pattern was `\d+\.?\d*`, which tried each way of splitting a run of digits between
 * `\d+` and `\d*`: time quadratic in the run, on a query string anyone signed in sends.
 */
describe('the list query string: amount filters', () => {
  const accepts = (amount_min: string) => transactionListQuerySchema.safeParse({ amount_min }).success;

  it('takes a decimal number, with an exponent or not', () => {
    for (const v of ['10', '-5', '+1.5', '.5', '12.', '1e3', '2.5E-2', '']) expect(accepts(v), v).toBe(true);
    for (const v of ['x', '1e', '1.2.3', '.', 'e5', '0x10', '1 000', '1e999']) expect(accepts(v), v).toBe(false);
  });

  it('refuses a long run of digits in linear time', () => {
    const start = performance.now();
    expect(accepts(`${'0'.repeat(100_000)}x`)).toBe(false);
    expect(performance.now() - start).toBeLessThan(50);
  });
});
