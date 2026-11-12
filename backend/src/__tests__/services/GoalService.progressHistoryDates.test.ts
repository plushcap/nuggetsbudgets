import { describe, it, expect } from 'vitest';
import { progressHistoryDates } from '../../services/GoalService.js';

// The days a goal's progress history is drawn at: each month end in the range,
// none after today, and today when it falls in the range. Pure: no database.
describe('progressHistoryDates', () => {
  it('takes each month end in the range, and today', () => {
    expect(progressHistoryDates('2026-07-02', '2026-11-04', '2026-11-04')).toEqual([
      '2026-07-31',
      '2026-08-31',
      '2026-09-30',
      '2026-10-31',
      '2026-11-04',
    ]);
  });

  it('includes a month end on the first or last day of the range', () => {
    expect(progressHistoryDates('2026-08-31', '2026-10-31', '2026-11-04')).toEqual(['2026-08-31', '2026-09-30', '2026-10-31']);
    expect(progressHistoryDates('2026-09-01', '2026-09-29', '2026-11-04')).toEqual([]);
  });

  it('draws a range before year 100 in those years', () => {
    // lastOfMonth read year 50 as 1950, past the range's end, so the history was [].
    expect(progressHistoryDates('0050-01-15', '0050-04-30', '2026-11-04')).toEqual(['0050-01-31', '0050-02-28', '0050-03-31', '0050-04-30']);
    expect(progressHistoryDates('0099-11-02', '0100-01-31', '2026-11-04')).toEqual(['0099-11-30', '0099-12-31', '0100-01-31']);
  });

  it('follows February, in leap years too', () => {
    expect(progressHistoryDates('2028-01-15', '2028-03-31', '2028-12-01')).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
    expect(progressHistoryDates('2027-02-01', '2027-02-28', '2028-12-01')).toEqual(['2027-02-28']);
  });

  it('stops at today, which it takes once when it is a month end', () => {
    expect(progressHistoryDates('2026-09-01', '2027-06-30', '2026-11-04')).toEqual(['2026-09-30', '2026-10-31', '2026-11-04']);
    expect(progressHistoryDates('2026-09-01', '2026-11-30', '2026-11-30')).toEqual(['2026-09-30', '2026-10-31', '2026-11-30']);
  });

  it('has nothing for a range wholly after today, or one that ends before it starts', () => {
    expect(progressHistoryDates('2026-11-05', '2027-01-31', '2026-11-04')).toEqual([]);
    expect(progressHistoryDates('2026-10-31', '2026-09-30', '2026-11-04')).toEqual([]);
  });

  it('counts ten years as 120 month ends and today', () => {
    expect(progressHistoryDates('2016-11-04', '2026-11-04', '2026-11-04')).toHaveLength(121);
  });
});
