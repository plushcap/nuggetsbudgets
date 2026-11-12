/**
 * What a database error may say where people read it and pass it on: the report a
 * failed migration leaves in the backups directory, and migrate's own log lines, which
 * an operator attaches to an issue.
 *
 * Postgres puts a row's values in an error's DETAIL (`Key (name)=(Acme) already exists`,
 * `Failing row contains (…)`) and its context (`SQL statement "…"`), which are always left
 * out here, and in the message itself: what a cast read (`invalid input syntax for type
 * integer: "Rent to J. Smith"`), what dynamic SQL named (`relation "…" does not exist`,
 * `syntax error at or near "12345"`), what a migration or a trigger raised (`RAISE
 * EXCEPTION 'payee % …', name`, with any SQLSTATE). So for every database error, its
 * message and its hint keep their shape with what they quote or list left out:
 * - quoted runs (`"…"`, `'…'`, and a translated server's `»…«`, `« … »`, `„…“`) stay only
 *   when each is a name the error's own fields give (its schema, table, column, data type
 *   or constraint). One that isn't makes everything
 *   from the first quote to the last `"…"`: a value can hold the quote itself, so where it
 *   starts and ends can't be told (`"tags" Smith 12345 "x"` could be one value). A single
 *   quote counts as a quote unless it is a contraction (`isn't`, `it's`), so `payee'Smith'`
 *   is one too;
 * - whatever parentheses hold is `(…)`, after a word too (`row(…)`, a type's `varchar(…)`),
 *   and an unpaired one leaves out everything on its far side.
 * When unsure it leaves out more. A value a RAISE wrote with no quotes or parentheses
 * around it can't be told from the message's words, so the report says to read it before
 * posting it.
 *
 * Nothing here imports the app's pool: the migrate script loads it.
 */

/** The fields of a node-postgres DatabaseError this reads. */
interface PgErrorFields {
  code?: unknown;
  severity?: unknown;
  message?: unknown;
  hint?: unknown;
  where?: unknown;
  position?: unknown;
  schema?: unknown;
  table?: unknown;
  column?: unknown;
  dataType?: unknown;
  constraint?: unknown;
}

const LEFT_OUT = '…';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/**
 * Whether `err` is an error the database answered with, as node-postgres's DatabaseError
 * has it: a five-character SQLSTATE (`2BP01`, `0A000`, `42P01`) and a severity. Node's own
 * errors (`EPIPE`, `ECONNREFUSED`) have no severity.
 */
export function isDatabaseError(err: unknown): boolean {
  const e = (err ?? {}) as PgErrorFields;
  return typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && typeof e.severity === 'string';
}

/** Whether the `'` at `i` is a contraction's (`isn't`, `it's`, `we're`), not a quote. */
function isContraction(value: string, i: number): boolean {
  return /\p{L}/u.test(value[i - 1] ?? '') && /^'(s|t|re|ve|ll|d|m)(?!\p{L})/iu.test(value.slice(i));
}

/**
 * The quotes a server whose messages are translated (`lc_messages`) uses in their place:
 * German `»tags«` and `„…“`, French `« tags »`, Japanese `「…」`, and the like. Each counts
 * as a quote, whichever way it faces.
 */
const TRANSLATED_QUOTES = new Set(['«', '»', '‹', '›', '„', '‚', '“', '”', '‘', '’', '「', '」', '『', '』']);

/**
 * Whether the character at `i` is a quote: `"`, a `'` that isn't a contraction's, or a
 * translated server's.
 */
function isQuote(value: string, i: number): boolean {
  const c = value.charAt(i);
  return c === '"' || (c === "'" && !isContraction(value, i)) || TRANSLATED_QUOTES.has(c);
}

/**
 * `value` with its quoted runs left out unless every one is a name in `keep`: then from the
 * first quote to the last, of any kind, is one `"…"` (`'…'`, `»…«`), and an unpaired quote
 * leaves out everything after it. All kinds at once: masking one kind first could swallow
 * the opening quote of another, whose closing one then left the value before it
 * (`l'entrée «O'Brien 12345»`).
 */
function withoutQuoted(value: string, keep: ReadonlySet<string>): string {
  const positions: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (isQuote(value, i)) positions.push(i);
  }
  const first = positions[0];
  const last = positions.at(-1);
  if (first === undefined || last === undefined) return value;
  if (positions.length === 1) return `${value.slice(0, first)}${value.charAt(first)}${LEFT_OUT}`;
  let allNames = positions.length % 2 === 0;
  for (let i = 0; allNames && i < positions.length; i += 2) {
    allNames = keep.has(value.slice(positions[i]! + 1, positions[i + 1]).trim()); // i < positions.length
  }
  if (allNames) return value;
  return `${value.slice(0, first)}${value.charAt(first)}${LEFT_OUT}${value.charAt(last)}${value.slice(last + 1)}`;
}


/**
 * `value` with whatever parentheses hold as `(…)` (an empty pair stays): a row's or a
 * key's values, `(account 12345)`, or a call's, `row(…)`. An unpaired `(` leaves out the
 * rest; an unpaired `)`, everything before it.
 */
function withoutParenthesized(value: string): string {
  let out = '';
  let depth = 0;
  let opened = -1;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '(') {
      if (depth === 0) opened = i;
      depth++;
    } else if (c === ')') {
      if (depth === 0) {
        out = `${LEFT_OUT})`;
      } else if (--depth === 0) {
        out += i === opened + 1 ? '()' : `(${LEFT_OUT})`;
      }
    } else if (depth === 0) {
      out += c;
    }
  }
  return depth > 0 ? `${out}(${LEFT_OUT}` : out;
}

/**
 * `value` (an error's message or hint) without the values it quotes or lists, whatever the
 * error: see above. `names` are the schema's names the error's own fields give, which stay.
 */
export function withoutQuotedValues(value: string, names: readonly unknown[] = []): string {
  const keep = new Set(names.filter((name): name is string => typeof name === 'string' && name !== ''));
  return withoutParenthesized(withoutQuoted(value, keep));
}

/**
 * The functions the error happened in (`PL/pgSQL function public.f() line 5 at RAISE`): a
 * trigger or a function the migration called. The context's other lines quote SQL, so
 * they are left out.
 */
export function functionContext(where: unknown): string | undefined {
  const lines = (text(where) ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(PL\/pgSQL|SQL) function /.test(line))
    .map((line) => line.slice(0, 200));
  return lines.length ? lines.join('; ') : undefined;
}

/** A database error's fields that say what failed, without its DETAIL, its SQL or a row's values. */
export interface PublicDbError {
  code: string;
  message: string;
  hint?: string;
  /** The functions it happened in (functionContext). */
  where?: string;
  position?: string;
  schema?: string;
  table?: string;
  column?: string;
  dataType?: string;
  constraint?: string;
}

/** `err`'s fields as a report or a log line may have them; null when it isn't a database error. */
export function publicDbError(err: unknown): PublicDbError | null {
  if (!isDatabaseError(err)) return null;
  const e = err as PgErrorFields;
  const code = e.code as string;
  const names = [e.schema, e.table, e.column, e.dataType, e.constraint];
  const clean = (value: unknown) => {
    const raw = text(value);
    return raw === undefined ? undefined : withoutQuotedValues(raw, names);
  };
  const out: PublicDbError = { code, message: clean(e.message) ?? '' };
  const optional = {
    hint: clean(e.hint),
    where: functionContext(e.where),
    position: text(e.position),
    schema: text(e.schema),
    table: text(e.table),
    column: text(e.column),
    dataType: text(e.dataType),
    constraint: text(e.constraint),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (out as unknown as Record<string, string>)[key] = value;
  }
  return out;
}

/** What dbErrorForLog logs for a database error: pino's err serializer names it by its class. */
class DatabaseError extends Error {}

/**
 * `err` for a log line that may be posted (migrate's failure lines): a database error as
 * publicDbError has it, with no DETAIL or SQL, and a stack of its first line only (a
 * node-postgres error's stack starts with its message, and the rest is the driver's own);
 * any other error as it is.
 */
export function dbErrorForLog(err: unknown): unknown {
  const fields = publicDbError(err);
  if (!fields) return err;
  const { message, ...rest } = fields;
  const logged = Object.assign(new DatabaseError(message), rest);
  logged.stack = `DatabaseError: ${message}`;
  return logged;
}

/** One line for a console: `CODE: message` as publicDbError has it, or the error's own. */
export function dbErrorLine(err: unknown): string {
  const fields = publicDbError(err);
  if (fields) return `${fields.code}: ${fields.message}`;
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const message = typeof e.message === 'string' && e.message ? e.message : String(err);
  return typeof e.code === 'string' && !message.startsWith(e.code) ? `${e.code}: ${message}` : message;
}
