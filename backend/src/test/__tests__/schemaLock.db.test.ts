import { describe, it, expect, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createTestTenant, type TestTenant } from '../testTenant.js';
import { holdSchemaChangeLock, withSchemaChangeLockShared } from '../schemaLock.js';

/**
 * A migration test's rolled-back schema change and a test ledger's setup or cleanup never
 * run at once: they took the same tables in opposite orders, and Postgres failed
 * one of them, often the cleanup, failing that file's afterAll (40P01).
 */
describe('the schema-change lock', () => {
  const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 4 });
  afterAll(async () => {
    await owner.end();
  });

  const settled = <T>(promise: Promise<T>) => {
    const state = { done: false };
    void promise.then(
      () => (state.done = true),
      () => (state.done = true)
    );
    return state;
  };
  const tenantExists = async (id: number) => (await owner.query('SELECT 1 FROM tenants WHERE id = $1', [id])).rowCount === 1;

  it("holds a test ledger's cleanup, and its creation, until a schema change's transaction ends", async () => {
    const tenant = await createTestTenant('Schema change lock');
    const migration = await owner.connect();
    let cleanup: Promise<void> | undefined;
    let creation: ReturnType<typeof createTestTenant> | undefined;
    try {
      await migration.query('BEGIN');
      await holdSchemaChangeLock(migration);

      cleanup = tenant.cleanup();
      creation = createTestTenant('Schema change lock (waits)');
      const cleaned = settled(cleanup);
      const created = settled(creation);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(cleaned.done).toBe(false);
      expect(created.done).toBe(false);
      expect(await tenantExists(tenant.tenantId)).toBe(true);
    } finally {
      await migration.query('ROLLBACK');
      migration.release();
    }

    await cleanup;
    expect(await tenantExists(tenant.tenantId)).toBe(false);
    const later = await creation!;
    expect(await tenantExists(later.tenantId)).toBe(true);
    await later.cleanup();
  });

  it("keeps a test ledger's creation out of a schema change's way, so neither is failed with a deadlock", async () => {
    // The deadlock seen inside createTestTenant()'s INSERT INTO users (accountsZeroBalance):
    // a migration test's DDL had users ACCESS EXCLUSIVE and went on to
    // tenants, while the creation had inserted its tenant and waited for users. Postgres
    // failed one of them (40P01). Taken by hand here, in that order: users, then the
    // creation starts and waits, then tenants.
    const migration = await owner.connect();
    let creation: Promise<TestTenant> | undefined;
    try {
      await migration.query('BEGIN');
      await holdSchemaChangeLock(migration);
      await migration.query(`SET LOCAL lock_timeout = '10s'`);
      const { pid } = (await migration.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0];
      await migration.query('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');

      creation = createTestTenant('Schema change lock (deadlock)');
      const created = settled(creation);
      // It waits: for the schema-change lock, holding no table (without it: for users,
      // holding tenants).
      for (let i = 0; ; i++) {
        const waiting = await owner.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> $1 AND wait_event_type = 'Lock'`,
          [pid]
        );
        if ((waiting.rowCount ?? 0) > 0) break;
        if (i > 500) throw new Error("the test ledger's creation never waited");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Fails with 40P01 here, or the creation does, if the creation holds tenants.
      await migration.query('LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE');
      expect(created.done).toBe(false);
    } finally {
      await migration.query('ROLLBACK').catch(() => undefined);
      migration.release();
    }

    const tenant = await creation;
    expect(await tenantExists(tenant.tenantId)).toBe(true);
    await tenant.cleanup();
  });

  it('holds a schema change while a cleanup holds the lock, and lets cleanups run alongside each other', async () => {
    const tenant = await createTestTenant('Schema change lock (alongside)');
    const cleaning = await owner.connect();
    const migration = await owner.connect();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    try {
      // A cleanup under way: it holds the lock shared until it's done.
      const underWay = withSchemaChangeLockShared(cleaning, () => released);

      // Another ledger's cleanup isn't held up by it.
      await tenant.cleanup();
      expect(await tenantExists(tenant.tenantId)).toBe(false);

      // A schema change is, until the cleanup has finished.
      await migration.query('BEGIN');
      const held = holdSchemaChangeLock(migration);
      const changing = settled(held);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(changing.done).toBe(false);
      release();
      await underWay;
      await held;
    } finally {
      release();
      await migration.query('ROLLBACK').catch(() => undefined);
      migration.release();
      cleaning.release();
    }
  });
});
