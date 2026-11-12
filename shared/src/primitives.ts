import { z } from 'zod';

/**
 * Shared primitive schemas — the building blocks reused across every entity.
 *
 * The single most important one is `money`: PostgreSQL serialises `NUMERIC`
 * columns as **strings**, but the app wants real `number`s. Parsing API
 * responses through schemas that use `money` coerces those strings to numbers
 * at the boundary, which eliminates the recurring string/number bug class
 * instead of patching it per call site.
 */

/** A NUMERIC/decimal value. Coerces pg's string form ("123.45") to a number. */
export const money = z.coerce.number();

/**
 * A nullable NUMERIC. NOTE: `z.nullable` short-circuits on `null` BEFORE the
 * inner coercion runs, so a real `null` stays `null` rather than coercing to 0
 * (which `Number(null)` would do). Always use this for nullable numeric columns.
 */
export const nullableMoney = money.nullable();

/**
 * The most characters a request's decimal text may have: more than any NUMERIC column here
 * needs (18 digits, a sign and a point), so text sent a megabyte long is refused before
 * anything scans it (moneyInput, decimalInput, readDecimal; the backend's readCents).
 */
export const DECIMAL_TEXT_MAX_LENGTH = 64;

/**
 * A decimal number as text, as the backend's toCents reads it: "12.34", "-5", ".5", "12.".
 * No two of its parts can match the same digits, so a test takes time linear in the text:
 * `\d+\.?\d*`, as it was, tried each way of splitting a run of digits between `\d+` and
 * `\d*`, quadratic in the run ("0" × 150,000 + "x" took seconds).
 */
export const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** `text` without the zeros it ends with. A loop: `replace(/0+$/, '')` is quadratic in a run of zeros. */
export function trimTrailingZeros(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 48) end -= 1;
  return text.slice(0, end);
}

/**
 * A money amount in a REQUEST body: a JSON number, or a decimal string ("12.34", "-5";
 * FormData sends text), passed on as it came (a string is trimmed). Unlike `money`, it is
 * not coerced: the backend reads the value with toCents (backend/src/utils/money.ts), which
 * refuses more than 2 decimal places and what DECIMAL(12,2) can't hold, and Number() would
 * hide both. "12.3400000000000001" would become 12.34 and "10000000000" 1e10, and text that
 * isn't a decimal number would be read anyway ("0x10" is 16, "1e2" 100, "" 0, true 1); here
 * those are refused with `message`, as is text longer than DECIMAL_TEXT_MAX_LENGTH, before
 * the pattern runs.
 */
export const moneyInput = (message: string, options: { range?: boolean } = {}) => {
  const money = z.union([
    z.number(),
    z.string().trim().max(DECIMAL_TEXT_MAX_LENGTH, { message, abort: true }).regex(DECIMAL_TEXT, message),
  ], { error: message });
  // `range: false` leaves the range to the backend's readCents: a bulk row's amount, whose
  // row alone fails when the column can't hold it, as one with too many decimals does.
  // Refused for its range, a value gets no further check (a field's own range, its sign):
  // one message for one field.
  return options.range === false ? money : money.refine(fitsMoneyColumn, { message: moneyRangeMessage(message), abort: true });
};

/** The whole digits DECIMAL(12,2) holds: ±9,999,999,999.99. */
const MONEY_WHOLE_DIGITS = 10;

/**
 * The message for money past DECIMAL(12,2), in the words the backend's readCents uses ("amount
 * must be between -9,999,999,999.99 and 9,999,999,999.99"), named by what `message` names.
 */
function moneyRangeMessage(message: string): string {
  const subject = /^(.+?) (?:must be|is required)\b/.exec(message)?.[1];
  return subject ? `${subject} must be ${MONEY_RANGE}` : `Give an amount ${MONEY_RANGE}.`;
}

/** What DECIMAL(12,2) holds, as the range messages say it. */
const MONEY_RANGE = `between -${decimalMaxText(2, 12)} and ${decimalMaxText(2, 12)}`;

/**
 * Whether `message` is a request schema's message for money past DECIMAL(12,2) (moneyInput's,
 * or decimalInput's at that column): a form says it for people instead, as the API's
 * message names the body's key and gives a minus bound to a box that takes no negatives.
 */
export function isMoneyRangeMessage(message: string): boolean {
  return message === `Give an amount ${MONEY_RANGE}.` || message.endsWith(` must be ${MONEY_RANGE}`) || message.endsWith(` must be a number ${MONEY_RANGE}`);
}

/**
 * Whether a value moneyInput read has no more whole digits than DECIMAL(12,2) holds: a
 * JSON number had no bound (fees of 1e12 passed the schema, which the forms check with), and
 * text none here either. Its decimals are toCents's to check, which refuses more than 2.
 */
function fitsMoneyColumn(value: number | string): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) < 10 ** MONEY_WHOLE_DIGITS;
  const whole = value.replace(/^[+-]/, '').split('.')[0] ?? '';
  let first = 0;
  while (first < whole.length && whole.charCodeAt(first) === 48) first += 1;
  return whole.length - first <= MONEY_WHOLE_DIGITS;
}

/**
 * Why a value isn't a decimal a NUMERIC(precision, scale) column holds as written: `format`,
 * not a decimal number ("1e2", "0x10", "", true, NaN); `scale`, more decimal places than the
 * column keeps (trailing zeros don't count); `range`, more whole digits than it has room for.
 */
export type DecimalProblem = 'format' | 'scale' | 'range';

const PLAIN_DECIMAL = /^([+-])?(\d*)(?:\.(\d*))?$/;

/**
 * `value`, a JSON number or decimal text, as a whole number of 10^-scale units, for a
 * NUMERIC(precision, scale) column: "12.5" at scale 4 is 125000n. Exact: text is read digit by
 * digit, and a number as the shortest decimal that reads back as it (String(12.5) is "12.5"),
 * never through float arithmetic, so "12.3400000000000001" is refused (`scale`) rather than
 * read as 12.34. The backend's readCents (utils/money.ts) does the same for scale 2. Text
 * longer than DECIMAL_TEXT_MAX_LENGTH is `format`, unread.
 */
export function readDecimal(
  value: unknown,
  scale: number,
  precision: number,
): { units: bigint } | { problem: DecimalProblem } {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { problem: 'format' };
    // String() writes 1e21 and above with an exponent: too large for any column here.
    if (Math.abs(value) >= 1e21) return { problem: 'range' };
    text = String(value);
    // ...and a number below 1e-6 too ("1.5e-7"): the same digits, written out (at most
    // about 330 characters, for 5e-324).
    const tiny = /^(-?)(\d)(?:\.(\d+))?e-(\d+)$/.exec(text);
    if (tiny) text = `${tiny[1]}0.${'0'.repeat(Number(tiny[4]) - 1)}${tiny[2]}${tiny[3] ?? ''}`;
  } else if (typeof value === 'string') {
    text = value.trim();
    if (text.length > DECIMAL_TEXT_MAX_LENGTH) return { problem: 'format' };
  } else {
    return { problem: 'format' };
  }
  const match = PLAIN_DECIMAL.exec(text);
  if (!match) return { problem: 'format' };
  const [, sign, whole = '', fractionRaw = ''] = match;
  if (whole === '' && fractionRaw === '') return { problem: 'format' };
  const fraction = trimTrailingZeros(fractionRaw);
  if (fraction.length > scale) return { problem: 'scale' };
  const digits = whole.replace(/^0+/, '');
  if (digits.length > precision - scale) return { problem: 'range' };
  const units = BigInt(`${digits || '0'}${fraction.padEnd(scale, '0')}`);
  return { units: sign === '-' ? -units : units };
}

/** The largest magnitude NUMERIC(precision, scale) holds, as people read it: "999,999.9999". */
export function decimalMaxText(scale: number, precision: number): string {
  const whole = '9'.repeat(Math.max(precision - scale, 1)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return scale > 0 ? `${whole}.${'9'.repeat(scale)}` : whole;
}

/**
 * The message for a value {@link readDecimal} refused, from `message` (what the field must be:
 * "shares must be a number"): "shares must be a number with at most 6 decimal places".
 */
export function decimalProblemMessage(message: string, problem: DecimalProblem, scale: number, precision: number): string {
  if (problem === 'format' || (problem === 'scale' && scale === 0)) return message;
  if (problem === 'scale') return `${message} with at most ${scale} decimal place${scale === 1 ? '' : 's'}`;
  const max = decimalMaxText(scale, precision);
  return `${message} between -${max} and ${max}`;
}

/**
 * A decimal in a REQUEST body that isn't 2-decimal money (moneyInput) — a share count, a
 * price per share, a ratio, a percentage — for a NUMERIC(precision, scale) column: a JSON
 * number, or decimal text (FormData sends text), passed on as it came (a string is trimmed).
 * It must be exact at the column's scale: more decimals than `scale`, more whole digits than
 * precision - scale, or text that isn't a decimal number ("1e2", "0x10", "", true) are refused,
 * where z.coerce.number() read them as the nearest double (or 100, 16, 0, 1) and Postgres
 * rounded what it stored. The route reads the value with readDecimal, in units of 10^-scale,
 * and does its arithmetic on those (backend utils/decimal.ts). For a whole number, scale 0.
 * Text longer than DECIMAL_TEXT_MAX_LENGTH is refused with `message`, unread.
 */
export const decimalInput = (scale: number, message: string, options: { precision?: number } = {}) => {
  const precision = options.precision ?? 18;
  const text = z.string().trim().max(DECIMAL_TEXT_MAX_LENGTH, { message, abort: true });
  return z.union([z.number(), text], { error: message }).superRefine((value, context) => {
    const read = readDecimal(value, scale, precision);
    if ('problem' in read) {
      context.addIssue({ code: 'custom', message: decimalProblemMessage(message, read.problem, scale, precision), continue: false });
    }
  });
};

/** Whether a value decimalInput or moneyInput accepted is above zero (their text is decimal: Number reads its sign exactly). */
export const isPositiveDecimal = (value: number | string): boolean => Number(value) > 0;
/** Whether a value decimalInput or moneyInput accepted is zero or more. */
export const isNonNegativeDecimal = (value: number | string): boolean => Number(value) >= 0;

/** A UUID string (Zod 4 top-level validator). */
export const uuid = z.uuid();

/**
 * The years a calendar date sent in a request may fall in. Wider is no use for money, and
 * code works ±30 days from a date (the wash-sale window): from year 0001 or 9999 that leaves
 * what Postgres's `date` holds, a 500.
 */
export const CALENDAR_DAY_YEARS = { min: 1800, max: 2999 } as const;

/** Whether `text` is a real `'YYYY-MM-DD'` day in CALENDAR_DAY_YEARS: not `2026-02-30`, not a timestamp. */
export function isCalendarDay(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < CALENDAR_DAY_YEARS.min || year > CALENDAR_DAY_YEARS.max || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= daysInMonth;
}

/** A calendar date sent in a request: a real day, as `'YYYY-MM-DD'`, refused (400) before any code reads it. */
export const calendarDay = z
  .string()
  .refine(isCalendarDay, `Give a real date, as YYYY-MM-DD, from ${CALENDAR_DAY_YEARS.min} to ${CALENDAR_DAY_YEARS.max}.`);

// ---------------------------------------------------------------------------
// Query strings
// ---------------------------------------------------------------------------
//
// The parts of a route's query-string schema, which the backend's validateQuery(schema)
// parses before the handler runs (a value it refuses is 400 VALIDATION_ERROR, naming the
// field). A query value arrives as text, or as a list of texts when a name is repeated
// (`?a=1&a=2`), which these refuse. `?x=` is given but empty: each of these reads it as not
// given. A domain's query schemas live in its own file (`transactions.ts`, …), built from
// these:
//
//   export const securityListQuery = z.object({
//     ...queryPage({ defaultLimit: 50, maxLimit: 200 }),
//     account: queryUuid(),
//     include_inactive: queryBoolean({ default: false }),
//   });

/**
 * `schema`, reading an absent or empty value (`?x=`) as not given: undefined, before
 * `schema` sees it. (`z.coerce.number()` alone reads `?x=` as 0.)
 */
export const emptyAsUndefined = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

/** A query value read with `schema`: undefined when not given, else `fallback` when there is one. */
function queryValue<T extends z.ZodType>(schema: T, fallback: z.output<T> | undefined) {
  const value = emptyAsUndefined(schema);
  return fallback === undefined ? value : value.transform((read) => read ?? fallback);
}

/** The highest page a query may ask for: past it the offset would only scan to return nothing (as the backend's utils/pagination.ts). */
export const QUERY_MAX_PAGE = 100_000;

/** The most characters a whole number in a query may have; more is refused unread. */
const QUERY_INT_MAX_LENGTH = 16;

/**
 * A whole number in a query.
 *
 * With a `default`, read as the backend's utils/pagination.ts reads a page or a page size:
 * the default when it is absent, isn't a number, or is below `min`; at most `max` (a page
 * size past the cap is the cap). It never refuses, so a route that read the value with
 * pagination.ts's boundedQueryInt answers the same.
 *
 * Without one, a filter: absent or empty is undefined, and anything else must be a whole
 * number from `min` to `max` (digits, and a `-` when `min` is below 0), else 400 naming the
 * field ('account_id must be a whole number from 1 to 2147483647.'), unless a `message` is given.
 */
export function queryInt(options: { min: number; max: number; default: number }): z.ZodType<number>;
export function queryInt(options: { min: number; max: number; message?: string }): z.ZodType<number | undefined>;
export function queryInt(options: { min: number; max: number; default?: number; message?: string }): z.ZodType<number | undefined> {
  const { min, max } = options;
  const fallback = options.default;
  if (fallback !== undefined) {
    // A preprocess, which runs for an absent key too (a transform on z.unknown() doesn't).
    return z.preprocess((value) => {
      const n = parseInt(String(value ?? ''), 10);
      if (!Number.isFinite(n) || n < min) return fallback;
      return Math.min(n, max);
    }, z.number());
  }
  const message = options.message ?? ((issue: QueryIssue) => `${queryField(issue)} must be a whole number from ${min} to ${max}.`);
  const wholeNumber = z
    .string({ error: message })
    .max(QUERY_INT_MAX_LENGTH, { error: message, abort: true })
    .regex(min < 0 ? /^-?\d+$/ : /^\d+$/, { error: message })
    // + 0: '-0' reads as 0, not negative zero.
    .transform((text) => Number(text) + 0)
    .refine((n) => Number.isSafeInteger(n) && n >= min && n <= max, { error: message });
  return emptyAsUndefined(wholeNumber);
}

/**
 * `page` (from 1) and `limit` (1 to `maxLimit`, `defaultLimit` when not given), read as the
 * backend's pageParams reads them: a value that isn't one falls back to the default, and a
 * limit past the cap is the cap. To spread into a query schema; the offset is
 * `(page - 1) * limit`.
 */
export const queryPage = (options: { defaultLimit: number; maxLimit: number }) => ({
  page: queryInt({ min: 1, max: QUERY_MAX_PAGE, default: 1 }),
  limit: queryInt({ min: 1, max: options.maxLimit, default: options.defaultLimit }),
});

/** What a query value's error message is given: where the value is. */
type QueryIssue = { path?: readonly PropertyKey[] | undefined };

/** The query field an issue is about, to name it in the message: 'The value' at the top. */
const queryField = (issue: QueryIssue) =>
  issue.path && issue.path.length > 0 ? issue.path.map(String).join('.') : 'The value';

/**
 * `true` or `false` in a query, as a boolean; undefined (or `default`) when not given, anything
 * else 400 ('include_hidden must be true or false.', unless a `message` is given).
 */
export function queryBoolean(options: { default: boolean }): z.ZodType<boolean>;
export function queryBoolean(options?: { message?: string }): z.ZodType<boolean | undefined>;
export function queryBoolean(options: { default?: boolean; message?: string } = {}): z.ZodType<boolean | undefined> {
  const message = options.message ?? ((issue: { path?: readonly PropertyKey[] | undefined }) => `${queryField(issue)} must be true or false.`);
  const flag = z.enum(['true', 'false'], { error: message }).transform((value) => value === 'true');
  return queryValue(flag, options.default);
}

/**
 * A uuid in a query; undefined when not given, anything else 400 naming the field ('tag_uuid
 * must be a uuid.'), unless a `message` is given. A well-formed one that names nothing matches
 * nothing.
 */
export const queryUuid = (options: { message?: string } = {}) =>
  emptyAsUndefined(z.uuid({ error: options.message ?? ((issue: QueryIssue) => `${queryField(issue)} must be a uuid.`) }));

/**
 * A calendar date in a query, as {@link calendarDay} reads one in a body (YYYY-MM-DD, 1800 to
 * 2999); undefined when not given, anything else 400 naming the field ('start_date must be a
 * real date, …'), unless a `message` is given.
 */
export const queryCalendarDay = (options: { message?: string } = {}) => {
  const message =
    options.message ??
    ((issue: { path?: readonly PropertyKey[] | undefined }) =>
      `${queryField(issue)} must be a real date, as YYYY-MM-DD, from ${CALENDAR_DAY_YEARS.min} to ${CALENDAR_DAY_YEARS.max}.`);
  return emptyAsUndefined(z.string({ error: message }).refine(isCalendarDay, { error: message }));
};

/**
 * One of `values` in a query (a vocabulary list); undefined (or `default`) when not given,
 * anything else 400 naming the field ('bucket must be one of: day, week, month.'), unless a
 * `message` is given.
 */
export function queryEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  options: { default: T[number]; message?: string }
): z.ZodType<T[number]>;
export function queryEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  options?: { message?: string }
): z.ZodType<T[number] | undefined>;
export function queryEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  options: { default?: T[number]; message?: string } = {}
): z.ZodType<T[number] | undefined> {
  const message = options.message ?? ((issue: QueryIssue) => `${queryField(issue)} must be one of: ${values.join(', ')}.`);
  return queryValue(z.enum(values, { error: message }), options.default);
}

/** The largest id an `integer` column holds: a larger one names no row. */
export const INT4_MAX = 2147483647;

/**
 * A list's filter in a query string, kept as text: absent or empty is no filter, and
 * anything else is one string `valid` accepts, else 400 with `message`. A value sent twice is
 * a list, which no filter takes.
 */
export const queryTextFilter = (message: string, valid: (value: string) => boolean = () => true) =>
  emptyAsUndefined(z.string({ error: message }).refine(valid, message));
/** An id filter: digits that fit Postgres's `integer`, which parseInt reads as written. */
export const queryIdFilter = (key: string) =>
  queryTextFilter(`${key} must be a whole number`, (v) => /^\d{1,10}$/.test(v) && Number(v) <= INT4_MAX);
/** A date filter: `YYYY-MM-DD` and a real day (1800 to 2999), never routed through a Date. */
export const queryDayFilter = (key: string) => queryTextFilter(`${key} must be a date (YYYY-MM-DD)`, isCalendarDay);
/**
 * An amount filter: a decimal number, which parseFloat reads as written. No two parts of the
 * pattern match the same digits (`\d+\.?\d*` did, quadratic in a long run of them).
 */
export const queryAmountFilter = (key: string) =>
  queryTextFilter(`${key} must be a number`, (v) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v) && Number.isFinite(Number(v)));
/** Text matched as it is (a search, a status, a uuid that names nothing matching nothing), sent once. */
export const querySentOnce = (key: string) => queryTextFilter(`${key} must be sent once`);

/**
 * A whole number in a request body, from `min` to `max`: a JSON number, or its digits as
 * text (a form sends text), passed on as a number; anything else is refused with `message`.
 */
export const wholeNumberInput = (min: number, max: number, message: string) =>
  z
    .union([z.number(), z.string().trim().regex(/^-?\d{1,16}$/, message).transform(Number)], { error: message })
    .refine((n) => Number.isSafeInteger(n) && n >= min && n <= max, message);

/** A row's numeric id in a request body (a positive `integer`), else 400 with `message`. */
export const rowIdInput = (message: string) => wholeNumberInput(1, INT4_MAX, message);

/** Standard pagination query params. */
export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});
export type Pagination = z.infer<typeof pagination>;

/** Account category. */
export const assetType = z.enum(['Asset', 'Liability']);
export type AssetType = z.infer<typeof assetType>;

/** Account sub-type. Grounded in the values the Add/Edit account forms offer. */
export const accountType = z.enum([
  'checking',
  'savings',
  'cash',
  'investment',
  'business',
  'credit_card',
  'loan',
  'mortgage',
  'line_of_credit',
  'other',
]);
export type AccountType = z.infer<typeof accountType>;

/**
 * Account grouping bucket. Includes the legacy `'credit cards'` (with a space)
 * value that parts of the frontend still send alongside `'credit_cards'`;
 * kept here for faithful validation and flagged for normalisation later.
 */
export const accountGroup = z.enum([
  'cash',
  'credit cards',
  'credit_cards',
  'investments',
  'loans',
  'other',
]);
export type AccountGroup = z.infer<typeof accountGroup>;
