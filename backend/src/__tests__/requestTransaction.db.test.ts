import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express, Response } from 'express';
import { sql } from 'kysely';
import { getDb, withSavepoint } from '../db/withTenant.js';
import { tenantHandler, type AuthenticatedRequest } from '../utils/routeHandler.js';
import { createTransactionsRoutes } from '../routes/transactions.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * A request's writes commit only when it answers 2xx/3xx, and a database error that a
 * handler catches can't turn its COMMIT into a silent ROLLBACK.
 *
 * Before: a handler that wrote and then answered 400 committed the write (a re-split
 * whose amounts didn't add up deleted the old splits for good), and a handler that
 * caught a database error answered 200 while PostgreSQL rolled everything back.
 */
describe('Request transactions', () => {
  const stamp = Date.now();
  let tenant: TestTenant;
  let app: Express;

  const tagExists = async (name: string) =>
    (await tenant.pool.query('SELECT 1 FROM tags WHERE name = $1', [name])).rowCount === 1;

  const addTag = (name: string) => getDb().insertInto('tags').values({ name }).execute();

  beforeAll(async () => {
    tenant = await createTestTenant('Request transactions');
    app = express();
    app.use(express.json());
    app.use(tenant.context());

    app.post('/answer/:status', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
      await addTag(String(req.body.name));
      res.status(Number(req.params.status)).json({ ok: true });
    }));
    app.post('/swallow', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
      await addTag(String(req.body.name));
      try {
        await sql`SELECT 1 / 0`.execute(getDb());
      } catch {
        // carry on, as several services did
      }
      res.json({ ok: true });
    }));
    app.post('/savepoint', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
      await addTag(`${req.body.name} before`);
      try {
        await withSavepoint(async () => {
          await addTag(`${req.body.name} inside`);
          await sql`SELECT 1 / 0`.execute(getDb());
        });
      } catch {
        // allowed to fail
      }
      const value = await withSavepoint(async () => {
        await addTag(`${req.body.name} kept`);
        return 7;
      });
      await addTag(`${req.body.name} after`);
      res.json({ value });
    }));
    app.use('/api/transactions', createTransactionsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('commits the writes of a request that succeeds', async () => {
    await request(app).post('/answer/201').send({ name: `ok ${stamp}` }).expect(201);
    expect(await tagExists(`ok ${stamp}`)).toBe(true);
  });

  it.each([400, 404, 409, 422, 500])('rolls back the writes of a request that answers %i', async (status) => {
    const name = `answered ${status} ${stamp}`;
    const res = await request(app).post(`/answer/${status}`).send({ name }).expect(status);
    expect(res.body).toEqual({ ok: true });
    expect(await tagExists(name)).toBe(false);
  });

  it('answers 500, not success, when a caught database error aborted the transaction', async () => {
    const name = `swallowed ${stamp}`;
    await request(app).post('/swallow').send({ name }).expect(500);
    expect(await tagExists(name)).toBe(false);
  });

  it('lets a savepoint fail without losing the rest of the transaction', async () => {
    const name = `sp ${stamp}`;
    const res = await request(app).post('/savepoint').send({ name }).expect(200);
    expect(res.body).toEqual({ value: 7 });
    expect(await tagExists(`${name} before`)).toBe(true);
    expect(await tagExists(`${name} inside`)).toBe(false);
    expect(await tagExists(`${name} kept`)).toBe(true);
    expect(await tagExists(`${name} after`)).toBe(true);
  });

  it('keeps the existing splits when a re-split does not add up', async () => {
    const pool = tenant.pool;
    const account = (
      await pool.query(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id`,
        [`Re-split ${stamp}`]
      )
    ).rows[0].id;
    const parent = (
      await pool.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description)
         VALUES ($1, -100, '2026-10-20', 'expense', 'Store') RETURNING id, uuid`,
        [account]
      )
    ).rows[0];
    const split = (splits: { amount: number }[]) =>
      request(app).post(`/api/transactions/${parent.uuid}/split`).send({ splits });

    await split([{ amount: -60 }, { amount: -40 }]).expect(200);
    const children = async () =>
      (
        await pool.query('SELECT amount FROM transactions WHERE parent_transaction_id = $1 ORDER BY amount', [parent.id])
      ).rows.map((r) => r.amount);
    expect(await children()).toEqual(['-60.00', '-40.00']);

    // The sign mistake the MCP split tool warns about: +60/+40 on a -100 parent.
    const res = await split([{ amount: 60 }, { amount: 40 }]).expect(400);
    expect(res.body.error).toBe('Split amounts must sum to transaction amount');
    expect(await children()).toEqual(['-60.00', '-40.00']);
  });
});
