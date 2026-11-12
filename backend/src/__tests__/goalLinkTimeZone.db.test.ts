import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import { withTenant } from '../db/withTenant.js';
import { GoalService } from '../services/GoalService.js';
import { addDays } from '../utils/calendarDate.js';

/**
 * A goal's links and its accounts' hidden ranges are stored as days of the ledger's time
 * zone, and a change of that zone can move today back: Pacific/Kiritimati is UTC+14,
 * Pacific/Pago_Pago UTC-11, so the ledger's today is a day or two earlier in the second.
 * Today's figure must still agree with the goal's lists (the links open now, the accounts
 * not hidden now), and hiding, showing, linking and unlinking across such a change must
 * leave one open range for what is hidden or linked now.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const AHEAD = 'Pacific/Kiritimati';
const BEHIND = 'Pacific/Pago_Pago';

describeDb('Goal links and hiding across a change of time zone', () => {
  let t: TestTenant;
  let seq = 0;
  const service = new GoalService();

  beforeAll(async () => {
    t = await createTestTenant('goal time zone');
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  /** Set the ledger's zone; returns its today then. */
  const zone = async (name: string) => {
    await t.pool.query(
      `INSERT INTO tenant_settings (setting_key, setting_value) VALUES ('application_timezone', $1)
       ON CONFLICT (tenant_id, setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
      [name]
    );
    return (await t.pool.query<{ today: string }>('SELECT app_today()::text AS today')).rows[0].today;
  };
  /** A goal and a 500.00 account, linked since 2026-01-01 unless `linked` is false. */
  const fixture = async (linked = true) => {
    const n = ++seq;
    const goal = (await t.pool.query<{ id: number }>(`INSERT INTO budget_items (name, expense_type, type) VALUES ($1, 'Savings', 'Goal') RETURNING id`, [`TZ goal ${n}`])).rows[0];
    const account = (
      await t.pool.query<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'savings', 'cash', 'Asset') RETURNING id`, [
        `TZ account ${n}`,
      ])
    ).rows[0];
    await t.pool.query(`INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, 500, '2026-01-01', 'starting balance', 'Opening')`, [account.id]);
    if (linked) await t.pool.query(`INSERT INTO budget_item_accounts (budget_item_id, account_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [goal.id, account.id]);
    return { goal: goal.id, account: account.id };
  };
  const hide = (account: number, hidden: boolean) => t.pool.query('UPDATE accounts SET hide_account = $2 WHERE id = $1', [account, hidden]);
  const ranges = async (account: number) =>
    (
      await t.pool.query<{ hidden_from: string | null; hidden_to: string | null }>(
        'SELECT hidden_from::text, hidden_to::text FROM account_hidden_ranges WHERE account_id = $1 ORDER BY hidden_from NULLS FIRST',
        [account]
      )
    ).rows;
  const links = async (goal: number) =>
    (
      await t.pool.query<{ id: number; valid_from: string; valid_to: string | null }>(
        'SELECT id, valid_from::text, valid_to::text FROM budget_item_accounts WHERE budget_item_id = $1 ORDER BY valid_from, id',
        [goal]
      )
    ).rows;
  /** Today's figure from the accounts, and the accounts the goal lists: they must agree. */
  const now = async (goal: number) => ({
    counted: (await withTenant(t.tenantId, () => service.calculateCurrentProgress(goal))).totalFromAccounts,
    listed: (await withTenant(t.tenantId, () => service.getAssociatedAccounts(goal))).length,
  });

  it("leaves an account hidden under the old zone out of today's figure, as the list does", async () => {
    const { goal, account } = await fixture();
    const ahead = await zone(AHEAD);
    await hide(account, true);
    expect(await ranges(account)).toEqual([{ hidden_from: ahead, hidden_to: null }]);

    // Today moves back before the day it was hidden on.
    const behind = await zone(BEHIND);
    expect(behind < ahead).toBe(true);
    expect(await now(goal)).toEqual({ counted: 0, listed: 0 });
    // Yesterday it wasn't hidden, and counts.
    const [yesterday] = await withTenant(t.tenantId, () => service.progressAt(goal, [addDays(behind, -1)]));
    expect(yesterday.total_from_accounts).toBe('500.00');

    // Shown again today: its range began after today, so it hid the account at the end of
    // no day before today, and goes.
    await hide(account, false);
    expect(await ranges(account)).toEqual([]);
    expect(await now(goal)).toEqual({ counted: 500, listed: 1 });
  });

  it('keeps one open range for an account hidden, shown and hidden again across two changes', async () => {
    const { goal, account } = await fixture();
    const behind = await zone(BEHIND);
    await hide(account, true);
    const ahead = await zone(AHEAD);
    await hide(account, false);
    expect(await ranges(account)).toEqual([{ hidden_from: behind, hidden_to: ahead }]);

    // Back behind: the range it was shown at ends after today, so it goes on (an insert of
    // a range from today clashed with it on its first day, and recorded nothing).
    await zone(BEHIND);
    await hide(account, true);
    expect(await ranges(account)).toEqual([{ hidden_from: behind, hidden_to: null }]);
    expect(await now(goal)).toEqual({ counted: 0, listed: 0 });
    // And a day after it was hidden, under either zone, it is still hidden.
    await zone(AHEAD);
    const [later] = await withTenant(t.tenantId, () => service.progressAt(goal, [addDays(behind, 1)]));
    expect(later.total_from_accounts).toBe('0.00');
  });

  it("counts today the links open now, and goes on with a link that ends after today", async () => {
    const { goal, account } = await fixture(false);

    // Linked under the zone ahead, then today moves back before the link's first day: it is
    // listed and counted today. Unlinked then: it began after today, so it goes.
    const ahead = await zone(AHEAD);
    await withTenant(t.tenantId, () => service.associateAccount(goal, account));
    expect((await links(goal)).map((l) => [l.valid_from, l.valid_to])).toEqual([[ahead, null]]);
    const behind = await zone(BEHIND);
    expect(await now(goal)).toEqual({ counted: 500, listed: 1 });
    await withTenant(t.tenantId, () => service.removeAccountAssociation(goal, account));
    expect(await links(goal)).toEqual([]);
    expect(await now(goal)).toEqual({ counted: 0, listed: 0 });

    // Linked behind, unlinked ahead, then behind again: the closed link still covers today
    // by its days, but it isn't open, so neither the list nor today's figure has it.
    await withTenant(t.tenantId, () => service.associateAccount(goal, account));
    await zone(AHEAD);
    await withTenant(t.tenantId, () => service.removeAccountAssociation(goal, account));
    const [closed] = await links(goal);
    expect([closed.valid_from, closed.valid_to]).toEqual([behind, ahead]);
    await zone(BEHIND);
    expect(await now(goal)).toEqual({ counted: 0, listed: 0 });
    // Linked again: that link goes on rather than a second one open beside it.
    await withTenant(t.tenantId, () => service.associateAccount(goal, account));
    expect(await links(goal)).toEqual([{ id: closed.id, valid_from: behind, valid_to: null }]);
    expect(await now(goal)).toEqual({ counted: 500, listed: 1 });
  });
});
