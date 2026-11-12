/**
 * Errors as a log line may carry them. `{ err }` logs an error's message, its
 * stack and every field it has, and some errors quote the data they failed on: a Postgres
 * check's message can name an amount ("… amount -31.37"), its `detail` the whole row
 * ("Failing row contains (…)") or a key ("Key (…)=(the payee) already exists"). Where the
 * row is a member's financial data, log a database error by what identifies it instead.
 * The same for errors a third party writes for people: SimpleFin's name the bank's accounts.
 * (A mailer's: EmailDeliveryService's mailErrorFields.)
 */

import type { SimpleFinProtocolError } from '@nuggets/shared';

/** A Postgres error as pg reports it (pg-protocol's DatabaseError): it has a severity and a routine. */
function isDatabaseError(err: unknown): err is Record<string, unknown> {
  return (
    typeof err === 'object' && err !== null &&
    typeof (err as { severity?: unknown }).severity === 'string' &&
    typeof (err as { code?: unknown }).code === 'string' &&
    'routine' in err
  );
}

/** The fields of a database error that name what failed, never the values it failed on. */
export interface DatabaseErrorFields {
  /** The SQLSTATE (`23514` a check, `23505` a unique key, `22003` numeric overflow). */
  code: string;
  constraint?: string;
  table?: string;
  column?: string;
  /** The server function that raised it (`ExecConstraints`, `_bt_check_unique`). */
  routine?: string;
}

/**
 * Log fields for an error met while writing a member's rows: a database error as
 * `{ dbError: { code, constraint, table, column, routine } }`, without its message, detail
 * or stack; anything else as `{ err }` (the app's own errors say what they mean without
 * the values, importFields.ts).
 */
export function rowErrorFields(err: unknown): { dbError: DatabaseErrorFields } | { err: unknown } {
  if (!isDatabaseError(err)) return { err };
  const text = (key: string) => (typeof err[key] === 'string' ? (err[key] as string) : undefined);
  const fields: DatabaseErrorFields = { code: err.code as string };
  for (const key of ['constraint', 'table', 'column', 'routine'] as const) {
    const value = text(key);
    if (value !== undefined) fields[key] = value;
  }
  return { dbError: fields };
}

/**
 * SimpleFin's errors as the log carries them: each one's code and the connection and
 * account it names, not its text (`msg`), which the bridge writes for people and may
 * name the bank's accounts. The code says what went wrong (`con.auth`, `act.sync`).
 */
export function simplefinErrorCodes(errlist: SimpleFinProtocolError[]): Pick<SimpleFinProtocolError, 'code' | 'conn_id' | 'account_id'>[] {
  return errlist.map(({ code, conn_id, account_id }) => ({
    code,
    ...(conn_id !== undefined && { conn_id }),
    ...(account_id !== undefined && { account_id }),
  }));
}
