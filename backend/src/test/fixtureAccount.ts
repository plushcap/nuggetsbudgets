import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema.generated.js';

/**
 * The id of an account in the current ledger for fixture transactions that aren't about
 * accounts: every transaction belongs to one (transactions.account_id is NOT NULL).
 * Creates a 'Fixture checking' account the first time. `db` is the ledger's executor
 * (getDb() inside withTenant), so the account is that ledger's.
 */
export async function fixtureAccountId(db: Kysely<DB>): Promise<number> {
  const existing = await db
    .selectFrom('accounts')
    .select('id')
    .where('name', '=', 'Fixture checking')
    .where('tenant_id', '=', sql<number>`current_tenant_id()`)
    .executeTakeFirst();
  if (existing) return existing.id;
  const created = await db
    .insertInto('accounts')
    .values({ name: 'Fixture checking', account_type: 'checking', account_group: 'cash', type: 'Asset' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return created.id;
}
