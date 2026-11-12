import { describe, it, expect } from 'vitest';
import { periodsNewestFirst, periodKey, resolvePeriodIndex } from '../budgetPeriods';

const p = (year: number, month_number: number) => ({ year, month_number, name: `${year}-${month_number}` });

describe('periodsNewestFirst', () => {
  it('orders newest first, crossing year boundaries', () => {
    // Ascending, as the API returns them.
    const asc = [p(2025, 7), p(2025, 8), p(2025, 12), p(2026, 1), p(2026, 8)];
    expect(periodsNewestFirst(asc).map((x) => x.name)).toEqual([
      '2026-8', '2026-1', '2025-12', '2025-8', '2025-7',
    ]);
  });

  it('puts the most recent period first so it is the top choice', () => {
    // The bug this prevents: "August 2025" sitting near the top while the
    // intended "August 2026" is buried at the bottom of the list.
    const asc = [p(2025, 8), p(2026, 8)];
    expect(periodsNewestFirst(asc)[0]).toEqual(p(2026, 8));
  });

  it('does not mutate the source array (the query cache)', () => {
    const asc = [p(2025, 7), p(2026, 8)];
    const snapshot = [...asc];
    periodsNewestFirst(asc);
    expect(asc).toEqual(snapshot);
  });

  it('handles empty and single-item lists', () => {
    expect(periodsNewestFirst([])).toEqual([]);
    expect(periodsNewestFirst([p(2026, 8)])).toEqual([p(2026, 8)]);
  });
});

describe('periodKey', () => {
  it('pads the month', () => {
    expect(periodKey(p(2026, 3))).toBe('2026-03');
    expect(periodKey(p(2026, 11))).toBe('2026-11');
  });
});

describe('resolvePeriodIndex (the Budget page selection)', () => {
  const period = (year: number, month_number: number, status = 'closed') => ({
    year,
    month_number,
    uuid: `uuid-${year}-${month_number}`,
    status,
  });
  // Chronological, as the API returns them.
  const periods = [period(2026, 1), period(2026, 2, 'active'), period(2026, 3), period(2026, 4)];

  it("takes the URL's period first, by uuid or by YYYY-MM", () => {
    expect(resolvePeriodIndex(periods, 'uuid-2026-3', '2026-01', '2026-04-10')).toBe(2);
    expect(resolvePeriodIndex(periods, '2026-04', '2026-01', '2026-02-10')).toBe(3);
  });

  it('shows the first period for a URL value that names none, without falling back', () => {
    expect(resolvePeriodIndex(periods, '2030-01', '2026-03', '2026-04-10')).toBe(0);
    expect(resolvePeriodIndex(periods, 'nonsense', '2026-03', '2026-04-10')).toBe(0);
  });

  it("takes the session's saved period next, and the first period when it names none", () => {
    expect(resolvePeriodIndex(periods, null, '2026-03', '2026-04-10')).toBe(2);
    expect(resolvePeriodIndex(periods, null, '2030-01', '2026-04-10')).toBe(0);
  });

  it("then today's month, then the active period, then the newest", () => {
    expect(resolvePeriodIndex(periods, null, null, '2026-04-30')).toBe(3);
    expect(resolvePeriodIndex(periods, null, null, '2027-06-01')).toBe(1);
    const noneActive = periods.map((x) => ({ ...x, status: 'closed' }));
    expect(resolvePeriodIndex(noneActive, null, null, '2027-06-01')).toBe(3);
    expect(resolvePeriodIndex([], null, null, '2027-06-01')).toBe(0);
  });
});
