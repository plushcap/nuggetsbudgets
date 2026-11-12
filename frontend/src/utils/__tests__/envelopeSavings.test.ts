import { describe, it, expect } from 'vitest';
import { requiredMonthlySavings } from '../envelopeSavings';

describe('requiredMonthlySavings', () => {
  const today = new Date(2026, 9, 25); // 25 October 2026

  it('spreads what is left over the months until the target date', () => {
    expect(requiredMonthlySavings(175, 0, '2027-10-01', today)).toEqual({ amount: 14.59, remaining: 175, months: 12 });
    expect(requiredMonthlySavings(175, 25, '2027-04-30', today)).toEqual({ amount: 25, remaining: 150, months: 6 });
  });

  it('asks for everything left when the target is this month or already past', () => {
    expect(requiredMonthlySavings(175, 0, '2026-10-31', today)?.months).toBe(1);
    expect(requiredMonthlySavings(175, 0, '2026-01-01', today)).toEqual({ amount: 175, remaining: 175, months: 1 });
  });

  it('needs nothing once the balance has reached the target', () => {
    expect(requiredMonthlySavings(175, 200, '2027-04-01', today)).toEqual({ amount: 0, remaining: 0, months: 6 });
  });

  describe('rounds up in whole cents, so an exact amount stays exact', () => {
    // Math.ceil(x * 100) / 100 asked for 150.31 of 150.30 (150.3 * 100 is 15030.000000000002 in
    // floats), and 0.08 of 0.07.
    it('asks for the amount itself when it is due this month', () => {
      expect(requiredMonthlySavings(150.3, 0, '2026-10-31', today)?.amount).toBe(150.3);
      expect(requiredMonthlySavings(0.07, 0, '2026-10-31', today)?.amount).toBe(0.07);
      expect(requiredMonthlySavings(1000, 849.7, '2026-10-31', today)).toEqual({ amount: 150.3, remaining: 150.3, months: 1 });
    });

    it('asks for each amount up to $2,000 exactly, over one month', () => {
      const off: number[] = [];
      for (let cents = 1; cents <= 200_000; cents++) {
        const target = cents / 100;
        if (requiredMonthlySavings(target, 0, '2026-10-31', today)?.amount !== target) off.push(target);
      }
      expect(off).toEqual([]);
    });

    it('asks for the least whole cent a month that gets there, over several', () => {
      // 100.00 over 3 months is 33.34 (33.33 three times falls a cent short).
      expect(requiredMonthlySavings(100, 0, '2027-01-15', today)).toEqual({ amount: 33.34, remaining: 100, months: 3 });
      for (let cents = 1; cents <= 20_000; cents += 7) {
        const monthly = Math.round((requiredMonthlySavings(cents / 100, 0, '2027-01-15', today)?.amount ?? NaN) * 100);
        expect(monthly * 3).toBeGreaterThanOrEqual(cents);
        expect((monthly - 1) * 3).toBeLessThan(cents);
      }
    });
  });

  it('has nothing to check without a target date or amount', () => {
    expect(requiredMonthlySavings(175, 0, null, today)).toBeNull();
    expect(requiredMonthlySavings(175, 0, '', today)).toBeNull();
    expect(requiredMonthlySavings(0, 0, '2027-04-01', today)).toBeNull();
  });
});
