import { sql } from 'kysely';
import type { PriceSyncRunResult, PriceSyncSettings } from '@nuggets/shared';
import type { Pool } from 'pg';
import appPool from '../../db.js';
import { globalDb, withOrganization, withTenant } from '../../db/withTenant.js';
import { getActiveOrganizationIds, getAllOrganizationIds } from '../../db/forEachTenant.js';
import { ControlPlaneError } from '../controlPlaneErrors.js';
import { createLogger } from '../../utils/logger.js';
import { publicErrorMessage } from '../../utils/apiError.js';
import { calendarDateIn } from '../../utils/calendarDate.js';
import { PriceIngestFailure, PriceIngestService } from './PriceIngestService.js';
import { PortfolioValuationService } from './PortfolioValuationService.js';

const logger = createLogger({ service: 'PriceSyncService' });

export type RunTrigger = 'user' | 'scheduler';

/**
 * First key of the session advisory lock a price sync holds on its organization (ASCII
 * "PRSC"); the second key is the organization id. One run of an organization at a time,
 * in this process or another server on the database: a manual run and a scheduled one
 * overlapped, each writing its own run row.
 */
const PRICE_SYNC_LOCK_CLASS = 0x50525343;

/**
 * A new organization's price-sync schedule: 17:00 US Eastern, just after the US markets
 * close (16:00 ET), when the day's closing prices are out. Deliberately Eastern, not the
 * household's zone or UTC: it's the exchanges' clock. An org admin can change both.
 * The organization_price_sync_settings columns default to the same, and the
 * settings route and PriceSyncCard show them.
 */
export const DEFAULT_PRICE_SYNC_TIME = '17:00';
export const DEFAULT_PRICE_SYNC_TIMEZONE = 'America/New_York';

/** What a run that was stopped part way (the server stopped or crashed) is recorded as. */
export const STALE_RUN_MESSAGE = 'The server stopped before this run finished';

/** A price sync of the organization is already running: a 409, and no run is started. */
export class PriceSyncInProgressError extends ControlPlaneError {
  constructor() {
    super(409, 'PRICE_SYNC_IN_PROGRESS', 'A price sync of this organization is already running. Try again when it has finished.');
    this.name = 'PriceSyncInProgressError';
  }
}

/** An organization's price-sync settings, as the settings routes answer them (@nuggets/shared). */
export type { PriceSyncSettings } from '@nuggets/shared';

/** Today's calendar date (YYYY-MM-DD) in the given IANA timezone. */
export function todayInTimezone(timezone: string, now: Date = new Date()): string {
  return calendarDateIn(timezone, now);
}

/**
 * Organization-scoped price sync: settings (the on/off switch + daily schedule),
 * the run log, and the actual per-org run (fetch EOD closes into each ledger's
 * security_prices, then snapshot portfolio value). Settings and runs are under the
 * organization RLS policy, read and written in short withOrganization transactions
 * (never around the price provider's answer); what spans organizations (the
 * scheduler's due check, the stale-run cleanup) visits each in its own. The run
 * iterates the org's ledgers under withTenant so the writes are RLS-scoped.
 */
export class PriceSyncService {
  constructor(
    private readonly priceIngest = new PriceIngestService(),
    private readonly valuation = new PortfolioValuationService(),
    private readonly pool: Pool = appPool
  ) {}

  /**
   * Run `fn` as the only price sync of `orgId`, or throw PriceSyncInProgressError. A run
   * waits on the price provider, so the claim can't be a transaction's lock: it's a
   * session advisory lock on a connection of its own, held for the run and released by
   * the server if the connection or process dies (as the bank sync's claim is).
   */
  private async withOrgClaim<T>(orgId: number, fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      const { rows } = await client.query<{ claimed: boolean }>(
        'SELECT pg_try_advisory_lock($1::int, $2::int) AS claimed',
        [PRICE_SYNC_LOCK_CLASS, orgId]
      );
      if (!rows[0]?.claimed) throw new PriceSyncInProgressError();
      try {
        return await fn();
      } finally {
        try {
          await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [PRICE_SYNC_LOCK_CLASS, orgId]);
        } catch (err) {
          // Close the connection instead of pooling it: that ends the session and its lock.
          broken = true;
          logger.warn({ err, orgId }, 'Could not release the price sync claim; closing its connection');
        }
      }
    } finally {
      client.release(broken);
    }
  }

  /**
   * Mark the organization's runs still 'running' as failed. Called holding its claim, so
   * none of them is live: each was left by a server that stopped mid-run, and would show
   * as running for ever.
   */
  private async failStaleRuns(orgId: number): Promise<number> {
    const result = await withOrganization(orgId, (trx) =>
      trx
        .updateTable('organization_price_sync_runs')
        .set({ run_status: 'error', completed_at: sql`NOW()`, error_message: STALE_RUN_MESSAGE })
        .where('organization_id', '=', orgId)
        .where('run_status', '=', 'running')
        .executeTakeFirst()
    );
    const failed = Number(result.numUpdatedRows ?? 0);
    if (failed > 0) logger.warn({ orgId, failed }, 'Marked price-sync runs a stopped server left running as failed');
    return failed;
  }

  /** Whether the organization has a run marked 'running'. */
  private async hasRunningRun(orgId: number): Promise<boolean> {
    const row = await withOrganization(orgId, (trx) =>
      trx
        .selectFrom('organization_price_sync_runs')
        .select('id')
        .where('organization_id', '=', orgId)
        .where('run_status', '=', 'running')
        .limit(1)
        .executeTakeFirst()
    );
    return row !== undefined;
  }

  /**
   * At startup: mark the runs a stopped server left 'running' as failed, for each
   * organization no run holds now (one that does is skipped; its next run does it).
   * Each organization is looked at in its own transaction: RLS shows one at a time.
   */
  async failStaleRunsOfIdleOrgs(): Promise<number> {
    const orgs: number[] = [];
    for (const orgId of await getAllOrganizationIds()) {
      if (await this.hasRunningRun(orgId)) orgs.push(orgId);
    }
    let failed = 0;
    for (const orgId of orgs) {
      try {
        failed += await this.withOrgClaim(orgId, () => this.failStaleRuns(orgId));
      } catch (err) {
        if (!(err instanceof PriceSyncInProgressError)) throw err;
      }
    }
    return failed;
  }

  async getSettings(orgId: number): Promise<PriceSyncSettings | null> {
    const row = await withOrganization(orgId, (trx) =>
      trx
        .selectFrom('organization_price_sync_settings')
        .selectAll()
        .where('organization_id', '=', orgId)
        .executeTakeFirst()
    );
    if (!row) return null;
    return {
      organization_id: row.organization_id,
      enabled: row.enabled,
      schedule_time: row.schedule_time,
      timezone: row.timezone,
      provider: row.provider,
      last_run_at: row.last_run_at ? new Date(row.last_run_at as unknown as string).toISOString() : null,
    };
  }

  async upsertSettings(
    orgId: number,
    input: { enabled?: boolean; schedule_time?: string; timezone?: string },
    userId?: number
  ): Promise<PriceSyncSettings> {
    // One transaction: getSettings joins it, so it reads what this wrote.
    return withOrganization(orgId, async (trx) => {
      await trx
        .insertInto('organization_price_sync_settings')
        .values({
          organization_id: orgId,
          enabled: input.enabled ?? false,
          schedule_time: input.schedule_time ?? DEFAULT_PRICE_SYNC_TIME,
          timezone: input.timezone ?? DEFAULT_PRICE_SYNC_TIMEZONE,
          created_by: userId ?? null,
        })
        .onConflict((oc) =>
          oc.column('organization_id').doUpdateSet((eb) => ({
            // Only overwrite fields the caller actually provided.
            enabled: input.enabled === undefined ? eb.ref('organization_price_sync_settings.enabled') : input.enabled,
            schedule_time:
              input.schedule_time === undefined
                ? eb.ref('organization_price_sync_settings.schedule_time')
                : input.schedule_time,
            timezone:
              input.timezone === undefined ? eb.ref('organization_price_sync_settings.timezone') : input.timezone,
          }))
        )
        .execute();
      return (await this.getSettings(orgId)) as PriceSyncSettings;
    });
  }

  /**
   * All orgs with the sync enabled (for the scheduler tick). RLS shows one
   * organization's settings at a time, so each organization is read in its own short
   * transaction: one per organization per tick. Active organizations only: a suspended or
   * deleted one's prices aren't fetched, as its ledgers don't sync
   * (getActiveTenantIds).
   */
  async listEnabledSettings(): Promise<PriceSyncSettings[]> {
    const enabled: PriceSyncSettings[] = [];
    for (const orgId of await getActiveOrganizationIds()) {
      const settings = await this.getSettings(orgId);
      if (settings?.enabled) enabled.push(settings);
    }
    return enabled;
  }

  async listRuns(orgId: number, limit = 50, offset = 0) {
    return withOrganization(orgId, async (trx) => {
      const rows = await trx
        .selectFrom('organization_price_sync_runs')
        .selectAll()
        .where('organization_id', '=', orgId)
        .orderBy('started_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await trx
        .selectFrom('organization_price_sync_runs')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('organization_id', '=', orgId)
        .executeTakeFirstOrThrow();
      return { runs: rows, total: Number(total.count), limit, offset };
    });
  }

  /** Active ledgers (tenants) belonging to an org. */
  private async orgTenants(orgId: number): Promise<Array<{ id: number; name: string }>> {
    return globalDb
      .selectFrom('tenants')
      .select(['id', 'name'])
      .where('organization_id', '=', orgId)
      .where('status', '=', 'active')
      .orderBy('id')
      .execute();
  }

  /**
   * Run a price sync for one organization: fetch EOD closes into every active
   * ledger's security_prices and snapshot each ledger's portfolio value. Records
   * one run-log row (running → success|partial|error) and stamps last_run_at.
   * One at a time per organization: another that is running makes this throw
   * PriceSyncInProgressError before anything is recorded.
   */
  async runForOrg(orgId: number, opts: { trigger: RunTrigger; userId?: number }): Promise<PriceSyncRunResult> {
    return this.withOrgClaim(orgId, async () => {
      await this.failStaleRuns(orgId);
      return this.runClaimed(orgId, opts);
    });
  }

  private async runClaimed(orgId: number, opts: { trigger: RunTrigger; userId?: number }): Promise<PriceSyncRunResult> {
    const settings = await this.getSettings(orgId);
    const timezone = settings?.timezone ?? DEFAULT_PRICE_SYNC_TIMEZONE;
    const today = todayInTimezone(timezone);
    const method = opts.trigger === 'user' ? 'manual' : 'scheduled';

    const run = await withOrganization(orgId, (trx) =>
      trx
        .insertInto('organization_price_sync_runs')
        .values({ organization_id: orgId, run_status: 'running', run_trigger: opts.trigger, user_id: opts.userId ?? null })
        .returning('id')
        .executeTakeFirstOrThrow()
    );

    let tenantsSynced = 0;
    let securitiesTotal = 0;
    let pricesUpdated = 0;
    let pricesFailed = 0;
    let snapshots = 0;
    const errors: string[] = [];

    const tenants = await this.orgTenants(orgId);
    for (const t of tenants) {
      try {
        // No transaction around the price provider's answer.
        const ing = await this.priceIngest.updateMarketPrices(t.id);
        securitiesTotal += ing.total;
        pricesUpdated += ing.updated;
        pricesFailed += ing.failed;
        // Closes another change held past lock_timeout weren't written: the run is partial, and
        // says so (the ledger's other prices and its snapshot are still written).
        if (ing.busy > 0) {
          errors.push(`${t.name}: ${ing.busy} securities' prices were not saved, because another change to them was being saved at the same time; the next run will try again`);
        }
        // A value too large to snapshot is skipped, and logged, without failing the ledger.
        const snapshot = await withTenant(t.id, () => this.valuation.upsertSnapshot(today, method));
        if (snapshot.snapshot_written) snapshots++;
        tenantsSynced++;
      } catch (err) {
        // Stopped after some of its batches were written: they're counted, and said.
        const wrote = err instanceof PriceIngestFailure ? err.result : null;
        if (wrote) {
          securitiesTotal += wrote.total;
          pricesUpdated += wrote.updated;
          pricesFailed += wrote.failed;
        }
        // Kept in the run's error_message, which org admins read: never the error's own text.
        const msg = wrote
          ? `price sync failed after saving ${wrote.updated} prices (${wrote.failed} securities' prices were not saved); the server log has the details`
          : publicErrorMessage(err, 'price sync failed; the server log has the details');
        errors.push(`${t.name}: ${msg}`);
        logger.error(
          wrote ? { err: (err as PriceIngestFailure).cause, tenantId: t.id, orgId, pricesUpdated: wrote.updated, pricesFailed: wrote.failed } : { err, tenantId: t.id, orgId },
          'Price sync failed for tenant'
        );
      }
    }

    // Partial when something was written: a ledger synced, or prices one saved before it failed.
    const status = errors.length === 0 ? 'success' : tenantsSynced > 0 || pricesUpdated > 0 ? 'partial' : 'error';
    await withOrganization(orgId, async (trx) => {
      await trx
        .updateTable('organization_price_sync_runs')
        .set({
          run_status: status,
          completed_at: sql`NOW()`,
          tenants_synced: tenantsSynced,
          securities_total: securitiesTotal,
          prices_updated: pricesUpdated,
          prices_failed: pricesFailed,
          snapshots_written: snapshots,
          error_message: errors.length ? errors.join('; ').slice(0, 2000) : null,
        })
        .where('id', '=', run.id)
        .execute();
      await trx
        .updateTable('organization_price_sync_settings')
        .set({ last_run_at: sql`NOW()` })
        .where('organization_id', '=', orgId)
        .execute();
    });

    logger.info({ orgId, status, tenantsSynced, pricesUpdated, snapshots }, 'Completed org price sync');
    return { run_id: run.id, status, tenants_synced: tenantsSynced, prices_updated: pricesUpdated, prices_failed: pricesFailed, snapshots_written: snapshots };
  }
}

export const priceSyncService = new PriceSyncService();
