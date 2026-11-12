import { z } from 'zod';

/**
 * The parts of a response schema: what a field of an API answer may hold.
 *
 * A response schema is a `z.object` that names every field the route answers, so a parse
 * checks each of them and a field the schema doesn't name is dropped. {@link answerProblem}
 * reports both: the route tests parse real answers with it (a field a route adds fails
 * them until its schema has it), and the frontend's `parseAnswer` throws with it in
 * development and tests.
 */

/**
 * A NUMERIC(12,2) amount as pg sends it ('-12.50'), or one the server computed in cents (-12.5),
 * as a number or, past 15 significant digits, as exact text (the backend's centsNumber; a
 * double would lose its cents). Up to 30 digits before the point: stored shares
 * (NUMERIC(18,6)) at a stored close (NUMERIC(12,4)) are under 10^20 dollars a lot, and a total
 * over every lot of a ledger (int4 ids, under 2^31 of them) under 10^30.
 */
const MONEY_TEXT = /^-?\d{1,30}(?:\.\d{1,2})?$/;
/** A decimal of any scale, as pg sends a NUMERIC ('0.00012345') or as a number. */
const DECIMAL_TEXT = /^-?\d{1,30}(?:\.\d{1,20})?$/;

/**
 * Money in an answer: a decimal with at most 2 places, as text or a number, read as a
 * number. Refuses `''`, other text, more than 2 places and a float the server added up
 * (0.30000000000000004).
 */
export const responseAmount = z
  .union([z.number(), z.string()])
  .refine((value) => MONEY_TEXT.test(String(value)), 'an amount with at most 2 decimal places')
  .transform(Number);
export const nullableResponseAmount = responseAmount.nullable();

/**
 * A share count, a price per share, a ratio or a percentage in an answer: a decimal of any
 * scale as text, or any finite number (a percentage the server divided, which can print as
 * 1e-7), read as a number.
 */
export const responseDecimal = z
  .union([z.number().refine(Number.isFinite, 'a finite number'), z.string().regex(DECIMAL_TEXT, 'a decimal number')])
  .transform(Number);
export const nullableResponseDecimal = responseDecimal.nullable();

/** A count in an answer: a number, or the text pg sends for a COUNT (a bigint), read as a number. */
export const responseCount = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,18}$/)]).transform(Number);

/** An instant (a timestamptz) as pg's JSON writes it: ISO-8601 with its offset. */
export const instant = z.iso.datetime({ offset: true });
export const nullableInstant = instant.nullable();

/** A calendar date (a `date` column) as the API sends it: 'YYYY-MM-DD'. */
export const dayText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as 'YYYY-MM-DD'");
export const nullableDayText = dayText.nullable();

/**
 * A column the database checks with `check_known_or_unchanged`: a new value is one
 * of today's `values`, and a row may keep the one it held before the list (an account's
 * legacy classification; a transaction type the app no longer offers). Typed
 * as today's values plus any other text, so a comparison offers today's values; show one
 * with `vocabularyLabel`, which keeps a legacy value as it is.
 */
export const storedValue = <const T extends readonly string[]>(values: T) =>
  z.custom<T[number] | (string & {})>(
    (value) => typeof value === 'string' && value.length > 0,
    `one of ${values.join(', ')} (or the value the row already held)`
  );

/**
 * A {@link storedValue} a row may lack: null, or the empty text an older row may hold for none
 * (an account saved with `type = ''`), read as null. The strict answer refused '', so
 * the account answers failed in development; and a page that shows a missing value its own
 * way (`account.type ?? inferred`) took '' as a value, and listed the account under
 * "Liabilities".
 */
export const nullableStoredValue = <const T extends readonly string[]>(values: T) =>
  z.union([z.literal('').transform(() => null), storedValue(values).nullable()]);

/** The fields of `raw` the parsed answer doesn't have, as paths ('accounts[0].bank_name'). */
export function droppedKeys(raw: unknown, parsed: unknown, path = ''): string[] {
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed)) return [];
    return raw.flatMap((item, i) => droppedKeys(item, parsed[i], `${path}[${i}]`));
  }
  if (raw === null || typeof raw !== 'object' || parsed === null || typeof parsed !== 'object') return [];
  const kept = parsed as Record<string, unknown>;
  return Object.entries(raw as Record<string, unknown>).flatMap(([key, value]) => {
    const at = path ? `${path}.${key}` : key;
    if (value === undefined) return [];
    if (!Object.prototype.hasOwnProperty.call(kept, key)) return [at];
    return droppedKeys(value, kept[key], at);
  });
}

/**
 * What's wrong with `raw` as an answer `schema` describes: the fields it refuses, then the
 * fields it would drop (ones the schema doesn't name). null when `raw` is exactly such an
 * answer.
 */
export function answerProblem(schema: z.ZodType, raw: unknown): string | null {
  const result = schema.safeParse(raw);
  if (!result.success) return z.prettifyError(result.error);
  const dropped = droppedKeys(raw, result.data);
  return dropped.length > 0 ? `fields the schema doesn't name: ${dropped.slice(0, 20).join(', ')}` : null;
}
