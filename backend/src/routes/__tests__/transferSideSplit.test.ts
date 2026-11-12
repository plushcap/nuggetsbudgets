import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createTransactionsRoutes } from '../transactions.js';
import { createTransferRoutes } from '../transfer.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * By design, a side of a transfer isn't split. A
 * split moved the side's envelope to its splits, so one transfer read as several budget
 * moves on one side and one on the other. POST /:uuid/split on either side answers 409
 * TRANSFER_SPLIT_REFUSED, nothing written. A side split before this rule keeps its splits
 * (it is read, and can be unsplit), but isn't split again.
 */
describe('A split on a side of a transfer', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let checking: number;
  let savings: number;
  let source: string;
  let destination: string;

  const splitsOf = async (uuid: string) =>
    (
      await pool.query(
        `SELECT c.amount::text AS amount FROM transactions c JOIN transactions p ON p.id = c.parent_transaction_id
          WHERE p.uuid = $1 ORDER BY c.id`,
        [uuid],
      )
    ).rows.map((r) => r.amount as string);
  const row = async (uuid: string) =>
    (await pool.query(`SELECT is_split_parent, amount::text AS amount FROM transactions WHERE uuid = $1`, [uuid])).rows[0];

  beforeAll(async () => {
    tenant = await createTestTenant('Transfer side split');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    app.use('/api/transfer', createTransferRoutes());
    const account = async (name: string) =>
      (
        await pool.query(
          `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id`,
          [name],
        )
      ).rows[0].id as number;
    checking = await account('Split checking');
    savings = await account('Split savings');
    const transfer = await request(app).post('/api/transfer').send({
      source_account_id: checking, destination_account_id: savings, amount: 40, transaction_date: '2026-06-16', type: 'transfer',
    });
    expect(transfer.status).toBe(200);
    source = transfer.body.source_transaction_uuid;
    destination = transfer.body.destination_transaction_uuid;
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('is refused on either side with 409 TRANSFER_SPLIT_REFUSED, nothing written', async () => {
    for (const [uuid, amount] of [[source, -20], [destination, 20]] as const) {
      const res = await request(app).post(`/api/transactions/${uuid}/split`).send({ splits: [{ amount }, { amount }] });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'TRANSFER_SPLIT_REFUSED', error: "A transfer can't be split" });
      expect(res.body.message).toMatch(/one side of a transfer/);
      expect(await row(uuid)).toMatchObject({ is_split_parent: false });
      expect(await splitsOf(uuid)).toEqual([]);
    }
  });

  it('leaves a side split before the rule as it is: read, not split again, and unsplit', async () => {
    // A split recorded before the rule, written as the database takes one (parent and splits
    // in one transaction).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const parent = (
        await client.query(`UPDATE transactions SET is_split_parent = true WHERE uuid = $1 RETURNING id, account_id, type`, [source])
      ).rows[0];
      for (const amount of [-30, -10]) {
        await client.query(
          `INSERT INTO transactions (parent_transaction_id, account_id, amount, type, transaction_date)
           VALUES ($1, $2, $3, $4, '2026-06-16')`,
          [parent.id, parent.account_id, amount, parent.type],
        );
      }
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const read = await request(app).get(`/api/transactions/${source}`);
    expect(read.status).toBe(200);
    expect(read.body.split_children.map((c: { amount: string }) => Number(c.amount))).toEqual([-30, -10]);

    const again = await request(app).post(`/api/transactions/${source}/split`).send({ splits: [{ amount: -20 }, { amount: -20 }] });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('TRANSFER_SPLIT_REFUSED');
    expect(await splitsOf(source)).toEqual(['-30.00', '-10.00']);

    // Nor is one of its splits split: that wrote a third level under the side.
    const child = (await pool.query(`SELECT c.uuid FROM transactions c JOIN transactions p ON p.id = c.parent_transaction_id WHERE p.uuid = $1 ORDER BY c.id LIMIT 1`, [source])).rows[0].uuid;
    const deeper = await request(app).post(`/api/transactions/${child}/split`).send({ splits: [{ amount: -15 }, { amount: -15 }] });
    expect(deeper.status).toBe(409);
    expect(deeper.body.code).toBe('SPLIT_OF_SPLIT_REFUSED');
    expect(await splitsOf(child)).toEqual([]);
    expect(await row(child)).toMatchObject({ is_split_parent: false, amount: '-30.00' });

    const unsplit = await request(app).delete(`/api/transactions/${source}/unsplit`);
    expect(unsplit.status).toBe(200);
    expect(await row(source)).toEqual({ is_split_parent: false, amount: '-40.00' });
    expect(await splitsOf(source)).toEqual([]);
  });

  it('refuses a split of one split of an ordinary transaction with 409 SPLIT_OF_SPLIT_REFUSED, nothing written', async () => {
    const parent = (
      await pool.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, type) VALUES ($1, -50, '2026-06-17', 'expense') RETURNING uuid`,
        [checking],
      )
    ).rows[0].uuid as string;
    const split = await request(app).post(`/api/transactions/${parent}/split`).send({ splits: [{ amount: -20 }, { amount: -30 }] });
    expect(split.status).toBe(200);
    const child = split.body.split_children[0].uuid as string;

    const res = await request(app).post(`/api/transactions/${child}/split`).send({ splits: [{ amount: -10 }, { amount: -10 }] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SPLIT_OF_SPLIT_REFUSED', error: "A split can't be split again" });
    expect(await splitsOf(child)).toEqual([]);
    expect(await row(child)).toMatchObject({ is_split_parent: false, amount: '-20.00' });
    expect(await splitsOf(parent)).toEqual(['-20.00', '-30.00']);
  });
});
