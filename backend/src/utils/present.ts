/**
 * Values the code knows are there but the compiler can't (the backend's source builds
 * with noUncheckedIndexedAccess, so `rows[0]` and `xs[i]` are `T | undefined`). Each checks
 * at run time instead of asserting with `!`: one that's missing is a bug, so it throws (the
 * route wrapper answers a 500 and logs the reason) rather than carry `undefined` on into a
 * figure or a write.
 */

/** `value`, which the caller has reason to know is defined: an item of a list built to match another one index for index. */
export function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Expected ${what}, found none`);
  return value;
}

/**
 * The row of a query that always answers with one: an aggregate without GROUP BY
 * (`count(*)`), a `SELECT f(…)` with no FROM, or a re-read of a row this transaction holds.
 * Not for a lookup that can miss: that one checks for the missing row and refuses.
 */
export function oneRow<T>(rows: readonly T[], query: string): T {
  return present(rows[0], `a row from ${query}`);
}
