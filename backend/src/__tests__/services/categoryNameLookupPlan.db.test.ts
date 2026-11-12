import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { CategoryService } from '../../services/categories/CategoryService.js';
import { withTenant } from '../../db/withTenant.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The check a category write makes of its name, under RLS. It filtered on
 * lower(btrim(name)), which isn't leakproof, so Postgres ran it only above the tenant policy:
 * the unique index on that expression served no lookup, and the check read every category of
 * the ledger. It is an = on the stored name_key now, which the unique (tenant_id, name_key)
 * index serves. The service's own statement is caught as it is sent and explained as the app
 * role, in the ledger, with sequential scans off (a small table is read whole anyway).
 */
describe("CategoryService's name check under RLS", () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('Category name lookup plan');
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await tenant?.cleanup();
  });

  it('looks the name up through the unique index, not by reading the ledger', async () => {
    const sent: Array<{ text: string; values: unknown[] }> = [];
    const query = pg.Client.prototype.query as (this: pg.Client, ...args: unknown[]) => unknown;
    vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const [text, values] = args;
      if (typeof text === 'string' && /from "categories"/i.test(text) && /select "id"/i.test(text)) sent.push({ text, values: (values as unknown[]) ?? [] });
      return query.apply(this, args);
    } as typeof pg.Client.prototype.query);
    await withTenant(tenant.tenantId, () => new CategoryService().create({ name: ' Plan Check ', icon: 'FolderOpen' }));
    vi.restoreAllMocks();

    const check = sent[0];
    expect(check, 'the name check').toBeDefined();
    const client = await tenant.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${check!.text}`, check!.values);
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/Index Cond: .*name_key/);
      expect(plan).not.toMatch(/Filter: .*name/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
