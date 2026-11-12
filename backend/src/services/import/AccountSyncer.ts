/**
 * Syncing one SimpleFin account into the ledger, inside that account's tenant
 * transaction: its institution, the linked account's import fields, its currency and
 * balance history, its transactions (TransactionImporter), and the auto-rebalance. Only
 * accounts a member linked are written; institutions and accounts are never created.
 */
import { sql } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import { appToday } from '../../utils/appDate.js';
import { createLogger } from '../../utils/logger.js';
import { rowErrorFields } from '../../utils/logSafeErrors.js';
import type { SimpleFinConnection } from '@nuggets/shared';
import type { BudgetPeriodResolver } from './BudgetPeriodResolver.js';
import type { SyncStats, TransactionImporter } from './TransactionImporter.js';
import type { ResolvedInstitution, SimplefinAccount, SimplefinAccountSet } from './types.js';
import { NO_UNSAVED_ROWS, type UnsavedRows } from './unsavedRows.js';

/** What syncing one account did. */
export interface AccountSyncResult {
  transactionsImported: number;
  transactionsUpdated: number;
  /** Transactions that couldn't be saved (logged one by one); the others were. */
  transactionsFailed: number;
  /** Pending rows updated in place by their posted transaction, which came with a new id. */
  pendingReplaced: number;
  /** Pending rows whose id left the feed with no posted transaction safely matched to them. */
  pendingVanished: number;
  /** …of which this sync flagged for review (the others were flagged by an earlier one). */
  pendingFlagged: number;
  balanceAdjustments: number;
  /**
   * The account's balance follows the bank's (import_account_rebalance), and wasn't compared
   * with it this sync: what some transactions that couldn't be saved change can't be told
   * (unsavedRows.ts).
   */
  rebalanceSkipped: boolean;
}

export class AccountSyncer {
  private logger = createLogger({ service: 'ImportService' });

  constructor(
    private readonly periods: BudgetPeriodResolver,
    private readonly transactions: TransactionImporter,
  ) {}

  /** `feedStart`: the start-date SimpleFin was asked for (null: all history), for unsavedRows.ts. */
  async syncAccount(
    sfAccount: SimplefinAccount,
    connections: SimpleFinConnection[],
    syncStats?: SyncStats,
    feedStart: Date | null = null,
  ): Promise<AccountSyncResult> {
    // Counts and ids only: every transaction's amount and description, and the account's
    // balance, went to the log on every sync. Nor the account's name:
    // `importAccountId` is SimpleFin's id for it, `accountId` the ledger's.
    this.logger.info({
      importAccountId: sfAccount.id,
      transactionCount: sfAccount.transactions?.length || 0,
      pendingCount: sfAccount.transactions?.filter((tx) => tx.pending).length || 0,
    }, 'Starting account sync');

    try {
      // 1. Upsert institution (v2: resolve via conn_id → connections; v1 fallback: org)
      const institutionId = await this.upsertInstitution(this.resolveInstitution(sfAccount, connections), syncStats);

      // 2. Upsert account - returns null if account not linked by user
      const accountId = await this.upsertAccount(sfAccount, institutionId, syncStats);

      // If account is not linked by user, skip all sync operations
      if (accountId === null) {
        return {
          transactionsImported: 0,
          transactionsUpdated: 0,
          transactionsFailed: 0,
          pendingReplaced: 0,
          pendingVanished: 0,
          pendingFlagged: 0,
          balanceAdjustments: 0,
          rebalanceSkipped: false
        };
      }
      
      // 3. Handle currency
      await this.upsertAccountCurrency(accountId, sfAccount.currency);

      // 4. Save balance history
      const balanceHistoryResult = await this.saveBalanceHistory(accountId, sfAccount);
      if (syncStats && balanceHistoryResult.conflict) {
        syncStats.balanceHistoryConflicts++;
      }

      // Today's budget period, for a balance adjustment (step 6): found or made now, before the
      // import locks any transaction (BudgetPeriodResolver.preparePeriods). Made
      // after, it waited for a merge that was waiting for one of those transactions.
      const importBalance = parseFloat(sfAccount.balance);
      const currentBudgetPeriodId = isNaN(importBalance) ? null : await this.periods.findBudgetPeriodForDate(await appToday(), { create: 'wait' });

      // 5. Import transactions
      let transactionsImported = 0;
      let transactionsUpdated = 0;
      let transactionsFailed = 0;
      let pendingReplaced = 0;
      let pendingVanished = 0;
      let pendingFlagged = 0;
      let unsaved: UnsavedRows = NO_UNSAVED_ROWS;

      this.logger.info({
        importAccountId: sfAccount.id,
        accountId,
        hasTransactions: !!sfAccount.transactions,
        transactionCount: sfAccount.transactions?.length || 0
      }, 'Checking for transactions to import');

      if (sfAccount.transactions && sfAccount.transactions.length > 0) {
        const txResult = await this.transactions.importTransactions(accountId, sfAccount.transactions, syncStats, feedStart);
        transactionsImported = txResult.imported;
        transactionsUpdated = txResult.updated;
        transactionsFailed = txResult.failed;
        pendingReplaced = txResult.pendingReplaced;
        pendingVanished = txResult.pendingVanished;
        pendingFlagged = txResult.pendingFlagged;
        unsaved = txResult.unsaved;

      } else {
        this.logger.info({
          importAccountId: sfAccount.id,
          accountId,
          hasTransactions: !!sfAccount.transactions,
        }, 'Account has no transactions from SimpleFin');

        // Track account with no transactions
        if (syncStats) {
          syncStats.accountsWithNoTransactions.push({ id: sfAccount.id, name: sfAccount.name });
        }
      }
      
      // 6. Handle balance rebalancing if enabled. SimpleFin's `balance` is the posted
      // balance; the rebalance compares it with the ledger's balance less the rows still
      // pending at the bank (calculateBankComparableBalance).
      //
      // A row that couldn't be saved stays out of both balances (unsavedRows.ts): the
      // bank's counts it and the ledger's doesn't, so the adjustment would book its amount,
      // and the sync that saves the row would count it a second time. Only when what such a
      // row changes can't be told (its amount can't be read, it has no date and may be a manual
      // entry, or the entry it would be linked to is dated after today) are the balances not
      // compared; the sync log says so.
      let balanceAdjustments = 0;
      let rebalanceSkipped = false;
      if (!isNaN(importBalance) && unsaved.undecidable) {
        rebalanceSkipped = await this.followsBankBalance(accountId);
        if (rebalanceSkipped) {
          this.logger.warn({ accountId, transactionsFailed }, 'Balance not compared with the bank: what some of the transactions that could not be imported change cannot be told');
        }
      } else if (!isNaN(importBalance)) {
        const { BalanceRebalanceService } = await import('../BalanceRebalanceService.js');
        const rebalanceService = new BalanceRebalanceService();

        // The adjustment goes in today's budget period, found before the import (above).
        if (await rebalanceService.checkAndRebalanceAccount(accountId, importBalance, currentBudgetPeriodId, unsaved)) {
          balanceAdjustments = 1;
        }
      }

      // 7. Today's net worth, once and last: after the import and the rebalance, when
      // either changed a balance, or for an account with a balance and no transactions
      // (balances themselves are computed on read). Last because it holds today's
      // snapshot row until this transaction ends, and every transaction takes an account's
      // row before that one (upsertAccount locks it first here; Adjust Balance does too): a
      // transaction holding the snapshot row while it waits for an account's waits for an
      // Adjust Balance that is waiting for it.
      const noTransactionsWithBalance =
        (!sfAccount.transactions || sfAccount.transactions.length === 0) && !isNaN(importBalance) && importBalance !== 0;
      if (transactionsImported > 0 || transactionsUpdated > 0 || balanceAdjustments > 0 || noTransactionsWithBalance) {
        const { accountBalanceService } = await import('../AccountBalanceService.js');
        // A savepoint of its own, which logs a failure instead of failing the sync.
        await accountBalanceService.triggerNetWorthSnapshot();
        this.logger.info({ accountId, transactionsImported, transactionsUpdated, balanceAdjustments }, 'Net worth updated after the account sync');
      }
      
      // 8. Update account sync timestamp
      await getDb()
        .updateTable('accounts')
        .set({ import_last_sync: sql<Date>`CURRENT_TIMESTAMP` })
        .where('id', '=', accountId)
        .execute();
      
      return {
        transactionsImported,
        transactionsUpdated,
        transactionsFailed,
        pendingReplaced,
        pendingVanished,
        pendingFlagged,
        balanceAdjustments,
        rebalanceSkipped
      };

    } catch (error) {
      this.logger.error({ ...rowErrorFields(error), importAccountId: sfAccount.id }, 'Error syncing account');
      throw error;
    }
  }

  /** Whether the account's balance follows the bank's: the rebalance would compare them. */
  private async followsBankBalance(accountId: number): Promise<boolean> {
    const account = await getDb()
      .selectFrom('accounts')
      .select('import_account_rebalance')
      .where('id', '=', accountId)
      .executeTakeFirst();
    return account?.import_account_rebalance === true;
  }

  /** Hostname from a URL or bare domain (for the stable institution key). */
  private hostFromUrl(u?: string): string | undefined {
    if (!u) return undefined;
    try {
      return new URL(u.includes('://') ? u : `https://${u}`).hostname;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve an account's institution to a normalized descriptor: join `account.conn_id` →
   * the AccountSet's `connections[]` (v2; every request asks for version 2). The deprecated
   * per-account `org` (v1) isn't read here: an account with no matching connection is left
   * unlinked, as it always was, rather than linked to an institution keyed another way. The
   * institution domain (host of org_url) is the stable key, since conn_id/org_id are only
   * unique per server.
   */
  private resolveInstitution(sfAccount: SimplefinAccount, connections: SimpleFinConnection[]): ResolvedInstitution {
    if (sfAccount.conn_id) {
      const conn = connections.find((c) => c.conn_id === sfAccount.conn_id) as
        | (SimpleFinConnection & { org_name?: string })
        | undefined;
      if (conn) {
        const host = this.hostFromUrl(conn.org_url) ?? this.hostFromUrl(conn.sfin_url);
        return {
          domain: host ?? conn.org_id,
          name: conn.org_name ?? sfAccount.conn_name ?? conn.name,
          'sfin-url': conn.sfin_url,
          ...(conn.org_url !== undefined && { url: conn.org_url }),
          id: conn.org_id,
        };
      }
    }
    // No connection match → leave unresolved. upsertInstitution skips (no link),
    // and the upsertAccount guard never nulls an existing link.
    return {};
  }

  /**
   * Persist each account's latest connection error from the v2 errlist so
   * connection health (dashboard card + status pill) is readable without a live
   * pull. Connection-level (con.*) errors also hit accounts not present in this
   * response (a fully-broken connection may return none), matched by the stored
   * SimpleFIN conn_id in import_extra. Accounts present with no error are cleared.
   */
  async persistConnectionHealth(accountSet: SimplefinAccountSet): Promise<void> {
    const errlist = accountSet.errlist ?? [];
    const actByAccount = new Map<string, string>();
    const conByConn = new Map<string, string>();
    for (const e of errlist) {
      if (e.account_id) actByAccount.set(e.account_id, e.code);
      else if (e.conn_id) conByConn.set(e.conn_id, e.code);
    }
    const db = getDb();

    // Every account written below, locked first, in id order, as a zone change and
    // every other write of several accounts lock them: written in the feed's order, they could
    // hold one another write waited for while they waited for one it held.
    const feedIds = accountSet.accounts.map((acc) => acc.id);
    const connIds = [...conByConn.keys()];
    if (feedIds.length > 0 || connIds.length > 0) {
      await db
        .selectFrom('accounts')
        .select('id')
        .where('import_provider', '=', 'simplefin')
        .where((eb) => eb.or([
          ...(feedIds.length > 0 ? [eb('import_account_id', 'in', feedIds)] : []),
          ...(connIds.length > 0 ? [sql<boolean>`import_extra->>'conn_id' = ANY(${connIds}::text[])`] : []),
        ]))
        .orderBy('id')
        .forNoKeyUpdate()
        .execute();
    }

    // Accounts present in this response: set (or clear) their latest error.
    for (const acc of accountSet.accounts) {
      const code =
        (acc.conn_id ? conByConn.get(acc.conn_id) : undefined) ?? actByAccount.get(acc.id) ?? null;
      await db
        .updateTable('accounts')
        .set({
          import_last_error_code: code,
          import_last_error_at: code ? sql<Date>`CURRENT_TIMESTAMP` : null,
        })
        .where('import_account_id', '=', acc.id)
        .where('import_provider', '=', 'simplefin')
        .execute();
    }

    // Connection-level errors also affect accounts absent from this response.
    for (const [connId, code] of conByConn) {
      await db
        .updateTable('accounts')
        .set({ import_last_error_code: code, import_last_error_at: sql<Date>`CURRENT_TIMESTAMP` })
        .where('import_provider', '=', 'simplefin')
        .where(sql<boolean>`import_extra->>'conn_id' = ${connId}`)
        .execute();
    }
  }

  private async upsertInstitution(org: ResolvedInstitution, syncStats?: SyncStats): Promise<number | null> {
    const domain = org.domain || org.name || 'Unknown Institution';

    // Check if institution exists
    const existing = await getDb()
      .selectFrom('account_institutions')
      .select('id')
      .where('import_domain', '=', domain)
      .executeTakeFirst();

    if (existing) {
      // Update existing institution
      await getDb()
        .updateTable('account_institutions')
        .set({
          name: sql<string>`COALESCE(NULLIF(name, ''), ${org.name ?? null})`,
          import_url: org['sfin-url'] ?? null,
          import_org_id: org.id ?? null,
          import_org_url: org.url ?? null,
          is_import_enabled: true,
          import_last_sync: sql<Date>`CURRENT_TIMESTAMP`
        })
        .where('id', '=', existing.id)
        .execute();

      return existing.id;
    } else {
      // DO NOT create new institution automatically
      // Let users manually create and associate institutions
      this.logger.info({ domain, importOrgId: org.id }, 'Institution not found - skipping auto-creation. User must manually create institution');

      // Track skipped institution
      if (syncStats) {
        syncStats.skippedInstitutions.push({ domain, ...(org.name !== undefined && { orgName: org.name }) });
      }

      return null;
    }
  }

  private async upsertAccount(sfAccount: SimplefinAccount, institutionId: number | null, syncStats?: SyncStats): Promise<number | null> {
    // Check if account exists - only sync accounts that have been explicitly linked by user.
    // Its row is locked here, at the start of the account's transaction, until the
    // transaction ends (the update below would lock it too, a few statements later): the
    // rebalance reads the balance under that lock, and the lock order is the account's
    // row, then today's net-worth snapshot row (taken last, in syncAccount), as Adjust
    // Balance takes them.
    const existing = await getDb()
      .selectFrom('accounts')
      .select(['id', 'import_enabled'])
      .where('import_account_id', '=', sfAccount.id)
      .where('import_provider', '=', 'simplefin')
      .forNoKeyUpdate()
      .executeTakeFirst();

    this.logger.info({
      importAccountId: sfAccount.id,
      foundInDb: !!existing,
      accountId: existing?.id,
      importEnabled: existing?.import_enabled
    }, 'Account lookup result');

    if (existing) {
      // Update existing linked account
      const balance = parseFloat(sfAccount.balance) || 0;
      const availableBalance = sfAccount['available-balance'] ? parseFloat(sfAccount['available-balance']) : null;
      const balanceDate = new Date(sfAccount['balance-date'] * 1000);

      // Debug logging to see what SimpleFin is sending
      // Account balance processed

      await getDb()
        .updateTable('accounts')
        .set({
          name: sql<string>`COALESCE(NULLIF(name, ''), ${sfAccount.name})`,
          // Only (re)link the institution when we resolved one. Never overwrite an
          // existing account's institution with null on a resolution miss — this
          // keeps already-linked accounts safe across the v1→v2 key change.
          ...(institutionId !== null ? { institution_id: institutionId } : {}),
          import_balance: balance,
          import_available_balance: availableBalance,
          import_balance_date: balanceDate,
          import_enabled: true,
          import_currency: sfAccount.currency,
          // Persist the SimpleFIN v2 connection id/name alongside server `extra`
          // so connection-health + dedup (two logins at one bank) can use it.
          import_extra: JSON.stringify({
            ...(sfAccount.extra || {}),
            ...(sfAccount.conn_id ? { conn_id: sfAccount.conn_id } : {}),
            ...(sfAccount.conn_name ? { conn_name: sfAccount.conn_name } : {}),
          }),
          import_last_sync: sql<Date>`CURRENT_TIMESTAMP`
        })
        .where('id', '=', existing.id)
        .execute();

      return existing.id;
    } else {
      // Account not linked by user - skip importing
      this.logger.info({ importAccountId: sfAccount.id }, 'Skipping unlinked account - not linked by user');

      // Track skipped unlinked account
      if (syncStats) {
        syncStats.skippedUnlinkedAccounts.push({ id: sfAccount.id, name: sfAccount.name });
      }

      return null;
    }
  }

  private async upsertAccountCurrency(accountId: number, currency: string): Promise<void> {
    const isCustomCurrency = currency.startsWith('http');
    
    // Check if currency record exists
    const existing = await getDb()
      .selectFrom('account_currencies')
      .select('id')
      .where('account_id', '=', accountId)
      .executeTakeFirst();

    if (isCustomCurrency) {
      // Handle custom currency (like airline miles)
      // For now, create a basic record - could enhance to fetch currency details
      const currencyData = {
        currency_type: 'custom',
        currency_url: currency,
        currency_name: 'Custom Currency',
        currency_abbr: 'CUSTOM'
      };

      if (existing) {
        await getDb()
          .updateTable('account_currencies')
          .set({
            currency_type: currencyData.currency_type,
            currency_url: currencyData.currency_url,
            currency_name: currencyData.currency_name,
            currency_abbr: currencyData.currency_abbr,
            updated_at: sql<Date>`CURRENT_TIMESTAMP`
          })
          .where('account_id', '=', accountId)
          .execute();
      } else {
        await getDb()
          .insertInto('account_currencies')
          .values({
            account_id: accountId,
            currency_type: currencyData.currency_type,
            currency_url: currencyData.currency_url,
            currency_name: currencyData.currency_name,
            currency_abbr: currencyData.currency_abbr
          })
          .execute();
      }
    } else {
      // Standard currency (USD, EUR, etc.)
      const currencyData = {
        currency_type: 'standard',
        currency_code: currency,
        currency_name: this.getCurrencyName(currency),
        currency_abbr: currency
      };

      if (existing) {
        await getDb()
          .updateTable('account_currencies')
          .set({
            currency_type: currencyData.currency_type,
            currency_code: currencyData.currency_code,
            currency_name: currencyData.currency_name,
            currency_abbr: currencyData.currency_abbr,
            updated_at: sql<Date>`CURRENT_TIMESTAMP`
          })
          .where('account_id', '=', accountId)
          .execute();
      } else {
        await getDb()
          .insertInto('account_currencies')
          .values({
            account_id: accountId,
            currency_type: currencyData.currency_type,
            currency_code: currencyData.currency_code,
            currency_name: currencyData.currency_name,
            currency_abbr: currencyData.currency_abbr
          })
          .execute();
      }
    }
  }

  private getCurrencyName(currencyCode: string): string {
    const currencyNames: { [key: string]: string } = {
      'USD': 'US Dollar',
      'EUR': 'Euro',
      'GBP': 'British Pound',
      'CAD': 'Canadian Dollar',
      'AUD': 'Australian Dollar',
      'JPY': 'Japanese Yen',
      'CHF': 'Swiss Franc',
      'CNY': 'Chinese Yuan'
    };
    
    return currencyNames[currencyCode] || currencyCode;
  }

  private async saveBalanceHistory(accountId: number, sfAccount: SimplefinAccount): Promise<{ conflict: boolean }> {
    const balance = parseFloat(sfAccount.balance) || 0;
    const availableBalance = sfAccount['available-balance'] ? parseFloat(sfAccount['available-balance']) : null;
    const balanceDate = new Date(sfAccount['balance-date'] * 1000);

    // Insert balance history (ON CONFLICT DO NOTHING due to unique constraint)
    // Check if the row was actually inserted to detect conflicts
    const inserted = await getDb()
      .insertInto('account_imported_balance_history')
      .values({
        account_id: accountId,
        balance_date: balanceDate,
        balance,
        available_balance: availableBalance,
        import_extra: JSON.stringify(sfAccount.extra || {})
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'account_id', 'balance_date']).doNothing())
      .returning('id')
      .executeTakeFirst();

    // If no rows returned, it was a conflict (already existed)
    return { conflict: !inserted };
  }
}
