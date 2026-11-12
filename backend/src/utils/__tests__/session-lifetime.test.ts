import { describe, it, expect, afterEach } from 'vitest';
import { sessionAbsoluteMs, sessionExpiryFrom, sessionIdleMs } from '../session-lifetime.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

afterEach(() => {
  delete process.env.SESSION_IDLE_HOURS;
  delete process.env.SESSION_ABSOLUTE_DAYS;
});

describe('session lifetime settings', () => {
  it('defaults to a 72-hour idle timeout and a 30-day absolute lifetime', () => {
    expect(sessionIdleMs()).toBe(72 * HOUR_MS);
    expect(sessionAbsoluteMs()).toBe(30 * DAY_MS);
  });

  it('reads SESSION_IDLE_HOURS and SESSION_ABSOLUTE_DAYS', () => {
    process.env.SESSION_IDLE_HOURS = '8';
    process.env.SESSION_ABSOLUTE_DAYS = '0.5';
    expect(sessionIdleMs()).toBe(8 * HOUR_MS);
    expect(sessionAbsoluteMs()).toBe(12 * HOUR_MS);
  });

  it.each(['0', '-1', 'abc', 'Infinity', '1e9'])('ignores %s for the default', (value) => {
    process.env.SESSION_IDLE_HOURS = value;
    process.env.SESSION_ABSOLUTE_DAYS = value;
    expect(sessionIdleMs()).toBe(72 * HOUR_MS);
    expect(sessionAbsoluteMs()).toBe(30 * DAY_MS);
  });

  it('slides by the idle timeout but never past the absolute lifetime', () => {
    const now = Date.UTC(2026, 9, 27, 12);
    expect(sessionExpiryFrom(new Date(now), now).getTime()).toBe(now + 72 * HOUR_MS);
    const signedIn = new Date(now - 30 * DAY_MS + HOUR_MS);
    expect(sessionExpiryFrom(signedIn, now).getTime()).toBe(now + HOUR_MS);
  });
});
