/**
 * Pure time math for the recurring schedulers (bank import today).
 *
 * Kept free of DB/logger imports so it can be unit-tested without Docker
 * secrets, and written so it does NOT depend on the container's own TZ (UTC
 * in the compose files, but an operator can change it): anything that parses
 * a naive `YYYY-MM-DDTHH:MM:SS` string with `new Date()` silently interprets
 * it in whatever zone the process happens to be in. Every conversion below
 * goes through `Intl.DateTimeFormat` + `Date.UTC`, which is zone-explicit.
 */

/** Frequencies the scheduler knows how to advance by. */
export type SyncFrequency = 'daily' | 'weekly';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Coerce a stored `import_sync_frequency` to a frequency we can schedule.
 *
 * Anything unrecognized (or missing) becomes 'daily'. The scheduler used to
 * arm its recurring timer only for an exact 'daily'/'weekly' match, so a stray
 * value meant it ran once and then never again — silently.
 */
export function normalizeFrequency(value: string | null | undefined): SyncFrequency {
  return value === 'weekly' ? 'weekly' : 'daily';
}

/**
 * Parse a stored `HH:MM` (or `HH:MM:SS`) time-of-day, falling back to
 * `fallback` when it is missing or unparseable.
 */
export function parseTimeOfDay(
  value: string | null | undefined,
  fallback = '02:00'
): { hours: number; minutes: number } {
  const parse = (raw: string | null | undefined) => {
    const [h, m] = String(raw ?? '').split(':');
    const hours = Number(h);
    const minutes = Number(m);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return { hours, minutes };
  };

  return parse(value) ?? parse(fallback) ?? { hours: 2, minutes: 0 };
}

/** `Intl` parts for `instant` rendered in `timeZone`, as numbers. */
function partsIn(timeZone: string, instant: Date): {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // `hour12: false` renders midnight as 24 in some ICU versions.
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Minutes east of UTC that `timeZone` is observing at `instant` (EDT → -240). */
function offsetMinutesAt(timeZone: string, instant: Date): number {
  const p = partsIn(timeZone, instant);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asIfUtc - instant.getTime()) / 60000;
}

/**
 * The UTC instant at which the wall clock in `timeZone` reads the given local
 * date and time.
 *
 * Tries the offsets in force a day either side, which differ only near a DST
 * transition. A time the clocks pass twice (fall-back) gets its first
 * occurrence. A time they skip (spring-forward) gets the instant as far past
 * the gap's start as the time asked for, e.g. 02:30 → 03:30 in New York. It
 * used to come out an hour early instead, which for a gap that starts at
 * midnight (America/Havana, Atlantic/Azores, America/Santiago) is the evening
 * before, in the past, and the schedulers re-armed on it every second.
 */
function zonedTimeToUtc(
  year: number, month: number, day: number,
  hours: number, minutes: number,
  timeZone: string
): Date {
  const wall = Date.UTC(year, month - 1, day, hours, minutes, 0);
  const candidates = [wall - DAY_MS, wall + DAY_MS]
    .map((probe) => wall - offsetMinutesAt(timeZone, new Date(probe)) * 60000)
    .sort((a, b) => a - b);
  const readsAsAsked = candidates.filter((ts) => {
    const p = partsIn(timeZone, new Date(ts));
    return p.year === year && p.month === month && p.day === day && p.hour === hours && p.minute === minutes;
  });
  return new Date(readsAsAsked[0] ?? Math.max(...candidates));
}

/** True when `timeZone` is an IANA zone this runtime understands. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The instant at which it is `time` (local wall clock) in `timeZone` on the
 * calendar day `days` days after the day `from` falls on there.
 *
 * Steps calendar days rather than adding `days` × 24h, so a DST transition in
 * between can't shift the time of day. Used for the backup schedule, whose
 * frequency is a number of days.
 */
export function timeOnDayAfter(
  from: Date,
  days: number,
  time: string | null | undefined,
  timeZone: string | null | undefined,
  fallbackTime = '02:00'
): Date {
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const { hours, minutes } = parseTimeOfDay(time, fallbackTime);
  const day = partsIn(zone, from);
  const target = new Date(Date.UTC(day.year, day.month - 1, day.day) + days * DAY_MS);
  return zonedTimeToUtc(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    hours,
    minutes,
    zone
  );
}

/**
 * The next instant at which it is `time` (local wall clock) in `timeZone`,
 * strictly after `now`.
 *
 * Recomputed from the calendar before every run rather than by adding a fixed
 * 24h, so the sync keeps landing at the configured local time across DST
 * transitions instead of drifting an hour twice a year.
 */
export function nextSyncTime(
  time: string | null | undefined,
  frequency: string | null | undefined,
  timeZone: string | null | undefined,
  now: Date = new Date()
): Date {
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const { hours, minutes } = parseTimeOfDay(time);
  const stepDays = normalizeFrequency(frequency) === 'weekly' ? 7 : 1;

  const today = partsIn(zone, now);
  let next = zonedTimeToUtc(today.year, today.month, today.day, hours, minutes, zone);

  // Advance the calendar day (not the instant) so DST can't shift the target, and
  // keep going should a zone's transitions ever leave it at or before `now`.
  for (let days = stepDays; next.getTime() <= now.getTime() && days <= stepDays + 2; days++) {
    const advanced = new Date(Date.UTC(today.year, today.month - 1, today.day) + days * DAY_MS);
    next = zonedTimeToUtc(
      advanced.getUTCFullYear(),
      advanced.getUTCMonth() + 1,
      advanced.getUTCDate(),
      hours,
      minutes,
      zone
    );
  }

  return next;
}
