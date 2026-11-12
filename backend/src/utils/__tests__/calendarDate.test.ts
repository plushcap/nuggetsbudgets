import { describe, it, expect, afterEach } from 'vitest';
import {
  addDays,
  addMonths,
  calendarDateIn,
  daysBetween,
  isCalendarDate,
  lastOfMonth,
  yearMonthOf,
} from '../calendarDate.js';

// Calendar-date arithmetic must not depend on the process TZ: run each
// check in zones on both sides of UTC, across a DST change.
const zones = ['UTC', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'];

describe('calendarDate', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it.each(zones)('adds and counts days across DST under TZ=%s', (zone) => {
    process.env.TZ = zone;
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31);
    expect(daysBetween('2026-11-02', '2026-10-31')).toBe(-2);
    expect(lastOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(yearMonthOf('2026-12-01')).toEqual({ year: 2026, month: 12 });
  });

  it.each(zones)('counts months in years 1 to 99 as those years, not 1901 to 1999, under TZ=%s', (zone) => {
    // Date.UTC reads a year from 0 to 99 as 1900 + it: the last day of 0050-02 was 1950-02-28.
    process.env.TZ = zone;
    expect(lastOfMonth('0050-02-10')).toBe('0050-02-28');
    expect(lastOfMonth('0004-02-01')).toBe('0004-02-29'); // a leap year; 1904 is one too, 1900 isn't
    expect(lastOfMonth('0001-12-05')).toBe('0001-12-31');
    expect(addMonths('0050-01-31', 1)).toBe('0050-02-28');
    expect(addMonths('0099-12-15', 1)).toBe('0100-01-15');
    expect(addMonths('0100-01-31', -1)).toBe('0099-12-31');
    expect(addMonths('0002-03-31', -14)).toBe('0001-01-31');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
  });

  it('accepts only real YYYY-MM-DD days', () => {
    expect(isCalendarDate('2026-12-31')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-12-31T00:00:00.000Z')).toBe(false);
    expect(isCalendarDate('12/31/2026')).toBe(false);
    expect(isCalendarDate('')).toBe(false);
    expect(isCalendarDate(undefined)).toBe(false);
    expect(isCalendarDate(20261231)).toBe(false);
  });

  it.each(zones)('reads the day of an instant in the zone asked for, not TZ=%s', (zone) => {
    process.env.TZ = zone;
    const lateEveningInNewYork = new Date('2026-11-01T02:30:00Z'); // 10:30 pm Oct 31 EDT
    expect(calendarDateIn('America/New_York', lateEveningInNewYork)).toBe('2026-10-31');
    expect(calendarDateIn('UTC', lateEveningInNewYork)).toBe('2026-11-01');
    expect(calendarDateIn('Pacific/Kiritimati', new Date('2026-12-31T10:00:00Z'))).toBe('2027-01-01');
    expect(() => calendarDateIn('Not/AZone', lateEveningInNewYork)).toThrow(RangeError);
  });
});
