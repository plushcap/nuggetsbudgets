import { sql, type RawBuilder, type SqlBool } from 'kysely';

/**
 * On a transaction row (`table`, or the row an UPDATE writes, `undefined`): something that
 * puts rows into periods on its own (a bank sync, a new period taking in its month's
 * transactions) may give it the period whose first day is `start`. Not when a member took it
 * out of a period (budget_period_cleared_from, which a trigger keeps), unless that period is
 * gone and was this one's month's (deleted, and its month's period made again: the row goes
 * back in it). A row taken out of another month's period (a member moved it there, then took
 * it out) stays out of every one, that period deleted or not. A start unknown (the clear was
 * the period delete's own cascade, which can't read it) counts as its month's.
 */
export function notTakenOut(start: RawBuilder<unknown>, table?: string): RawBuilder<SqlBool> {
  const column = (name: string) => (table === undefined ? sql.ref(name) : sql.ref(`${table}.${name}`));
  const cleared = column('budget_period_cleared_from');
  const clearedStart = column('budget_period_cleared_start');
  return sql<SqlBool>`(${cleared} IS NULL
    OR (NOT EXISTS (SELECT 1 FROM budget_period gone WHERE gone.id = ${cleared})
        AND (${clearedStart} IS NULL OR ${clearedStart} = ${start})))`;
}
