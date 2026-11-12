/**
 * The bank import's orchestrator: a sync of one ledger, from the claim that keeps a
 * second one out, through SimpleFin's answer, to the sync log and the net worth snapshot.
 *
 * A sync runs in pieces, never with a tenant transaction open while SimpleFin answers:
 * the sync log's row in a short withTenant; the fetch (SimpleFinClient) with no
 * transaction, in the tenant's scope; each account in a transaction of its own
 * (AccountSyncer → TransactionImporter); then the summary. The parts:
 *
 * - import/SimpleFinClient: the HTTP client (timeouts, the circuit breaker per ledger).
 * - import/AccountSyncer: one account's institution, import fields, currency, balance
 *   history and rebalance.
 * - import/TransactionImporter: one account's transactions, written idempotently.
 * - import/MerchantMatcher, import/pendingMatcher, import/manualMatch: the matchers.
 * - import/BudgetPeriodResolver: the budget period of a day, cached per ledger, and the
 *   savepoint every step runs in.
 */
import { Pool } from 'pg';
import { getDb, inTenantTransaction, withTenant } from '../db/withTenant.js';
import { runInTenantScope } from '../context/requestContext.js';
import { readTenantSetting, writeTenantSettings } from './tenantSettings.js';
import { getConnectionForTenant, markSynced } from './OrganizationSimpleFinService.js';
import { BudgetService } from './BudgetService.js';
import { BudgetItemMatcher } from './BudgetItemMatcher.js';
import { createLogger } from '../utils/logger.js';
import { rowErrorFields } from '../utils/logSafeErrors.js';
import { publicErrorMessage } from '../utils/apiError.js';
import { SyncInProgressError, SYNC_FAILED_REASON } from './import/errors.js';
import { SimpleFinClient } from './import/SimpleFinClient.js';
import { simplefinErrorCodes } from '../utils/logSafeErrors.js';
import { BudgetPeriodResolver } from './import/BudgetPeriodResolver.js';
import { MerchantMatcher } from './import/MerchantMatcher.js';
import { TransactionImporter, type SyncStats } from './import/TransactionImporter.js';
import { AccountSyncer } from './import/AccountSyncer.js';
import type { ImportSyncOptions, SimplefinAccountSet } from './import/types.js';

export { NoSimpleFinConnectionError, SyncInProgressError, SimpleFinUpstreamError, SYNC_FAILED_REASON } from './import/errors.js';
export { simplefinBreakerName } from './import/SimpleFinClient.js';

/**
 * First key of the transaction-scoped advisory lock a bank sync holds on its ledger
 * (ASCII "SYNC"); the second key is the tenant id. The two-key lock space doesn't
 * overlap the single-bigint keys the migration runner, backups and setup use.
 */
const BANK_SYNC_LOCK_CLASS = 0x53594e43;

/** "2 transactions could not be imported…", for a sync log's error message. */
function failedTransactionsMessage(count: number): string {
  return `${count} transaction${count === 1 ? '' : 's'} could not be imported; see the server log`;
}

/** How a full sync ended, as its sync-log row records it. */
export interface FullSyncOutcome {
  status: 'completed' | 'partial' | 'failed';
  /** What went wrong or needs a look (the sync log's error_message), or null. */
  message: string | null;
}

/**
 * The sync log's note for accounts whose balance follows the bank's but wasn't compared with
 * it: what some of their transactions that couldn't be saved change can't be told
 * (unsavedRows.ts).
 */
function rebalanceSkippedMessage(count: number): string {
  const why = 'had an amount that could not be read, or may be a transaction entered by hand that is dated after today or can\'t be told apart';
  return count === 1
    ? `1 account's balance was not adjusted to the bank's: a transaction of it that could not be imported ${why}`
    : `${count} accounts' balances were not adjusted to the bank's: a transaction of each that could not be imported ${why}`;
}

/** "1 pending transaction disappeared…", for a sync log's message. */
function flaggedPendingMessage(count: number): string {
  return `${count} pending transaction${count === 1 ? '' : 's'} disappeared without a matching posted one; flagged for review`;
}

export class ImportService {
  private pool: Pool;
  private logger = createLogger({ service: 'ImportService' });
  private readonly client = new SimpleFinClient();
  private readonly periods: BudgetPeriodResolver;
  private readonly merchants: MerchantMatcher;
  private readonly transactions: TransactionImporter;
  private readonly accounts: AccountSyncer;

  constructor(pool: Pool) {
    this.pool = pool;
    this.periods = new BudgetPeriodResolver(new BudgetService());
    this.merchants = new MerchantMatcher(this.periods.savepoint);
    this.transactions = new TransactionImporter(this.periods, this.merchants, new BudgetItemMatcher());
    this.accounts = new AccountSyncer(this.periods, this.transactions);
  }

  /**
   * Run `fn` as the only bank sync of `tenantId`, or throw SyncInProgressError if another
   * sync (a member's, or the scheduler's) holds the ledger. Every sync claims it before
   * anything else, so they can't fetch the same answer and both write it, or lock each
   * other's accounts in opposite orders.
   *
   * A sync runs in pieces, with no transaction open while SimpleFin answers, so
   * the claim can't be a transaction's lock. It's a session advisory lock on a
   * connection of its own, held only for the sync: unlocked when it ends, and released
   * by the server if the connection or process dies, so nothing can leave it held.
   */
  private async withSyncClaim<T>(tenantId: number, fn: () => Promise<T>): Promise<T> {
    if (inTenantTransaction()) {
      throw new Error('A bank sync opens its own transactions; start it outside one');
    }
    const client = await this.pool.connect();
    let broken = false;
    try {
      const { rows } = await client.query<{ claimed: boolean }>(
        'SELECT pg_try_advisory_lock($1::int, $2::int) AS claimed', [BANK_SYNC_LOCK_CLASS, tenantId]
      );
      if (!rows[0]?.claimed) {
        this.logger.info({ tenantId }, 'Another bank sync of this tenant is running; not starting a second');
        throw new SyncInProgressError();
      }
      try {
        return await fn();
      } finally {
        try {
          await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [BANK_SYNC_LOCK_CLASS, tenantId]);
        } catch (err) {
          // Close the connection instead of pooling it: that ends the session and its lock.
          broken = true;
          this.logger.warn({ err, tenantId }, 'Could not release the bank sync claim; closing its connection');
        }
      }
    } finally {
      client.release(broken);
    }
  }

  /**
   * One piece of a sync's database work, in a transaction of its own: a database error
   * in it rolls back only that piece (an account), and the budget period cache with it.
   */
  private async inSyncTransaction<T>(tenantId: number, fn: () => Promise<T>): Promise<T> {
    try {
      return await withTenant(tenantId, fn);
    } catch (err) {
      this.periods.forget(tenantId);
      throw err;
    }
  }

  /** SimpleFin's answer for `tenantId`'s connection, fetched with no transaction open. */
  private fetchAccountsFor(tenantId: number, options: ImportSyncOptions): Promise<SimplefinAccountSet> {
    return runInTenantScope(tenantId, () => this.fetchAccounts(options));
  }

  /** The active tenant's SimpleFin answer (SimpleFinClient.fetchAccounts). */
  fetchAccounts(options: ImportSyncOptions = {}): Promise<SimplefinAccountSet> {
    return this.client.fetchAccounts(options);
  }

  /** Whether the active tenant's SimpleFin connection answers (SimpleFinClient.testConnection). */
  testConnection(): Promise<boolean> {
    return this.client.testConnection();
  }

  async runAutomaticSync(tenantId: number): Promise<void> {
    this.logger.info('Starting automatic sync');

    // Whether this ledger's automatic import is on (tenant_settings).
    if ((await readTenantSetting('import_enabled', tenantId)) !== 'true') {
      this.logger.info({ tenantId }, 'Automatic sync is disabled for this tenant');
      return;
    }
    
    try {
      try {
        await this.runFullSync(tenantId, {
          syncType: 'automatic',
          syncTrigger: 'schedule'
        });
      } catch (error) {
        // A member's sync of this ledger is running: it does what this run would.
        if (error instanceof SyncInProgressError) {
          this.logger.info({ tenantId }, 'Skipping scheduled sync of this tenant: a sync is already running');
          return;
        }
        throw error;
      }

      // When the scheduler last imported this ledger: its next run counts from here.
      await writeTenantSettings({ import_last_auto_sync: new Date().toISOString() }, null, tenantId);
      
      // Automatic sync completed
    } catch (error) {
      this.logger.error({ err: error }, 'Automatic sync failed');
      throw error;
    }
  }

  async runSingleAccountSync(tenantId: number, accountUuid: string, options: {
    syncType: 'manual' | 'automatic';
    syncTrigger: 'user' | 'api';
    userId?: number;
  }): Promise<{
    success: boolean;
    /** How the sync log records it: 'partial' when some transactions couldn't be saved. */
    status?: 'completed' | 'partial';
    /** What needs a look (transactions not saved, pending ones flagged), as the sync log says it. */
    notice?: string;
    transactionsImported: number;
    transactionsUpdated: number;
    transactionsFailed?: number;
    balanceAdjustments: number;
    message: string;
    error?: string;
  }> {
    const syncStartTime = new Date();
    let logId: number | null = null;
    const inTenant = <T>(fn: () => Promise<T>) => withTenant(tenantId, fn);

    // The claim comes before anything is written: a sync turned away leaves no trace
    // (SyncInProgressError, a 409). Then it runs in pieces, with no transaction open
    // while SimpleFin answers.
    return this.withSyncClaim(tenantId, async () => {
    try {
      // The account, and the sync log's row: committed, so the sync shows as started.
      const account = await inTenant(async () => {
        const row = await getDb()
          .selectFrom('accounts')
          .select(['id', 'name', 'import_account_id'])
          .where('uuid', '=', accountUuid)
          .where('import_account_id', 'is not', null)
          .executeTakeFirst();
        if (!row) return null;
        const logRow = await getDb()
          .insertInto('import_sync_log')
          .values({
            sync_type: options.syncType,
            sync_status: 'started',
            sync_trigger: options.syncTrigger,
            sync_start_time: syncStartTime,
            user_id: options.userId || null,
            account_id: row.id
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        logId = logRow.id;
        // Load budget period cache once at the start for performance
        await this.periods.loadBudgetPeriodCache();
        return row;
      });

      if (!account) {
        return {
          success: false,
          transactionsImported: 0,
          transactionsUpdated: 0,
          balanceAdjustments: 0,
          message: 'Account not found or not linked to bank import',
          error: 'Account not found or not configured for import'
        };
      }
      
      const importAccountId = account.import_account_id;

      // Fetch accounts from SimpleFin
      const accountSet = await this.fetchAccountsFor(tenantId, { includePending: true });

      if ((accountSet.errlist?.length ?? 0) > 0) {
        this.logger.error({ simplefinErrors: simplefinErrorCodes(accountSet.errlist ?? []) }, 'SimpleFin returned errors during account sync');
      }
      
      // Find the specific account we want to sync
      const sfAccount = accountSet.accounts.find(acc => acc.id === importAccountId);
      
      if (!sfAccount) {
        await inTenant(() => getDb()
          .updateTable('import_sync_log')
          .set({
            sync_status: 'failed',
            sync_end_time: new Date(),
            error_message: 'Account not found in SimpleFin response'
          })
          .where('id', '=', logId!)
          .execute());

        return {
          success: false,
          transactionsImported: 0,
          transactionsUpdated: 0,
          balanceAdjustments: 0,
          message: 'Account not found in bank data',
          error: 'Account not found in SimpleFin response'
        };
      }
      
      // Sync the specific account, in a transaction of its own: a database error in it
      // rolls back only its writes, and the failure below can still be recorded.
      const syncResult = await this.inSyncTransaction(tenantId, () => this.accounts.syncAccount(sfAccount, accountSet.connections ?? [], undefined, accountSet.requestedStartDate ?? null));

      const status = syncResult.transactionsFailed > 0 ? 'partial' : 'completed';
      const problems = [
        ...(syncResult.transactionsFailed > 0 ? [failedTransactionsMessage(syncResult.transactionsFailed)] : []),
        ...(syncResult.rebalanceSkipped ? [rebalanceSkippedMessage(1)] : []),
        ...(syncResult.pendingFlagged > 0 ? [flaggedPendingMessage(syncResult.pendingFlagged)] : []),
      ];
      await inTenant(async () => {
      // Persist per-account connection health from the v2 errlist.
      await this.accounts.persistConnectionHealth(accountSet);

      // Update sync log with results
      await getDb()
        .updateTable('import_sync_log')
        .set({
          sync_status: status,
          sync_end_time: new Date(),
          accounts_synced: 1,
          transactions_imported: syncResult.transactionsImported,
          transactions_updated: syncResult.transactionsUpdated,
          balance_adjustments_created: syncResult.balanceAdjustments,
          error_message: problems.length > 0 ? problems.join('; ') : null
        })
        .where('id', '=', logId!)
        .execute();
      
      // CRITICAL FIX: Trigger net worth calculation after single account sync
      if (syncResult.transactionsImported > 0 || syncResult.transactionsUpdated > 0 || syncResult.balanceAdjustments > 0) {
        this.logger.info('📊 Triggering net worth snapshot after single account sync');
        try {
          await this.periods.savepoint(async () => {
            const NetWorthService = (await import('./NetWorthService.js')).default;
            const netWorthService = new NetWorthService();

            const snapshot = await netWorthService.createSnapshotIfNeeded('transaction');

            if (snapshot) {
              this.logger.info({ snapshotId: snapshot.id }, '✅ Net worth snapshot updated');
            } else {
              this.logger.info('ℹ️  Net worth snapshot already current');
            }
          });
        } catch (netWorthError) {
          this.logger.error({ err: netWorthError }, '❌ Failed to create net worth snapshot after single account sync');
          // Don't fail the sync for net worth calculation errors
        }
      }
      });

      // Account sync completed successfully
      
      return {
        success: true,
        status,
        ...(problems.length > 0 ? { notice: problems.join('; ') } : {}),
        transactionsImported: syncResult.transactionsImported,
        transactionsUpdated: syncResult.transactionsUpdated,
        transactionsFailed: syncResult.transactionsFailed,
        balanceAdjustments: syncResult.balanceAdjustments,
        message: `Sync completed: ${syncResult.transactionsImported} new transactions, ${syncResult.transactionsUpdated} updated` +
          problems.map((problem) => `; ${problem}`).join('')
      };
      
    } catch (error) {
      // Update sync log with error
      if (logId) {
        const failedLogId = logId;
        await inTenant(() => getDb()
          .updateTable('import_sync_log')
          .set({
            sync_status: 'failed',
            sync_end_time: new Date(),
            error_message: publicErrorMessage(error, SYNC_FAILED_REASON)
          })
          .where('id', '=', failedLogId)
          .execute());
      }

      this.logger.error({ ...rowErrorFields(error) }, 'Single account sync failed');

      return {
        success: false,
        transactionsImported: 0,
        transactionsUpdated: 0,
        balanceAdjustments: 0,
        message: 'Sync failed',
        error: publicErrorMessage(error, SYNC_FAILED_REASON)
      };
    }
    });
  }

  async runFullSync(tenantId: number, options: {
    syncType: 'manual' | 'automatic' | 'initial';
    syncTrigger: 'user' | 'schedule' | 'api';
    userId?: number;
  }): Promise<FullSyncOutcome> {
    const syncStartTime = new Date();
    let logId: number | null = null;

    // Track sync statistics for detailed logging
    const syncStats: SyncStats = {
      skippedInstitutions: [],
      skippedUnlinkedAccounts: [],
      accountsWithNoTransactions: [],
      balanceHistoryConflicts: 0,
      reconciledTransactionsSkipped: 0
    };

    const inTenant = <T>(fn: () => Promise<T>) => withTenant(tenantId, fn);

    // The claim comes before anything is written: a sync turned away leaves no trace
    // (SyncInProgressError, a 409). Then it runs in pieces, with no transaction open
    // while SimpleFin answers: the sync log's row, committed so the sync shows
    // as started; the fetch; each account in a transaction of its own; the summary.
    return this.withSyncClaim(tenantId, async () => {
    try {
      logId = await inTenant(async () => {
        // Load budget period cache once at the start for performance
        await this.periods.loadBudgetPeriodCache();

        const logRow = await getDb()
          .insertInto('import_sync_log')
          .values({
            sync_type: options.syncType,
            sync_status: 'started',
            sync_trigger: options.syncTrigger,
            sync_start_time: syncStartTime,
            user_id: options.userId || null
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        return logRow.id;
      });

      // Fetch all accounts from SimpleFin (including pending transactions)
      const accountSet = await this.fetchAccountsFor(tenantId, { includePending: true });

      if ((accountSet.errlist?.length ?? 0) > 0) {
        this.logger.error({ simplefinErrors: simplefinErrorCodes(accountSet.errlist ?? []) }, 'SimpleFin returned errors during account sync');
      }

      let totalAccountsSynced = 0;
      let totalTransactionsImported = 0;
      let totalTransactionsUpdated = 0;
      let totalTransactionsFailed = 0;
      let totalPendingReplaced = 0;
      let totalPendingVanished = 0;
      let totalPendingFlagged = 0;
      let totalBalanceAdjustments = 0;
      let totalRebalancesSkipped = 0;
      const failedAccounts: Array<{ id: string; name?: string; error: string }> = [];

      // Process each account, in a transaction of its own: one that fails rolls back only its writes.
      for (const sfAccount of accountSet.accounts) {
        try {
          await this.inSyncTransaction(tenantId, async () => {
            const syncResult = await this.accounts.syncAccount(sfAccount, accountSet.connections ?? [], syncStats, accountSet.requestedStartDate ?? null);
            totalAccountsSynced++;
            totalTransactionsImported += syncResult.transactionsImported;
            totalTransactionsUpdated += syncResult.transactionsUpdated;
            totalTransactionsFailed += syncResult.transactionsFailed;
            totalPendingReplaced += syncResult.pendingReplaced;
            totalPendingVanished += syncResult.pendingVanished;
            totalPendingFlagged += syncResult.pendingFlagged;
            totalBalanceAdjustments += syncResult.balanceAdjustments;
            if (syncResult.rebalanceSkipped) totalRebalancesSkipped++;
          });
        } catch (error) {
          this.logger.error({ ...rowErrorFields(error), importAccountId: sfAccount.id }, 'Error syncing account');
          failedAccounts.push({
            id: sfAccount.id,
            name: sfAccount.name,
            error: publicErrorMessage(error, 'This account failed to sync')
          });
          // Continue with other accounts
        }
      }

      // Determine sync status and error message
      const totalAccounts = accountSet.accounts.length;
      let syncStatus: 'completed' | 'partial' | 'failed';
      const problems: string[] = [];

      if (failedAccounts.length === 0) {
        syncStatus = 'completed';
      } else if (failedAccounts.length === totalAccounts) {
        syncStatus = 'failed';
        problems.push(`All ${failedAccounts.length} accounts failed to sync`);
      } else {
        syncStatus = 'partial';
        problems.push(`${failedAccounts.length} of ${totalAccounts} accounts failed: ${failedAccounts.map(a => a.name || a.id).join(', ')}`);
      }
      // Rows that couldn't be saved were skipped, and the rest of their account saved.
      if (totalTransactionsFailed > 0) {
        if (syncStatus === 'completed') syncStatus = 'partial';
        problems.push(failedTransactionsMessage(totalTransactionsFailed));
      }
      if (totalRebalancesSkipped > 0) problems.push(rebalanceSkippedMessage(totalRebalancesSkipped));
      // Possible double counts a member should look at; everything was saved.
      if (totalPendingFlagged > 0) problems.push(flaggedPendingMessage(totalPendingFlagged));
      const errorMessage = problems.length > 0 ? problems.join('; ') : null;

      // Log comprehensive sync summary
      this.logger.info({
        totalAccounts,
        accountsSynced: totalAccountsSynced,
        accountsFailed: failedAccounts.length,
        syncStatus,
        transactionsImported: totalTransactionsImported,
        transactionsUpdated: totalTransactionsUpdated,
        transactionsFailed: totalTransactionsFailed,
        pendingReplaced: totalPendingReplaced,
        pendingVanished: totalPendingVanished,
        pendingFlagged: totalPendingFlagged,
        balanceAdjustments: totalBalanceAdjustments,
        rebalancesSkipped: totalRebalancesSkipped,
        skippedInstitutionsCount: syncStats.skippedInstitutions.length,
        skippedUnlinkedAccountsCount: syncStats.skippedUnlinkedAccounts.length,
        accountsWithNoTransactionsCount: syncStats.accountsWithNoTransactions.length,
        balanceHistoryConflicts: syncStats.balanceHistoryConflicts,
        reconciledTransactionsSkipped: syncStats.reconciledTransactionsSkipped
      }, 'Full sync completed with status');

      // Log detailed breakdowns if there are skipped items
      if (syncStats.skippedInstitutions.length > 0) {
        this.logger.warn({
          count: syncStats.skippedInstitutions.length,
          domains: syncStats.skippedInstitutions.map((institution) => institution.domain)
        }, '⚠️ Institutions skipped (not found in database - must be created manually)');
      }

      if (syncStats.skippedUnlinkedAccounts.length > 0) {
        this.logger.warn({
          count: syncStats.skippedUnlinkedAccounts.length,
          importAccountIds: syncStats.skippedUnlinkedAccounts.map((account) => account.id)
        }, '⚠️ Accounts skipped (not linked to Nuggets accounts)');
      }

      if (syncStats.accountsWithNoTransactions.length > 0) {
        this.logger.info({
          count: syncStats.accountsWithNoTransactions.length,
          importAccountIds: syncStats.accountsWithNoTransactions.map((account) => account.id)
        }, 'ℹ️ Accounts with no transactions from SimpleFin');
      }

      if (syncStats.balanceHistoryConflicts > 0) {
        this.logger.info({
          count: syncStats.balanceHistoryConflicts
        }, 'ℹ️ Balance history records skipped (already exist for date)');
      }

      if (syncStats.reconciledTransactionsSkipped > 0) {
        this.logger.info({
          count: syncStats.reconciledTransactionsSkipped
        }, 'ℹ️ Reconciled transactions skipped (locked from updates)');
      }

      await inTenant(async () => {
      // Persist per-account connection health from the v2 errlist.
      await this.accounts.persistConnectionHealth(accountSet);

      // Update sync log with results
      await getDb()
        .updateTable('import_sync_log')
        .set({
          sync_status: syncStatus,
          sync_end_time: new Date(),
          accounts_synced: totalAccountsSynced,
          transactions_imported: totalTransactionsImported,
          transactions_updated: totalTransactionsUpdated,
          balance_adjustments_created: totalBalanceAdjustments,
          records_processed: totalAccounts,
          error_message: errorMessage
        })
        .where('id', '=', logId!)
        .execute();

      // CRITICAL FIX: Trigger comprehensive net worth calculation after successful sync
      if (totalAccountsSynced > 0 || totalTransactionsImported > 0 || totalTransactionsUpdated > 0 || totalBalanceAdjustments > 0) {
        this.logger.info('📊 Triggering net worth snapshot after successful import sync');
        try {
          await this.periods.savepoint(async () => {
            const NetWorthService = (await import('./NetWorthService.js')).default;
            const netWorthService = new NetWorthService();

            const snapshot = await netWorthService.createSnapshotIfNeeded('transaction');

            if (snapshot) {
              this.logger.info({ snapshotId: snapshot.id, accountCount: snapshot.account_count }, '✅ Net worth snapshot created');
            } else {
              this.logger.info('ℹ️  Net worth snapshot already exists for today');
            }
          });
        } catch (netWorthError) {
          this.logger.error({ err: netWorthError }, '❌ Failed to create net worth snapshot after import');
          // Don't fail the entire sync for net worth calculation errors
          // Log this for manual intervention if needed
        }
      }
      });

      // Stamp last_synced_at on the org connection driving this tenant's sync,
      // so the org admin's connection view reflects sync activity. In a
      // short organization transaction of its own, after the ledger's: inside it, a
      // failure here would abort the ledger's work, and the ledgers of one organization
      // would wait on each other for the connection's row.
      try {
        const connection = await getConnectionForTenant(tenantId);
        if (connection) await markSynced(connection.organization_id, connection.id);
      } catch (err) {
        this.logger.warn({ err, tenantId }, 'Could not stamp SimpleFin connection last_synced_at');
      }

      return { status: syncStatus as FullSyncOutcome['status'], message: errorMessage };
    } catch (error) {
      // Update sync log with error
      if (logId) {
        const failedLogId = logId;
        await inTenant(() => getDb()
          .updateTable('import_sync_log')
          .set({
            sync_status: 'failed',
            sync_end_time: new Date(),
            error_message: publicErrorMessage(error, SYNC_FAILED_REASON)
          })
          .where('id', '=', failedLogId)
          .execute());
      }

      this.logger.error({ ...rowErrorFields(error), logId }, 'Full sync failed');
      throw error;
    }
    });
  }
}
