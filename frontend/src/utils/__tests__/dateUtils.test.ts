import { describe, it, expect } from 'vitest';
import {
  DateUtils,
  calendarDatePart,
  calendarDaysBetween,
  calendarMonthKey,
  compareCalendarDates,
  formatCalendarDate,
  formatCalendarMonth,
  formatInstantDate,
  isCalendarDateInRange,
  parseCalendarDate,
  toCalendarDateString,
  todayLocal,
} from '../dateUtils';
import { pinTimeZone } from '../../test/timeZone';

const localParts = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];

// One zone west of UTC (where a UTC-midnight read lands on the day before) and
// one far east of it (where "today" in UTC is still yesterday).
describe.each(['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC'])('calendar dates in %s', (tz) => {
  pinTimeZone(tz);

  describe('calendarDatePart', () => {
    it.each([
      ['2026-12-31', '2026-12-31'],
      ['2026-12-31T00:00:00.000Z', '2026-12-31'],
      ['2026-12-31T05:00:00.000Z', '2026-12-31'],
      ['2026-12-31 00:00:00', '2026-12-31'],
      ['2024-02-29', '2024-02-29'],
    ])('takes the day of %s', (value, expected) => {
      expect(calendarDatePart(value)).toBe(expected);
    });

    it.each([null, undefined, '', 'garbage', '2026-1-5', '2026-02-30', '2025-02-29', '2026-13-01', '12/31/2026'])(
      'is null for %s',
      (value) => {
        expect(calendarDatePart(value)).toBeNull();
      },
    );
  });

  describe('parseCalendarDate', () => {
    it.each(['2026-12-31', '2026-12-31T00:00:00.000Z', '2026-12-31T05:00:00.000Z'])('reads %s as local midnight of Dec 31', (value) => {
      expect(localParts(parseCalendarDate(value))).toEqual([2026, 12, 31, 0, 0]);
    });

    it('keeps the 1st of a month in that month', () => {
      expect(localParts(parseCalendarDate('2026-06-01'))).toEqual([2026, 6, 1, 0, 0]);
    });

    it('is an Invalid Date for a value that is not a calendar date', () => {
      expect(Number.isNaN(parseCalendarDate('nope').getTime())).toBe(true);
      expect(Number.isNaN(parseCalendarDate(null).getTime())).toBe(true);
    });
  });

  describe('formatCalendarDate', () => {
    it.each(['2026-12-31', '2026-12-31T00:00:00.000Z'])('shows %s on Dec 31', (value) => {
      expect(formatCalendarDate(value, 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })).toBe('Dec 31, 2026');
      expect(formatCalendarDate(value, 'en-US')).toBe('12/31/2026');
    });

    it("is '' without a value and the value itself when it is not a date", () => {
      expect(formatCalendarDate(null)).toBe('');
      expect(formatCalendarDate(undefined)).toBe('');
      expect(formatCalendarDate('soon')).toBe('soon');
    });
  });

  describe('months', () => {
    it('keys a date by its own month', () => {
      expect(calendarMonthKey('2026-06-01')).toBe('2026-06');
      expect(calendarMonthKey('2026-06-01T00:00:00.000Z')).toBe('2026-06');
      expect(calendarMonthKey('x')).toBeNull();
    });

    it('labels a month key, or a date, with that month', () => {
      expect(formatCalendarMonth('2026-06')).toBe('June 2026');
      expect(formatCalendarMonth('2026-06-01T00:00:00.000Z', 'en-US', { month: 'short', year: 'numeric' })).toBe('Jun 2026');
      expect(formatCalendarMonth('2026-13')).toBe('2026-13');
    });
  });

  describe('calendarDaysBetween', () => {
    it('counts calendar days, in either format', () => {
      expect(calendarDaysBetween('2026-10-27', '2026-12-31')).toBe(65);
      expect(calendarDaysBetween('2026-10-27', '2026-12-31T00:00:00.000Z')).toBe(65);
      expect(calendarDaysBetween('2026-10-27', '2026-10-27')).toBe(0);
      expect(calendarDaysBetween('2026-10-27', '2026-10-26')).toBe(-1);
    });

    it('is not skewed by daylight-saving changes', () => {
      expect(calendarDaysBetween('2026-03-07', '2026-03-09')).toBe(2);
      expect(calendarDaysBetween('2026-10-31', '2026-11-02')).toBe(2);
      expect(calendarDaysBetween('2026-01-01', '2027-01-01')).toBe(365);
    });

    it('is NaN when either is not a date', () => {
      expect(calendarDaysBetween('2026-10-27', null)).toBeNaN();
    });
  });

  describe('compareCalendarDates and isCalendarDateInRange', () => {
    it('orders dates in either format, earliest first, with non-dates last', () => {
      const sorted = ['2026-07-01T00:00:00.000Z', null, '2026-06-30', '2026-07-01', 'x', '2025-12-31']
        .sort(compareCalendarDates);
      expect(sorted.slice(0, 4)).toEqual(['2025-12-31', '2026-06-30', '2026-07-01T00:00:00.000Z', '2026-07-01']);
      expect(sorted.slice(4)).toEqual(expect.arrayContaining([null, 'x']));
    });

    it('includes both ends of a range', () => {
      expect(isCalendarDateInRange('2026-10-01', '2026-10-01', '2026-10-31T00:00:00.000Z')).toBe(true);
      expect(isCalendarDateInRange('2026-10-31', '2026-10-01', '2026-10-31T00:00:00.000Z')).toBe(true);
      expect(isCalendarDateInRange('2026-11-01', '2026-10-01', '2026-10-31')).toBe(false);
      expect(isCalendarDateInRange('2026-09-30', '2026-10-01', '2026-10-31')).toBe(false);
      expect(isCalendarDateInRange('2026-10-15', null, '2026-10-31')).toBe(false);
    });
  });

  it('toCalendarDateString writes the local day of a Date', () => {
    expect(toCalendarDateString(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(toCalendarDateString(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31');
  });

  describe('DateUtils presets', () => {
    it('take either format', () => {
      expect(DateUtils.formatDateUS('2025-09-01')).toBe('09/01/2025');
      expect(DateUtils.formatDateUS('2025-09-01T00:00:00.000Z')).toBe('09/01/2025');
      expect(DateUtils.formatForDisplay('2025-09-01T00:00:00.000Z')).toBe('Sep 1, 2025');
      expect(localParts(DateUtils.parseBusinessDate('2025-09-01T00:00:00.000Z'))).toEqual([2025, 9, 1, 0, 0]);
    });

    it('return a value that is not a date unchanged, and parseBusinessDate throws on it', () => {
      expect(DateUtils.formatDateUS('pending')).toBe('pending');
      expect(DateUtils.formatForDisplay('pending')).toBe('pending');
      expect(() => DateUtils.parseBusinessDate('pending')).toThrow('Invalid date format');
    });
  });
});

// Chile starts daylight saving at midnight: 2026-09-06 has no 00:00.
describe('a day whose local midnight is skipped (America/Santiago)', () => {
  pinTimeZone('America/Santiago');

  it('is still a valid calendar date, parsed onto that day', () => {
    expect(calendarDatePart('2026-09-06')).toBe('2026-09-06');
    expect(localParts(parseCalendarDate('2026-09-06')).slice(0, 3)).toEqual([2026, 9, 6]);
    expect(formatCalendarDate('2026-09-06', 'en-US')).toBe('9/6/2026');
    expect(calendarDaysBetween('2026-09-05', '2026-09-07')).toBe(2);
  });
});

describe('todayLocal', () => {
  describe('9:30 pm on Oct 31 in Los Angeles (Nov 1 in UTC)', () => {
    pinTimeZone('America/Los_Angeles', '2026-10-31T21:30:00-07:00');
    it('is Oct 31', () => {
      expect(todayLocal()).toBe('2026-10-31');
    });
  });

  describe('one minute before midnight on Dec 31 in Los Angeles', () => {
    pinTimeZone('America/Los_Angeles', '2026-12-31T23:59:00-08:00');
    it('is still Dec 31', () => {
      expect(todayLocal()).toBe('2026-12-31');
    });
  });

  describe('8:00 am on Nov 1 in Kiritimati, UTC+14 (Oct 31 in UTC)', () => {
    pinTimeZone('Pacific/Kiritimati', '2026-11-01T08:00:00+14:00');
    it('is Nov 1', () => {
      expect(todayLocal()).toBe('2026-11-01');
    });
  });

  describe('12:01 am on Jan 1 in Kiritimati', () => {
    pinTimeZone('Pacific/Kiritimati', '2027-01-01T00:01:00+14:00');
    it('is Jan 1', () => {
      expect(todayLocal()).toBe('2027-01-01');
    });
  });
});

describe('formatInstantDate (a timestamptz, not a calendar date)', () => {
  describe('in Los Angeles', () => {
    pinTimeZone('America/Los_Angeles');
    it('shows the local day the instant happened on', () => {
      // 9:30 pm Oct 31 in Los Angeles; the UTC date part would say Nov 1.
      expect(formatInstantDate('2026-11-01T04:30:00.000Z', 'en-US')).toBe('10/31/2026');
    });
  });

  describe('in Kiritimati', () => {
    pinTimeZone('Pacific/Kiritimati');
    it('shows the local day the instant happened on', () => {
      expect(formatInstantDate('2026-10-31T18:00:00.000Z', 'en-US')).toBe('11/1/2026');
    });
  });

  it("is '' without a value and the value itself when it doesn't parse", () => {
    expect(formatInstantDate(null)).toBe('');
    expect(formatInstantDate('later')).toBe('later');
  });
});
