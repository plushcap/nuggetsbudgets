import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type { Pool } from 'pg';
import { createTransactionsRoutes } from '../routes/transactions.js';
import { createAccountsRoutes } from '../routes/accounts.js';
import { createMerchantsRoutes } from '../routes/merchants.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import { inTransaction } from '../test/inTransaction.js';
import { insertLegacyRow } from '../test/legacyRows.js';

/**
 * The database refuses an invalid ledger: each rule here is written around the app,
 * as the app role under RLS (`tenant.pool`), and the write is refused; then the app's own
 * flows still work. The migrations' handling of existing rows is in
 * tenantInvariantsMigrations.db.test.ts.
 */

type Ref = { id: number; uuid: string };

async function pgError(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error('expected the statement to be refused');
}

const CHECK = '23514';
const NOT_NULL = '23502';
const RESTRICT = '23001';

describe('Ledger invariants in the schema', () => {
  let tenant: TestTenant;
  let pool: Pool;
  let app: Express;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let account: Ref;
  let budgetItem: Ref;
  let period: Ref;
  let periodItem: Ref;
  let merchant: Ref;
  let tag: Ref;

  const one = async (text: string, params: unknown[] = [], db: Pick<Pool, 'query'> = pool): Promise<Ref> =>
    (await db.query<Ref>(`${text} RETURNING id, uuid`, params)).rows[0];
  const transaction = (values: { amount?: number | null; type?: string; status?: string; review_status?: string } = {}, db: Pick<Pool, 'query'> = pool) =>
    one(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, status, review_status, description)
       VALUES ($1, $2, '2026-10-20', $3, $4, $5, 'Invariant')`,
      [account.id, values.amount === undefined ? -10 : values.amount, values.type ?? 'expense', values.status ?? 'cleared', values.review_status ?? 'needs review'],
      db
    );

  beforeAll(async () => {
    tenant = await createTestTenant('Ledger invariants');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    app.use('/api/accounts', createAccountsRoutes());
    app.use('/api/merchants', createMerchantsRoutes());

    account = await one(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset')`, [
      `Invariant checking ${stamp}`,
    ]);
    budgetItem = await one(`INSERT INTO budget_items (name, expense_type) VALUES ($1, 'Expense')`, [`Invariant item ${stamp}`]);
    period = await one(
      `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
       VALUES ($1, 'October', 2026, 10, '2026-10-01', '2026-10-31')`,
      [`Invariant period ${stamp}`]
    );
    periodItem = await one('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2)', [period.id, budgetItem.id]);
    merchant = await one('INSERT INTO merchants (name) VALUES ($1)', [`Invariant merchant ${stamp}`]);
    tag = await one('INSERT INTO tags (name) VALUES ($1)', [`Invariant tag ${stamp}`]);
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  describe('vocabulary', () => {
    it("refuses a transaction type, status or review status the app doesn't use", async () => {
      expect((await pgError(transaction({ type: 'Expense' }))).code).toBe(CHECK);
      expect((await pgError(transaction({ status: 'Reconciled' }))).code).toBe(CHECK);
      expect((await pgError(transaction({ review_status: 'needs_review' }))).code).toBe(CHECK);
      const tx = await transaction();
      expect((await pgError(pool.query(`UPDATE transactions SET budget_matching_method = 'guess' WHERE id = $1`, [tx.id]))).code).toBe(CHECK);
      await pool.query(`UPDATE transactions SET status = 'reconciled', review_status = 'flagged', budget_matching_method = 'merchant-rule' WHERE id = $1`, [tx.id]);
    });

    it('keeps a value from before the enums on a row that has one, and nothing else', async () => {
      const legacy = await insertLegacyRow<Ref>(
        `INSERT INTO transactions (tenant_id, account_id, amount, transaction_date, type, status)
         VALUES ($1, $2, -3, '2026-10-20', 'refund', 'Posted') RETURNING id, uuid`,
        [tenant.tenantId, account.id]
      );
      await pool.query(`UPDATE transactions SET notes = 'kept', type = type, status = status WHERE id = $1`, [legacy.id]);
      expect((await pgError(pool.query(`UPDATE transactions SET type = 'rebate' WHERE id = $1`, [legacy.id]))).code).toBe(CHECK);
      await pool.query(`UPDATE transactions SET type = 'expense', status = 'cleared' WHERE id = $1`, [legacy.id]);

      const oldAccount = await insertLegacyRow<Ref>(
        `INSERT INTO accounts (tenant_id, name, account_type, account_group, type)
         VALUES ($1, $2, 'Checking', 'Banking', 'Asset') RETURNING id, uuid`,
        [tenant.tenantId, `Legacy account ${stamp}`]
      );
      await pool.query(`UPDATE accounts SET name = name || ' renamed', account_group = 'Banking' WHERE id = $1`, [oldAccount.id]);
      expect((await pgError(pool.query(`UPDATE accounts SET account_group = 'Brokerage' WHERE id = $1`, [oldAccount.id]))).code).toBe(CHECK);
      expect(
        (await pgError(pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('New', 'checking', 'Banking', 'Asset')`)))
          .code
      ).toBe(CHECK);
    });

    it('refuses an unknown budget item kind or priority, budget event, notification, tagging or annotation value', async () => {
      const refused = [
        () => pool.query(`INSERT INTO budget_items (name, expense_type) VALUES ('x', 'expense')`),
        () => pool.query(`INSERT INTO budget_items (name, priority) VALUES ('x', 'High')`),
        () => pool.query(
          `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
           VALUES ($1, $2, 'subtract', 'budget_update', 5)`,
          [periodItem.id, budgetItem.id]
        ),
        () => pool.query(
          `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
           VALUES ($1, $2, 'add', 'budget', 5)`,
          [periodItem.id, budgetItem.id]
        ),
        () => pool.query(
          `INSERT INTO notifications (user_id, recipient_email, notification_type, subject, template_data, status)
           VALUES ($1, 'x@test.local', 'test', 's', '{}', 'queued')`,
          [tenant.userId]
        ),
        () => pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'Transaction', 1)`, [tag.id]),
        () => pool.query(`INSERT INTO annotations (subject_type, subject_id, kind, body) VALUES ('transaction', 1, 'chat', 'x')`),
      ];
      for (const attempt of refused) {
        expect((await pgError(attempt())).code).toBe(CHECK);
      }
    });

    it('PUT /transactions/:uuid answers 400 for a status or review status outside the enums', async () => {
      const tx = await transaction();
      const status = await request(app).put(`/api/transactions/${tx.uuid}`).send({ status: 'Reconciled' });
      expect(status.status).toBe(400);
      expect(status.body.error).toMatch(/status/);
      const review = await request(app).put(`/api/transactions/${tx.uuid}`).send({ review_status: 'needs_review' });
      expect(review.status).toBe(400);
      await request(app).put(`/api/transactions/${tx.uuid}`).send({ status: 'reconciled', review_status: 'reviewed' }).expect(200);

      // A row from before the enums saves with its own value sent back (a whole-form save).
      const legacy = await insertLegacyRow<Ref>(
        `INSERT INTO transactions (tenant_id, account_id, amount, transaction_date, type, status) VALUES ($1, $2, -3, '2026-10-20', 'expense', 'Posted') RETURNING id, uuid`,
        [tenant.tenantId, account.id]
      );
      await request(app).put(`/api/transactions/${legacy.uuid}`).send({ status: 'Posted', notes: 'kept' }).expect(200);
      expect((await request(app).put(`/api/transactions/${legacy.uuid}`).send({ status: 'Settled' })).status).toBe(400);
    });

    it('serves the review filter from its index (needs review, with a space)', async () => {
      const def = (await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_transactions_review_status_date'`)).rows[0].indexdef;
      expect(def).toContain("'needs review'");
    });
  });

  describe('money', () => {
    it('refuses a negative income, but not a negative split of one', async () => {
      expect((await pgError(transaction({ type: 'income', amount: -5 }))).code).toBe(CHECK);
      await inTransaction(pool, async (client) => {
        const pay = await one(
          `INSERT INTO transactions (account_id, amount, transaction_date, type, is_split_parent) VALUES ($1, 1000, '2026-10-20', 'income', true)`,
          [account.id],
          client
        );
        await client.query(
          `INSERT INTO transactions (account_id, amount, transaction_date, type, parent_transaction_id)
           VALUES ($1, 1200, '2026-10-20', 'income', $2), ($1, -200, '2026-10-20', 'income', $2)`,
          [account.id, pay.id]
        );
      });
    });

    it('lets a negative income from before the rule save unchanged, not change to another', async () => {
      const legacy = await insertLegacyRow<Ref>(
        `INSERT INTO transactions (tenant_id, account_id, amount, transaction_date, type) VALUES ($1, $2, -7, '2026-10-20', 'income') RETURNING id, uuid`,
        [tenant.tenantId, account.id]
      );
      await pool.query(`UPDATE transactions SET notes = 'note', amount = -7, type = 'income' WHERE id = $1`, [legacy.id]);
      expect((await pgError(pool.query('UPDATE transactions SET amount = -8 WHERE id = $1', [legacy.id]))).code).toBe(CHECK);
    });

    it('refuses a negative budget event', async () => {
      const err = await pgError(
        pool.query(
          `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
           VALUES ($1, $2, 'remove', 'budget_update', -50)`,
          [periodItem.id, budgetItem.id]
        )
      );
      expect(err.code).toBe(CHECK);
    });

    describe('splits add up when the transaction commits', () => {
      const split = (parentAmount: number, children: number[], flagParent = true) =>
        inTransaction(pool, async (client) => {
          const parent = await one(
            `INSERT INTO transactions (account_id, amount, transaction_date, type, is_split_parent) VALUES ($1, $2, '2026-10-20', 'expense', $3)`,
            [account.id, parentAmount, flagParent],
            client
          );
          for (const amount of children) {
            await client.query(
              `INSERT INTO transactions (account_id, amount, transaction_date, type, parent_transaction_id) VALUES ($1, $2, '2026-10-20', 'expense', $3)`,
              [account.id, amount, parent.id]
            );
          }
          return parent;
        });

      it('refuses splits that miss the amount, a split mark with no splits, and splits of an unmarked transaction', async () => {
        expect((await pgError(split(-100, [-60, -39.99]))).message).toMatch(/add up to -99.99, not its amount -100.00/);
        expect((await pgError(split(-100, []))).code).toBe(CHECK);
        expect((await pgError(split(-100, [-60, -40], false))).message).toMatch(/not marked split/);
        const ok = await split(-100, [-60, -40]);
        // Changing a split's amount without its parent is refused too.
        const [child] = (await pool.query('SELECT id FROM transactions WHERE parent_transaction_id = $1 ORDER BY id', [ok.id])).rows;
        expect((await pgError(pool.query('UPDATE transactions SET amount = -61 WHERE id = $1', [child.id]))).code).toBe(CHECK);
        expect((await pgError(pool.query('DELETE FROM transactions WHERE id = $1', [child.id]))).code).toBe(CHECK);
        // Deleting the whole split is fine (its splits go with it).
        await pool.query('DELETE FROM transactions WHERE id = $1', [ok.id]);
      });

      it('still splits and unsplits through the routes', async () => {
        const tx = await transaction({ amount: -50 });
        await request(app).post(`/api/transactions/${tx.uuid}/split`).send({ splits: [{ amount: -20 }, { amount: -30 }] }).expect(200);
        await request(app).post(`/api/transactions/${tx.uuid}/split`).send({ splits: [{ amount: -25 }, { amount: -25 }] }).expect(200);
        await request(app).delete(`/api/transactions/${tx.uuid}/unsplit`).expect(200);
        expect((await pool.query('SELECT count(*)::int AS n FROM transactions WHERE parent_transaction_id = $1', [tx.id])).rows[0].n).toBe(0);
      });
    });

    describe('a transfer is a pair', () => {
      const pair = (amountA: number, amountB: number, linkBack = true) =>
        inTransaction(pool, async (client) => {
          const a = await one(`INSERT INTO transactions (account_id, amount, transaction_date, type) VALUES ($1, $2, '2026-10-20', 'transfer')`, [account.id, amountA], client);
          const b = await one(`INSERT INTO transactions (account_id, amount, transaction_date, type) VALUES ($1, $2, '2026-10-20', 'transfer')`, [account.id, amountB], client);
          await client.query('UPDATE transactions SET transfer_transaction_id = $1 WHERE id = $2', [b.id, a.id]);
          if (linkBack) await client.query('UPDATE transactions SET transfer_transaction_id = $1 WHERE id = $2', [a.id, b.id]);
          return { a, b };
        });

      it('refuses a one-sided link and sides that are not equal and opposite', async () => {
        expect((await pgError(pair(-10, 10, false))).message).toMatch(/does not name it back/);
        expect((await pgError(pair(-10, 9))).message).toMatch(/not equal and opposite/);
        const { a } = await pair(-10, 10);
        expect((await pgError(pool.query('UPDATE transactions SET amount = -11 WHERE id = $1', [a.id]))).code).toBe(CHECK);
      });
    });
  });

  describe('NOT NULL', () => {
    it('refuses a transaction without an account or an amount, and core NULLs elsewhere', async () => {
      const refused = [
        () => pool.query(`INSERT INTO transactions (amount, transaction_date, type) VALUES (-1, '2026-10-20', 'expense')`),
        () => transaction({ amount: null }),
        () => pool.query(`INSERT INTO budget_period_items (budget_item_id) VALUES ($1)`, [budgetItem.id]),
        () => pool.query(`INSERT INTO budget_period_transactions (budget_item_id, transaction_type, type, amount) VALUES ($1, 'add', 'budget_update', 1)`, [
          budgetItem.id,
        ]),
        () => pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES (NULL, 'transaction', 1)`),
        () => pool.query('UPDATE accounts SET hide_account = NULL WHERE id = $1', [account.id]),
        () => pool.query('UPDATE budget_items SET rollover = NULL WHERE id = $1', [budgetItem.id]),
        () => pool.query('UPDATE merchants SET created_at = NULL WHERE id = $1', [merchant.id]),
        () => pool.query(`UPDATE transactions SET status = NULL WHERE account_id = $1`, [account.id]),
      ];
      for (const attempt of refused) {
        expect((await pgError(attempt())).code).toBe(NOT_NULL);
      }
    });
  });

  describe('ON DELETE', () => {
    it("never deletes an account's transactions with it; the route deletes one with only its opening balance", async () => {
      const acct = await one(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'savings', 'cash', 'Asset')`, [
        `Delete me ${stamp}`,
      ]);
      const opening = await one(
        `INSERT INTO transactions (account_id, amount, transaction_date, type) VALUES ($1, 100, '2026-10-01', 'starting balance')`,
        [acct.id]
      );
      expect((await pgError(pool.query('DELETE FROM accounts WHERE id = $1', [acct.id]))).code).toBe(RESTRICT);
      await one(`INSERT INTO import_sync_log (sync_type, sync_status, sync_trigger, account_id) VALUES ('account', 'completed', 'manual', $1)`, [acct.id]);

      await request(app).delete(`/api/accounts/${acct.uuid}`).expect(200);
      expect((await pool.query('SELECT 1 FROM transactions WHERE id = $1', [opening.id])).rows).toEqual([]);
      // The sync log stays, without its account.
      expect((await pool.query('SELECT account_id FROM import_sync_log WHERE uuid IS NOT NULL AND account_id IS NULL')).rows.length).toBeGreaterThan(0);
    });

    it('never deletes budget events or receipts with their period item, merchant or budget item', async () => {
      const item = await one(`INSERT INTO budget_items (name) VALUES ($1)`, [`Event item ${stamp}`]);
      const pi = await one('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2)', [period.id, item.id]);
      await pool.query(
        `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount) VALUES ($1, $2, 'add', 'budget_update', 5)`,
        [pi.id, item.id]
      );
      expect((await pgError(pool.query('DELETE FROM budget_period_items WHERE id = $1', [pi.id]))).code).toBe(RESTRICT);

      const shop = await one('INSERT INTO merchants (name) VALUES ($1)', [`Receipt shop ${stamp}`]);
      await pool.query(
        `INSERT INTO attachments (name, original_filename, safe_filename, file_extension, file_name, merchant_id, budget_item_id)
         VALUES ('r', 'r.pdf', 'r.pdf', 'pdf', 'r.pdf', $1, $2)`,
        [shop.id, item.id]
      );
      expect((await pgError(pool.query('DELETE FROM merchants WHERE id = $1', [shop.id]))).code).toBe(RESTRICT);
      // The merchant route says so, rather than failing.
      const res = await request(app).delete(`/api/merchants/${shop.uuid}`).send({});
      expect(res.status).toBe(409);
      expect(res.body.usage.attachments).toBe(1);
    });

    it('gives every foreign key an index', async () => {
      const unindexed = await pool.query<{ fk: string }>(
        `SELECT c.conrelid::regclass || '.' || c.conname AS fk
           FROM pg_constraint c
          WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
            AND NOT EXISTS (
              SELECT 1 FROM pg_index i
               WHERE i.indrelid = c.conrelid
                 AND (i.indkey[0] = c.conkey[cardinality(c.conkey)]
                      OR (cardinality(c.conkey) = 2 AND i.indkey[0] = c.conkey[1] AND i.indkey[1] = c.conkey[2])))
          ORDER BY 1`
      );
      expect(unindexed.rows.map((r) => r.fk)).toEqual([]);
    });
  });

  describe('polymorphic references', () => {
    it("deletes a transaction's and a budget item's taggings and annotations with it", async () => {
      const tx = await transaction();
      const item = await one(`INSERT INTO budget_items (name) VALUES ($1)`, [`Tagged item ${stamp}`]);
      await pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'transaction', $2), ($1, 'budget_item', $3)`, [
        tag.id,
        tx.id,
        item.id,
      ]);
      await pool.query(`INSERT INTO annotations (subject_type, subject_id, kind, body) VALUES ('transaction', $1, 'note', 'x'), ('budget_item', $2, 'note', 'y')`, [
        tx.id,
        item.id,
      ]);
      await pool.query('DELETE FROM transactions WHERE id = $1', [tx.id]);
      await pool.query('DELETE FROM budget_items WHERE id = $1', [item.id]);
      const left = async (text: string) => (await pool.query(text, [tx.id, item.id])).rows;
      expect(
        await left(`SELECT 1 FROM taggings WHERE (taggable_type = 'transaction' AND taggable_id = $1) OR (taggable_type = 'budget_item' AND taggable_id = $2)`)
      ).toEqual([]);
      expect(
        await left(`SELECT 1 FROM annotations WHERE (subject_type = 'transaction' AND subject_id = $1) OR (subject_type = 'budget_item' AND subject_id = $2)`)
      ).toEqual([]);
    });
  });

  describe('updated_at', () => {
    it('is kept on the five tables that had no trigger', async () => {
      const old = '2000-01-01T00:00:00Z';
      const touched = async (table: string, set: string, where: string, params: unknown[]) => {
        await pool.query(`UPDATE ${table} SET updated_at = $${params.length + 1} WHERE ${where}`, [...params, old]);
        const row = (await pool.query(`UPDATE ${table} SET ${set} WHERE ${where} RETURNING updated_at`, params)).rows[0];
        return new Date(row.updated_at).getTime() > new Date(old).getTime() + 1000;
      };
      expect(await touched('budget_items', `notes = 'x'`, 'id = $1', [budgetItem.id])).toBe(true);
      const rule = await one(`INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text) VALUES ($1, 'contains', 'x')`, [budgetItem.id]);
      expect(await touched('budget_item_matching_rules', `matching_text = 'y'`, 'id = $1', [rule.id])).toBe(true);
      const snapshot = await one(
        `INSERT INTO net_worth_snapshots (snapshot_date, total_assets, total_liabilities, net_worth) VALUES ('2001-01-01', 1, 0, 1)`
      );
      expect(await touched('net_worth_snapshots', 'net_worth = 2', 'id = $1', [snapshot.id])).toBe(true);
      const triggers = (
        await pool.query<{ t: string }>(
          `SELECT tgrelid::regclass::text AS t FROM pg_trigger
            WHERE NOT tgisinternal AND tgname LIKE 'update\\_%\\_updated\\_at'
              AND tgrelid::regclass::text IN ('account_currencies', 'budget_item_matching_rules', 'budget_item_usage_history', 'budget_items', 'net_worth_snapshots')
            ORDER BY 1`
        )
      ).rows.map((r) => r.t);
      expect(triggers).toEqual(['account_currencies', 'budget_item_matching_rules', 'budget_item_usage_history', 'budget_items', 'net_worth_snapshots']);
    });
  });
});
