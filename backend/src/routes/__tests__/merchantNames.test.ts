import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { sql } from 'kysely';
import globalPool from '../../db.js';
import { createMerchantsRoutes } from '../merchants.js';
import { getDb, withTenant } from '../../db/withTenant.js';
import { ImportService } from '../../services/ImportService.js';
import type { MerchantMatcher } from '../../services/import/MerchantMatcher.js';
import { findOrCreateMerchant } from '../../services/merchantNames.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A ledger's merchant names are unique ignoring case. The create and rename
 * routes answer a taken name with 409, and so does a request that checked the name just
 * before a concurrent one took it; the import uses the merchant created meanwhile.
 *
 * The races are made deterministic: a first transaction inserts the name and stays open
 * until the request under test is seen waiting for it (pg_blocking_pids), then commits.
 */
describe('Merchant names', () => {
  let tenant: TestTenant;
  let app: Express;

  const named = async (name: string) =>
    (await tenant.pool.query(`SELECT id, name FROM merchants WHERE lower(name) = lower($1) ORDER BY id`, [name])).rows;

  async function waitFor(what: string, check: () => Promise<boolean>) {
    const deadline = Date.now() + 5_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /**
   * Inserts merchant `name` in a transaction of its own, which stays open while `during`
   * runs and is committed once something waits for it, and returns the inserted id and
   * what `during` resolved to.
   */
  async function whileUncommitted<T>(name: string, during: () => Promise<T>): Promise<{ id: number; result: T }> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let inserted!: (row: { pid: number; id: number }) => void;
    const ready = new Promise<{ pid: number; id: number }>((resolve) => (inserted = resolve));
    const first = withTenant(tenant.tenantId, async () => {
      const pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(getDb())).rows[0].pid;
      const { id } = await getDb().insertInto('merchants').values({ name }).returning('id').executeTakeFirstOrThrow();
      inserted({ pid, id });
      await held;
    });
    const { pid, id } = await ready;
    const result = during();
    try {
      await waitFor(`a request to wait for the uncommitted "${name}"`, async () => {
        const blocked = await tenant.pool.query(`SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid]);
        return (blocked.rowCount ?? 0) > 0;
      });
    } finally {
      release();
      await first;
    }
    return { id, result: await result };
  }

  beforeAll(async () => {
    tenant = await createTestTenant('Merchant names');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/merchants', createMerchantsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('answers 409 to a name the ledger has in another case, on create and rename', async () => {
    const created = await request(app).post('/api/merchants').send({ name: 'Corner Store' }).expect(201);
    const other = await request(app).post('/api/merchants').send({ name: 'Bakery' }).expect(201);

    const again = await request(app).post('/api/merchants').send({ name: 'CORNER STORE' });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'Merchant exists', code: 'CONFLICT', message: 'A merchant with this name already exists' });

    const rename = await request(app).put(`/api/merchants/${other.body.uuid}`).send({ name: 'corner store' });
    expect(rename.status).toBe(409);
    // Its own name in another case is fine.
    await request(app).put(`/api/merchants/${created.body.uuid}`).send({ name: 'CORNER Store' }).expect(200);
    expect((await named('corner store')).map((m) => m.name)).toEqual(['CORNER Store']);
  });

  it('answers 409 to a create that checked the name before a concurrent request took it', async () => {
    const { id, result } = await whileUncommitted('Deli', () =>
      request(app).post('/api/merchants').send({ name: 'DELI' }).then((res) => res)
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: 'Merchant exists' });
    expect(await named('deli')).toEqual([{ id, name: 'Deli' }]);
  });

  it('answers 409 to a rename that checked the name before a concurrent request took it', async () => {
    const renamed = await request(app).post('/api/merchants').send({ name: 'Old Pharmacy' }).expect(201);
    const { id, result } = await whileUncommitted('Pharmacy', () =>
      request(app).put(`/api/merchants/${renamed.body.uuid}`).send({ name: 'PHARMACY' }).then((res) => res)
    );
    expect(result.status).toBe(409);
    expect(await named('pharmacy')).toEqual([{ id, name: 'Pharmacy' }]);
    expect(await named('old pharmacy')).toHaveLength(1);
  });

  it("finds the transfer routes' merchant in any case instead of adding a second one", async () => {
    const existing = (await tenant.pool.query(`INSERT INTO merchants (name) VALUES ('transfer: savings') RETURNING id`)).rows[0].id;
    expect(await withTenant(tenant.tenantId, () => findOrCreateMerchant('Transfer: Savings'))).toEqual({ id: existing, created: false });
    const made = await withTenant(tenant.tenantId, () => findOrCreateMerchant('Transfer: Brokerage', { notes: 'made here' }));
    expect(made).toEqual({ id: expect.any(Number), created: true });
    expect(await named('transfer: brokerage')).toEqual([{ id: made.id, name: 'Transfer: Brokerage' }]);
  });

  it('gives an imported payee the merchant a concurrent request created meanwhile', async () => {
    const service = new ImportService(globalPool);
    const processMerchant = (payee: string) =>
      withTenant(tenant.tenantId, () =>
        (service as unknown as { merchants: MerchantMatcher }).merchants.match('GAS STATION 123 XX', payee, false)
      );
    const { id, result } = await whileUncommitted('Gas Station', () => processMerchant('GAS STATION'));
    expect(result).toBe(id);
    expect(await named('gas station')).toEqual([{ id, name: 'Gas Station' }]);
  });
});
