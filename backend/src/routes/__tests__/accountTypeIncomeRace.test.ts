import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { createAccountsRoutes } from '../accounts.js';
import { createTransactionsRoutes } from '../transactions.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * An account becoming a liability while an income is added to it. A liability takes
 * no income: the database refuses one (check_transaction_type_for_account), and the
 * account edit refuses to make an account with incomes a liability (409 ACCOUNT_HAS_INCOME).
 * Neither read took a lock, so each saw the other's state from before it committed, and both
 * went through: an income on a liability.
 *
 * Now the edit locks the account FOR UPDATE before it counts the incomes, and an income reads
 * its account's type FOR KEY SHARE, so the two wait for each other: in either order, the one
 * that goes second is refused. Two incomes on one account, or an income and an ordinary edit
 * of it, still don't wait for each other.
 *
 * Each race is set up from other connections: an open transaction holds one side part-way.
 */
describe('an account becoming a liability while an income is added', () => {
  let app: Express;
  let tenant: TestTenant;
  let n = 0;

  beforeAll(async () => {
    tenant = await createTestTenant('Account type and income race');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/accounts', createAccountsRoutes());
    app.use('/api/transactions', createTransactionsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  type Account = { id: number; uuid: string; name: string };
  const newAccount = async (label: string): Promise<Account> =>
    (
      await tenant.pool.query<Account>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id, uuid, name`,
        [`${label} ${++n}`]
      )
    ).rows[0];
  const typeOf = async (id: number) => (await tenant.pool.query<{ type: string }>('SELECT type FROM accounts WHERE id = $1', [id])).rows[0].type;
  const incomesOn = async (id: number) =>
    Number((await tenant.pool.query<{ n: string }>(`SELECT count(*) AS n FROM transactions WHERE account_id = $1 AND type = 'income'`, [id])).rows[0].n);
  const addIncome = (client: PoolClient | TestTenant['pool'], accountId: number, description = 'Paycheck') =>
    client.query(`INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, 100, '2026-10-15', 'income', $2)`, [
      accountId,
      description,
    ]);
  /** The edit form making `account` a credit card, paid from `payFrom` when given. */
  const makeLiability = (account: Account, payFrom?: number) =>
    request(app)
      .put(`/api/accounts/${account.uuid}`)
      .send({
        name: account.name,
        account_type: 'credit_card',
        account_group: 'credit_cards',
        type: 'Liability',
        ...(payFrom === undefined ? {} : { default_pay_from_account_id: payFrom }),
      })
      .then((res) => res);

  /** Another connection, holding a transaction open until `commit()`. */
  const holder = async () => {
    const client: PoolClient = await tenant.pool.connect();
    await client.query('BEGIN');
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let done = false;
    return {
      client,
      pid,
      commit: async () => {
        if (done) return;
        done = true;
        await client.query('COMMIT').catch(() => client.query('ROLLBACK'));
        client.release();
      },
    };
  };
  const waitersOf = async (pid: number) =>
    (await tenant.pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.map((r) => r.pid);
  const waiterOf = async (pid: number): Promise<number> => {
    let found: number | undefined;
    await waitUntil(async () => (found = (await waitersOf(pid))[0]) !== undefined);
    return found!;
  };
  /** 'waited' once a backend waits for `pid`, or 'went through' once `pending` has settled without. */
  const waitedFor = async (pending: Promise<unknown>, pid: number): Promise<'waited' | 'went through'> => {
    let settled = false;
    let waiting = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true)
    );
    await waitUntil(async () => settled || (waiting = (await waitersOf(pid)).length > 0));
    return waiting ? 'waited' : 'went through';
  };

  /**
   * The edit first: it has locked the account, counted no income and written the new type,
   * and is held as it checks the account it is paid from (whose row another connection
   * holds). Then `write` adds an income; it should wait for the edit.
   */
  const editFirst = async <C>(write: (account: Account, context: C) => Promise<unknown>, prepare?: (account: Account) => Promise<C>) => {
    const account = await newAccount('Becoming a card');
    const payFrom = await newAccount('Pays the card');
    const context = (await prepare?.(account)) as C;
    const gate = await holder();
    let editing: ReturnType<typeof makeLiability> | undefined;
    let writing: Promise<unknown> | undefined;
    try {
      await gate.client.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [payFrom.id]);
      editing = makeLiability(account, payFrom.id);
      const editPid = await waiterOf(gate.pid);
      writing = write(account, context).catch((err: unknown) => err);
      expect(await waitedFor(writing, editPid)).toBe('waited');
    } finally {
      await gate.commit();
    }
    const [edited, written] = await Promise.all([editing!, writing!]);
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(await typeOf(account.id)).toBe('Liability');
    expect(await incomesOn(account.id)).toBe(0);
    return written;
  };

  it('an income added through the route waits for the edit, then is refused (400)', async () => {
    const written = (await editFirst((account) =>
      request(app)
        .post('/api/transactions')
        .send({ account_uuid: account.uuid, amount: 100, transaction_date: '2026-10-15', type: 'income', description: 'Paycheck' })
        .then((res) => res)
    )) as request.Response;
    expect(written.status, JSON.stringify(written.body)).toBe(400);
    expect(written.body.code).toBe('INCOME_ON_LIABILITY');
  });

  it('an income any other writer adds waits for the edit, then is refused by the database', async () => {
    const written = await editFirst((account) => addIncome(tenant.pool, account.id));
    expect(written).toBeInstanceOf(Error);
    expect((written as Error).message).toMatch(/Income transactions are not allowed on liability accounts/);
  });

  it('an expense changed into an income waits for the edit, then is refused by the database', async () => {
    // An expense from before the edit (which doesn't stop one), made an income during it: no
    // foreign key is checked (its account stays), so only the type check's lock waits.
    const written = await editFirst(
      (_account, expense: number) => tenant.pool.query(`UPDATE transactions SET type = 'income', amount = 100 WHERE id = $1`, [expense]),
      async (account) =>
        (
          await tenant.pool.query<{ id: number }>(
            `INSERT INTO transactions (account_id, amount, transaction_date, type) VALUES ($1, -100, '2026-10-01', 'expense') RETURNING id`,
            [account.id]
          )
        ).rows[0].id
    );
    expect(written).toBeInstanceOf(Error);
    expect((written as Error).message).toMatch(/Income transactions are not allowed on liability accounts/);
  });

  it('an income added first makes the edit wait, count it, and refuse (409 ACCOUNT_HAS_INCOME)', async () => {
    const account = await newAccount('Has a new income');
    const writer = await holder();
    let editing: ReturnType<typeof makeLiability> | undefined;
    try {
      await addIncome(writer.client, account.id);
      editing = makeLiability(account);
      expect(await waitedFor(editing, writer.pid)).toBe('waited');
    } finally {
      await writer.commit();
    }
    const edited = await editing!;
    expect(edited.status, JSON.stringify(edited.body)).toBe(409);
    expect(edited.body.code).toBe('ACCOUNT_HAS_INCOME');
    expect(edited.body.incomeCount).toBe(1);
    expect(await typeOf(account.id)).toBe('Asset');
    expect(await incomesOn(account.id)).toBe(1);
  });

  it("two incomes on one account, and an income and an ordinary edit of it, don't wait for each other", async () => {
    const account = await newAccount('Two incomes');
    const first = await holder();
    const second = await holder();
    try {
      await addIncome(first.client, account.id, 'First paycheck');
      // Each holds its income uncommitted, and neither waits for the other.
      await addIncome(second.client, account.id, 'Second paycheck');
      expect(await waitersOf(first.pid)).toEqual([]);
      // Renaming the account (no change of type) doesn't wait for them either.
      const renamed = await request(app)
        .put(`/api/accounts/${account.uuid}`)
        .send({ name: `${account.name} renamed`, account_type: 'checking', account_group: 'cash' });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    } finally {
      await first.commit();
      await second.commit();
    }
    expect(await incomesOn(account.id)).toBe(2);
  });
});

/** Resolve once `check` answers true, polling; fail after 5 s. */
async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
