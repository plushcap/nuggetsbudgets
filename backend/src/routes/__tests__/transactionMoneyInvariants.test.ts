import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool, type PoolClient } from 'pg';
import { createTransactionsRoutes } from '../transactions.js';
import { createTransferRoutes } from '../transfer.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { insertLegacyRow } from '../../test/legacyRows.js';
import { inTransaction } from '../../test/inTransaction.js';

// Transaction edits keep the money rules: an amount is whole cents and
// signed for its type, a split's splits add up to it to the cent, and the two
// sides of a transfer stay equal and opposite (requires Postgres test DB).
describe('Money rules on transaction edits', () => {
  const stamp = Date.now();
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let checking: { id: number; uuid: string };
  let card: { id: number; uuid: string };

  const amountOf = async (id: number): Promise<string | undefined> =>
    (await pool.query('SELECT amount FROM transactions WHERE id = $1', [id])).rows[0]?.amount;
  const typeOf = async (id: number): Promise<string | undefined> =>
    (await pool.query('SELECT type FROM transactions WHERE id = $1', [id])).rows[0]?.type;
  const balanceOf = async (accountId: number): Promise<string> =>
    (await pool.query('SELECT calculate_account_balance($1) AS balance', [accountId])).rows[0].balance;
  const insert = async (amount: string | number, type: string, accountId = checking.id) =>
    (await pool.query<{ id: number; uuid: string }>(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description)
       VALUES ($1, $2, '2026-10-20', $3, 'Fixture') RETURNING id, uuid`,
      [accountId, amount, type],
    )).rows[0];
  const childrenOf = async (parentId: number): Promise<string[]> =>
    (await pool.query('SELECT amount FROM transactions WHERE parent_transaction_id = $1 ORDER BY id', [parentId])).rows.map((r) => r.amount);

  /** A -100.00 expense split into -60.00 and -40.00 through the split route. */
  const splitExpense = async () => {
    const parent = await insert(-100, 'expense');
    await request(app).post(`/api/transactions/${parent.uuid}/split`).send({ splits: [{ amount: -60 }, { amount: -40 }] }).expect(200);
    const children = (await pool.query<{ id: number; uuid: string }>(
      'SELECT id, uuid FROM transactions WHERE parent_transaction_id = $1 ORDER BY id', [parent.id],
    )).rows;
    return { parent, children };
  };

  /** A $500 checking -> card payment through the transfer route; both sides. */
  const payCard = async (amount = 500) => {
    const res = await request(app).post('/api/transfer').send({
      source_account_uuid: checking.uuid,
      destination_account_uuid: card.uuid,
      amount,
      transaction_date: '2026-10-21',
      type: 'payment',
    }).expect(200);
    const sides = (await pool.query<{ id: number; uuid: string }>(
      'SELECT id, uuid FROM transactions WHERE uuid = ANY($1::uuid[])',
      [[res.body.source_transaction_uuid, res.body.destination_transaction_uuid]],
    )).rows;
    const from = sides.find((s) => s.uuid === res.body.source_transaction_uuid)!;
    const to = sides.find((s) => s.uuid === res.body.destination_transaction_uuid)!;
    return { from, to };
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Money rules on transaction edits');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    app.use('/api/transfer', createTransferRoutes());

    checking = (await pool.query(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id, uuid`,
      [`Money Checking ${stamp}`],
    )).rows[0];
    card = (await pool.query(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'credit_card', 'credit_cards', 'Liability') RETURNING id, uuid`,
      [`Money Card ${stamp}`],
    )).rows[0];
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  describe('signs', () => {
    it('signs an edited expense negative and an income positive, as create does', async () => {
      const expense = await insert(-45.67, 'expense');
      const res = await request(app).put(`/api/transactions/${expense.uuid}`).send({ amount: 45.67 }).expect(200);
      expect(res.body.amount).toBe('-45.67');
      expect(await amountOf(expense.id)).toBe('-45.67');

      const income = await insert(100, 'income');
      await request(app).put(`/api/transactions/${income.uuid}`).send({ amount: '-120.50' }).expect(200);
      expect(await amountOf(income.id)).toBe('120.50');
    });

    it('re-signs the amount when the type changes', async () => {
      const tx = await insert(-20, 'expense');
      await request(app).put(`/api/transactions/${tx.uuid}`).send({ type: 'income' }).expect(200);
      expect(await amountOf(tx.id)).toBe('20.00');
      expect(await typeOf(tx.id)).toBe('income');
    });

    it('keeps the sign given for the other types', async () => {
      const tx = await insert(-10, 'balance adjustment');
      await request(app).put(`/api/transactions/${tx.uuid}`).send({ amount: 15 }).expect(200);
      expect(await amountOf(tx.id)).toBe('15.00');
    });

    it('refuses an unknown type, and an amount with more than 2 decimals', async () => {
      const tx = await insert(-10, 'expense');
      const type = await request(app).put(`/api/transactions/${tx.uuid}`).send({ type: 'refund' }).expect(400);
      expect(type.body.error).toMatch(/Invalid transaction type/);
      const amount = await request(app).put(`/api/transactions/${tx.uuid}`).send({ amount: -12.345 }).expect(400);
      expect(amount.body.error).toBe('amount must be a number with at most 2 decimal places');
      await request(app).put(`/api/transactions/${tx.uuid}`).send({ amount: null }).expect(400);
      expect(await amountOf(tx.id)).toBe('-10.00');
      expect(await typeOf(tx.id)).toBe('expense');
    });

    it('leaves an amount sent back unchanged as it is (a whole-form save)', async () => {
      // A positive expense from before these rules: saving the form for a note
      // doesn't move the account's balance behind the user's back.
      const legacy = await insert(5, 'expense');
      await request(app).put(`/api/transactions/${legacy.uuid}`).send({ amount: 5, type: 'expense', notes: 'note' }).expect(200);
      expect(await amountOf(legacy.id)).toBe('5.00');
      // Nor is a type the app no longer offers refused when it's sent back as it was. The
      // database takes no new one, so the row is written as an older install has it.
      const oddType = await insertLegacyRow<{ id: number; uuid: string }>(
        `INSERT INTO transactions (tenant_id, account_id, amount, transaction_date, type, description)
         VALUES ($1, $2, -5, '2026-10-20', 'refund', 'Fixture') RETURNING id, uuid`,
        [tenant.tenantId, checking.id],
      );
      await request(app).put(`/api/transactions/${oddType.uuid}`).send({ amount: -5, type: 'refund', notes: 'note' }).expect(200);
      expect(await typeOf(oddType.id)).toBe('refund');
    });

    it('refuses more than 2 decimals on create rather than rounding', async () => {
      const res = await request(app).post('/api/transactions').send({
        account_uuid: checking.uuid, amount: 12.345, transaction_date: '2026-10-20', type: 'expense', description: `Rounded ${stamp}`,
      }).expect(400);
      expect(res.body.error).toBe('amount must be a number with at most 2 decimal places');
      const stored = await pool.query('SELECT 1 FROM transactions WHERE description = $1', [`Rounded ${stamp}`]);
      expect(stored.rows).toHaveLength(0);

      const bulk = await request(app).post('/api/transactions/bulk').send({
        transactions: [
          { account_uuid: checking.uuid, amount: 12.345, transaction_date: '2026-10-20', type: 'expense' },
          { account_uuid: checking.uuid, amount: 12.34, transaction_date: '2026-10-20', type: 'expense', description: `Bulk ${stamp}` },
        ],
      }).expect(201);
      expect(bulk.body.results[0]).toMatchObject({ status: 'failed', reason: 'amount must have at most 2 decimal places' });
      expect(bulk.body.results[1].status).toBe('created');
      const created = await pool.query('SELECT amount FROM transactions WHERE description = $1', [`Bulk ${stamp}`]);
      expect(created.rows[0].amount).toBe('-12.34');
    });

    it('reads an amount as it was sent, not as Number() reads it, on create and bulk create', async () => {
      const create = (amount: unknown, description: string) =>
        request(app).post('/api/transactions').send({ account_uuid: checking.uuid, amount, transaction_date: '2026-10-20', type: 'expense', description });
      const stored = async (description: string) =>
        (await pool.query('SELECT amount FROM transactions WHERE description = $1', [description])).rows.map((r) => r.amount);

      // More decimals than 12.34, in text: refused, not read as the double nearest it.
      const precise = await create('12.3400000000000001', `Precise ${stamp}`);
      expect(precise.status, JSON.stringify(precise.body)).toBe(400);
      expect(precise.body.error).toBe('amount must be a number with at most 2 decimal places');
      // Text that isn't a decimal number isn't an amount (Number() makes these 16, 100, 1, 0).
      for (const notAnAmount of ['0x10', '1e2', true, '', '12,50']) {
        const res = await create(notAnAmount, `Not an amount ${stamp}`);
        expect(res.status, `${JSON.stringify(notAnAmount)}: ${JSON.stringify(res.body)}`).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
      // Too large for an amount says so.
      const big = await create('10000000000', `Too big ${stamp}`);
      expect(big.status, JSON.stringify(big.body)).toBe(400);
      // The request's schema refuses it, as the column can't hold it (a JSON number had no bound there).
      expect(big.body).toMatchObject({ message: 'amount must be between -9,999,999,999.99 and 9,999,999,999.99', code: 'VALIDATION_ERROR' });
      expect([...await stored(`Precise ${stamp}`), ...await stored(`Not an amount ${stamp}`), ...await stored(`Too big ${stamp}`)]).toEqual([]);

      // A JSON number and a decimal string are read as written.
      expect((await create(12.34, `As number ${stamp}`)).status).toBe(201);
      expect((await create(' 7.50 ', `As text ${stamp}`)).status).toBe(201);
      expect(await stored(`As number ${stamp}`)).toEqual(['-12.34']);
      expect(await stored(`As text ${stamp}`)).toEqual(['-7.50']);

      const row = (amount: unknown, description: string) => ({ account_uuid: checking.uuid, amount, transaction_date: '2026-10-20', type: 'expense', description });
      // In a bulk row, text that isn't a number refuses the request, as the schema does any bad row.
      const hex = await request(app).post('/api/transactions/bulk').send({ transactions: [row('0x10', `Bulk hex ${stamp}`)] });
      expect(hex.status, JSON.stringify(hex.body)).toBe(400);
      expect(await stored(`Bulk hex ${stamp}`)).toEqual([]);
      // A number written with too many decimals, or too large, fails its row, saying which.
      const bulk = await request(app).post('/api/transactions/bulk').send({
        transactions: [row('12.3400000000000001', `Bulk precise ${stamp}`), row('10000000000', `Bulk big ${stamp}`), row('3.25', `Bulk text ${stamp}`)],
      }).expect(201);
      expect(bulk.body.results.map((r: { status: string; reason?: string }) => [r.status, r.reason])).toEqual([
        ['failed', 'amount must have at most 2 decimal places'],
        ['failed', 'amount must be between -9,999,999,999.99 and 9,999,999,999.99'],
        ['created', undefined],
      ]);
      expect(await stored(`Bulk text ${stamp}`)).toEqual(['-3.25']);

      // An edit, which has no schema, reads it as sent too, and says when it's too large.
      const tx = await insert(-10, 'expense');
      for (const [amount, error] of [
        ['12.3400000000000001', 'amount must be a number with at most 2 decimal places'],
        ['0x10', 'amount must be a number with at most 2 decimal places'],
        [10000000000, 'amount must be between -9,999,999,999.99 and 9,999,999,999.99'],
      ] as const) {
        const res = await request(app).put(`/api/transactions/${tx.uuid}`).send({ amount });
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(res.body).toMatchObject({ error, code: 'INVALID_AMOUNT' });
      }
      expect(await amountOf(tx.id)).toBe('-10.00');
    });
  });

  describe('splits', () => {
    it("refuses to change a split transaction's amount or type outside the splits", async () => {
      const { parent } = await splitExpense();
      const res = await request(app).put(`/api/transactions/${parent.uuid}`).send({ amount: -120 }).expect(400);
      expect(res.body.error).toMatch(/This transaction is split/);
      await request(app).put(`/api/transactions/${parent.uuid}`).send({ type: 'income' }).expect(400);
      expect(await amountOf(parent.id)).toBe('-100.00');
      expect(await typeOf(parent.id)).toBe('expense');
      // Its other fields still save, from a form that sends the amount back unchanged.
      await request(app).put(`/api/transactions/${parent.uuid}`).send({ amount: -100, type: 'expense', notes: 'Bulk shop' }).expect(200);
    });

    it("refuses to change one split's amount, so the splits can't drift from the total", async () => {
      // The reported case: one split from -60 to -70 left -110 of splits on a -100 parent.
      const { parent, children } = await splitExpense();
      const res = await request(app).put(`/api/transactions/${children[0].uuid}`).send({ amount: -70 }).expect(400);
      expect(res.body.error).toMatch(/one split of a transaction/);
      await request(app).put(`/api/transactions/${children[0].uuid}`).send({ type: 'income' }).expect(400);
      expect(await childrenOf(parent.id)).toEqual(['-60.00', '-40.00']);
      // A magnitude that signs to the amount it already has changes nothing.
      await request(app).put(`/api/transactions/${children[0].uuid}`).send({ amount: 60, notes: 'Groceries' }).expect(200);
      expect(await childrenOf(parent.id)).toEqual(['-60.00', '-40.00']);
    });

    it("refuses to delete one split, and deletes a split transaction's splits with it", async () => {
      const { parent, children } = await splitExpense();
      const res = await request(app).delete(`/api/transactions/${children[1].uuid}`).expect(400);
      expect(res.body.error).toMatch(/one split of a transaction/);
      expect(await childrenOf(parent.id)).toEqual(['-60.00', '-40.00']);

      await request(app).delete(`/api/transactions/${parent.uuid}`).expect(200);
      expect(await amountOf(parent.id)).toBeUndefined();
      expect(await childrenOf(parent.id)).toEqual([]);
    });

    it('requires the splits to add up to the cent', async () => {
      // 1000.00 against 1000.01 differs by 0.00999999999990905 as floats, which
      // the old 0.01 tolerance let through.
      const parent = await insert('-1000.01', 'expense');
      const short = await request(app).post(`/api/transactions/${parent.uuid}/split`).send({ splits: [{ amount: -500 }, { amount: -500 }] }).expect(400);
      expect(short.body).toMatchObject({ error: 'Split amounts must sum to transaction amount', expected: -1000.01, actual: -1000 });
      expect(await childrenOf(parent.id)).toEqual([]);

      await request(app).post(`/api/transactions/${parent.uuid}/split`).send({ splits: [{ amount: -500 }, { amount: -500.01 }] }).expect(200);
      expect(await childrenOf(parent.id)).toEqual(['-500.00', '-500.01']);
    });

    describe('made at the same time as an edit', () => {
      // Another request holds the transaction's row (as a concurrent edit does);
      // `fragment` is the locking read the request under test should wait in.
      const whileHeld = async (id: number, fragment: string, send: () => Promise<request.Response>, then: (client: PoolClient) => Promise<void>) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT 1 FROM transactions WHERE id = $1 FOR UPDATE', [id]);
          const pending = send();
          // Wait (up to 2s) for the request to block on the row, then change it.
          for (let i = 0; i < 100; i++) {
            const waiting = await pool.query(
              `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1`, [`%${fragment}%`],
            );
            if (waiting.rows.length > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          await then(client);
          await client.query('COMMIT');
          return await pending;
        } finally {
          client.release();
        }
      };

      it('checks the splits against the amount the edit leaves', async () => {
        const parent = await insert(-100, 'expense');
        const res = await whileHeld(
          parent.id,
          'from "transactions" where "uuid" = $1 for update',
          () => request(app).post(`/api/transactions/${parent.uuid}/split`).send({ splits: [{ amount: -60 }, { amount: -40 }] }).then((r) => r),
          async (client) => { await client.query('UPDATE transactions SET amount = -120 WHERE id = $1', [parent.id]); },
        );
        expect(res.status).toBe(400);
        expect(await childrenOf(parent.id)).toEqual([]);
      });

      it("doesn't change the amount of a transaction split meanwhile", async () => {
        const parent = await insert(-100, 'expense');
        const res = await whileHeld(
          parent.id,
          'order by "id" for update',
          () => request(app).put(`/api/transactions/${parent.uuid}`).send({ amount: -120 }).then((r) => r),
          async (client) => {
            await client.query('UPDATE transactions SET is_split_parent = true WHERE id = $1', [parent.id]);
            await client.query(
              `INSERT INTO transactions (account_id, amount, transaction_date, type, parent_transaction_id)
               VALUES ($1, -60, '2026-10-20', 'expense', $2), ($1, -40, '2026-10-20', 'expense', $2)`,
              [checking.id, parent.id],
            );
          },
        );
        expect(res.status).toBe(400);
        expect(await amountOf(parent.id)).toBe('-100.00');
      });
    });

    it('refuses split amounts with more than 2 decimals instead of rounding them', async () => {
      // -33.333 x2 and -33.334 add up to -100, but the database rounds each to
      // -33.33, which left -99.99 of splits on a -100.00 transaction.
      const parent = await insert(-100, 'expense');
      const res = await request(app)
        .post(`/api/transactions/${parent.uuid}/split`)
        .send({ splits: [{ amount: -33.333 }, { amount: -33.333 }, { amount: -33.334 }] })
        .expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Each split amount must have at most 2 decimal places' });
      expect(await childrenOf(parent.id)).toEqual([]);

      await request(app)
        .post(`/api/transactions/${parent.uuid}/split`)
        .send({ splits: [{ amount: -33.33 }, { amount: -33.33 }, { amount: -33.34 }] })
        .expect(200);
      expect(await childrenOf(parent.id)).toEqual(['-33.33', '-33.33', '-33.34']);
    });
  });

  describe('transfers', () => {
    it('moves both sides when one side gets a new amount', async () => {
      const { from, to } = await payCard();
      expect([await amountOf(from.id), await amountOf(to.id)]).toEqual(['-500.00', '500.00']);

      await request(app).put(`/api/transactions/${from.uuid}`).send({ amount: -550 }).expect(200);
      expect([await amountOf(from.id), await amountOf(to.id)]).toEqual(['-550.00', '550.00']);

      await request(app).put(`/api/transactions/${to.uuid}`).send({ amount: 600 }).expect(200);
      expect([await amountOf(from.id), await amountOf(to.id)]).toEqual(['-600.00', '600.00']);
    });

    it("takes both sides' locks in id order, so edits of the two sides can't deadlock", async () => {
      const { from, to } = await payCard();
      const [lower, higher] = [from, to].sort((a, b) => a.id - b.id);
      // Another edit holds the lower side, as an edit of that side does first.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT 1 FROM transactions WHERE id = $1 FOR UPDATE', [lower.id]);
        // .then() sends it now; supertest sends a request only once it's awaited.
        const pending = request(app).put(`/api/transactions/${higher.uuid}`).send({ amount: higher.id === to.id ? 650 : -650 }).then((r) => r);
        for (let i = 0; i < 100; i++) {
          const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%for update%' AND pid <> pg_backend_pid()`);
          if (waiting.rows.length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        // The edit waits for the lower side before it takes the higher one, so this
        // gets it at once. Locked the other way round, the two would deadlock.
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query('SELECT 1 FROM transactions WHERE id = $1 FOR UPDATE', [higher.id]);
        await client.query('COMMIT');
        expect((await pending).status).toBe(200);
      } finally {
        client.release();
      }
      expect([await amountOf(from.id), await amountOf(to.id)]).toEqual(['-650.00', '650.00']);
    });

    it('refuses an amount of 0 on either side, as creating a transfer does', async () => {
      const { from, to } = await payCard();
      for (const [side, amount] of [[from, 0], [to, '0.00']] as const) {
        const res = await request(app).put(`/api/transactions/${side.uuid}`).send({ amount, description: 'Zeroed' }).expect(400);
        expect(res.body.code).toBe('TRANSFER_AMOUNT_ZERO');
        expect(res.body.error).toMatch(/can't be 0/);
      }
      // Nothing was written: both sides keep their amounts, and the description sent with it.
      expect([await amountOf(from.id), await amountOf(to.id)]).toEqual(['-500.00', '500.00']);
      const descriptions = await pool.query('SELECT description FROM transactions WHERE id = ANY($1::int[])', [[from.id, to.id]]);
      expect(descriptions.rows.map((r) => r.description)).not.toContain('Zeroed');

      // An amount sent back as it is (a whole-form save) still saves the rest.
      await request(app).put(`/api/transactions/${from.uuid}`).send({ amount: -500, description: 'Card payment' }).expect(200);
      expect([await amountOf(from.id), await amountOf(to.id)]).toEqual(['-500.00', '500.00']);
    });

    it('keeps each side in its direction when sent a magnitude', async () => {
      const { from, to } = await payCard();
      await request(app).put(`/api/transactions/${from.uuid}`).send({ amount: 700 }).expect(200);
      expect([await amountOf(from.id), await amountOf(to.id)]).toEqual(['-700.00', '700.00']);
    });

    it('changes the type of both sides between payment and transfer, and refuses other types', async () => {
      const { from, to } = await payCard();
      await request(app).put(`/api/transactions/${to.uuid}`).send({ type: 'transfer' }).expect(200);
      expect([await typeOf(from.id), await typeOf(to.id)]).toEqual(['transfer', 'transfer']);

      const res = await request(app).put(`/api/transactions/${from.uuid}`).send({ type: 'expense' }).expect(400);
      expect(res.body.error).toMatch(/one side of a transfer/);
      expect([await typeOf(from.id), await typeOf(to.id)]).toEqual(['transfer', 'transfer']);
      expect([await amountOf(from.id), await amountOf(to.id)]).toEqual(['-500.00', '500.00']);
    });

    it("refuses a new amount when the other side is split, since its splits wouldn't add up", async () => {
      const { from, to } = await payCard();
      // A side split before the rule that no side of a transfer is split: the
      // route refuses one now, so it is written as the database takes one.
      await inTransaction(pool, async (client) => {
        const side = (await client.query(`UPDATE transactions SET is_split_parent = true WHERE id = $1 RETURNING account_id, type`, [to.id])).rows[0];
        for (const amount of [300, 200]) {
          await client.query(
            `INSERT INTO transactions (parent_transaction_id, account_id, amount, type, transaction_date) VALUES ($1, $2, $3, $4, '2026-10-21')`,
            [to.id, side.account_id, amount, side.type],
          );
        }
      });
      const res = await request(app).put(`/api/transactions/${from.uuid}`).send({ amount: -550 }).expect(400);
      expect(res.body.error).toMatch(/other side of this transfer is split/);
      expect([await amountOf(from.id), await amountOf(to.id)]).toEqual(['-500.00', '500.00']);
    });

    it('deletes both sides together', async () => {
      // The reported case: deleting the checking side of a card payment left the
      // card's credit, so the household's net worth rose by the payment.
      const before = { checking: await balanceOf(checking.id), card: await balanceOf(card.id) };
      const { from, to } = await payCard();
      await request(app).delete(`/api/transactions/${from.uuid}`).expect(200);
      expect(await amountOf(from.id)).toBeUndefined();
      expect(await amountOf(to.id)).toBeUndefined();
      expect({ checking: await balanceOf(checking.id), card: await balanceOf(card.id) }).toEqual(before);
    });

    it('refuses a transfer amount with more than 2 decimals', async () => {
      const res = await request(app).post('/api/transfer').send({
        source_account_uuid: checking.uuid, destination_account_uuid: card.uuid, amount: 10.005, transaction_date: '2026-10-21', type: 'payment',
      }).expect(400);
      expect(res.body.error).toBe('Amount must have at most 2 decimal places');
    });
  });
});
