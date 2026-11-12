import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';
import { addMonths, firstOfMonth } from '../../utils/calendarDate.js';

/**
 * A goal's links and its accounts' hiding have a history, through the real
 * app under RLS: linking an account or an envelope, unlinking it, linking it again, and
 * hiding or showing an account change the goal's progress history only from that day.
 *
 * The routes and the account form write on the ledger's today, so the test can't wait a
 * month between two changes: after a change it moves the day the change was made back
 * (`valid_from`, `valid_to`, `hidden_from` set to a past day), as if it had been made then,
 * and makes the next change today. Each test has its own goal, accounts and envelopes.
 *
 * Every account's balance and every envelope's budget changes month by month, so a point
 * shows which of them it counted. The dates are relative to today (the ledger's
 * app_today()): M-k is the month k months before this one, E-k its last day.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

type Point = { snapshot_date: string; total_from_accounts: string; total_from_budget_items: string; total_progress: string };
type Ref = { id: number; uuid: string; name: string };

describeDb('Goal link and hiding history', () => {
  let h: RouteHarness;
  let a: TestTenant;
  let b: TestTenant;
  let member: string;
  let memberB: string;
  let today: string;
  let periods: Array<{ id: number; start_date: string }>;
  let seq = 0;
  const unique = (name: string) => `${name} ${++seq}`;
  /** The first day of the month k months back (0 = this month). */
  const monthStart = (k: number) => addMonths(firstOfMonth(today), -k);
  /** Day `d` of the month k months back. */
  const day = (k: number, d: number) => `${monthStart(k).slice(0, 8)}${String(d).padStart(2, '0')}`;

  const one = async <T>(t: TestTenant, text: string, params: unknown[] = []) => (await t.pool.query(text, params)).rows[0] as T;
  const ok = async (res: Promise<{ status: number; text: string; body: unknown }> | { status: number; text: string; body: unknown }, status = 200) => {
    const r = await res;
    expect(r.status, r.text).toBe(status);
    return r.body as Record<string, unknown>;
  };

  /** A goal of ledger A, begun on the 2nd of M-4. */
  const newGoal = async () => {
    const created = await ok(h.call(member, 'post', '/api/goals', { name: unique('House'), target_amount: 5000, target_date: '2030-01-01' }), 201);
    const goal = created.goal as { id: number; uuid: string };
    await a.pool.query(`UPDATE budget_items SET created_at = $2::date + time '12:00' WHERE id = $1`, [goal.id, day(4, 2)]);
    return goal;
  };
  /**
   * An account of ledger A: `base` on the 5th of M-4, and `step` more on the 5th of each
   * later month (the 1st of this one), so at E-4..E-1 and today it holds base, base +
   * step, ... base + 4 * step.
   */
  const newAccount = async (base: number, step: number, hidden = false): Promise<Ref> => {
    const name = unique('Savings');
    const account = await one<Ref>(
      a,
      `INSERT INTO accounts (name, account_type, account_group, type, hide_account) VALUES ($1, 'savings', 'cash', 'Asset', $2) RETURNING id, uuid, name`,
      [name, hidden]
    );
    await a.pool.query(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description)
       VALUES ($1, $2, $3, 'starting balance', 'Opening'), ($1, $4, $5, 'income', 'Deposit'), ($1, $4, $6, 'income', 'Deposit'),
              ($1, $4, $7, 'income', 'Deposit'), ($1, $4, $8, 'income', 'Deposit')`,
      [account.id, base, day(4, 5), step, day(3, 5), day(2, 5), day(1, 5), day(0, 1)]
    );
    return account;
  };
  /** A rollover envelope of ledger A with `base` budgeted in M-4 and `step` in each later month. */
  const newEnvelope = async (base: number, step: number): Promise<Ref> => {
    const envelope = await one<Ref>(a, `INSERT INTO budget_items (name, expense_type, rollover) VALUES ($1, 'Savings', true) RETURNING id, uuid, name`, [
      unique('Fund'),
    ]);
    const items = (
      await a.pool.query<{ uuid: string; budget_period_id: number }>(
        `INSERT INTO budget_period_items (budget_period_id, budget_item_id) SELECT id, $1 FROM unnest($2::int[]) AS p(id) RETURNING uuid, budget_period_id`,
        [envelope.id, periods.map((p) => p.id)]
      )
    ).rows;
    for (let k = 4; k >= 0; k--) {
      const period = periods.find((p) => p.start_date === monthStart(k))!;
      const item = items.find((i) => i.budget_period_id === period.id)!;
      await ok(h.call(member, 'put', `/api/budgets/period-items/${item.uuid}/budget`, { amount: k === 4 ? base : step }));
    }
    return envelope;
  };

  const history = async (goal: { uuid: string }) =>
    (await ok(h.call(member, 'get', `/api/goals/${goal.uuid}/progress-history?start_date=${monthStart(4)}`))).history as Point[];
  /** The accounts' part of each point: E-4, E-3, E-2, E-1 and today. */
  const fromAccounts = async (goal: { uuid: string }) => (await history(goal)).map((p) => p.total_from_accounts);
  const fromEnvelopes = async (goal: { uuid: string }) => (await history(goal)).map((p) => p.total_from_budget_items);
  const accountLinks = (goal: { id: number }, account: Ref) =>
    a.pool
      .query<{ id: number; valid_from: string; valid_to: string | null }>(
        'SELECT id, valid_from::text, valid_to::text FROM budget_item_accounts WHERE budget_item_id = $1 AND account_id = $2 ORDER BY valid_from',
        [goal.id, account.id]
      )
      .then((r) => r.rows);
  const envelopeLinks = (goal: { id: number }, envelope: Ref) =>
    a.pool
      .query<{ id: number; valid_from: string; valid_to: string | null }>(
        'SELECT id, valid_from::text, valid_to::text FROM goal_budget_items WHERE goal_id = $1 AND budget_item_id = $2 ORDER BY valid_from',
        [goal.id, envelope.id]
      )
      .then((r) => r.rows);
  const hiddenRanges = (account: Ref) =>
    a.pool
      .query<{ id: number; hidden_from: string | null; hidden_to: string | null }>(
        'SELECT id, hidden_from::text, hidden_to::text FROM account_hidden_ranges WHERE account_id = $1 ORDER BY hidden_from NULLS FIRST',
        [account.id]
      )
      .then((r) => r.rows);
  const link = (goal: { uuid: string }, account: Ref) => ok(h.call(member, 'post', `/api/goals/${goal.uuid}/accounts`, { account_id: account.id }), 201);
  const unlink = (goal: { uuid: string }, account: Ref) => ok(h.call(member, 'delete', `/api/goals/${goal.uuid}/accounts/${account.uuid}`));
  const linkEnvelope = (goal: { uuid: string }, envelope: Ref) =>
    ok(h.call(member, 'post', `/api/goals/${goal.uuid}/budget-items`, { budget_item_id: envelope.id }), 201);
  const unlinkEnvelope = (goal: { uuid: string }, envelope: Ref) => ok(h.call(member, 'delete', `/api/goals/${goal.uuid}/budget-items/${envelope.uuid}`));
  /** Hide or show an account through the account form's route, as a member does. */
  const setHidden = (account: Ref, hidden: boolean) =>
    ok(
      h.call(member, 'put', `/api/accounts/${account.uuid}`, {
        name: account.name,
        account_type: 'savings',
        account_group: 'cash',
        type: 'Asset',
        hide_account: hidden,
      })
    );

  beforeAll(async () => {
    h = await startRouteHarness('Goal link history');
    a = await createTestTenant('Goal link history A');
    b = await createTestTenant('Goal link history B');
    member = await h.signIn(a.userId, a.tenantId);
    memberB = await h.signIn(b.userId, b.tenantId);
    today = (await one<{ today: string }>(a, 'SELECT app_today()::text AS today')).today;
    periods = (
      await a.pool.query<{ id: number; start_date: string }>(
        `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
         SELECT to_char(d, 'FMMonth YYYY'), to_char(d, 'FMMonth'), extract(year FROM d)::int, extract(month FROM d)::int,
                d::date, (d + interval '1 month - 1 day')::date
           FROM generate_series(date_trunc('month', app_today()::timestamp) - interval '4 months',
                                date_trunc('month', app_today()::timestamp), interval '1 month') AS d
         RETURNING id, start_date::text`
      )
    ).rows;
  }, 120_000);

  afterAll(async () => {
    const settled = await Promise.allSettled([h?.close(), a?.cleanup(), b?.cleanup()]);
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }, 60_000);

  it('counts an account from the day it was linked, not before', async () => {
    const goal = await newGoal();
    const savings = await newAccount(1000, 100);
    await link(goal, savings);
    expect(await accountLinks(goal, savings)).toEqual([{ id: expect.any(Number), valid_from: today, valid_to: null }]);
    // Linked today: only today's point counts it.
    expect(await fromAccounts(goal)).toEqual(['0.00', '0.00', '0.00', '0.00', '1400.00']);

    // As if linked on the 10th of M-2: from E-2 on, each at its balance then.
    await a.pool.query('UPDATE budget_item_accounts SET valid_from = $3 WHERE budget_item_id = $1 AND account_id = $2', [goal.id, savings.id, day(2, 10)]);
    expect(await fromAccounts(goal)).toEqual(['0.00', '0.00', '1200.00', '1300.00', '1400.00']);
    // Linking it again while it is linked changes nothing.
    await link(goal, savings);
    expect(await accountLinks(goal, savings)).toEqual([{ id: expect.any(Number), valid_from: day(2, 10), valid_to: null }]);
  });

  it('unlinking an account ends its link today: the points before today still count it', async () => {
    const goal = await newGoal();
    const savings = await newAccount(1000, 100);
    const other = await newAccount(5, 0);
    await link(goal, savings);
    await link(goal, other);
    await a.pool.query('UPDATE budget_item_accounts SET valid_from = $2 WHERE budget_item_id = $1', [goal.id, day(3, 1)]);

    await unlink(goal, savings);
    const [closed] = await accountLinks(goal, savings);
    expect(closed).toEqual({ id: expect.any(Number), valid_from: day(3, 1), valid_to: today });
    expect(await fromAccounts(goal)).toEqual(['0.00', '1105.00', '1205.00', '1305.00', '5.00']);

    // Today's figures and the lists show the links in effect now.
    const detail = (await ok(h.call(member, 'get', `/api/goals/${goal.uuid}`))).goal as {
      total_from_accounts: number;
      associated_accounts: Array<{ id: number; linked_since: string }>;
    };
    expect(detail.total_from_accounts).toBe(5);
    expect(detail.associated_accounts.map((x) => [x.id, x.linked_since])).toEqual([[other.id, day(3, 1)]]);
    const listed = (await ok(h.call(member, 'get', '/api/goals'))).goals as Array<{ uuid: string; account_count: string; current_progress: number }>;
    expect(listed.find((g) => g.uuid === goal.uuid)).toMatchObject({ account_count: '1', current_progress: 5 });
    const balances = (await ok(h.call(member, 'get', `/api/goals/${goal.uuid}/balance-history?period=day&limit=0`))).history as Array<{ balance: number }>;
    expect(balances).toEqual([{ date: today, balance: 5 }]);
    const perAccount = (await ok(h.call(member, 'get', `/api/goals/${goal.uuid}/account-balance-history?period=day&limit=0`))).accounts as Array<{
      account_id: number;
    }>;
    expect(perAccount.map((x) => x.account_id)).toEqual([other.id]);

    // Unlinking it again (it isn't linked) changes nothing.
    await unlink(goal, savings);
    expect(await accountLinks(goal, savings)).toEqual([closed]);
  });

  it('linking an account again goes on with the link closed today, or opens a new one after a gap', async () => {
    const goal = await newGoal();
    const savings = await newAccount(1000, 100);
    await link(goal, savings);
    await a.pool.query('UPDATE budget_item_accounts SET valid_from = $2 WHERE budget_item_id = $1', [goal.id, day(4, 3)]);
    const [first] = await accountLinks(goal, savings);

    // Unlinked and linked again today: one link, as if it had never been removed.
    await unlink(goal, savings);
    await link(goal, savings);
    expect(await accountLinks(goal, savings)).toEqual([{ id: first.id, valid_from: day(4, 3), valid_to: null }]);
    expect(await fromAccounts(goal)).toEqual(['1000.00', '1100.00', '1200.00', '1300.00', '1400.00']);

    // As if unlinked on the 10th of M-2, then linked again today: a second link.
    await unlink(goal, savings);
    await a.pool.query('UPDATE budget_item_accounts SET valid_to = $2 WHERE id = $1', [first.id, day(2, 10)]);
    await link(goal, savings);
    const links = await accountLinks(goal, savings);
    expect(links).toEqual([
      { id: first.id, valid_from: day(4, 3), valid_to: day(2, 10) },
      { id: expect.any(Number), valid_from: today, valid_to: null },
    ]);
    expect(await fromAccounts(goal)).toEqual(['1000.00', '1100.00', '0.00', '0.00', '1400.00']);

    // As if linked again on the 20th of M-1: E-1 counts it, and once however many links it has.
    await a.pool.query('UPDATE budget_item_accounts SET valid_from = $2 WHERE id = $1', [links[1].id, day(1, 20)]);
    expect(await fromAccounts(goal)).toEqual(['1000.00', '1100.00', '0.00', '1300.00', '1400.00']);
    const detail = (await ok(h.call(member, 'get', `/api/goals/${goal.uuid}`))).goal as { total_from_accounts: number; associated_accounts: unknown[] };
    expect(detail.total_from_accounts).toBe(1400);
    expect(detail.associated_accounts).toHaveLength(1);
    const listed = (await ok(h.call(member, 'get', '/api/goals'))).goals as Array<{ uuid: string; account_count: string }>;
    expect(listed.find((g) => g.uuid === goal.uuid)?.account_count).toBe('1');
    const balances = (await ok(h.call(member, 'get', `/api/goals/${goal.uuid}/balance-history?period=day&limit=0`))).history;
    expect(balances).toEqual([{ date: today, balance: 1400 }]);
  });

  it('leaves no link behind when one is made and removed the same day', async () => {
    const goal = await newGoal();
    const savings = await newAccount(1000, 100);
    const envelope = await newEnvelope(10, 20);
    await link(goal, savings);
    await linkEnvelope(goal, envelope);
    await unlink(goal, savings);
    await unlinkEnvelope(goal, envelope);
    expect(await accountLinks(goal, savings)).toEqual([]);
    expect(await envelopeLinks(goal, envelope)).toEqual([]);
  });

  it("links one goal's account twice at once as one link", async () => {
    const goal = await newGoal();
    const savings = await newAccount(1000, 100);
    const envelope = await newEnvelope(10, 20);
    await Promise.all([link(goal, savings), link(goal, savings), linkEnvelope(goal, envelope), linkEnvelope(goal, envelope)]);
    expect(await accountLinks(goal, savings)).toHaveLength(1);
    expect(await envelopeLinks(goal, envelope)).toHaveLength(1);
    await Promise.all([unlink(goal, savings), unlink(goal, savings)]);
    expect(await accountLinks(goal, savings)).toEqual([]);
  });

  it('counts an envelope only while it is linked, as it does an account', async () => {
    const goal = await newGoal();
    const envelope = await newEnvelope(10, 20);
    const steady = await newEnvelope(1, 0);
    await linkEnvelope(goal, envelope);
    await linkEnvelope(goal, steady);
    expect(await envelopeLinks(goal, envelope)).toEqual([{ id: expect.any(Number), valid_from: today, valid_to: null }]);
    // Its balance is 10, 30, 50, 70 and 90 at E-4..today; the steady one's 1.
    expect(await fromEnvelopes(goal)).toEqual(['0.00', '0.00', '0.00', '0.00', '91.00']);

    // As if linked on the 15th of M-3, and unlinked today.
    await a.pool.query('UPDATE goal_budget_items SET valid_from = $2 WHERE goal_id = $1', [goal.id, day(3, 15)]);
    expect(await fromEnvelopes(goal)).toEqual(['0.00', '31.00', '51.00', '71.00', '91.00']);
    await unlinkEnvelope(goal, envelope);
    expect(await envelopeLinks(goal, envelope)).toEqual([{ id: expect.any(Number), valid_from: day(3, 15), valid_to: today }]);
    expect(await fromEnvelopes(goal)).toEqual(['0.00', '31.00', '51.00', '71.00', '1.00']);
    const detail = (await ok(h.call(member, 'get', `/api/goals/${goal.uuid}`))).goal as {
      total_from_budget_items: number;
      associated_budget_items: Array<{ id: number; linked_since: string }>;
    };
    expect(detail.total_from_budget_items).toBe(1);
    expect(detail.associated_budget_items.map((x) => [x.id, x.linked_since])).toEqual([[steady.id, day(3, 15)]]);
    const listed = (await ok(h.call(member, 'get', '/api/goals'))).goals as Array<{ uuid: string; budget_item_count: string }>;
    expect(listed.find((g) => g.uuid === goal.uuid)?.budget_item_count).toBe('1');

    // As if unlinked on the 10th of M-1, and linked again today: two links, a gap at E-1.
    const [first] = await envelopeLinks(goal, envelope);
    await a.pool.query('UPDATE goal_budget_items SET valid_to = $2 WHERE id = $1', [first.id, day(1, 10)]);
    await linkEnvelope(goal, envelope);
    expect(await envelopeLinks(goal, envelope)).toHaveLength(2);
    expect(await fromEnvelopes(goal)).toEqual(['0.00', '31.00', '51.00', '1.00', '91.00']);
    // Unlinked the day it was linked again, and linked once more: still two links.
    await unlinkEnvelope(goal, envelope);
    await linkEnvelope(goal, envelope);
    expect((await envelopeLinks(goal, envelope)).map((l) => l.valid_to)).toEqual([day(1, 10), null]);
  });

  it('leaves an account out of the points from the day it was hidden to the day it was shown', async () => {
    const goal = await newGoal();
    const savings = await newAccount(1000, 100);
    const other = await newAccount(5, 0);
    await link(goal, savings);
    await link(goal, other);
    await a.pool.query('UPDATE budget_item_accounts SET valid_from = $2 WHERE budget_item_id = $1', [goal.id, day(4, 2)]);
    expect(await fromAccounts(goal)).toEqual(['1005.00', '1105.00', '1205.00', '1305.00', '1405.00']);

    // Hidden today through the account form: only today's point leaves it out.
    await setHidden(savings, true);
    expect(await hiddenRanges(savings)).toEqual([{ id: expect.any(Number), hidden_from: today, hidden_to: null }]);
    expect(await fromAccounts(goal)).toEqual(['1005.00', '1105.00', '1205.00', '1305.00', '5.00']);
    expect(((await ok(h.call(member, 'get', `/api/goals/${goal.uuid}`))).goal as { total_from_accounts: number }).total_from_accounts).toBe(5);

    // As if hidden on the 10th of M-2, and shown again today.
    await a.pool.query('UPDATE account_hidden_ranges SET hidden_from = $2 WHERE account_id = $1', [savings.id, day(2, 10)]);
    expect(await fromAccounts(goal)).toEqual(['1005.00', '1105.00', '5.00', '5.00', '5.00']);
    await setHidden(savings, false);
    expect(await hiddenRanges(savings)).toEqual([{ id: expect.any(Number), hidden_from: day(2, 10), hidden_to: today }]);
    expect(await fromAccounts(goal)).toEqual(['1005.00', '1105.00', '5.00', '5.00', '1405.00']);

    // Hidden again the day it was shown: that range goes on. Then shown again, as if the
    // range had ended on the 20th of M-1.
    await setHidden(savings, true);
    const [range] = await hiddenRanges(savings);
    expect(range).toEqual({ id: expect.any(Number), hidden_from: day(2, 10), hidden_to: null });
    await setHidden(savings, false);
    await a.pool.query('UPDATE account_hidden_ranges SET hidden_to = $2 WHERE id = $1', [range.id, day(1, 20)]);
    expect(await fromAccounts(goal)).toEqual(['1005.00', '1105.00', '5.00', '1305.00', '1405.00']);

    // Hidden and shown again the same day: no range for it, nothing changes.
    await setHidden(savings, true);
    await setHidden(savings, false);
    expect(await hiddenRanges(savings)).toEqual([{ id: range.id, hidden_from: day(2, 10), hidden_to: day(1, 20) }]);
    expect(await fromAccounts(goal)).toEqual(['1005.00', '1105.00', '5.00', '1305.00', '1405.00']);
  });

  it('never counts an account created hidden until it is shown, and records any writer of the flag', async () => {
    const goal = await newGoal();
    const hidden = await newAccount(5000, 0, true);
    expect(await hiddenRanges(hidden)).toEqual([{ id: expect.any(Number), hidden_from: null, hidden_to: null }]);
    await link(goal, hidden);
    await a.pool.query('UPDATE budget_item_accounts SET valid_from = $2 WHERE budget_item_id = $1', [goal.id, day(4, 2)]);
    expect(await fromAccounts(goal)).toEqual(['0.00', '0.00', '0.00', '0.00', '0.00']);

    // Shown by a plain UPDATE (a script, say), not the route: the trigger records it all the same.
    await a.pool.query('UPDATE accounts SET hide_account = false WHERE id = $1', [hidden.id]);
    expect(await hiddenRanges(hidden)).toEqual([{ id: expect.any(Number), hidden_from: null, hidden_to: today }]);
    expect(await fromAccounts(goal)).toEqual(['0.00', '0.00', '0.00', '0.00', '5000.00']);
    // An update that leaves the flag as it is writes nothing.
    await a.pool.query('UPDATE accounts SET hide_account = false, notes = $2 WHERE id = $1', [hidden.id, 'unchanged']);
    expect(await hiddenRanges(hidden)).toHaveLength(1);
    // Created through the route, hidden: hidden since always too.
    const created = await ok(
      h.call(member, 'post', '/api/accounts', { name: unique('Hidden from the start'), account_type: 'savings', account_group: 'cash', type: 'Asset', hide_account: true }),
      201
    );
    expect(await hiddenRanges({ id: created.id as number, uuid: '', name: '' })).toEqual([{ id: expect.any(Number), hidden_from: null, hidden_to: null }]);
  });

  it("keeps each ledger's hiding history to itself", async () => {
    const theirs = await one<Ref>(
      b,
      `INSERT INTO accounts (name, account_type, account_group, type, hide_account) VALUES ('Their savings', 'savings', 'cash', 'Asset', true) RETURNING id, uuid, name`
    );
    const range = await one<{ tenant_id: number }>(b, 'SELECT tenant_id FROM account_hidden_ranges WHERE account_id = $1', [theirs.id]);
    expect(range.tenant_id).toBe(b.tenantId);
    // Ledger A sees none of B's ranges, and can't write one for B's account.
    expect((await a.pool.query('SELECT 1 FROM account_hidden_ranges WHERE account_id = $1', [theirs.id])).rowCount).toBe(0);
    await expect(
      a.pool.query('INSERT INTO account_hidden_ranges (tenant_id, account_id) VALUES ($1, $2)', [b.tenantId, theirs.id])
    ).rejects.toThrow(/row-level security/);
    await expect(a.pool.query('INSERT INTO account_hidden_ranges (account_id) VALUES ($1)', [theirs.id])).rejects.toThrow(/foreign key/);
    // And B's goal routes don't see A's goals.
    const goalA = await newGoal();
    expect((await h.call(memberB, 'get', `/api/goals/${goalA.uuid}/progress-history`)).status).toBe(404);
  });
});
