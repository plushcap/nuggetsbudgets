import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { CategoryService } from '../../services/categories/CategoryService.js';
import { getDb, withTenant } from '../../db/withTenant.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import globalPool from '../../db.js';

/**
 * A ledger's category names are unique ignoring case and surrounding spaces.
 * The service looks the name up before it writes, so two requests at once both pass that
 * check; the unique index uq_categories_tenant_name_key is what refuses the second,
 * and the service answers it with the same 409 its check gives.
 *
 * Driven deterministically: the first write holds its transaction open; the second runs
 * its check (it can't see the uncommitted row), writes, and waits on the first's index
 * entry (seen in pg_blocking_pids); then the first commits.
 */
describe('CategoryService: two writes of one name at once', () => {
  let tenant: TestTenant;
  let other: TestTenant;
  const service = new CategoryService();
  const input = (name: string) => ({ name, icon: 'FolderOpen' });

  beforeAll(async () => {
    tenant = await createTestTenant('Category name race');
    other = await createTestTenant('Category name race (other ledger)');
  });

  afterAll(async () => {
    await tenant?.cleanup();
    await other?.cleanup();
  });

  const waitUntilBlockedBy = async (pid: number) => {
    for (let i = 0; i < 400; i += 1) {
      const { rows } = await globalPool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))`,
        [pid]
      );
      if ((rows[0]?.n ?? 0) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  };

  /**
   * `first` runs and holds its transaction open; `second` runs meanwhile, and once it waits
   * on `first` (or ends without waiting), `first` commits. Answers whether `second` waited,
   * and how it ended.
   */
  async function race(first: () => Promise<unknown>, second: () => Promise<unknown>) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let firstPid!: (pid: number) => void;
    const firstPidKnown = new Promise<number>((resolve) => (firstPid = resolve));

    const held = withTenant(tenant.tenantId, async () => {
      await first();
      const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(getDb());
      firstPid(rows[0]!.pid);
      await released;
    });
    const pid = await firstPidKnown;

    const outcome = withTenant(tenant.tenantId, second)
      .then((row) => ({ row, err: undefined }))
      .catch((err: { status?: number; message?: string }) => ({ row: undefined, err }));
    // Without the index the second write doesn't wait: it commits a duplicate.
    const blocked = await Promise.race([waitUntilBlockedBy(pid), outcome.then(() => false)]);
    release();
    await held;
    return { blocked, ...(await outcome) };
  }

  it('refuses the second create with 409 "Category exists" and leaves one row', async () => {
    const { blocked, err } = await race(
      () => service.create(input('Groceries')),
      () => service.create(input('  GROCERIES '))
    );
    expect(blocked).toBe(true);
    expect(err).toMatchObject({ status: 409, message: 'A category with this name already exists' });

    const { rows } = await tenant.pool.query(`SELECT name FROM categories WHERE lower(btrim(name)) = 'groceries'`);
    expect(rows.map((r) => r.name)).toEqual(['Groceries']);
  });

  it('refuses a rename into a name created meanwhile with the same 409', async () => {
    const fuel = await withTenant(tenant.tenantId, () => service.create(input('Fuel')));
    const { blocked, err } = await race(
      () => service.create(input('Travel')),
      () => service.update(fuel.uuid, input('travel'))
    );
    expect(blocked).toBe(true);
    expect(err).toMatchObject({ status: 409, message: 'A category with this name already exists' });

    const { rows } = await tenant.pool.query(`SELECT name FROM categories WHERE uuid = $1`, [fuel.uuid]);
    expect(rows[0]?.name).toBe('Fuel');
  });

  it('keeps names apart per ledger, and a category may change its own case', async () => {
    await withTenant(tenant.tenantId, () => service.create(input('Shared name')));
    await expect(withTenant(other.tenantId, () => service.create(input('Shared name')))).resolves.toMatchObject({ name: 'Shared name' });
    const own = await withTenant(tenant.tenantId, () => service.create(input('Gifts')));
    await expect(withTenant(tenant.tenantId, () => service.update(own.uuid, input('GIFTS')))).resolves.toMatchObject({ name: 'GIFTS' });
  });
});
