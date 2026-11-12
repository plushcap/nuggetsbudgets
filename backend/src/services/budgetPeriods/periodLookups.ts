import { getDb } from '../../db/withTenant.js';
import { budgetPeriodItemNotFound, budgetPeriodNotFound } from './BudgetPeriodError.js';

/**
 * A budget period or period item named by its uuid (what a URL carries),
 * looked up under RLS: one of another ledger is not found, as one that doesn't exist.
 */

/** The id and name of the period `uuid` names, or a 404 BudgetPeriodError. */
export async function budgetPeriodOf(uuid: string): Promise<{ id: number; name: string }> {
  const row = await getDb().selectFrom('budget_period').select(['id', 'name']).where('uuid', '=', uuid).executeTakeFirst();
  if (!row) throw budgetPeriodNotFound();
  return row;
}

/** The id of the period `uuid` names, or a 404 BudgetPeriodError. */
export async function budgetPeriodIdOf(uuid: string): Promise<number> {
  return (await budgetPeriodOf(uuid)).id;
}

/** The id of the period item `uuid` names, or a 404 BudgetPeriodError. */
export async function budgetPeriodItemIdOf(uuid: string): Promise<number> {
  const row = await getDb().selectFrom('budget_period_items').select('id').where('uuid', '=', uuid).executeTakeFirst();
  if (!row) throw budgetPeriodItemNotFound();
  return row.id;
}
