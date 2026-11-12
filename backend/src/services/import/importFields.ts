/**
 * Reading a SimpleFin transaction's fields: its id, amount, the second it is dated by,
 * and text cut to the columns that hold it. Each refuses what it can't read rather than
 * import it wrong.
 */
import type { SimplefinTransaction } from './types.js';

/** transactions.description is varchar(255); the whole text is kept in import_description. */
export const DESCRIPTION_MAX_CHARS = 255;
/** transactions.import_payee is varchar(500). */
export const PAYEE_MAX_CHARS = 500;

// The seconds Postgres can date (years 1-9999, with a day to spare for the zone), so one
// bad timestamp can't fail the query that dates a whole account's transactions.
const FIRST_DATED_SECOND = -62135596800 + 86_400;
const LAST_DATED_SECOND = 253402300800 - 86_400;

/** `raw` as a Unix second Postgres can date, or null: not a number, or out of range (milliseconds, say). */
export function datableSecond(raw: unknown): number | null {
  const seconds = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof seconds === 'number' && seconds >= FIRST_DATED_SECOND && seconds <= LAST_DATED_SECOND ? seconds : null;
}

/**
 * The Unix second a SimpleFin transaction is dated by: transacted_at, or posted when
 * transacted_at is missing or not a datable second; null when neither is. A numeric
 * string still counts, as it did.
 */
export function datingSecond(tx: SimplefinTransaction): number | null {
  return (tx.transacted_at ? datableSecond(tx.transacted_at) : null) ?? datableSecond(tx.posted);
}

/**
 * A SimpleFin transaction's id as text. One without an id can't be matched to its row on
 * the next sync (and a NULL id is never a conflict for the unique index), so it would be
 * added again every time: it is refused instead.
 */
export function importIdOf(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'string' && raw.trim() !== '') return raw;
  throw new Error(`SimpleFin sent a transaction without an id: ${JSON.stringify(raw) ?? String(raw)}`);
}

/** At most a string's first `max` characters (code points, so a surrogate pair is never split). */
export function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/**
 * A SimpleFin amount as a decimal string, for a NUMERIC column. Anything that isn't a
 * plain decimal number is refused: `parseFloat(x) || 0` used to import it as 0.00.
 */
export function parseImportAmount(raw: unknown): { text: string; cents: number } {
  const text = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : '';
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) {
    // Not the value: it's logged with the row's id, and may be an amount written
    // another way ("1,234.56").
    const what =
      typeof raw === 'string' ? `text of ${Array.from(raw).length} characters`
      : typeof raw === 'number' ? 'not a finite number'
      : raw === null || raw === undefined ? 'none'
      : typeof raw === 'object' ? 'an object'
      : `a ${typeof raw}`;
    throw new Error(`SimpleFin sent an amount that isn't a number (${what})`);
  }
  return { text, cents: Math.round(Number(text) * 100) };
}
