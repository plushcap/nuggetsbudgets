import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { Pool } from 'pg';
import { sql } from 'kysely';
import { answerProblem, priceSyncRunsResponseSchema, priceSyncSettingsResponseSchema } from '@nuggets/shared';
import globalPool from '../db.js';
import { getDb, getOrgDb, withOrganization, withSavepoint, withTenant } from '../db/withTenant.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import { createOrganizationRoutes } from '../routes/organizations.js';
import { rejectMalformedIds } from '../middleware/routeParams.js';
import { EncryptionService } from '../services/EncryptionService.js';
import { getAccessUrlForTenant, getConnectionForTenant, markSynced } from '../services/OrganizationSimpleFinService.js';
import { PriceSyncService, STALE_RUN_MESSAGE } from '../services/investments/PriceSyncService.js';
import { ImportService } from '../services/ImportService.js';
import { purgeOldPriceSyncRuns, runRetention, type RetentionPolicy } from '../services/maintenance/retention.js';

/**
 * Organization isolation: an organization's SimpleFin
 * connection, price-sync settings and runs are under RLS keyed on
 * app.current_organization_id, as a ledger's rows are on app.current_tenant_id.
 *
 * Two organizations, A and B, one ledger each. Fixtures are written as the owner (RLS
 * doesn't apply to it); everything under test runs on the app's own pool as the
 * serving role, which RLS applies to. Each route and job that touches these tables
 * sees only its own organization's rows, a ledger's transaction sees its organization's,
 * and a query with no organization set fails.
 *
 * The jobs that visit every organization (the price-sync due check and stale-run
 * cleanup, retention) are pointed at A and B only, so other files' organizations,
 * which run in parallel on the same database, are left alone.
 */

const orgScope = vi.hoisted(() => ({ ids: null as number[] | null }));
vi.mock('../db/forEachTenant.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/forEachTenant.js')>();
  return {
    ...actual,
    getAllOrganizationIds: async () => orgScope.ids ?? actual.getAllOrganizationIds(),
    getActiveOrganizationIds: async () => {
      const active = await actual.getActiveOrganizationIds();
      return orgScope.ids ? active.filter((id) => orgScope.ids!.includes(id)) : active;
    },
  };
});

const ORG_TABLES = ['organization_simplefin_connections', 'organization_price_sync_settings', 'organization_price_sync_runs'] as const;
const NO_ORGANIZATION = 'no organization is set for this query (app.current_organization_id)';
const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const accessUrl = (who: string) => `https://${who}-${stamp}:${who}-secret@bridge.simplefin.org/simplefin`; // gitleaks:allow (made-up)
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

interface Side {
  tenant: TestTenant;
  orgUuid: string;
  connectionId: number;
  accountId: number;
  runs: { old: number; recent: number; running: number };
  app: Express;
}

describe('Organization isolation (organization RLS)', () => {
  let owner: Pool;
  let a: Side;
  let b: Side;

  const ownerOne = async <T>(text: string, params: unknown[]) => (await owner.query(text, params)).rows[0] as T;

  async function side(label: string, scheduleTime: string): Promise<Side> {
    const tenant = await createTestTenant(`Organization isolation ${label}`);
    const org = tenant.organizationId;
    await owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, true)', [org, tenant.userId]);
    const orgUuid = (await ownerOne<{ uuid: string }>('SELECT uuid FROM organizations WHERE id = $1', [org])).uuid;
    // The access URL as it is stored; EncryptionService is passed through below.
    const connectionId = (
      await ownerOne<{ id: number }>(
        `INSERT INTO organization_simplefin_connections (organization_id, access_url, label) VALUES ($1, $2, $3) RETURNING id`,
        [org, accessUrl(label), `${label}-${stamp}`]
      )
    ).id;
    await owner.query(
      `INSERT INTO organization_price_sync_settings (organization_id, enabled, schedule_time, timezone) VALUES ($1, true, $2, 'UTC')`,
      [org, scheduleTime]
    );
    const run = async (status: string, started: Date) =>
      (
        await ownerOne<{ id: number }>(
          `INSERT INTO organization_price_sync_runs (organization_id, run_status, started_at) VALUES ($1, $2, $3) RETURNING id`,
          [org, status, started]
        )
      ).id;
    // Old is 500 days: past this file's retention period (365), within the one retention.db.test.ts
    // runs over every organization (3650), so that file never deletes it from under this one.
    const runs = { old: await run('success', ago(500)), running: await run('running', ago(3)), recent: await run('success', ago(1)) };
    const accountId = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id`,
        [`${label} account`]
      )
    ).rows[0].id;
    const app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/organizations', rejectMalformedIds(createOrganizationRoutes()));
    return { tenant, orgUuid, connectionId, accountId, runs, app };
  }

  beforeAll(async () => {
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 2 });
    a = await side('A', '00:00');
    b = await side('B', '00:01');
    orgScope.ids = [a.tenant.organizationId, b.tenant.organizationId];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    orgScope.ids = null;
    // Deleting each organization (cleanup) cascades to its rows here; accounts first.
    await a?.tenant.pool.query('UPDATE accounts SET simplefin_connection_id = NULL');
    await b?.tenant.pool.query('UPDATE accounts SET simplefin_connection_id = NULL');
    await owner?.query('DELETE FROM organization_users WHERE user_id = ANY($1)', [[a?.tenant.userId, b?.tenant.userId]]);
    await owner?.end();
    await a?.tenant.cleanup();
    await b?.tenant.cleanup();
  });

  /** Ids of `table`'s rows the owner sees for the organization. */
  const ownerIds = async (table: string, orgId: number) =>
    (await owner.query<{ id: number }>(`SELECT id FROM ${table} WHERE organization_id = $1 ORDER BY id`, [orgId])).rows.map((r) => r.id);

  it('fails a query on an organization table with no organization set, whatever it does', async () => {
    for (const table of ORG_TABLES) {
      await expect(globalPool.query(`SELECT count(*) FROM ${table}`), table).rejects.toThrow(NO_ORGANIZATION);
      await expect(globalPool.query(`UPDATE ${table} SET updated_at = now() WHERE id > 0`), table).rejects.toThrow(NO_ORGANIZATION);
      await expect(globalPool.query(`DELETE FROM ${table} WHERE id > 0`), table).rejects.toThrow(NO_ORGANIZATION);
    }
    // An insert that names its organization fails too: the policy has no organization to admit it to.
    await expect(
      globalPool.query(`INSERT INTO organization_price_sync_runs (organization_id, run_status) VALUES ($1, 'running')`, [a.tenant.organizationId])
    ).rejects.toThrow(NO_ORGANIZATION);
    // A tenant setting alone is no organization (a stray app.current_tenant_id, not withTenant).
    const client = await globalPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [String(a.tenant.tenantId)]);
      await expect(client.query('SELECT count(*) FROM organization_simplefin_connections')).rejects.toThrow(NO_ORGANIZATION);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await ownerIds('organization_price_sync_runs', a.tenant.organizationId)).toEqual(Object.values(a.runs).sort((x, y) => x - y));
  });

  it("reads and changes only the set organization's rows, even with no organization predicate", async () => {
    const orgA = a.tenant.organizationId;
    for (const table of ORG_TABLES) {
      const seen = await withOrganization(orgA, () =>
        sql<{ organization_id: number }>`SELECT organization_id FROM ${sql.table(table)}`.execute(getOrgDb())
      );
      expect(seen.rows.length, table).toBeGreaterThan(0);
      expect(new Set(seen.rows.map((r) => r.organization_id)), table).toEqual(new Set([orgA]));
    }
    // B's rows are out of reach: an update or delete by id finds nothing.
    const touched = await withOrganization(orgA, async (trx) => ({
      updated: (await trx.updateTable('organization_simplefin_connections').set({ label: 'hijacked' }).where('id', '=', b.connectionId).executeTakeFirst()).numUpdatedRows,
      deleted: (await trx.deleteFrom('organization_price_sync_runs').where('id', '=', b.runs.old).executeTakeFirst()).numDeletedRows,
    }));
    expect(touched).toEqual({ updated: 0n, deleted: 0n });
    expect((await ownerOne<{ label: string }>('SELECT label FROM organization_simplefin_connections WHERE id = $1', [b.connectionId])).label).toBe(`B-${stamp}`);
    expect(await ownerIds('organization_price_sync_runs', b.tenant.organizationId)).toContain(b.runs.old);
    // A row for B can't be written from A's; one that names no organization lands in A's.
    await expect(
      withOrganization(orgA, (trx) =>
        trx.insertInto('organization_price_sync_runs').values({ organization_id: b.tenant.organizationId, run_status: 'error' }).execute()
      )
    ).rejects.toThrow(/row-level security/);
    const stamped = await withOrganization(orgA, (trx) =>
      trx.insertInto('organization_price_sync_runs').values({ run_status: 'error', started_at: ago(400) }).returning('organization_id').executeTakeFirstOrThrow()
    );
    expect(stamped.organization_id).toBe(orgA);
  });

  it("gives a ledger's transaction its organization: it reads its own connection, and links an account only to it", async () => {
    await withTenant(a.tenant.tenantId, async () => {
      const visible = await getOrgDb().selectFrom('organization_simplefin_connections').select('id').execute();
      expect(visible.map((r) => r.id)).toEqual([a.connectionId]);
      // getConnectionForTenant joins this transaction (its organization is the same).
      expect((await getConnectionForTenant(a.tenant.tenantId))?.id).toBe(a.connectionId);
      // The account trigger checks the connection under the policy: B's is refused, A's taken.
      await expect(
        withSavepoint(() =>
          getDb().updateTable('accounts').set({ simplefin_connection_id: b.connectionId }).where('id', '=', a.accountId).execute()
        )
      ).rejects.toMatchObject({ code: '23503' });
      await getDb().updateTable('accounts').set({ simplefin_connection_id: a.connectionId }).where('id', '=', a.accountId).execute();
      // A ledger page joining its accounts' connection reads it through the organization policy.
      const joined = await getDb()
        .selectFrom('accounts as acc')
        .innerJoin('organization_simplefin_connections as c', 'c.id', 'acc.simplefin_connection_id')
        .select(['acc.id', 'c.label'])
        .execute();
      expect(joined).toEqual([{ id: a.accountId, label: `A-${stamp}` }]);
    });
    const linked = await a.tenant.pool.query('SELECT simplefin_connection_id FROM accounts WHERE id = $1', [a.accountId]);
    expect(linked.rows[0].simplefin_connection_id).toBe(a.connectionId);
  });

  it("syncs a ledger with its own organization's credential, and stamps only that connection", async () => {
    vi.spyOn(EncryptionService.prototype, 'decryptString').mockImplementation(async (value: string) => value);
    expect(await getAccessUrlForTenant(a.tenant.tenantId)).toBe(accessUrl('A'));
    expect(await getAccessUrlForTenant(b.tenant.tenantId)).toBe(accessUrl('B'));

    const authorizations: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get('authorization') ?? '');
        return new Response(JSON.stringify({ errlist: [], connections: [], accounts: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      })
    );
    const outcome = await new ImportService(globalPool).runFullSync(a.tenant.tenantId, { syncType: 'manual', syncTrigger: 'user', userId: a.tenant.userId });
    expect(outcome.status).not.toBe('failed');
    expect(authorizations).toEqual([`Basic ${Buffer.from(`A-${stamp}:A-secret`).toString('base64')}`]);

    const lastSynced = async (id: number) =>
      (await ownerOne<{ last_synced_at: Date | null }>('SELECT last_synced_at FROM organization_simplefin_connections WHERE id = $1', [id])).last_synced_at;
    expect(await lastSynced(a.connectionId)).not.toBeNull();
    expect(await lastSynced(b.connectionId)).toBeNull();
    // Named with A's organization, B's connection is out of reach.
    await markSynced(a.tenant.organizationId, b.connectionId);
    expect(await lastSynced(b.connectionId)).toBeNull();
  });

  it("answers the price-sync settings and runs routes with the organization's own rows", async () => {
    const settings = await request(a.app).get(`/api/organizations/${a.orgUuid}/price-sync/settings`).expect(200);
    expect(settings.body).toMatchObject({ organization_id: a.tenant.organizationId, schedule_time: '00:00' });
    // Each answer exactly its shared schema.
    expect(answerProblem(priceSyncSettingsResponseSchema, settings.body)).toBeNull();
    const saved = await request(a.app).put(`/api/organizations/${a.orgUuid}/price-sync/settings`).send({ schedule_time: '06:30' }).expect(200);
    expect(answerProblem(priceSyncSettingsResponseSchema, saved.body)).toBeNull();
    const schedules = await owner.query<{ organization_id: number; schedule_time: string }>(
      'SELECT organization_id, schedule_time FROM organization_price_sync_settings WHERE organization_id = ANY($1) ORDER BY organization_id',
      [[a.tenant.organizationId, b.tenant.organizationId]]
    );
    expect(schedules.rows).toEqual([
      { organization_id: a.tenant.organizationId, schedule_time: '06:30' },
      { organization_id: b.tenant.organizationId, schedule_time: '00:01' },
    ]);

    const runs = await request(a.app).get(`/api/organizations/${a.orgUuid}/price-sync/runs`).expect(200);
    const mine = await ownerIds('organization_price_sync_runs', a.tenant.organizationId);
    expect(runs.body.total).toBe(mine.length);
    expect(runs.body.runs.length).toBeGreaterThan(0);
    expect(answerProblem(priceSyncRunsResponseSchema, runs.body)).toBeNull();
    expect(runs.body.runs.map((r: { id: number }) => r.id).sort((x: number, y: number) => x - y)).toEqual(mine);
    // Another organization's URL is refused before anything is read.
    await request(a.app).get(`/api/organizations/${b.orgUuid}/price-sync/runs`).expect(403);
  });

  it("runs the jobs that span organizations one organization at a time, each on its own rows", async () => {
    const svc = new PriceSyncService();
    const enabled = await svc.listEnabledSettings();
    expect(enabled.map((s) => [s.organization_id, s.schedule_time])).toEqual([
      [a.tenant.organizationId, '06:30'],
      [b.tenant.organizationId, '00:01'],
    ]);

    // Both organizations' stale runs are marked. (Not counted: investmentsPriceSync.test.ts
    // runs the same cleanup over every organization, and may mark these first.)
    await svc.failStaleRunsOfIdleOrgs();
    const statusOf = async (id: number) =>
      (await ownerOne<{ run_status: string; error_message: string | null }>('SELECT run_status, error_message FROM organization_price_sync_runs WHERE id = $1', [id]));
    expect(await statusOf(a.runs.running)).toEqual({ run_status: 'error', error_message: STALE_RUN_MESSAGE });
    expect(await statusOf(b.runs.running)).toEqual({ run_status: 'error', error_message: STALE_RUN_MESSAGE });

    // Retention: A's old runs go, B's stay until B's turn. Sessions and notifications are
    // kept far longer than any other file's fixtures, so the global job leaves them be.
    const policy: RetentionPolicy = { sessionDays: 36500, notificationDays: 36500, notificationDeliveryDays: 36500, syncLogDays: 365 };
    expect(await purgeOldPriceSyncRuns(policy, { organizationIds: [a.tenant.organizationId] })).toBe(2); // the 500- and 400-day-old runs
    expect(await ownerIds('organization_price_sync_runs', a.tenant.organizationId)).not.toContain(a.runs.old);
    expect(await ownerIds('organization_price_sync_runs', b.tenant.organizationId)).toContain(b.runs.old);
    const counts = await runRetention(policy, { tenantIds: [] });
    expect(counts.organization_price_sync_runs).toBe(1);
    expect(await ownerIds('organization_price_sync_runs', b.tenant.organizationId)).toEqual([b.runs.running, b.runs.recent]);
  });

  it("answers the SimpleFin connection routes with the organization's own connection, and deletes only it", async () => {
    const mine = await request(a.app).get(`/api/organizations/${a.orgUuid}/simplefin/connection`).expect(200);
    expect(mine.body).toMatchObject({ label: `A-${stamp}`, mappedAccountCount: 0 });
    await request(a.app).get(`/api/organizations/${b.orgUuid}/simplefin/connection`).expect(403);

    await request(a.app).delete(`/api/organizations/${a.orgUuid}/simplefin/connection`).expect(200);
    expect(await ownerIds('organization_simplefin_connections', a.tenant.organizationId)).toEqual([]);
    expect(await ownerIds('organization_simplefin_connections', b.tenant.organizationId)).toEqual([b.connectionId]);
    // The account A linked to it was unlinked with it.
    const linked = await a.tenant.pool.query('SELECT simplefin_connection_id FROM accounts WHERE id = $1', [a.accountId]);
    expect(linked.rows[0].simplefin_connection_id).toBeNull();
    // B's still answers B.
    const theirs = await request(b.app).get(`/api/organizations/${b.orgUuid}/simplefin/connection`).expect(200);
    expect(theirs.body).toMatchObject({ label: `B-${stamp}` });
  });
});
