import { sql, type Selectable } from 'kysely';
import { getDb, withSavepoint } from '../db/withTenant.js';
import type { DB } from '../db/schema.generated.js';
import { createLogger } from '../utils/logger.js';
import { addDays, daysBetween } from '../utils/calendarDate.js';
import { appToday } from '../utils/appDate.js';
import { numericToCents, centsToAmount } from '../utils/money.js';
import { DomainError, defaultErrorCode } from './domainErrors.js';
import { oneRow } from '../utils/present.js';

const logger = createLogger({ service: 'NetWorthService' });

/** A net-worth request refused: answered with its status, `{ error: heading, code, message }`. */
export class NetWorthError extends DomainError {
  constructor(status: 400, heading: string, message: string) {
    super(status, defaultErrorCode(status), message, {}, { heading });
  }
}

/** What rebuilding the history did: its daily snapshots, and the weekly and monthly ones made from them. */
export interface NetWorthRebuild {
  startDate: string;
  endDate: string;
  totalDays: number;
  snapshotsCreated: number;
  /** Absent when aggregating the daily snapshots failed (they are kept). */
  aggregates?: { weekly: number; monthly: number };
}

/** The most daily snapshots one upsert writes, to keep the bound parameter count reasonable on a long history. */
const SNAPSHOT_CHUNK = 1000;

/**
 * Net Worth Tracking Service
 *
 * Provides high-performance net worth calculations and historical tracking using:
 * - Event-driven snapshot creation (sparse storage)
 * - Multi-level aggregation (daily -> weekly -> monthly -> yearly)
 * - Smart caching for different time ranges
 * - Gap-filling for smooth chart visualization
 */

export interface NetWorthSnapshot {
    id: number;
    uuid: string;
    /** Calendar date, 'YYYY-MM-DD'. */
    snapshot_date: string;
    total_assets: number;
    total_liabilities: number;
    net_worth: number;
    /** null for a stored snapshot without one (the column is nullable). */
    account_count: number | null;
    active_account_count: number;
    snapshot_trigger: 'transaction' | 'manual' | 'scheduled' | 'aggregation';
    aggregation_level: 'daily' | 'weekly' | 'monthly' | 'yearly';
    source_snapshot_count: number;
    calculation_method: 'event_driven' | 'scheduled' | 'aggregated';
    is_interpolated?: boolean;
    created_at: Date;
    updated_at: Date;
}

/** Today's net worth, computed now (GET /api/net-worth/current). */
export interface CurrentNetWorth {
    /** Today in the application time zone, 'YYYY-MM-DD'. */
    snapshot_date: string;
    total_assets: number;
    total_liabilities: number;
    net_worth: number;
    account_count: number;
    active_account_count: number;
}

// Every query runs on the caller's tenant transaction via getDb(), so the service takes no pool.
class NetWorthService {

    /**
     * Create or update a net worth snapshot for today
     * Called automatically when transactions are added/modified
     */
    async createSnapshotIfNeeded(
        trigger: 'transaction' | 'manual' | 'scheduled' = 'transaction'
    ): Promise<NetWorthSnapshot | null> {
        try {
            const result = await sql<{ snapshot_uuid: string | null }>`
                SELECT create_net_worth_snapshot(
                    app_today(),
                    ${trigger},
                    'daily'
                ) as snapshot_uuid
            `.execute(getDb());

            const snapshotUuid = result.rows[0]?.snapshot_uuid;
            if (snapshotUuid) {
                return await this.getSnapshotByUuid(snapshotUuid);
            }

            return null;
        } catch (error) {
            logger.error({ err: error, trigger }, 'Error creating net worth snapshot');
            throw error;
        }
    }

    /**
     * Get net worth history for charting with optimal performance
     */
    async getNetWorthHistory(
        period: 'day' | 'week' | 'month' | 'year' = 'month',
        limit: number = 30,
        fillGaps: boolean = true
    ): Promise<NetWorthSnapshot[]> {
        try {
            // Set-returning PL/pgSQL function — kept as raw sql.
            const result = await sql<{
                snapshot_date: string;
                total_assets: string;
                total_liabilities: string;
                net_worth: string;
                account_count: number | string | null;
                is_interpolated: boolean;
            }>`
                SELECT * FROM get_net_worth_history(${period}, ${limit}, ${fillGaps})
                ORDER BY snapshot_date DESC
            `.execute(getDb());

            return result.rows.map(row => ({
                id: 0, // Not returned by function
                uuid: '', // Not returned by function
                snapshot_date: row.snapshot_date,
                total_assets: parseFloat(row.total_assets),
                total_liabilities: parseFloat(row.total_liabilities),
                net_worth: parseFloat(row.net_worth),
                // A snapshot stored without a count has none: parseInt(String(null)) was NaN.
                account_count: row.account_count == null ? null : Number(row.account_count),
                active_account_count: 0,
                snapshot_trigger: 'aggregation' as const,
                aggregation_level: this.getOptimalLevel(period),
                source_snapshot_count: 0,
                calculation_method: 'aggregated' as const,
                is_interpolated: row.is_interpolated,
                created_at: new Date(),
                updated_at: new Date()
            }));
        } catch (error) {
            logger.error({ err: error, period }, 'Error fetching net worth history');
            throw error;
        }
    }

    /**
     * Aggregate daily snapshots into higher-level periods
     */
    async aggregateSnapshots(
        sourceLevel: 'daily' | 'weekly' | 'monthly',
        targetLevel: 'weekly' | 'monthly' | 'yearly',
        startDate?: string,
        endDate?: string
    ): Promise<number> {
        try {
            const result = await sql<{ aggregated_count: number | string | null }>`
                SELECT aggregate_net_worth_snapshots(
                    ${sourceLevel}, ${targetLevel}, ${startDate ?? null}::date, ${endDate ?? null}::date
                ) as aggregated_count
            `.execute(getDb());

            return Number(result.rows[0]?.aggregated_count ?? 0);
        } catch (error) {
            logger.error({ err: error, sourceLevel, targetLevel }, 'Error aggregating snapshots');
            throw error;
        }
    }

    /**
     * Today's net worth, computed now from the one definition (net_worth_as_of),
     * not read from the latest stored snapshot, which is as old as the last write that
     * recorded one. Reads only.
     */
    async getCurrentNetWorth(): Promise<CurrentNetWorth> {
        try {
            // Table-returning SQL function — kept as raw sql.
            const result = await sql<{
                snapshot_date: string;
                total_assets: string;
                total_liabilities: string;
                net_worth: string;
                account_count: number;
                active_account_count: number;
            }>`
                SELECT d.today::text AS snapshot_date, nw.*
                  FROM (SELECT app_today() AS today) d
                 CROSS JOIN LATERAL net_worth_as_of(d.today) nw
            `.execute(getDb());

            const row = oneRow(result.rows, 'net_worth_as_of');
            return {
                snapshot_date: row.snapshot_date,
                total_assets: parseFloat(row.total_assets),
                total_liabilities: parseFloat(row.total_liabilities),
                net_worth: parseFloat(row.net_worth),
                account_count: row.account_count,
                active_account_count: row.active_account_count,
            };
        } catch (error) {
            logger.error({ err: error }, 'Error computing current net worth');
            throw error;
        }
    }

    /** Deletes every net-worth snapshot of the ledger, at every aggregation level; answers how many. */
    async clearSnapshots(): Promise<number> {
        const result = await getDb().deleteFrom('net_worth_snapshots').executeTakeFirst();
        return Number(result.numDeletedRows);
    }

    /**
     * Rebuilds the ledger's daily net-worth history, from its earliest transaction to today
     * (400 when it has none), then the weekly and monthly aggregates over that range.
     *
     * In a single pass: two set-based queries up front, then each account's balance
     * carried forward day to day (the previous version re-summed every account's whole
     * history on every day). Each day is net_worth_as_of(day), which
     * create_net_worth_snapshot records: the accounts in net_worth_accounts (closed
     * ones included), each at its calculate_account_balance_as_of(day), the running sum of
     * its transactions' amounts whatever their status, with liabilities at minus their
     * balance. All sums are in whole cents, which add exactly.
     *
     * The aggregation runs in a savepoint: when it fails, the daily snapshots are kept (and
     * `aggregates` is absent). Caught without one, its error aborted the request's
     * transaction, so the answer said the snapshots were created and the commit then
     * discarded them.
     */
    async rebuildHistory(): Promise<NetWorthRebuild> {
        const earliestDateRow = await getDb()
            .selectFrom('transactions')
            .select((eb) => eb.fn.min('transaction_date').as('earliest_date'))
            .where('transaction_date', 'is not', null)
            .executeTakeFirst();
        const startDate = earliestDateRow?.earliest_date;
        if (!startDate) throw new NetWorthError(400, 'No transactions found', 'Cannot rebuild net worth history without transaction data');
        const endDate = await appToday();
        logger.info({ startDate, endDate }, 'Rebuilding net worth history from date range');

        // The accounts that count in net worth, and the day of each one's first transaction:
        // an account is counted in account_count from that day. A date column reads as its
        // 'YYYY-MM-DD' text (db/pgSession.ts), as the map keys are.
        const accountsMeta = await getDb()
          .selectFrom('net_worth_accounts as nwa')
          .innerJoin('transactions as t', 't.account_id', 'nwa.account_id')
          .select(['nwa.account_id as id', 'nwa.is_liability'])
          .select((eb) => eb.fn.min('t.transaction_date').as('first_txn'))
          .groupBy(['nwa.account_id', 'nwa.is_liability'])
          .execute();

        // Per-account, per-day balance deltas. parent_transaction_id IS NULL leaves out a
        // split's children, so a split transaction counts once, as
        // calculate_account_balance_as_of() counts it.
        const deltaRows = await getDb()
          .selectFrom('transactions')
          .select(['account_id', 'transaction_date'])
          .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('amount'), sql<string>`0`).as('delta'))
          .where('parent_transaction_id', 'is', null)
          .where('account_id', 'in', (eb) => eb.selectFrom('net_worth_accounts').select('account_id'))
          .groupBy(['account_id', 'transaction_date'])
          .execute();

        // The deltas by day, in cents.
        const deltasByDay = new Map<string, Array<{ accountId: number; delta: number }>>();
        for (const row of deltaRows) {
            const bucket = deltasByDay.get(row.transaction_date);
            const entry = { accountId: row.account_id, delta: numericToCents(row.delta) };
            if (bucket) bucket.push(entry);
            else deltasByDay.set(row.transaction_date, [entry]);
        }

        const isLiability = new Map<number, boolean>();
        const firstTxn = new Map<number, string>();
        for (const acct of accountsMeta) {
            // The view's columns read as nullable; an account's id and kind never are.
            if (acct.id === null || acct.is_liability === null) continue;
            isLiability.set(acct.id, acct.is_liability);
            firstTxn.set(acct.id, acct.first_txn);
        }
        const runningBalance = new Map<number, number>();

        // Each calendar day once, carrying balances forward; the rows are written in batches below.
        const snapshotRows: Array<{ dateStr: string; totalAssets: number; totalLiabilities: number; netWorth: number; accountCount: number }> = [];
        for (let dateStr = startDate; dateStr <= endDate; dateStr = addDays(dateStr, 1)) {
            for (const { accountId, delta } of deltasByDay.get(dateStr) ?? []) {
                runningBalance.set(accountId, (runningBalance.get(accountId) || 0) + delta);
            }

            // Amounts are pre-signed, so a liability owed is a negative balance: it adds minus
            // its balance to the liabilities, and an overpaid one lowers them.
            let totalAssets = 0;
            let totalLiabilities = 0;
            let accountCount = 0;
            for (const [accountId, liability] of isLiability) {
                const first = firstTxn.get(accountId);
                if (!first || first > dateStr) continue; // not active on this day yet
                accountCount++;
                const balance = runningBalance.get(accountId) || 0;
                if (liability) totalLiabilities -= balance;
                else totalAssets += balance;
            }
            snapshotRows.push({ dateStr, totalAssets, totalLiabilities, netWorth: totalAssets - totalLiabilities, accountCount });
        }

        // One multi-row upsert per chunk, with the conflict target, columns and constants
        // of a single snapshot, so a rebuild run again writes the same rows.
        for (let i = 0; i < snapshotRows.length; i += SNAPSHOT_CHUNK) {
            const chunk = snapshotRows.slice(i, i + SNAPSHOT_CHUNK);
            // Batched UNNEST upsert with ON CONFLICT DO UPDATE — kept as raw sql
            await sql`
              INSERT INTO net_worth_snapshots (
                snapshot_date,
                total_assets,
                total_liabilities,
                net_worth,
                account_count,
                active_account_count,
                snapshot_trigger,
                aggregation_level,
                calculation_method
              )
              SELECT
                d.snapshot_date::DATE,
                d.total_assets,
                d.total_liabilities,
                d.net_worth,
                d.account_count,
                d.account_count,
                'manual',
                'daily',
                'event_driven'
              FROM UNNEST(
                ${chunk.map((r) => r.dateStr)}::text[],
                ${chunk.map((r) => centsToAmount(r.totalAssets))}::numeric[],
                ${chunk.map((r) => centsToAmount(r.totalLiabilities))}::numeric[],
                ${chunk.map((r) => centsToAmount(r.netWorth))}::numeric[],
                ${chunk.map((r) => r.accountCount)}::int[]
              )
                AS d(snapshot_date, total_assets, total_liabilities, net_worth, account_count)
              ON CONFLICT (tenant_id, snapshot_date, aggregation_level) DO UPDATE SET
                total_assets = EXCLUDED.total_assets,
                total_liabilities = EXCLUDED.total_liabilities,
                net_worth = EXCLUDED.net_worth,
                account_count = EXCLUDED.account_count,
                active_account_count = EXCLUDED.active_account_count,
                updated_at = CURRENT_TIMESTAMP
            `.execute(getDb());
        }

        const rebuild: NetWorthRebuild = {
            startDate,
            endDate,
            totalDays: daysBetween(startDate, endDate) + 1,
            snapshotsCreated: snapshotRows.length,
        };
        logger.info({ snapshotsCreated: rebuild.snapshotsCreated, totalDays: rebuild.totalDays }, 'Successfully completed net worth history rebuild');

        // Weekly and monthly aggregates over the range (monthly directly from the daily
        // snapshots, for better coverage).
        try {
            const aggregates = await withSavepoint(async () => ({
                weekly: await this.aggregateSnapshots('daily', 'weekly', startDate, endDate),
                monthly: await this.aggregateSnapshots('daily', 'monthly', startDate, endDate),
            }));
            logger.info({ weeklyCount: aggregates.weekly, monthlyCount: aggregates.monthly }, 'Created weekly and monthly aggregates for historical range');
            return { ...rebuild, aggregates };
        } catch (aggregateError) {
            logger.warn({ err: aggregateError, snapshotsCreated: rebuild.snapshotsCreated }, 'Snapshots created but aggregation failed');
            return rebuild;
        }
    }

    // Private helper methods

    private async getSnapshotByUuid(uuid: string): Promise<NetWorthSnapshot | null> {
        const row = await getDb()
            .selectFrom('net_worth_snapshots')
            .selectAll()
            .where('uuid', '=', uuid)
            .executeTakeFirst();

        if (!row) {
            return null;
        }

        return this.mapRowToSnapshot(row);
    }

    private mapRowToSnapshot(row: Selectable<DB['net_worth_snapshots']>): NetWorthSnapshot {
        return {
            id: row.id,
            uuid: row.uuid,
            snapshot_date: row.snapshot_date,
            total_assets: parseFloat(row.total_assets),
            total_liabilities: parseFloat(row.total_liabilities),
            net_worth: parseFloat(row.net_worth),
            // Integer columns; a null one reads as NaN, as parseInt(null) did.
            account_count: parseInt(String(row.account_count)),
            active_account_count: parseInt(String(row.active_account_count)),
            // Plain text columns (no CHECK); the app writes only these values.
            snapshot_trigger: row.snapshot_trigger as NetWorthSnapshot['snapshot_trigger'],
            aggregation_level: row.aggregation_level as NetWorthSnapshot['aggregation_level'],
            source_snapshot_count: parseInt(String(row.source_snapshot_count || 0)),
            calculation_method: row.calculation_method as NetWorthSnapshot['calculation_method'],
            // new Date(null) was the epoch.
            created_at: new Date(row.created_at ?? 0),
            updated_at: new Date(row.updated_at ?? 0)
        };
    }

    private getOptimalLevel(period: 'day' | 'week' | 'month' | 'year'): 'daily' | 'weekly' | 'monthly' | 'yearly' {
        switch (period) {
            case 'day': return 'daily';
            case 'week': return 'weekly';
            case 'month': return 'monthly';
            case 'year': return 'yearly';
            default: return 'daily';
        }
    }
}

export default NetWorthService;
