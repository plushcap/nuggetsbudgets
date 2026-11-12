import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Run each test in the calling file (or `describe`) in the IANA time zone `tz`,
 * whatever zone the test run itself uses. CI runs in UTC, where a calendar date
 * read as a UTC instant still lands on the right day, so the date tests
 * pin a zone on either side of UTC to fail the way a real browser would.
 *
 * Node re-reads the zone whenever `process.env.TZ` is assigned, and Vitest runs
 * every test file in its own worker, so the change stays inside the file.
 *
 * With `now`, `Date` is also faked to that instant (timers are left real, so
 * Testing Library's `findBy*` waits still work).
 */
export function pinTimeZone(tz: string, now?: string | Date): void {
  beforeEach(() => {
    vi.stubEnv('TZ', tz);
    if (now !== undefined) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(now));
    }
  });
  afterEach(() => {
    if (now !== undefined) vi.useRealTimers();
    vi.unstubAllEnvs();
  });
}
