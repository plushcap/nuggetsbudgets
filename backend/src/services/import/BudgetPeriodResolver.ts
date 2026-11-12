/**
 * Which budget period an imported transaction belongs to: found by its day in the
 * application time zone, and created for this month or the next two when it is missing
 * (BudgetService, as the configured import user), but only before the sync locks any
 * transaction (preparePeriods, AccountSyncer's today). Lookups go through a cache per ledger
 * that a sync loads at its start.
 *
 * The savepoint every import step runs in lives here too, because a step that rolls back
 * must take what the cache learned inside it with it.
 */
import { getDb, globalDb, withSavepoint } from '../../db/withTenant.js';
import { getCurrentTenantId } from '../../context/requestContext.js';
import { isCalendarDate, yearMonthOf } from '../../utils/calendarDate.js';
import { appToday } from '../../utils/appDate.js';
import { readTenantSetting } from '../tenantSettings.js';
import { loadTenantAccess } from '../MembershipService.js';
import { createLogger } from '../../utils/logger.js';
import type { BudgetService } from '../BudgetService.js';

/** Run `fn` in a savepoint of the open tenant transaction. */
export type Savepoint = <T>(fn: () => Promise<T>) => Promise<T>;

export class BudgetPeriodResolver {
  private logger = createLogger({ service: 'ImportService' });
  // budget_period ids keyed by "YYYY-MM", one map per tenant: the import routes share
  // one ImportService, so two ledgers' manual syncs can run at once, and one shared
  // map pointed a ledger's transactions at the other ledger's budget periods. Rebuilt
  // for the active tenant at the start of each sync (loadBudgetPeriodCache); no map
  // for a tenant means the lookups go to the database.
  private budgetPeriodCaches = new Map<number, Map<string, number>>();

  /** The active tenant's budget period cache, if a sync loaded one. */
  private get budgetPeriodCache(): Map<string, number> | undefined {
    const tenantId = getCurrentTenantId();
    return tenantId == null ? undefined : this.budgetPeriodCaches.get(tenantId);
  }

  private set budgetPeriodCache(cache: Map<string, number>) {
    const tenantId = getCurrentTenantId();
    if (tenantId != null) this.budgetPeriodCaches.set(tenantId, cache);
  }

  /**
   * withSavepoint, and forget what the cache learned inside it if it rolls back: a
   * budget period created there is gone, and another account's transactions must not
   * be pointed at it.
   */
  readonly savepoint: Savepoint = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await withSavepoint(fn);
    } catch (err) {
      if (this.budgetPeriodCache) this.budgetPeriodCache = new Map();
      throw err;
    }
  };

  constructor(private readonly budgetService: BudgetService) {}

  /**
   * A sync's piece of work rolled back outside any savepoint (inSyncTransaction): the
   * periods it created are gone, so `tenantId`'s cache forgets what it learned. By tenant
   * id, since out there no tenant scope names it for the cache's getter.
   */
  forget(tenantId: number): void {
    if (this.budgetPeriodCaches.has(tenantId)) this.budgetPeriodCaches.set(tenantId, new Map());
  }

  /**
   * Load all budget periods into cache for fast lookups during import
   * This avoids querying the database for every transaction
   */
  async loadBudgetPeriodCache(): Promise<void> {
    try {
      const rows = await getDb()
        .selectFrom('budget_period')
        .select(['id', 'year', 'month_number'])
        .orderBy('year')
        .orderBy('month_number')
        .execute();

      const cache = new Map<string, number>();
      for (const row of rows) {
        const key = `${row.year}-${String(row.month_number).padStart(2, '0')}`;
        cache.set(key, row.id);
      }
      this.budgetPeriodCache = cache;

      this.logger.info({ periodCount: cache.size }, 'Budget period cache loaded');
    } catch (error) {
      this.logger.error({ err: error }, 'Error loading budget period cache');
      this.budgetPeriodCache = new Map(); // Empty cache on error
    }
  }

  /**
   * Get the configured import user ID for automatic operations (imports, budget period creation)
   * @returns Configured import user ID or null if not configured/found
   */
  private async getImportUserId(): Promise<number | null> {
    try {
      // The ledger's own import user (tenant_settings).
      const value = (await readTenantSetting('import_user_id'))?.trim();
      if (!value) {
        this.logger.warn('No import user set for this tenant - budget period auto-creation disabled');
        return null;
      }

      const importUserId = parseInt(value, 10);
      if (isNaN(importUserId)) {
        this.logger.error('Invalid import user id in the tenant settings');
        return null;
      }

      // Stamped as the audit user of what the import writes, so it must be someone who
      // still has access to this ledger, with an account that isn't locked.
      const tenantId = getCurrentTenantId();
      const user = await globalDb
        .selectFrom('users')
        .select(['id'])
        .where('id', '=', importUserId)
        .where('is_locked', '=', false)
        .executeTakeFirst();
      const access = user && tenantId != null ? await loadTenantAccess(importUserId, tenantId, false) : null;
      if (!user || !access?.hasAccess) {
        this.logger.error({ importUserId }, "The tenant's import user no longer has access to it");
        return null;
      }

      this.logger.info({ userId: importUserId }, 'Using import user');
      return importUserId;
    } catch (error) {
      this.logger.error({ err: error }, 'Error getting import user ID');
      return null;
    }
  }

  /**
   * Find, or make, the budget period of each of `days` before the sync locks any transaction:
   * making one takes the ledger's budget item rows lock, which a merge holds
   * while it waits for its item's transactions, so a sync that had locked one of them and then
   * waited for that lock deadlocked with the merge. Here it waits for the merge, holding no
   * transaction, and the lookups that follow find the periods made. One lookup per month.
   */
  async preparePeriods(days: Iterable<string>): Promise<void> {
    const months = new Map<string, string>();
    for (const day of days) {
      if (isCalendarDate(day) && !months.has(day.slice(0, 7))) months.set(day.slice(0, 7), day);
    }
    for (const day of months.values()) await this.findBudgetPeriodForDate(day, { create: 'wait' });
  }

  /**
   * Find the budget period of a calendar day and, with `create: 'wait'`, make it when it is
   * missing and not before the ledger's first period nor more than two months ahead.
   * @param day 'YYYY-MM-DD', the day in the application time zone
   * @param options.create 'wait' only where the caller has locked no transactions
   *   (preparePeriods, AccountSyncer's today): making a period waits for an archive or a merge
   *   (lockBudgetItemRows) and takes FOR KEY SHARE on every active budget item. Else ('no', the
   *   default: a row of the sync, its transactions locked) a missing period is not made and the
   *   lookup answers null: a try of the lock got it once the merge was done, and
   *   then the item lock waited for any write holding an item FOR UPDATE that was itself waiting
   *   for one of the sync's transactions, a deadlock. A row left without its period gets it on a
   *   later sync, once the period is made (TransactionImporter).
   * @returns Budget period ID or null if not found and couldn't/shouldn't be created
   */
  async findBudgetPeriodForDate(day: string, { create = 'no' }: { create?: 'wait' | 'no' | undefined } = {}): Promise<number | null> {
    try {
      // Guard against an invalid/missing date: a NaN year or month sent to Postgres
      // as an int param throws 22P02 ("invalid input syntax for type integer: NaN"),
      // which aborts the surrounding sync transaction and fails every subsequent
      // account. Skip.
      if (!isCalendarDate(day)) {
        this.logger.warn({ day }, 'Skipping budget period lookup - invalid transaction date');
        return null;
      }
      const { year, month } = yearMonthOf(day);
      const cacheKey = `${year}-${String(month).padStart(2, '0')}`;
      
      // Try cache first (if available)
      if (this.budgetPeriodCache && this.budgetPeriodCache.has(cacheKey)) {
        return this.budgetPeriodCache.get(cacheKey)!;
      }
      
      // Fallback to database query (cache miss or cache not loaded)
      const existingPeriod = await getDb()
        .selectFrom('budget_period')
        .select('id')
        .where('year', '=', year)
        .where('month_number', '=', month)
        .executeTakeFirst();

      if (existingPeriod) {
        // Add to cache if it exists
        if (this.budgetPeriodCache) {
          this.budgetPeriodCache.set(cacheKey, existingPeriod.id);
        }
        return existingPeriod.id;
      }
      
      // Not made by a caller that holds transactions' locks (see `create`).
      if (create !== 'wait') return null;

      // Budget period doesn't exist - check if we should create it
      // CRITICAL: Only create budget periods for current month or future months, never past months
      
      // Get the earliest existing budget period to determine the "budget system start date"
      const earliestPeriodRow = await getDb()
        .selectFrom('budget_period')
        .select(['year', 'month_number'])
        .orderBy('year')
        .orderBy('month_number')
        .limit(1)
        .executeTakeFirst();

      if (earliestPeriodRow) {
        const earliestYear = earliestPeriodRow.year;
        const earliestMonth = earliestPeriodRow.month_number;
        
        // Compare transaction date with earliest budget period
        const transactionPeriod = year * 100 + month; // e.g., 202402 for February 2024
        const earliestPeriod = earliestYear * 100 + earliestMonth; // e.g., 202403 for March 2024
        
        if (transactionPeriod < earliestPeriod) {
          this.logger.warn({
            requestedMonth: month,
            requestedYear: year,
            earliestMonth,
            earliestYear
          }, '⚠️ Skipping budget period creation - before budget system start');
          return null;
        }
      }

      // Also check against current date - don't create periods more than 2 months in the future.
      // Counted in months, so November's limit is January: year * 100 + month + 2 made it
      // 202613, a month that doesn't exist, and refused January and February.
      const { year: currentYear, month: currentMonth } = yearMonthOf(await appToday());
      const monthsAhead = (year - currentYear) * 12 + (month - currentMonth);

      if (monthsAhead > 2) {
        this.logger.warn({
          requestedMonth: month,
          requestedYear: year,
          currentMonth,
          currentYear,
          maxMonthsAhead: 2
        }, '⚠️ Skipping budget period creation - too far in the future');
        return null;
      }

      // Proceed with budget period creation
      this.logger.info({ month, year }, 'Budget period not found, attempting to create');

      const importUserId = await this.getImportUserId();
      if (!importUserId) {
        this.logger.error('No import user configured for budget period creation');
        return null;
      }

      try {
        // In a savepoint of its own: a failure here is logged and the lookup
        // answers null, so a failed statement must not leave the sync's transaction aborted
        // (AccountSyncer's call has no savepoint of its own). The caller has locked no
        // transactions, so it waits for the ledger's budget item rows lock (an archive or a
        // merge), up to the lock timeout.
        const createdPeriod = await this.savepoint(() => this.budgetService.createBudgetPeriod(
          year,
          month,
          importUserId,
          true, // Enable auto-rollover
        ));

        this.logger.info({
          month,
          year,
          periodId: createdPeriod.periodId,
          budgetItemsCreated: createdPeriod.budgetItemsCreated,
          created: createdPeriod.created
        }, createdPeriod.created ? '✅ Auto-created budget period' : 'Budget period was created meanwhile; using it');
        return createdPeriod.periodId;

      } catch (createError) {
        this.logger.error({ err: createError, month, year }, 'Failed to auto-create budget period');
        return null;
      }

    } catch (error) {
      this.logger.error({ err: error }, 'Error finding/creating budget period for date');
      return null;
    }
  }
}
