import { sql } from 'kysely';
import { getDb, withSavepoint } from '../db/withTenant.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ service: 'AccountBalanceService' });

// pg returns numeric as a string; coerce at the row→domain boundary.
const toNum = (v: string | number | null | undefined): number =>
    (v == null ? 0 : typeof v === 'number' ? v : parseFloat(v)) || 0;

/** One point of an account's balance history: the balance at the end of `balance_date`. */
export interface BalanceHistoryPoint {
    account_id: number;
    /** The calendar day (YYYY-MM-DD) the balance is taken at the end of. */
    balance_date: string;
    balance: number;
}

/**
 * Account balances.
 *
 * There is one definition of an account balance: SUM(amount) of the account's
 * transactions with `parent_transaction_id IS NULL` (amounts are pre-signed; a
 * split parent carries the money). The opening balance is an ordinary
 * 'starting balance' transaction. The definition lives in the SQL functions
 * `calculate_account_balance_as_of(account_id, date)` and
 * `calculate_account_balance(account_id)`, the balance as of app_today(), so a
 * transaction dated after today counts from its date. Both are SECURITY
 * INVOKER, so RLS scopes them to the active tenant, and every reader goes through them.
 *
 * Nothing is cached or snapshotted: a balance is one indexed aggregate, and a
 * list of balances is one query. Every query runs on the caller's tenant
 * transaction via getDb(), so the service holds no state and takes no pool: use
 * the shared {@link accountBalanceService}. Reads never write.
 */
class AccountBalanceService {

    /** The current balance of one account. Throws if it can't be computed. */
    async getBalance(accountId: number): Promise<number> {
        const result = await sql<{ balance: string }>`
            SELECT calculate_account_balance(${accountId}) AS balance
        `.execute(getDb());
        return toNum(result.rows[0]?.balance);
    }

    /**
     * Current balances for many accounts in one query. Every requested id is in
     * the map (an account the tenant can't see, or with no transactions, is 0).
     * Throws if the query fails; callers show the balances as unavailable.
     */
    async getBalances(accountIds: number[]): Promise<Map<number, number>> {
        const balances = new Map<number, number>();
        if (accountIds.length === 0) return balances;
        const ids = [...new Set(accountIds)];
        const result = await sql<{ account_id: number; balance: string }>`
            SELECT u.account_id, calculate_account_balance(u.account_id) AS balance
              FROM UNNEST(${ids}::int[]) AS u(account_id)
        `.execute(getDb());
        for (const row of result.rows) {
            balances.set(row.account_id, toNum(row.balance));
        }
        return balances;
    }

    /**
     * Balances for many accounts, or null when they couldn't be computed (the
     * caller renders "unavailable", never $0). Runs in a savepoint so a database
     * error doesn't abort the request's transaction.
     */
    async tryGetBalances(accountIds: number[]): Promise<Map<number, number> | null> {
        try {
            return await withSavepoint(() => this.getBalances(accountIds));
        } catch (err) {
            logger.error({ err, accountCount: accountIds.length }, 'Failed to compute account balances');
            return null;
        }
    }

    /** One account's balance, or null when it couldn't be computed. */
    async tryGetBalance(accountId: number): Promise<number | null> {
        try {
            return await withSavepoint(() => this.getBalance(accountId));
        } catch (err) {
            logger.error({ err, accountId }, 'Failed to compute account balance');
            return null;
        }
    }

    /**
     * Month-end balance history, newest first: the current balance (as of today)
     * followed by the balance at the end of each of the previous `limit - 1`
     * months. Computed from the transactions, so it always agrees with the
     * current balance.
     */
    async getBalanceHistory(accountId: number, limit: number = 12): Promise<BalanceHistoryPoint[]> {
        const points = Math.min(Math.max(Math.trunc(limit) || 12, 1), 120);
        // calculate_account_balance_as_of at each date, from one pass over the
        // account's transactions (account_balances_as_of).
        const result = await sql<{ balance_date: string; balance: string }>`
            WITH d AS (
                SELECT CASE WHEN g.n = 0 THEN app_today()
                            ELSE (date_trunc('month', app_today()) - make_interval(months => g.n - 1))::date - 1
                       END AS balance_date
                  FROM generate_series(0, ${points - 1}) AS g(n)
            )
            SELECT d.balance_date::text AS balance_date, b.balance
              FROM d
              JOIN account_balances_as_of(ARRAY[${accountId}]::int[], ARRAY(SELECT d.balance_date FROM d)) b
                ON b.as_of = d.balance_date
             ORDER BY d.balance_date DESC
        `.execute(getDb());
        return result.rows.map((row) => ({
            account_id: accountId,
            balance_date: row.balance_date,
            balance: toNum(row.balance),
        }));
    }

    /**
     * Record today's net-worth snapshot after a write that changed balances.
     * Only write paths call this, never a GET. Call it last in a transaction: it holds
     * today's snapshot row until the transaction ends, and a transaction takes the rows of
     * the accounts it locks (Adjust Balance, the SimpleFin rebalance) before that one.
     */
    async triggerNetWorthSnapshot(): Promise<void> {
        try {
            // A savepoint, so a failure here doesn't abort the caller's transaction.
            await withSavepoint(async () => {
                // Imported locally to avoid a circular dependency.
                const NetWorthService = (await import('./NetWorthService.js')).default;
                const netWorthService = new NetWorthService();
                await netWorthService.createSnapshotIfNeeded('transaction');
            });
        } catch (error) {
            // Log, but don't fail the write that triggered it.
            logger.error({ err: error }, 'Failed to trigger net worth snapshot');
        }
    }
}

/** The one instance every caller uses: the service has no state of its own. */
export const accountBalanceService = new AccountBalanceService();

export default AccountBalanceService;
