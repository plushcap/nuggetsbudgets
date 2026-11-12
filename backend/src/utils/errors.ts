/**
 * Narrowing for caught values. A `catch` binding is `unknown`: anything can be thrown, so read
 * an Error's fields through these rather than typing the binding `any`.
 */

/** An Error's message, or the thrown value as a string. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The `code` a thrown value carries, when it is a string: a Postgres SQLSTATE (`'23505'`), a Node
 * system error (`'ENOENT'`, `'EXDEV'`), a mailer's (`'EAUTH'`), or one of the app's own.
 */
export function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

/** The constraint a Postgres error names (pg's `DatabaseError.constraint`), if any. */
export function errorConstraint(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('constraint' in err)) return undefined;
  return typeof err.constraint === 'string' ? err.constraint : undefined;
}
