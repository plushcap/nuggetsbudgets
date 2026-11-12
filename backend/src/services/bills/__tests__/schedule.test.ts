import { describe, it, expect } from 'vitest';
import { addMonths, dueDateIn, monthsBetween } from '../schedule.js';

describe('bill schedule', () => {
  it('is due every month on the anchor day for a monthly bill', () => {
    expect(dueDateIn('2026-11-05', 1, '2026-11')).toBe('2026-11-05');
    expect(dueDateIn('2026-11-05', 1, '2027-03')).toBe('2027-03-05');
  });

  it('is due only every Nth month for a less frequent bill', () => {
    expect(dueDateIn('2026-12-20', 6, '2026-12')).toBe('2026-12-20');
    expect(dueDateIn('2026-12-20', 6, '2027-01')).toBeNull();
    expect(dueDateIn('2026-12-20', 6, '2027-06')).toBe('2027-06-20');
  });

  it('falls on the last day of a shorter month and back on the anchor day after', () => {
    expect(dueDateIn('2027-01-31', 1, '2027-02')).toBe('2027-02-28');
    expect(dueDateIn('2028-01-31', 1, '2028-02')).toBe('2028-02-29');
    expect(dueDateIn('2027-01-31', 1, '2027-03')).toBe('2027-03-31');
  });

  it("isn't due before its anchor, or without a frequency", () => {
    expect(dueDateIn('2026-12-20', 1, '2026-11')).toBeNull();
    expect(dueDateIn('2026-12-20', 0, '2026-12')).toBeNull();
  });

  it('counts and steps months across years', () => {
    expect(monthsBetween('2026-11', '2027-02')).toBe(3);
    expect(monthsBetween('2027-02', '2026-11')).toBe(-3);
    expect(addMonths('2026-11', 2)).toBe('2027-01');
    expect(addMonths('2027-01', -1)).toBe('2026-12');
  });

  it("falls on each 2026 month's last day for an anchor of the 31st", () => {
    const ends = ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30',
      '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31'];
    expect(ends.map((_, i) => dueDateIn('2026-01-31', 1, addMonths('2026-01', i)))).toEqual(ends);
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(dueDateIn('2026-02-28', 1, '2026-03')).toBe('2026-03-28');
  });

  it('keeps a four-digit year for a year under 100', () => {
    // The year wasn't padded: a month after 0050-12 was "51-01", and its due day "51-01-31".
    expect(addMonths('0050-12', 1)).toBe('0051-01');
    expect(addMonths('0050-01', -1)).toBe('0049-12');
    expect(addMonths('0099-12', 1)).toBe('0100-01');
    expect(dueDateIn('0050-01-31', 1, addMonths('0050-01', 1))).toBe('0050-02-28');
    // 48 is a leap year (Date.UTC read a year under 100 as 19xx, which happened to agree).
    expect(dueDateIn('0048-01-31', 1, '0048-02')).toBe('0048-02-29');
    expect(dueDateIn('0050-01-31', 3, addMonths('0050-01', 3))).toBe('0050-04-30');
  });
});
