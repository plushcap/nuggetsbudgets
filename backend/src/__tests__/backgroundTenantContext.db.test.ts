import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from '../db/schema.generated.js';
import { getDb, withTenant, runDetached } from '../db/withTenant.js';
import { BackupScheduler } from '../services/BackupScheduler.js';
import type { BackupService } from '../services/BackupService.js';
import type { OneDriveService } from '../services/OneDriveService.js';
import { getActiveTenantIds } from '../db/forEachTenant.js';
import { getCurrentTenantId, getCurrentUserId, runWithRequestContext } from '../context/requestContext.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * Background jobs run each tenant in withTenant, and read "which tenant" from
 * getCurrentTenantId(). That used to read only the request context, which a
 * job started at boot doesn't have (so the bank sync found no connection for anyone)
 * and a job armed from a request keeps for ever (so every tenant was synced with that
 * request's organization's bank connection).
 */
describe('Tenant context in background work', () => {
  let a: TestTenant;
  let b: TestTenant;
  let owner: Pool;

  beforeAll(async () => {
    a = await createTestTenant('Background context A');
    b = await createTestTenant('Background context B');
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 1 });
  });

  afterAll(async () => {
    await owner?.query(`UPDATE organizations SET status = 'active' WHERE id = $1`, [b?.organizationId]);
    await owner?.end();
    await a?.cleanup();
    await b?.cleanup();
  });

  it("is the withTenant transaction's tenant, with or without a request", async () => {
    expect(await withTenant(a.tenantId, async () => getCurrentTenantId())).toBe(a.tenantId);
    const inRequest = runWithRequestContext({ userId: b.userId, tenantId: b.tenantId, isDeploymentAdmin: false }, () =>
      withTenant(a.tenantId, async () => getCurrentTenantId())
    );
    expect(await inRequest).toBe(a.tenantId);
    // A request's own transaction is its tenant, as before.
    expect(
      await runWithRequestContext({ userId: b.userId, tenantId: b.tenantId, isDeploymentAdmin: false }, () =>
        withTenant(b.tenantId, async () => getCurrentTenantId())
      )
    ).toBe(b.tenantId);
  });

  it("arms a scheduler's timer without the request that started it", async () => {
    const fired = await runWithRequestContext({ userId: b.userId, tenantId: b.tenantId, isDeploymentAdmin: true }, () =>
      withTenant(b.tenantId, () =>
        new Promise<{ tenantId: unknown; userId: unknown; db: string }>((resolve) => {
          runDetached(() =>
            setTimeout(() => {
              let db = 'available';
              try {
                getDb();
              } catch {
                db = 'none';
              }
              resolve({ tenantId: getCurrentTenantId(), userId: getCurrentUserId(), db });
            }, 5)
          );
        })
      )
    );
    expect(fired).toEqual({ tenantId: undefined, userId: undefined, db: 'none' });
  });

  // It armed its timer leaving the request context only, so the timer kept the tenant
  // transaction it was armed in, and getDb() in a backup returned that finished
  // transaction. Armed from an admin's request: POST /api/backup/scheduler/start.
  it("arms the backup scheduler's timer without the request or transaction that started it", async () => {
    type Seen = { tenantId: unknown; userId: unknown; db: string };
    let fired!: (seen: Seen) => void;
    const seen = new Promise<Seen>((resolve) => (fired = resolve));
    const backupService = {
      encryptionState: async () => ({ recipients: 1, legacyKey: false, mode: 'age' }),
      // None yet: a catch-up backup is armed.
      listBackups: async () => [],
      createBackup: async () => {
        let db = 'available';
        try {
          getDb();
        } catch {
          db = 'none';
        }
        fired({ tenantId: getCurrentTenantId(), userId: getCurrentUserId(), db });
        throw new Error('not run in this test');
      },
    };
    // system_settings as the scheduler reads it: backups on.
    const settings = {
      connect: async () => ({
        query: async (_sql: string, params: unknown[] = []) => {
          const rows = params.includes('backup_enabled') ? [{ setting_key: 'backup_enabled', setting_value: 'true' }] : [];
          return { command: 'SELECT', rowCount: rows.length, rows };
        },
        release: () => {},
      }),
    } as unknown as Pool;
    const scheduler = new BackupScheduler(
      backupService as unknown as BackupService,
      { isConfigured: async () => false } as unknown as OneDriveService,
      { db: new Kysely<DB>({ dialect: new PostgresDialect({ pool: settings }) }) }
    );

    // The catch-up is due in 10 s. Here its timer fires in a moment, in the context it was
    // armed in, with the clock moved past the due time so it backs up rather than wait on.
    const realSetTimeout = globalThis.setTimeout;
    try {
      await runWithRequestContext({ userId: b.userId, tenantId: b.tenantId, isDeploymentAdmin: true }, () =>
        withTenant(b.tenantId, async () => {
          const shorten = vi
            .spyOn(globalThis, 'setTimeout')
            .mockImplementation(((fn: () => void) => realSetTimeout(fn, 5)) as unknown as typeof setTimeout);
          try {
            await scheduler.startScheduler();
          } finally {
            shorten.mockRestore();
          }
          // Before the timer fires: it is a macrotask, this runs on.
          vi.setSystemTime(Date.now() + 60_000);
        })
      );
      expect(await seen).toEqual({ tenantId: undefined, userId: undefined, db: 'none' });
    } finally {
      vi.useRealTimers();
      await scheduler.stopScheduler();
    }
  });

  it("leaves out a suspended organization's ledgers", async () => {
    expect(await getActiveTenantIds()).toEqual(expect.arrayContaining([a.tenantId, b.tenantId]));
    await owner.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [b.organizationId]);
    const ids = await getActiveTenantIds();
    expect(ids).toContain(a.tenantId);
    expect(ids).not.toContain(b.tenantId);
  });
});
