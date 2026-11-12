import { sql } from 'kysely';
import { getDb, globalDb, withTenant } from '../db/withTenant.js';
import { createLogger } from '../utils/logger.js';
import { ControlPlaneError } from './controlPlaneErrors.js';
import { readTenantSetting } from './tenantSettings.js';
import { isLockConflict } from './transactions/locks.js';

const logger = createLogger({ service: 'GoalDayRanges' });

/**
 * The ranges of days a goal's history reads: its links to accounts
 * (budget_item_accounts) and envelopes (goal_budget_items), each in effect from valid_from up to
 * valid_to, and the days each account was hidden (account_hidden_ranges, hidden_from up to
 * hidden_to). Each day in them is the ledger's today when it was written (app_today()).
 *
 * A goal's point for today reads the links open now and the accounts' hide_account flags; a
 * past day's reads these days. When a change of the ledger's time zone moves today back from K
 * to N, the ranges written on K keep K, after N: once N had passed, its point read them and
 * counted a link removed on K, left out one made on K, and counted an account hidden on K, where
 * the point shown while N was today did the opposite. So a change of the
 * tenant's zone clamps them to the new today, in its own transaction (saveGeneralSettings), and
 * a save of the deployment's clamps every tenant's that has no zone of its own, each in a
 * transaction of its own (clampTenantsOnDeploymentZone).
 */

/** What {@link clampDayRangesToToday} rewrote: how many links and hidden ranges it deleted and moved. */
export interface DayRangeClamp {
  linksDeleted: number;
  linksMoved: number;
  hiddenRangesDeleted: number;
  hiddenRangesMoved: number;
}

const LINK_TABLES = ['budget_item_accounts', 'goal_budget_items'] as const;

/**
 * pg_advisory_xact_lock's class for a ledger's day ranges ('DAYR'): a budget item or an
 * account being added holds it shared (the wait_for_day_range_change trigger), and
 * so does an item becoming a goal; a zone change alone.
 */
const DAY_RANGES_LOCK_CLASS = 0x44415952;

/**
 * Hold the ledger's day-ranges lock shared, as adding a budget item or an account does in its
 * trigger, for a write that locks other rows before that insert: createAccount
 * clears the old envelope account's flag first, a row a zone change locks after it takes this
 * lock alone. Taken as the write's first lock, it can't hold one the change waits for.
 */
export async function holdDayRangesShared(): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock_shared(${DAY_RANGES_LOCK_CLASS}::int, current_tenant_id())`.execute(getDb());
}

/**
 * Lock what writes the ranges, before the zone changes: every goal's row, which a
 * change of its links locks first (GoalService's lockGoal), and every account's, which hiding or
 * showing one updates before its trigger writes the range. In id order, FOR NO KEY UPDATE, as they
 * lock them. A write under way, its day read in the old zone, is waited for and then clamped; one
 * that starts now waits for the zone change and reads the new zone.
 *
 * A row being added can't be locked until it is committed: a goal created and linked in
 * one transaction, or an account created hidden, wrote its range in the old zone and committed
 * after the clamp. So the ledger's day-ranges lock comes first, alone: each insert of a budget
 * item or an account takes it shared, and so does an item becoming a goal, so the change waits
 * for them, and then locks them with the rest; one after waits for the change. Only the goals,
 * not every budget item: writes of several items that lock them out of id order
 * (a merchant merge's, say) deadlocked with it. A wait past the lock timeout, or a deadlock, is
 * a 409 to try again, nothing changed.
 */
export async function lockDayRangeWriters(): Promise<void> {
  try {
    await sql`SELECT pg_advisory_xact_lock(${DAY_RANGES_LOCK_CLASS}::int, current_tenant_id())`.execute(getDb());
    await sql`
      SELECT id FROM budget_items
       WHERE (expense_type = 'Savings' AND type = 'Goal')
          OR id IN (SELECT budget_item_id FROM budget_item_accounts)
          OR id IN (SELECT goal_id FROM goal_budget_items)
       ORDER BY id
         FOR NO KEY UPDATE
    `.execute(getDb());
    await sql`SELECT id FROM accounts ORDER BY id FOR NO KEY UPDATE`.execute(getDb());
  } catch (err) {
    if (!isLockConflict(err)) throw err;
    logger.warn({ err }, 'A time zone change could not lock the goals and accounts in time; nothing changed');
    throw new ControlPlaneError(
      409,
      'RECORD_BUSY',
      'Another change to the goals or accounts was being saved at the same time, so the time zone was not changed. Try again.'
    );
  }
}

/**
 * Clamp the current ledger's ranges to its today (app_today(), the new zone's once the setting is
 * written): each day after today becomes today, and a range left with no day is deleted. So a
 * point for today, once today has passed, reads what today's point reads now: an open link
 * counts from today, a closed one has ended by today, and an open hidden range covers today. A
 * day before today is in no range it wasn't in before, nor out of one it was in, so no past
 * point changes. The rows (under RLS, the ledger's own):
 *
 * - budget_item_accounts, goal_budget_items: a closed link that starts today or later (valid_to
 *   set, valid_from >= today) is deleted; otherwise a valid_from or valid_to after today becomes
 *   today.
 * - account_hidden_ranges: a closed range that starts today or later (hidden_to set, hidden_from
 *   >= today) is deleted; otherwise a hidden_from or hidden_to after today becomes today. Only an
 *   open range can then start today, and an account has one at most, so no two start the same day.
 *
 * Under any zone a day is at most today when written, so only a zone that has moved today back
 * leaves a day after it; with none, nothing is rewritten. Run after {@link lockDayRangeWriters},
 * in the transaction that writes the zone.
 */
export async function clampDayRangesToToday(): Promise<DayRangeClamp> {
  const db = getDb();
  const counted = (result: { numAffectedRows?: bigint | undefined }) => Number(result.numAffectedRows ?? 0);
  const clamp: DayRangeClamp = { linksDeleted: 0, linksMoved: 0, hiddenRangesDeleted: 0, hiddenRangesMoved: 0 };
  for (const table of LINK_TABLES) {
    clamp.linksDeleted += counted(await sql`
      DELETE FROM ${sql.table(table)} WHERE valid_to IS NOT NULL AND valid_from >= app_today()
    `.execute(db));
    clamp.linksMoved += counted(await sql`
      UPDATE ${sql.table(table)}
         SET valid_from = LEAST(valid_from, app_today()),
             valid_to = CASE WHEN valid_to > app_today() THEN app_today() ELSE valid_to END
       WHERE valid_from > app_today() OR valid_to > app_today()
    `.execute(db));
  }
  clamp.hiddenRangesDeleted = counted(await sql`
    DELETE FROM account_hidden_ranges
     WHERE hidden_to IS NOT NULL AND hidden_from IS NOT NULL AND hidden_from >= app_today()
  `.execute(db));
  clamp.hiddenRangesMoved = counted(await sql`
    UPDATE account_hidden_ranges
       SET hidden_from = CASE WHEN hidden_from > app_today() THEN app_today() ELSE hidden_from END,
           hidden_to = CASE WHEN hidden_to > app_today() THEN app_today() ELSE hidden_to END
     WHERE hidden_from > app_today() OR hidden_to > app_today()
  `.execute(db));
  if (Object.values(clamp).some((n) => n > 0)) {
    logger.info(clamp, "Clamped the goals' links and the accounts' hidden ranges to the tenant's new today");
  }
  return clamp;
}

/**
 * After the deployment's time zone is saved (PUT /api/admin/deployment-settings, the setting
 * written and committed): clamp the ranges of tenant `tenantId` to its today, in a short
 * transaction of its own, when it has no zone of its own (app_timezone() then reads the
 * deployment's, so its today moved with it). One with its own zone is left as it is: its today
 * didn't move. The same locks and clamp as a tenant's own zone change, so a write under way in
 * the old zone is waited for and clamped. Its clamp, or null when it has its own zone.
 */
export async function clampTenantOnDeploymentZone(tenantId: number): Promise<DayRangeClamp | null> {
  return withTenant(tenantId, async () => {
    if ((await readTenantSetting('application_timezone'))?.trim()) return null;
    await lockDayRangeWriters();
    return clampDayRangesToToday();
  });
}

/**
 * Every tenant's id, whatever its status or its organization's: a suspended one comes back
 * later with the days it had, so it is clamped with the others. tenants is control plane.
 */
export async function everyTenantId(): Promise<number[]> {
  return (await globalDb.selectFrom('tenants').select('id').orderBy('id').execute()).map((row) => row.id);
}

/**
 * {@link clampTenantOnDeploymentZone} for each of `tenantIds` (every tenant's by default), one at
 * a time, each in its own transaction: a tenant that can't be clamped (its goals or
 * accounts busy past the lock timeout) is logged and counted, and the others go on. Idempotent:
 * the deployment-settings route runs it on every save of the zone, so saving it again clamps
 * what a save couldn't.
 */
export async function clampTenantsOnDeploymentZone(tenantIds?: readonly number[]): Promise<{ total: number; failed: number }> {
  const ids = tenantIds ?? (await everyTenantId());
  let failed = 0;
  for (const tenantId of ids) {
    try {
      await clampTenantOnDeploymentZone(tenantId);
    } catch (err) {
      failed += 1;
      logger.error({ err, tenantId }, "Could not clamp the tenant's goal ranges to the deployment time zone");
    }
  }
  if (failed > 0) logger.warn({ total: ids.length, failed }, "Some tenants' goal ranges were not clamped to the deployment time zone");
  return { total: ids.length, failed };
}
