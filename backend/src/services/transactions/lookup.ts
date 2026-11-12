import { sql } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import { accountBalanceService } from '../AccountBalanceService.js';

/** The lookups and follow-ups every transaction service shares. All run on getDb(). */

/** The id of the transaction with this uuid, or null (get_transaction_id_by_uuid). */
export async function transactionIdByUuid(uuid: string): Promise<number | null> {
  const result = await sql<{ transaction_id: number | null }>`
    SELECT get_transaction_id_by_uuid(${uuid}) as transaction_id
  `.execute(getDb());
  return result.rows[0]?.transaction_id ?? null;
}

/** The id of the tag with this uuid, or null (get_tag_id_by_uuid). */
export async function tagIdByUuid(uuid: string): Promise<number | null> {
  const result = await sql<{ tag_id: number | null }>`SELECT get_tag_id_by_uuid(${uuid}) as tag_id`.execute(getDb());
  return result.rows[0]?.tag_id ?? null;
}

/** The envelope (budget_period_items row) of a budget item in a period, if it has one. */
export async function periodItemId(budgetItemId: number, budgetPeriodId: number): Promise<number | null> {
  const row = await getDb()
    .selectFrom('budget_period_items')
    .select('id')
    .where('budget_item_id', '=', budgetItemId)
    .where('budget_period_id', '=', budgetPeriodId)
    .executeTakeFirst();
  return row?.id ?? null;
}

const balances = accountBalanceService;

/**
 * After a write that moves money: balances are computed on read, so only
 * today's net worth is recorded. Never fails the write (it runs in a savepoint).
 */
export function recordNetWorth(): Promise<void> {
  return balances.triggerNetWorthSnapshot();
}
