import { sql } from 'kysely';
import { getDb } from '../db/withTenant.js';

/**
 * A ledger's merchant names are unique ignoring case: the unique index
 * uq_merchants_tenant_lower_name on (tenant_id, lower(name)).
 */
export const MERCHANT_NAME_INDEX = 'uq_merchants_tenant_lower_name';

/** The conflict target of that index, for INSERT ... ON CONFLICT. */
export const merchantNameConflictTarget = sql`tenant_id, lower(name)`;

/** A database error from a write that would give the ledger a second merchant of that name. */
export function isMerchantNameConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && e.constraint === MERCHANT_NAME_INDEX;
}

/** The active ledger's merchant named `name` (any case), if it has one. */
export function findMerchantByName(name: string): Promise<{ id: number } | undefined> {
  return getDb().selectFrom('merchants').select('id').where(sql<boolean>`lower(name) = lower(${name})`).executeTakeFirst();
}

/**
 * The active ledger's merchant named `name` (any case), created with `values` if it has
 * none. When a concurrent request creates the name between the lookup and the insert,
 * the insert does nothing (it waits for that request's row) and its merchant is returned.
 * Runs on the request's transaction (getDb()).
 */
export async function findOrCreateMerchant(
  name: string,
  values: { notes?: string | null } = {}
): Promise<{ id: number; created: boolean }> {
  const db = getDb();
  const byName = () => findMerchantByName(name);

  const existing = await byName();
  if (existing) return { id: existing.id, created: false };

  const inserted = await db
    .insertInto('merchants')
    .values({ name, notes: values.notes ?? null })
    .onConflict((oc) => oc.expression(merchantNameConflictTarget).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) return { id: inserted.id, created: true };

  const meanwhile = await byName();
  if (!meanwhile) throw new Error(`Merchant "${name}" was neither created nor found`);
  return { id: meanwhile.id, created: false };
}
