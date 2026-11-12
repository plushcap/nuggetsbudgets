import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { createTransferRoutes } from '../transfer.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * POST /api/transfer reads its amount as sent, in whole cents. The shared schema
 * coerced it to a float first, so "1e2" moved 100.00, "12.3400000000000001" moved 12.34,
 * and true moved 1.00. Text that isn't a decimal number, or has more than 2 decimals, is
 * refused with nothing written; a number and the same amount as text write the same pair.
 */
describe('POST /api/transfer amount', () => {
  let app: Express;
  let tenant: TestTenant;
  let checking: number;
  let savings: number;

  beforeAll(async () => {
    tenant = await createTestTenant('transfer amount input');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transfer', createTransferRoutes());
    const account = async (name: string) =>
      (
        await tenant.pool.query<{ id: number }>(
          `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id`,
          [name],
        )
      ).rows[0].id;
    checking = await account('Transfer amount checking');
    savings = await account('Transfer amount savings');
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  const transfer = (amount: unknown) =>
    request(app).post('/api/transfer').send({
      source_account_id: checking,
      destination_account_id: savings,
      amount,
      transaction_date: '2026-06-16',
      type: 'transfer',
    });
  const written = async () => Number((await tenant.pool.query('SELECT count(*) FROM transactions')).rows[0].count);

  it.each([['1e2'], ['0x10'], [''], [true], ['12.3400000000000001'], ['100.005'], [100.005], ['-5'], [0], ['abc']])(
    'refuses %j with a 400 and writes nothing',
    async (amount) => {
      const before = await written();
      const res = await transfer(amount);
      expect(res.status).toBe(400);
      expect(await written()).toBe(before);
    },
  );

  it('writes the same pair for a number and for the same amount as text', async () => {
    for (const amount of [12.34, '12.34', ' 12.340 ']) {
      const res = await transfer(amount);
      expect(res.status).toBe(200);
      const { rows } = await tenant.pool.query<{ amount: string }>(
        'SELECT amount FROM transactions WHERE uuid = ANY($1) ORDER BY amount',
        [[res.body.source_transaction_uuid, res.body.destination_transaction_uuid]],
      );
      expect(rows.map((r) => r.amount)).toEqual(['-12.34', '12.34']);
    }
  });
});
