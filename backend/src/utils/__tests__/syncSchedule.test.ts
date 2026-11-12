import { describe, it, expect } from 'vitest';
import {
  nextSyncTime,
  normalizeFrequency,
  parseTimeOfDay,
  isValidTimeZone,
  timeOnDayAfter,
} from '../syncSchedule.js';

/** Wall clock in a zone, for readable assertions. */
const wallClock = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);

describe('normalizeFrequency', () => {
  it('keeps the two frequencies the UI offers', () => {
    expect(normalizeFrequency('daily')).toBe('daily');
    expect(normalizeFrequency('weekly')).toBe('weekly');
  });

  it('falls back to daily for anything unrecognized', () => {
    // The old scheduler armed its recurring timer only on an exact
    // 'daily'/'weekly' match, so a stray value made it run once and stop.
    expect(normalizeFrequency('hourly')).toBe('daily');
    expect(normalizeFrequency('')).toBe('daily');
    expect(normalizeFrequency(null)).toBe('daily');
    expect(normalizeFrequency(undefined)).toBe('daily');
  });
});

describe('parseTimeOfDay', () => {
  it('parses HH:MM and HH:MM:SS', () => {
    expect(parseTimeOfDay('04:25')).toEqual({ hours: 4, minutes: 25 });
    expect(parseTimeOfDay('04:25:00')).toEqual({ hours: 4, minutes: 25 });
    expect(parseTimeOfDay('23:59')).toEqual({ hours: 23, minutes: 59 });
  });

  it('falls back when the stored value is missing or malformed', () => {
    expect(parseTimeOfDay(null)).toEqual({ hours: 2, minutes: 0 });
    expect(parseTimeOfDay('')).toEqual({ hours: 2, minutes: 0 });
    expect(parseTimeOfDay('nonsense')).toEqual({ hours: 2, minutes: 0 });
    expect(parseTimeOfDay('25:00')).toEqual({ hours: 2, minutes: 0 });
    expect(parseTimeOfDay(undefined, '04:25')).toEqual({ hours: 4, minutes: 25 });
  });
});

describe('nextSyncTime', () => {
  it('picks today when the time is still ahead', () => {
    // 2026-09-09 01:00 in New York = 05:00Z (EDT, UTC-4).
    const now = new Date('2026-09-09T05:00:00Z');
    const next = nextSyncTime('04:25', 'daily', 'America/New_York', now);
    expect(next.toISOString()).toBe('2026-09-09T08:25:00.000Z');
  });

  it('rolls to tomorrow once the time has passed', () => {
    const now = new Date('2026-09-09T08:25:00Z'); // exactly the sync instant
    const next = nextSyncTime('04:25', 'daily', 'America/New_York', now);
    expect(next.toISOString()).toBe('2026-09-10T08:25:00.000Z');
  });

  it('advances a week for weekly', () => {
    const now = new Date('2026-09-09T12:00:00Z');
    const next = nextSyncTime('04:25', 'weekly', 'America/New_York', now);
    expect(next.toISOString()).toBe('2026-09-16T08:25:00.000Z');
  });

  it('holds the local wall-clock time across the DST fall-back', () => {
    // US DST ends 2026-11-01. A fixed 24h interval would drift to 03:25;
    // recomputing from the calendar keeps it at 04:25 local.
    const beforeDst = new Date('2026-10-31T12:00:00Z');
    const first = nextSyncTime('04:25', 'daily', 'America/New_York', beforeDst);
    expect(wallClock(first, 'America/New_York')).toBe('11/01/2026, 04:25');
    expect(first.toISOString()).toBe('2026-11-01T09:25:00.000Z'); // now EST (UTC-5)

    const afterFirst = nextSyncTime('04:25', 'daily', 'America/New_York', first);
    expect(wallClock(afterFirst, 'America/New_York')).toBe('11/02/2026, 04:25');
  });

  it('holds the local wall-clock time across the DST spring-forward', () => {
    const beforeDst = new Date('2026-03-07T12:00:00Z');
    const first = nextSyncTime('04:25', 'daily', 'America/New_York', beforeDst);
    expect(wallClock(first, 'America/New_York')).toBe('03/08/2026, 04:25');
    expect(first.toISOString()).toBe('2026-03-08T08:25:00.000Z'); // EDT (UTC-4)
  });

  it('does not depend on the container timezone', () => {
    const now = new Date('2026-09-09T12:00:00Z');
    expect(nextSyncTime('04:25', 'daily', 'UTC', now).toISOString())
      .toBe('2026-09-10T04:25:00.000Z');
  });

  it('falls back to UTC for an unknown timezone', () => {
    const now = new Date('2026-09-09T12:00:00Z');
    expect(nextSyncTime('04:25', 'daily', 'Mars/Olympus_Mons', now).toISOString())
      .toBe('2026-09-10T04:25:00.000Z');
  });

  it('never returns a past instant in a DST gap that starts at midnight', () => {
    // Re-arming right after a 00:30 run in Havana on the eve of the gap: the old result was
    // 04:30Z, now, so the scheduler re-armed at its 1 s minimum for half an hour.
    const now = new Date('2026-03-08T04:30:00.500Z');
    const next = nextSyncTime('00:30', 'daily', 'America/Havana', now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.toISOString()).toBe('2026-03-08T05:30:00.000Z');
  });

  it('always returns an instant in the future', () => {
    const now = new Date('2026-09-09T12:00:00Z');
    for (const tz of ['UTC', 'America/New_York', 'America/Chicago', 'Australia/Sydney', 'Asia/Kolkata']) {
      for (const time of ['00:00', '04:25', '12:00', '23:59']) {
        const next = nextSyncTime(time, 'daily', tz, now);
        expect(next.getTime()).toBeGreaterThan(now.getTime());
        // ...and never more than a day and a bit out.
        expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
      }
    }
  });
});

describe('timeOnDayAfter', () => {
  it('lands on the local time of day, whole calendar days later', () => {
    // 2026-01-09 22:00 in New York is already 01-10 in UTC; the day counts from the local date.
    const from = new Date('2026-01-10T03:00:00Z');
    expect(timeOnDayAfter(from, 30, '03:00', 'America/New_York').toISOString()).toBe('2026-02-08T08:00:00.000Z');
    expect(timeOnDayAfter(from, 30, '03:00', 'UTC').toISOString()).toBe('2026-02-09T03:00:00.000Z');
  });

  it('keeps the wall-clock time across DST and year ends', () => {
    // 2026-10-31 is EDT, 2026-11-07 is EST.
    const next = timeOnDayAfter(new Date('2026-10-31T07:00:00Z'), 7, '03:00', 'America/New_York');
    expect(wallClock(next, 'America/New_York')).toBe('11/07/2026, 03:00');
    expect(timeOnDayAfter(new Date('2026-12-31T12:00:00Z'), 365, '03:00', 'UTC').toISOString()).toBe(
      '2027-12-31T03:00:00.000Z'
    );
  });

  it('maps a time the clocks skip to just after the gap, never the evening before', () => {
    // Havana springs forward at midnight on 2026-03-08: 00:30 doesn't exist that day. It
    // used to come out as 23:30 the evening before, an instant already in the past.
    const after = new Date('2026-03-08T04:30:05Z'); // 23:30:05 on 03-07 in Havana
    const next = timeOnDayAfter(after, 1, '00:30', 'America/Havana');
    expect(next.toISOString()).toBe('2026-03-08T05:30:00.000Z'); // 01:30 CDT
    expect(wallClock(next, 'America/Havana')).toBe('03/08/2026, 01:30');
    // The same at the other midnight gaps, and at a 02:00 one.
    expect(wallClock(timeOnDayAfter(new Date('2026-03-28T12:00:00Z'), 1, '00:30', 'Atlantic/Azores'), 'Atlantic/Azores'))
      .toBe('03/29/2026, 01:30');
    expect(wallClock(timeOnDayAfter(new Date('2026-09-05T12:00:00Z'), 1, '00:30', 'America/Santiago'), 'America/Santiago'))
      .toBe('09/06/2026, 01:30');
    expect(wallClock(timeOnDayAfter(new Date('2026-03-07T12:00:00Z'), 1, '02:30', 'America/New_York'), 'America/New_York'))
      .toBe('03/08/2026, 03:30');
  });

  it('gives a time the clocks pass twice its first occurrence', () => {
    // New York falls back at 02:00 EDT on 2026-11-01: 01:30 happens in EDT, then in EST.
    const next = timeOnDayAfter(new Date('2026-10-31T12:00:00Z'), 1, '01:30', 'America/New_York');
    expect(next.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('falls back on a bad time or timezone', () => {
    const from = new Date('2026-01-10T12:00:00Z');
    expect(timeOnDayAfter(from, 1, 'nonsense', 'Not/AZone', '03:00').toISOString()).toBe('2026-01-11T03:00:00.000Z');
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA zones and rejects junk', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });
});
