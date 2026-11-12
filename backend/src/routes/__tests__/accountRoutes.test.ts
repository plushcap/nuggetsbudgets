import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createAccountsRoutes } from '../accounts.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { inTransaction } from '../../test/inTransaction.js';
import { insertLegacyRow } from '../../test/legacyRows.js';
import { accountListResponseSchema, accountResponseSchema, answerProblem, transactionPageResponseSchema } from '@nuggets/shared';

/**
 * The account routes the other suites leave out: what Adjust Balance writes,
 * hiding, closing and deleting an account, and its import settings. The balance definition
 * itself is accountBalances.test.ts; balance history, budgetAndGoalHistoryQueries;
 * another ledger's account, tenant-isolation-api; connecting a bank,
 * tenantAdminRoutes.db.test.ts (it takes an organization admin).
 */
describe('Account routes: Adjust Balance, hide, close, delete and import settings', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let n = 0;

  type Account = { id: number; uuid: string; name: string };
  const one = async <T>(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows[0] as T;
  const balanceOf = async (accountId: number) =>
    (await one<{ b: string }>('SELECT calculate_account_balance($1) AS b', [accountId])).b;
  const transactionsOf = async (accountId: number) =>
    (await pool.query(
      `SELECT amount, type, status, review_status, transaction_date = app_today() AS today
         FROM transactions WHERE account_id = $1 AND parent_transaction_id IS NULL ORDER BY id`,
      [accountId],
    )).rows;
  const addTransaction = (accountId: number, amount: number, date = '2026-03-10') =>
    one<{ id: number }>(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, $2, $3, 'expense', 'Fixture') RETURNING id`,
      [accountId, amount, date],
    );

  /** Through POST /api/accounts, as the Add Account page does. */
  const createAccount = async (initialBalance: number | string = 0): Promise<Account> => {
    const res = await request(app)
      .post('/api/accounts')
      .send({ name: `Routes account ${++n}`, account_type: 'checking', account_group: 'cash', type: 'Asset', initial_balance: initialBalance });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.id, uuid: res.body.uuid, name: res.body.name };
  };
  const adjust = (account: Account, targetBalance: number | string) =>
    request(app).post(`/api/accounts/${account.uuid}/adjust-balance`).send({ targetBalance });

  beforeAll(async () => {
    tenant = await createTestTenant('Account routes');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/accounts', createAccountsRoutes());
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  // A register date or id that isn't one reached the query as text Postgres couldn't read
  // (a 500), and a list flag other than true/false was read as one or the other.
  describe('the query strings', () => {
    it('refuses a register filter or a list flag that is not one with 400, and reads a page or page size as before', async () => {
      const account = await createAccount();
      await addTransaction(account.id, -10);
      for (const [path, field] of [
        [`/api/accounts/${account.uuid}/transactions?date_from=2026-02-30`, 'date_from'],
        [`/api/accounts/${account.uuid}/transactions?budget_period_id=abc`, 'budget_period_id'],
        [`/api/accounts/${account.uuid}/transactions?amount_min=lots`, 'amount_min'],
        [`/api/accounts/${account.uuid}/transactions?search=a&search=b`, 'search'],
        ['/api/accounts?include_hidden=yes', 'include_hidden'],
        ['/api/accounts?exclude_closed=1', 'exclude_closed'],
      ] as const) {
        const res = await request(app).get(path);
        expect({ path, status: res.status, code: res.body.code, field: res.body.details?.[0]?.field }).toEqual({ path, status: 400, code: 'VALIDATION_ERROR', field });
      }
      const register = await request(app).get(`/api/accounts/${account.uuid}/transactions?page=x&limit=500&date_from=2026-03-01`).expect(200);
      expect(register.body.pagination).toEqual({ page: 1, limit: 200, total: 1, totalPages: 1 });
      const history = await request(app).get(`/api/accounts/${account.uuid}/balance-history?limit=0`).expect(200);
      expect(history.body).toBeDefined();
    });
  });

  // The answers are exactly what the shared schema names: a field a route
  // adds, or one it sends in another form (an amount as '', a date as a timestamp), fails
  // here until accountResponseSchema has it, so the frontend's parse never drops it.
  describe('the answers', () => {
    it('lists and reads an account, with its institution and bank figures, as accountResponseSchema names them', async () => {
      const account = await createAccount(250.5);
      const institution = await one<{ id: number }>(`INSERT INTO account_institutions (name, notes) VALUES ('Answers bank', 'n') RETURNING id`);
      await pool.query(
        `UPDATE accounts SET institution_id = $2, institution_current_balance = 12.30, import_balance = -4.05,
                import_last_sync = now(), import_extra = '{"org": {"name": "x"}}' WHERE id = $1`,
        [account.id, institution.id],
      );
      const list = await request(app).get('/api/accounts?include_hidden=true&exclude_closed=false').expect(200);
      expect(answerProblem(accountListResponseSchema, list.body)).toBeNull();
      const listed = accountListResponseSchema.parse(list.body).accounts.find((a) => a.id === account.id);
      expect(listed).toMatchObject({ institution_name: 'Answers bank', institution_current_balance: 12.3, import_balance: -4.05, calculated_balance: 250.5 });

      const single = await request(app).get(`/api/accounts/${account.uuid}`).expect(200);
      expect(answerProblem(accountResponseSchema, single.body)).toBeNull();
      expect(accountResponseSchema.parse(single.body)).toMatchObject({ institution_balance: 12.3, import_extra: { org: { name: 'x' } } });

      await addTransaction(account.id, -20.25);
      const register = await request(app).get(`/api/accounts/${account.uuid}/transactions`).expect(200);
      expect(answerProblem(transactionPageResponseSchema, register.body)).toBeNull();
      expect(transactionPageResponseSchema.parse(register.body).transactions.map((t) => t.running_account_balance)).toEqual([230.25, -20.25]);
    });
  });

  describe('Adjust Balance', () => {
    it('writes one balance adjustment for the difference, signed either way, dated today, and the balance is then the target', async () => {
      const account = await createAccount(500);
      await addTransaction(account.id, -120.55);
      expect(await balanceOf(account.id)).toBe('379.45');

      const up = await adjust(account, 400).expect(200);
      expect(up.body).toMatchObject({ adjusted: true, adjustment: 20.55, balance: 400 });
      const down = await adjust(account, -10.1).expect(200);
      expect(down.body).toMatchObject({ adjusted: true, adjustment: -410.1, balance: -10.1 });
      expect(await balanceOf(account.id)).toBe('-10.10');

      // The opening balance, the expense, and one adjustment per change.
      expect(await transactionsOf(account.id)).toEqual([
        { amount: '500.00', type: 'starting balance', status: 'cleared', review_status: 'reviewed', today: true },
        { amount: '-120.55', type: 'expense', status: 'pending', review_status: 'needs review', today: false },
        { amount: '20.55', type: 'balance adjustment', status: 'cleared', review_status: 'reviewed', today: true },
        { amount: '-410.10', type: 'balance adjustment', status: 'cleared', review_status: 'reviewed', today: true },
      ]);

      // Already there: nothing to write.
      const same = await adjust(account, -10.1).expect(200);
      expect(same.body.adjusted).toBe(false);
      expect(await transactionsOf(account.id)).toHaveLength(4);
    });

    it('counts a split once when it works out the difference', async () => {
      const account = await createAccount(0);
      await inTransaction(pool, async (client) => {
        const parent = (await client.query<{ id: number }>(
          `INSERT INTO transactions (account_id, amount, transaction_date, type, is_split_parent) VALUES ($1, -100, '2026-03-11', 'expense', true) RETURNING id`,
          [account.id],
        )).rows[0];
        await client.query(
          `INSERT INTO transactions (account_id, amount, transaction_date, type, parent_transaction_id)
           VALUES ($1, -60, '2026-03-11', 'expense', $2), ($1, -40, '2026-03-11', 'expense', $2)`,
          [account.id, parent.id],
        );
      });
      const res = await adjust(account, 0).expect(200);
      expect(res.body).toMatchObject({ adjusted: true, adjustment: 100, balance: 0 });
      expect(await balanceOf(account.id)).toBe('0.00');
    });

    it('refuses a target with more than 2 decimal places instead of rounding it, and writes nothing', async () => {
      const account = await createAccount(100);
      const res = await adjust(account, 80.005);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error).toBe('targetBalance must be a number with at most 2 decimal places');
      expect(await transactionsOf(account.id)).toHaveLength(1);
      expect(await balanceOf(account.id)).toBe('100.00');
    });

    it('refuses an adjustment larger than one transaction holds with a 400, and writes nothing', async () => {
      const account = await createAccount('-9999999999.99');
      // Both are amounts, but the difference, 19,999,999,999.98, doesn't fit DECIMAL(12,2).
      const res = await adjust(account, '9999999999.99');
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_AMOUNT' });
      expect(res.body.error).toContain('9,999,999,999.99');
      expect(await transactionsOf(account.id)).toHaveLength(1);
      expect(await balanceOf(account.id)).toBe('-9999999999.99');

      // The largest adjustment there is still goes through.
      const most = await createAccount(0);
      expect((await adjust(most, -9999999999.99).expect(200)).body).toMatchObject({ adjusted: true, adjustment: -9999999999.99 });
      expect(await balanceOf(most.id)).toBe('-9999999999.99');
    });

    it('refuses a target beyond 9,999,999,999.99 as too large, not as too precise', async () => {
      const account = await createAccount(100);
      for (const target of [10000000000, '10000000000', '-10000000000.00']) {
        const res = await adjust(account, target);
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        // The request's schema refuses it, as the column can't hold it (a JSON number had no bound there).
        expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'targetBalance must be between -9,999,999,999.99 and 9,999,999,999.99' });
      }
      expect(await transactionsOf(account.id)).toHaveLength(1);
    });

    it('reads the target as it was sent, not as Number() reads it', async () => {
      const account = await createAccount(100);
      // More decimals than 80, in text: refused, not read as the double nearest it.
      const precise = await adjust(account, '80.0000000000000001');
      expect(precise.status, JSON.stringify(precise.body)).toBe(400);
      expect(precise.body).toEqual({ error: 'targetBalance must be a number with at most 2 decimal places', code: 'INVALID_AMOUNT', message: 'targetBalance must be a number with at most 2 decimal places' });
      // Text that isn't a decimal number isn't a balance (Number() makes these 16, 100, 1, 0).
      for (const notAnAmount of ['0x10', '1e2', true, '']) {
        const res = await request(app).post(`/api/accounts/${account.uuid}/adjust-balance`).send({ targetBalance: notAnAmount });
        expect(res.status, `${JSON.stringify(notAnAmount)}: ${JSON.stringify(res.body)}`).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
      expect(await transactionsOf(account.id)).toHaveLength(1);
      // A JSON number and a decimal string are read as written.
      expect((await adjust(account, 80.5).expect(200)).body).toMatchObject({ adjusted: true, adjustment: -19.5 });
      expect((await adjust(account, ' 70.25 ').expect(200)).body).toMatchObject({ adjusted: true, adjustment: -10.25 });
      expect(await balanceOf(account.id)).toBe('70.25');
    });

    it('answers 404 for an account that is not there', async () => {
      expect((await adjust({ id: 0, uuid: '00000000-0000-0000-0000-000000000000', name: '' }, 1)).status).toBe(404);
    });
  });

  describe('the opening balance', () => {
    it('is the amount entered, to the cent', async () => {
      const account = await createAccount('1234.56');
      expect(await transactionsOf(account.id)).toEqual([
        { amount: '1234.56', type: 'starting balance', status: 'cleared', review_status: 'reviewed', today: true },
      ]);
    });

    it('refuses more than 2 decimal places instead of rounding, and creates no account', async () => {
      const name = `Rounded opening ${Date.now()}`;
      const res = await request(app)
        .post('/api/accounts')
        .send({ name, account_type: 'checking', account_group: 'cash', type: 'Asset', initial_balance: 12.345 });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error).toBe('initial_balance must be a number with at most 2 decimal places');
      expect((await pool.query('SELECT 1 FROM accounts WHERE name = $1', [name])).rows).toHaveLength(0);
    });

    it('refuses one beyond 9,999,999,999.99 as too large, and creates no account', async () => {
      const name = `Huge opening ${Date.now()}`;
      for (const initial_balance of [10000000000, '10000000000', '-12345678901.5']) {
        const res = await request(app)
          .post('/api/accounts')
          .send({ name, account_type: 'checking', account_group: 'cash', type: 'Asset', initial_balance });
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        // The request's schema refuses it, as the column can't hold it (a JSON number had no bound there).
        expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'initial_balance must be between -9,999,999,999.99 and 9,999,999,999.99' });
      }
      expect((await pool.query('SELECT 1 FROM accounts WHERE name = $1', [name])).rows).toHaveLength(0);
      // The largest there is is fine.
      const largest = await createAccount('9999999999.99');
      expect(await balanceOf(largest.id)).toBe('9999999999.99');
    });

    it('is read as it was sent, not as Number() reads it', async () => {
      const name = `Read as sent ${Date.now()}`;
      const send = (initial_balance: unknown) =>
        request(app).post('/api/accounts').send({ name, account_type: 'checking', account_group: 'cash', type: 'Asset', initial_balance });
      const precise = await send('12.3400000000000001');
      expect(precise.status, JSON.stringify(precise.body)).toBe(400);
      expect(precise.body).toEqual({ error: 'initial_balance must be a number with at most 2 decimal places', code: 'INVALID_AMOUNT', message: 'initial_balance must be a number with at most 2 decimal places' });
      for (const notAnAmount of ['0x10', '1e2', true, '']) {
        const res = await send(notAnAmount);
        expect(res.status, `${JSON.stringify(notAnAmount)}: ${JSON.stringify(res.body)}`).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
      expect((await pool.query('SELECT 1 FROM accounts WHERE name = $1', [name])).rows).toHaveLength(0);

      // As the Add Account page sends it (FormData: text), and as a JSON number.
      const form = await request(app)
        .post('/api/accounts')
        .field('name', `${name} form`).field('account_type', 'checking').field('account_group', 'cash').field('type', 'Asset')
        .field('initial_balance', '-45.5');
      expect(form.status, JSON.stringify(form.body)).toBe(201);
      expect(await balanceOf(form.body.id)).toBe('-45.50');
      expect(await balanceOf((await createAccount(12.34)).id)).toBe('12.34');
      // No opening balance: no Starting Balance transaction.
      const none = await request(app).post('/api/accounts').send({ name: `${name} none`, account_type: 'checking' }).expect(201);
      expect(await transactionsOf(none.body.id)).toEqual([]);
    });
  });

  describe('hiding, closing and deleting', () => {
    const listed = async (query: Record<string, string> = {}) => {
      const res = await request(app).get('/api/accounts').query(query).expect(200);
      return new Map((res.body.accounts as Array<{ uuid: string; calculated_balance: number }>).map((a) => [a.uuid, a.calculated_balance]));
    };
    const edit = (account: Account, fields: Record<string, unknown>) =>
      request(app)
        .put(`/api/accounts/${account.uuid}`)
        .send({ name: account.name, account_type: 'checking', account_group: 'cash', type: 'Asset', ...fields })
        .expect(200);

    it('hiding or closing keeps the account and its transactions; the list leaves it out unless asked for it', async () => {
      const hidden = await createAccount(300);
      await addTransaction(hidden.id, -45);
      const closed = await createAccount(200);
      await addTransaction(closed.id, -15);
      const before = { hidden: await transactionsOf(hidden.id), closed: await transactionsOf(closed.id) };

      await edit(hidden, { hide_account: true });
      await edit(closed, { is_active: false });
      expect(await one('SELECT hide_account, close_account FROM accounts WHERE id = $1', [hidden.id])).toEqual({ hide_account: true, close_account: false });
      expect(await one('SELECT hide_account, close_account FROM accounts WHERE id = $1', [closed.id])).toEqual({ hide_account: false, close_account: true });

      const defaults = await listed();
      expect(defaults.has(hidden.uuid)).toBe(false);
      expect(defaults.has(closed.uuid)).toBe(false);
      expect((await listed({ include_hidden: 'true' })).get(hidden.uuid)).toBe(255);
      expect((await listed({ exclude_closed: 'false' })).get(closed.uuid)).toBe(185);

      expect(await transactionsOf(hidden.id)).toEqual(before.hidden);
      expect(await transactionsOf(closed.id)).toEqual(before.closed);
      const balance = await request(app).get(`/api/accounts/${closed.uuid}/balance`).expect(200);
      expect(balance.body).toMatchObject({ balance: 185, balance_unavailable: false });
    });

    it('refuses to delete an account with transactions, and deletes nothing', async () => {
      const account = await createAccount(50);
      await addTransaction(account.id, -5);
      const res = await request(app).delete(`/api/accounts/${account.uuid}`);
      expect(res.status).toBe(400);
      expect(res.body.details).toMatchObject({ transactionCount: 1 });
      expect(await one('SELECT name FROM accounts WHERE id = $1', [account.id])).toEqual({ name: account.name });
      expect(await transactionsOf(account.id)).toHaveLength(2);
    });
  });

  // A liability account takes no income: the database refuses a write of one
  // (trigger_check_transaction_type_for_account, on transactions only). Turning an asset
  // account with incomes into a liability left them there, each refused at its next edit.
  describe('making an account a liability', () => {
    const asLiability = (account: Account) =>
      request(app)
        .put(`/api/accounts/${account.uuid}`)
        .send({ name: account.name, account_type: 'credit_card', account_group: 'credit_cards', type: 'Liability' });
    const addOfType = (accountId: number, amount: number, type: string) =>
      one<{ id: number }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, $2, '2026-03-12', $3, 'Fixture') RETURNING id`,
        [accountId, amount, type],
      );
    const classOf = (accountId: number) => one('SELECT type, account_type FROM accounts WHERE id = $1', [accountId]);

    it('is refused while the account has incomes, saying how many and what to do, and nothing changes', async () => {
      const account = await createAccount(100);
      const incomes = [await addOfType(account.id, 25, 'income'), await addOfType(account.id, 40, 'income')];
      await addTransaction(account.id, -10);

      const refused = await asLiability(account);
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.code).toBe('ACCOUNT_HAS_INCOME');
      expect(refused.body.incomeCount).toBe(2);
      expect(refused.body.error).toMatch(/2 incomes/);
      expect(refused.body.error).toMatch(/payment or an expense/);
      expect(await classOf(account.id)).toEqual({ type: 'Asset', account_type: 'checking' });

      // Retyped as a payment and an expense, the account becomes a liability.
      await pool.query(`UPDATE transactions SET type = 'payment' WHERE id = $1`, [incomes[0].id]);
      await pool.query(`UPDATE transactions SET type = 'expense', amount = -40 WHERE id = $1`, [incomes[1].id]);
      expect((await asLiability(account)).status).toBe(200);
      expect(await classOf(account.id)).toEqual({ type: 'Liability', account_type: 'credit_card' });
    });

    it('names one income as one', async () => {
      const account = await createAccount();
      await addOfType(account.id, 5, 'income');
      const refused = await asLiability(account);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/has 1 income[^s]/);
    });

    it('saves an account with no incomes as a liability, and a liability with an income from before the rule as it is', async () => {
      const account = await createAccount(0);
      await addTransaction(account.id, -10);
      expect((await asLiability(account)).status).toBe(200);

      // An income from before that rule, on the account that is already a liability: the edit
      // form sends its type back as it was, which changes nothing.
      await insertLegacyRow(
        `INSERT INTO transactions (tenant_id, account_id, amount, transaction_date, type, description) VALUES ($1, $2, 12, '2026-03-13', 'income', 'Legacy')`,
        [tenant.tenantId, account.id],
      );
      const saved = await request(app)
        .put(`/api/accounts/${account.uuid}`)
        .send({ name: `${account.name} renamed`, account_type: 'credit_card', account_group: 'credit_cards', type: 'Liability' });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(await one('SELECT name FROM accounts WHERE id = $1', [account.id])).toEqual({ name: `${account.name} renamed` });
    });
  });

  describe('import settings', () => {
    const importFields = (accountId: number) =>
      one(
        `SELECT import_enabled, import_account_id, import_account_rebalance, import_auto_match_merchants,
                import_auto_assign_budget_period, import_auto_assign_budget_item, import_auto_review, import_default_assigned_to
           FROM accounts WHERE id = $1`,
        [accountId],
      );
    const linked = {
      import_enabled: true,
      import_account_id: 'bank-acct-1',
      import_account_rebalance: true,
      import_auto_match_merchants: true,
      import_auto_assign_budget_period: true,
      import_auto_assign_budget_item: false,
      import_auto_review: false,
      import_default_assigned_to: null,
    };
    const linkedAccount = async () => {
      const account = await createAccount(0);
      await pool.query(
        `UPDATE accounts SET import_enabled = true, import_account_id = 'bank-acct-1', import_account_rebalance = true,
                import_auto_match_merchants = true, import_auto_assign_budget_period = true,
                import_auto_assign_budget_item = false, import_auto_review = false
          WHERE id = $1`,
        [account.id],
      );
      return account;
    };

    it('PATCH changes only the settings sent, to an assignee of the ledger', async () => {
      const account = await linkedAccount();
      const other = await linkedAccount();
      const patch = (body: object) => request(app).patch(`/api/accounts/${account.uuid}/import-settings`).send(body);

      await patch({ import_auto_review: true, import_auto_match_merchants: false }).expect(200);
      expect(await importFields(account.id)).toEqual({ ...linked, import_auto_review: true, import_auto_match_merchants: false });
      await patch({ import_default_assigned_to: tenant.userId }).expect(200);
      expect(await importFields(account.id)).toMatchObject({ import_default_assigned_to: tenant.userId, import_auto_review: true });
      await patch({ import_default_assigned_to: null }).expect(200);
      expect(await importFields(account.id)).toMatchObject({ import_default_assigned_to: null });

      expect((await patch({})).status).toBe(400);
      expect((await patch({ import_auto_review: 'yes' })).status).toBe(400);
      expect(await importFields(other.id)).toEqual(linked);
      expect((await request(app).patch('/api/accounts/00000000-0000-0000-0000-000000000000/import-settings').send({ import_enabled: false })).status).toBe(404);
    });

    it("disconnecting the bank stops the account's imports and keeps its transactions and balance", async () => {
      const account = await linkedAccount();
      const other = await linkedAccount();
      await addTransaction(account.id, -30);
      const before = { balance: await balanceOf(account.id), transactions: await transactionsOf(account.id) };

      await request(app).post(`/api/accounts/${account.uuid}/disconnect-bank`).expect(200);
      expect(await importFields(account.id)).toEqual({ ...linked, import_enabled: false, import_account_id: null, import_account_rebalance: false });
      expect(await importFields(other.id)).toEqual(linked);
      expect(await balanceOf(account.id)).toBe(before.balance);
      expect(await transactionsOf(account.id)).toEqual(before.transactions);
      expect((await request(app).post('/api/accounts/00000000-0000-0000-0000-000000000000/disconnect-bank')).status).toBe(404);
    });
  });
});
