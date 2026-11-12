import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Refused requests log warnings; keep them out of the test output unless asked for.
vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import http from 'http';
import request from 'supertest';
import { Pool, type PoolClient } from 'pg';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import { sessionService } from '../middleware/auth.js';
import { SESSION_COOKIE_NAME } from '../utils/session-cookie-config.js';
// The CSRF token is bound to the session.
import { csrfTokenFor } from '../utils/csrfToken.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * Two ledger routes behind an admin, through the real app (createApp + mountRoutes) with
 * the roles that may call them: bulk deletion by date range (a ledger
 * admin), and connecting an account to the organization's bank connection (an
 * organization admin). That the roles below are refused is route-authorization.test.ts.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

describeDb('Ledger admin routes: bulk deletion and bank connection', () => {
  let owner: Pool;
  let a: TestTenant;
  let b: TestTenant;
  let server: http.Server;
  const userIds: number[] = [];
  let sideTenant: { id: number; client: PoolClient } | undefined;
  let connectionId: number;

  let tenantAdmin: string; // A's own user, made an admin of ledger A
  let member: string; // a plain member of ledger A
  let orgAdmin: string; // an admin of A's organization, a member of ledger A

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= 'ledger-admin-routes-test-encryption-key-0123456789';
    const app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    owner = new Pool({ connectionString, max: 3 });
    a = await createTestTenant('Ledger admin routes A');
    b = await createTestTenant('Ledger admin routes B');
    await owner.query('UPDATE tenant_users SET is_admin = true WHERE tenant_id = $1 AND user_id = $2', [a.tenantId, a.userId]);
    tenantAdmin = await signIn(a.userId);
    member = await signIn(await addUser('member'));
    const orgAdminId = await addUser('org-admin');
    await owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, true)', [a.organizationId, orgAdminId]);
    orgAdmin = await signIn(orgAdminId);
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (!owner) return;
    try {
      if (sideTenant) {
        await sideTenant.client.query('DELETE FROM accounts WHERE tenant_id = $1', [sideTenant.id]);
        sideTenant.client.release(true);
        await owner.query('DELETE FROM tenants WHERE id = $1', [sideTenant.id]);
      }
      if (connectionId) {
        // Accounts of A connected to it are purged with A below; unlink them first.
        await a.pool.query('UPDATE accounts SET simplefin_connection_id = NULL WHERE simplefin_connection_id = $1', [connectionId]);
        await owner.query('DELETE FROM organization_simplefin_connections WHERE id = $1', [connectionId]);
      }
      await owner.query('DELETE FROM organization_users WHERE user_id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM tenant_users WHERE user_id = ANY($1)', [userIds]);
      const settled = await Promise.allSettled([a?.cleanup(), b?.cleanup()]);
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    } finally {
      await owner.end();
    }
  }, 60_000);

  /** A member of ledger A. */
  async function addUser(label: string): Promise<number> {
    const email = `ledger-admin-routes-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
    const { id } = (
      await owner.query<{ id: number }>(
        `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, 'x', 'Test', $2) RETURNING id`,
        [email, label]
      )
    ).rows[0];
    userIds.push(id);
    await owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [a.tenantId, id]);
    return id;
  }

  /** A session in ledger A. */
  async function signIn(userId: number): Promise<string> {
    const { token, sessionId } = await sessionService.createSession({ userId });
    await owner.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [a.tenantId, sessionId]);
    return token;
  }

  /** A write from the browser holding `session`, with that session's CSRF token, as the SPA sends it. */
  const post = (session: string, path: string, body: object) =>
    request(server)
      .post(path)
      .set('Cookie', `${SESSION_COOKIE_NAME}=${session}; csrf_token=${csrfTokenFor(session)}`)
      .set('X-CSRF-Token', csrfTokenFor(session))
      .send(body);

  const one = async <T>(db: Pick<Pool, 'query'>, text: string, params: unknown[] = []) => (await db.query(text, params)).rows[0] as T;
  const account = (db: Pool, name: string) =>
    one<{ id: number; uuid: string }>(
      db,
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id, uuid`,
      [name]
    );

  describe('bulk deletion by date range', () => {
    let checking: { id: number; uuid: string };
    let savings: { id: number; uuid: string };
    let periodId: number;

    beforeAll(async () => {
      checking = await account(a.pool, 'Deletion checking');
      savings = await account(a.pool, 'Deletion savings');
      periodId = (
        await one<{ id: number }>(
          a.pool,
          `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
           VALUES ('February 2026', 'February', 2026, 2, '2026-02-01', '2026-02-28') RETURNING id`
        )
      ).id;
    });

    const add = async (date: string, amount: number, extra: { type?: string; accountId?: number; budgetPeriodId?: number; db?: Pool } = {}) =>
      (
        await one<{ id: number }>(
          extra.db ?? a.pool,
          `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_period_id)
           VALUES ($1, $2, $3, $4, 'Deletion fixture', $5) RETURNING id`,
          [extra.accountId ?? checking.id, amount, date, extra.type ?? (amount < 0 ? 'expense' : 'income'), extra.budgetPeriodId ?? null]
        )
      ).id;
    /** Both sides of a transfer from checking to savings, on their own dates. */
    const transfer = async (amount: number, fromDate: string, toDate: string) => {
      const client = await a.pool.connect();
      try {
        await client.query('BEGIN');
        const from = await add(fromDate, -amount, { type: 'transfer', db: client as unknown as Pool });
        const to = await add(toDate, amount, { type: 'transfer', accountId: savings.id, db: client as unknown as Pool });
        await client.query('UPDATE transactions SET transfer_transaction_id = $1 WHERE id = $2', [to, from]);
        await client.query('UPDATE transactions SET transfer_transaction_id = $1 WHERE id = $2', [from, to]);
        await client.query('COMMIT');
        return { from, to };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    };
    const exists = async (id: number, db: Pool = a.pool) => (await db.query('SELECT 1 FROM transactions WHERE id = $1', [id])).rowCount === 1;
    const preview = (range: object) => post(tenantAdmin, '/api/data-management/preview-delete-transactions', range);
    /** Delete what `previewed` found for `range`: the page sends the preview's selectionKey with it. */
    const remove = (range: object, previewed: { body: { selectionKey?: unknown } }) =>
      post(tenantAdmin, '/api/data-management/delete-transactions', { ...range, createBackup: false, selectionKey: previewed.body.selectionKey });

    it("deletes what the preview counted: the range's own rows, a split with its splits, never an opening balance or another ledger's rows", async () => {
      const before = await add('2026-01-31', -10);
      const opening = await add('2026-02-05', 1000, { type: 'starting balance' });
      const spend = await add('2026-02-01', -20);
      const pay = await add('2026-02-15', 300);
      const budgeted = await add('2026-02-10', -40, { budgetPeriodId: periodId });
      const after = await add('2026-03-01', -5);
      const client = await a.pool.connect();
      let split: number;
      try {
        await client.query('BEGIN');
        split = (await one<{ id: number }>(client, `INSERT INTO transactions (account_id, amount, transaction_date, type, is_split_parent) VALUES ($1, -100, '2026-02-20', 'expense', true) RETURNING id`, [checking.id])).id;
        await client.query(
          `INSERT INTO transactions (account_id, amount, transaction_date, type, parent_transaction_id) VALUES ($1, -70, '2026-02-20', 'expense', $2), ($1, -30, '2026-02-20', 'expense', $2)`,
          [checking.id, split]
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const whole = await transfer(50, '2026-02-12', '2026-02-12');
      const bAccount = await account(b.pool, 'Ledger B deletion');
      const bRow = await add('2026-02-10', -99, { accountId: bAccount.id, db: b.pool });
      const range = { dateFrom: '2026-02-01', dateTo: '2026-02-28' };

      // A member who doesn't administer the ledger can't (refused as such, not by the CSRF check).
      const notAdmin = await post(member, '/api/data-management/preview-delete-transactions', { ...range, excludeBudgetPeriod: false });
      expect(notAdmin.status).toBe(403);
      expect(notAdmin.body.code).toBe('TENANT_ADMIN_REQUIRED');

      // Leaving out the rows in a budget period first.
      const unbudgeted = await preview({ ...range, excludeBudgetPeriod: true });
      expect(unbudgeted.status, JSON.stringify(unbudgeted.body)).toBe(200);
      expect(unbudgeted.body).toMatchObject({
        count: 5,
        affectedAccounts: 2,
        totalIncome: 350,
        totalExpenses: 170,
        earliestDate: '2026-02-01',
        latestDate: '2026-02-20',
      });
      const deleted = await remove({ ...range, excludeBudgetPeriod: true }, unbudgeted);
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      expect(deleted.body).toMatchObject({ count: 5, affectedAccounts: 2, totalIncome: 350, totalExpenses: 170 });
      for (const id of [spend, pay, split!, whole.from, whole.to]) expect(await exists(id), `row ${id}`).toBe(false);
      expect((await a.pool.query('SELECT 1 FROM transactions WHERE parent_transaction_id = $1', [split!])).rowCount).toBe(0);
      expect(await exists(budgeted)).toBe(true);

      // Then the rest of the range.
      const rest = await preview({ ...range, excludeBudgetPeriod: false });
      expect(rest.body).toMatchObject({ count: 1, totalExpenses: 40 });
      expect((await remove({ ...range, excludeBudgetPeriod: false }, rest)).body).toMatchObject({ count: 1 });
      expect(await exists(budgeted)).toBe(false);
      expect((await preview({ ...range, excludeBudgetPeriod: false })).body).toMatchObject({ count: 0 });

      for (const id of [before, opening, after]) expect(await exists(id), `row ${id}`).toBe(true);
      expect(await exists(bRow, b.pool)).toBe(true);
    });

    it('with budget periods left out, keeps a split with a split in one, though the split itself has none', async () => {
      const june = (
        await one<{ id: number }>(
          a.pool,
          `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
           VALUES ('June 2026', 'June', 2026, 6, '2026-06-01', '2026-06-30') RETURNING id`
        )
      ).id;
      // A split and its splits, written in one transaction. A backfill before v3.0.0
      // gave a split its splits' period only when they all had the same one, so a split
      // whose splits disagree, or where one has none, keeps none of its own.
      const split = async (splitPeriods: (number | null)[]) => {
        const client = await a.pool.connect();
        try {
          await client.query('BEGIN');
          const parent = (await one<{ id: number }>(
            client,
            `INSERT INTO transactions (account_id, amount, transaction_date, type, is_split_parent) VALUES ($1, $2, '2026-06-14', 'expense', true) RETURNING id`,
            [checking.id, -10 * splitPeriods.length],
          )).id;
          for (const period of splitPeriods) {
            await client.query(
              `INSERT INTO transactions (account_id, amount, transaction_date, type, parent_transaction_id, budget_period_id) VALUES ($1, -10, '2026-06-14', 'expense', $2, $3)`,
              [checking.id, parent, period],
            );
          }
          await client.query('COMMIT');
          return parent;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      };
      const splitsOf = async (parent: number) =>
        (await a.pool.query('SELECT 1 FROM transactions WHERE parent_transaction_id = $1', [parent])).rowCount;
      const partlyBudgeted = await split([june, null]);
      const budgeted = await split([june, june]);
      await a.pool.query('UPDATE transactions SET budget_period_id = NULL WHERE id = $1', [budgeted]);
      const unbudgeted = await split([null, null]);
      const plain = await add('2026-06-15', -5);
      const range = { dateFrom: '2026-06-01', dateTo: '2026-06-30', excludeBudgetPeriod: true };

      const previewed = await preview(range);
      expect(previewed.status, JSON.stringify(previewed.body)).toBe(200);
      expect(previewed.body).toMatchObject({ count: 2, totalExpenses: 25 });
      const deleted = await remove(range, previewed);
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      expect(deleted.body.count).toBe(previewed.body.count);

      for (const parent of [partlyBudgeted, budgeted]) {
        expect(await exists(parent), `split ${parent}`).toBe(true);
        expect(await splitsOf(parent), `splits of ${parent}`).toBe(2);
      }
      expect([await exists(unbudgeted), await splitsOf(unbudgeted), await exists(plain)]).toEqual([false, 0, false]);

      // Without leaving periods out, the range goes, splits and all.
      const whole = await preview({ ...range, excludeBudgetPeriod: false });
      expect(whole.body).toMatchObject({ count: 2, totalExpenses: 40 });
      expect((await remove({ ...range, excludeBudgetPeriod: false }, whole)).body).toMatchObject({ count: 2 });
      for (const parent of [partlyBudgeted, budgeted]) expect([await exists(parent), await splitsOf(parent)]).toEqual([false, 0]);
    });

    it('deletes a transfer whole, or not at all when one side is outside the range', async () => {
      const inside = await transfer(60, '2026-04-10', '2026-04-10');
      // The card side was moved to the day the payment posted.
      const straddling = await transfer(75, '2026-04-29', '2026-05-02');
      const balances = async () =>
        (await a.pool.query('SELECT calculate_account_balance($1) AS c, calculate_account_balance($2) AS s', [checking.id, savings.id])).rows[0];
      const before = await balances();
      const range = { dateFrom: '2026-04-01', dateTo: '2026-04-30', excludeBudgetPeriod: false };

      const previewed = await preview(range);
      expect(previewed.status, JSON.stringify(previewed.body)).toBe(200);
      expect(previewed.body).toMatchObject({ count: 2, totalIncome: 60, totalExpenses: 60 });
      const deleted = await remove(range, previewed);
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      expect(deleted.body.count).toBe(previewed.body.count);

      expect([await exists(inside.from), await exists(inside.to)]).toEqual([false, false]);
      expect([await exists(straddling.from), await exists(straddling.to)]).toEqual([true, true]);
      const pair = await a.pool.query('SELECT id, transfer_transaction_id FROM transactions WHERE id = ANY($1) ORDER BY id', [[straddling.from, straddling.to]]);
      expect(pair.rows).toEqual([
        { id: straddling.from, transfer_transaction_id: straddling.to },
        { id: straddling.to, transfer_transaction_id: straddling.from },
      ]);
      // Only the transfer deleted whole moved the balances, by its amount on each side; the
      // household's total is what it was.
      const after = await balances();
      expect(Number(after.c)).toBeCloseTo(Number(before.c) + 60, 2);
      expect(Number(after.s)).toBeCloseTo(Number(before.s) - 60, 2);
    });

    // The preview's count is what the confirmation shows; Delete re-selected the range when
    // it ran, so a transaction a bank sync or another member added since was deleted too.
    describe('when the range changed after the preview', () => {
      const month = (m: string) => ({ dateFrom: `2026-${m}-01`, dateTo: `2026-${m}-28`, excludeBudgetPeriod: false });

      it('answers 409 PREVIEW_OUTDATED and deletes nothing when a transaction joined it', async () => {
        const range = month('07');
        const first = await add('2026-07-03', -11);
        const second = await add('2026-07-04', -12);
        const previewed = await preview(range);
        expect(previewed.body).toMatchObject({ count: 2 });

        const synced = await add('2026-07-05', -13); // a bank sync, after the preview
        const refused = await remove(range, previewed);
        expect(refused.status, JSON.stringify(refused.body)).toBe(409);
        expect(refused.body.code).toBe('PREVIEW_OUTDATED');
        expect(refused.body.error).toMatch(/changed since the preview/);
        for (const id of [first, second, synced]) expect(await exists(id), `row ${id}`).toBe(true);

        // A new preview counts it, and Delete then deletes what it counted.
        const again = await preview(range);
        expect(again.body).toMatchObject({ count: 3 });
        const deleted = await remove(range, again);
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        expect(deleted.body.count).toBe(3);
        for (const id of [first, second, synced]) expect(await exists(id), `row ${id}`).toBe(false);
      });

      it('answers 409 when one transaction left the range and another joined it, the count the same', async () => {
        const range = month('09');
        const stays = await add('2026-09-10', -21);
        const leaves = await add('2026-09-11', -22);
        const previewed = await preview(range);
        expect(previewed.body).toMatchObject({ count: 2 });

        await a.pool.query(`UPDATE transactions SET transaction_date = '2025-12-11' WHERE id = $1`, [leaves]);
        const joins = await add('2026-09-12', -23);
        expect((await preview(range)).body.count).toBe(2);
        const refused = await remove(range, previewed);
        expect(refused.status, JSON.stringify(refused.body)).toBe(409);
        expect(refused.body.code).toBe('PREVIEW_OUTDATED');
        for (const id of [stays, leaves, joins]) expect(await exists(id), `row ${id}`).toBe(true);

        const again = await preview(range);
        expect((await remove(range, again)).status).toBe(200);
        expect([await exists(stays), await exists(joins), await exists(leaves)]).toEqual([false, false, true]);
      });

      it('answers 400 for a delete that sends no preview, and 409 for a key no preview gave', async () => {
        const range = month('10');
        const kept = await add('2026-10-20', -31);
        const res = await post(tenantAdmin, '/api/data-management/delete-transactions', { ...range, createBackup: false });
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(await exists(kept)).toBe(true);

        const forged = await remove(range, { body: { selectionKey: '0'.repeat(64) } });
        expect(forged.status, JSON.stringify(forged.body)).toBe(409);
        expect(await exists(kept)).toBe(true);
        expect((await remove(range, await preview(range))).status).toBe(200);
        expect(await exists(kept)).toBe(false);
      });
    });
  });

  describe("connecting an account to the organization's bank connection", () => {
    it('maps one bank account to one account across the organization’s ledgers, and refuses a second mapping', async () => {
      connectionId = (
        await one<{ id: number }>(
          owner,
          `INSERT INTO organization_simplefin_connections (organization_id, access_url) VALUES ($1, 'unused') RETURNING id`,
          [a.organizationId]
        )
      ).id;
      // Another ledger of the same organization, whose account has the bank account already.
      const sideId = (
        await one<{ id: number }>(owner, 'INSERT INTO tenants (organization_id, name) VALUES ($1, $2) RETURNING id', [
          a.organizationId,
          `Ledger admin routes side ${Date.now()}`,
        ])
      ).id;
      const client = await owner.connect();
      sideTenant = { id: sideId, client };
      await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [String(sideId)]);
      const elsewhere = await one<{ id: number }>(
        client,
        `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_enabled, simplefin_connection_id)
         VALUES ('Mapped elsewhere', 'checking', 'cash', 'Asset', 'bank-77', true, $1) RETURNING id`,
        [connectionId]
      );

      const mine = await account(a.pool, 'Connect me');
      const connect = (uuid: string, importAccountId: string) =>
        post(orgAdmin, `/api/accounts/${uuid}/connect-bank`, { import_account_id: importAccountId });
      const mapping = async () =>
        one(a.pool, 'SELECT import_account_id, import_enabled, import_provider, simplefin_connection_id FROM accounts WHERE id = $1', [mine.id]);
      const unmapped = await mapping();

      const refused = await connect(mine.uuid, 'bank-77');
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.code).toBe('SIMPLEFIN_BANK_ACCOUNT_ALREADY_MAPPED');
      expect(await mapping()).toEqual(unmapped);

      const connected = await connect(mine.uuid, 'bank-78');
      expect(connected.status, JSON.stringify(connected.body)).toBe(200);
      expect(await mapping()).toEqual({ import_account_id: 'bank-78', import_enabled: true, import_provider: 'simplefin', simplefin_connection_id: connectionId });
      // Its own mapping is no conflict: saving it again works.
      expect((await connect(mine.uuid, 'bank-78')).status).toBe(200);

      // Once the other ledger's account lets it go, it can be mapped here.
      await client.query('UPDATE accounts SET import_account_id = NULL, import_enabled = false WHERE id = $1', [elsewhere.id]);
      expect((await connect(mine.uuid, 'bank-77')).status).toBe(200);
      expect(await mapping()).toMatchObject({ import_account_id: 'bank-77' });

      // Disconnecting stops the account's imports (a member may).
      expect((await post(member, `/api/accounts/${mine.uuid}/disconnect-bank`, {})).status).toBe(200);
      expect(await mapping()).toMatchObject({ import_account_id: null, import_enabled: false });
      expect((await connect(mine.uuid, '')).status).toBe(400);
    });
  });
});
