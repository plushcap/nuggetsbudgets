import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { globalDb, withTenant, getDb } from '../../../db/withTenant.js';
import { BillService } from '../../../services/bills/BillService.js';
import { billMessage } from '../../../services/notifications/messages.js';
import { fixtureAccountId } from '../../../test/fixtureAccount.js';

/**
 * Bill occurrences end to end against Postgres, in a tenant of its own, on a
 * fixed "today" of 15 November 2026:
 * - Internet, $100 monthly on the 5th
 * - Car insurance, $600 every 6 months from 20 December
 * - Electric, about $80 monthly on the 25th, varying, with three paid months
 *   before tracking started (August to October: $80, $90, $100)
 *
 * The CI database role bypasses RLS, so fixtures and cleanup name the tenant.
 */
describe('BillService (database)', () => {
  const today = '2026-11-15';
  const stamp = Date.now();
  const service = new BillService();

  let tenantId: number;
  let organizationId: number;
  let userId: number;
  const items = { internet: 0, insurance: 0, electric: 0, groceries: 0 };
  const inTenant = <T>(fn: () => Promise<T>) => withTenant(tenantId, fn);

  const addTransaction = (budgetItemId: number, date: string, amount: number, description = 'Payment') =>
    inTenant(async () => getDb()
      .insertInto('transactions')
      .values({ account_id: await fixtureAccountId(getDb()), type: 'expense', amount: amount.toFixed(2), transaction_date: date, budget_item_id: budgetItemId, description })
      .returning(['id', 'uuid'])
      .executeTakeFirstOrThrow());

  const month = (m: string) => inTenant(() => service.monthView(m, today));
  const find = async (m: string, name: string) => (await month(m)).occurrences.find((o) => o.bill.name.startsWith(name));

  beforeAll(async () => {
    const organization = await globalDb.insertInto('organizations').values({ name: `Bills org ${stamp}` }).returning('id').executeTakeFirstOrThrow();
    organizationId = organization.id;
    tenantId = (await globalDb.insertInto('tenants').values({ name: `Bills ${stamp}`, organization_id: organizationId }).returning('id').executeTakeFirstOrThrow()).id;
    userId = (await globalDb.insertInto('users').values({ email: `bills-${stamp}@test.local`, password_hash: 'x' }).returning('id').executeTakeFirstOrThrow()).id;

    await inTenant(async () => {
      const bill = (name: string, amount: number, frequency: number, anchor: string, varies = false) => getDb()
        .insertInto('budget_items')
        .values({
          name: `${name} ${stamp}`, expense_type: 'Expense', type: frequency === 1 ? 'Monthly' : 'Envelope', subtype: 'Fixed',
          isbill: true, recurring_payment: true, recurring_payment_amount: amount.toFixed(2),
          recurring_payment_frequency: frequency, recurring_next_payment_date: anchor, recurring_amount_varies: varies,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      items.internet = (await bill('Internet', 100, 1, '2026-01-05')).id;
      items.insurance = (await bill('Car insurance', 600, 6, '2026-12-20')).id;
      items.electric = (await bill('Electric', 80, 1, '2026-08-25', true)).id;
      items.groceries = (await getDb().insertInto('budget_items').values({ name: `Groceries ${stamp}`, expense_type: 'Expense', type: 'Monthly' }).returning('id').executeTakeFirstOrThrow()).id;
    });

    // Electric's history from before tracking: made by hand, as no back-fill makes them.
    for (const [due, paid] of [['2026-08-25', 80], ['2026-09-25', 90], ['2026-10-25', 100]] as const) {
      const tx = await addTransaction(items.electric, due, -paid);
      await inTenant(async () => {
        const occurrence = await getDb().insertInto('bill_occurrences')
          .values({ budget_item_id: items.electric, due_date: due, expected_amount: '-80.00' })
          .returning('id')
          .executeTakeFirstOrThrow();
        await getDb().insertInto('bill_occurrence_transactions')
          .values({ bill_occurrence_id: occurrence.id, transaction_id: tx.id, matched_by: 'manual' })
          .execute();
      });
    }
  });

  afterAll(async () => {
    await inTenant(async () => {
      await getDb().deleteFrom('bill_occurrence_transactions').where('tenant_id', '=', tenantId).execute();
      await getDb().deleteFrom('bill_occurrences').where('tenant_id', '=', tenantId).execute();
      await getDb().deleteFrom('transactions').where('tenant_id', '=', tenantId).execute();
      await getDb().deleteFrom('accounts').where('tenant_id', '=', tenantId).execute();
      await getDb().deleteFrom('budget_period_items').where('tenant_id', '=', tenantId).execute();
      await getDb().deleteFrom('budget_items').where('tenant_id', '=', tenantId).execute();
    });
    await globalDb.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await globalDb.deleteFrom('organizations').where('id', '=', organizationId).execute();
    await globalDb.deleteFrom('users').where('id', '=', userId).execute();
  });

  it("lists this month's bills with their status, and only bills due that month", async () => {
    const view = await month('2026-11');
    expect(view.occurrences.map((o) => [o.bill.name.split(' ')[0], o.due_date, o.status])).toEqual([
      ['Internet', '2026-11-05', 'overdue'],
      ['Electric', '2026-11-25', 'upcoming'],
    ]);
    // Electric varies: expected is the average of its last three payments.
    expect(view.occurrences[1].expected).toBe(90);
    expect(view.totals).toEqual({ expected: 190, paid: 0, remaining: 190 });

    expect((await month('2026-12')).occurrences.map((o) => o.bill.name.split(' ')[0])).toEqual(['Internet', 'Car', 'Electric']);
  });

  it("doesn't make due dates for months before tracking started", async () => {
    expect((await month('2026-10')).occurrences.map((o) => o.bill.name.split(' ')[0])).toEqual(['Electric']);
  });

  it('marks a bill paid when a payment within 10 days arrives, allowing 10% under', async () => {
    const tx = await addTransaction(items.internet, '2026-11-03', -92.5);
    const internet = await find('2026-11', 'Internet');
    expect(internet).toMatchObject({ status: 'paid', paid: 92.5, paid_date: '2026-11-03' });
    expect(internet?.payments).toEqual([expect.objectContaining({ transaction_uuid: tx.uuid, matched_by: 'auto' })]);

    const last = await inTenant(() => getDb().selectFrom('budget_items').select('recurring_last_payment_date').where('id', '=', items.internet).executeTakeFirstOrThrow());
    expect(last.recurring_last_payment_date).toBe('2026-11-03');
  });

  it("leaves a payment outside the window unplaced, and places it on a later due date by hand", async () => {
    // Paid in November for the June instalment.
    const early = await addTransaction(items.insurance, '2026-11-10', -600, 'Insurance, paid early');
    const view = await month('2026-11');
    expect(view.unplaced).toEqual([expect.objectContaining({ transaction_uuid: early.uuid, amount: 600 })]);

    const insuranceUuid = (await month('2026-12')).occurrences.find((o) => o.bill.name.startsWith('Car'))!.bill.uuid;
    const dueDates = await inTenant(() => service.dueDates(insuranceUuid, today));
    expect(dueDates.map((d) => d.due_date)).toEqual(['2026-12-20', '2027-06-20']);

    const placed = await inTenant(() => service.place(insuranceUuid, early.uuid, '2027-06-20', userId, today));
    expect(placed).toMatchObject({ due_date: '2027-06-20', status: 'paid', paid: 600 });
    expect((await month('2026-11')).unplaced).toEqual([]);

    await expect(inTenant(() => service.place(insuranceUuid, early.uuid, '2027-03-20', userId, today))).rejects.toThrow('isn’t due on 2027-03-20');
  });

  it('counts a partial payment, and a second one completes it', async () => {
    await addTransaction(items.electric, '2026-11-20', -40);
    expect(await find('2026-11', 'Electric')).toMatchObject({ status: 'partly_paid', paid: 40 });
    await addTransaction(items.electric, '2026-11-24', -55);
    expect(await find('2026-11', 'Electric')).toMatchObject({ status: 'paid', paid: 95 });
  });

  it("unlinks a payment for good: it isn't matched again", async () => {
    const internet = (await find('2026-11', 'Internet'))!;
    const unlinked = await inTenant(() => service.unlink(internet.uuid, internet.payments[0].transaction_uuid, userId, today));
    expect(unlinked).toMatchObject({ status: 'overdue', paid: 0, payments: [] });
    expect(await find('2026-11', 'Internet')).toMatchObject({ status: 'overdue' });

    // Linking it by hand brings it back.
    const relinked = await inTenant(() => service.link(internet.uuid, internet.payments[0].transaction_uuid, userId, today));
    expect(relinked.payments).toEqual([expect.objectContaining({ matched_by: 'manual' })]);
  });

  it('drops an automatic link when the payment moves to another budget item', async () => {
    const tx = await addTransaction(items.internet, '2026-12-04', -100);
    expect(await find('2026-12', 'Internet')).toMatchObject({ status: 'paid' });
    await inTenant(() => getDb().updateTable('transactions').set({ budget_item_id: items.groceries }).where('id', '=', tx.id).execute());
    expect(await find('2026-12', 'Internet')).toMatchObject({ status: 'upcoming', payments: [] });
  });

  it('skips a due date and marks one paid by hand, and undoes either', async () => {
    const december = (await find('2026-12', 'Electric'))!;
    const skipped = await inTenant(() => service.resolve(december.uuid, { resolution: 'skipped', note: 'Credit from the utility' }, userId, today));
    expect(skipped).toMatchObject({ status: 'skipped', note: 'Credit from the utility' });
    expect((await month('2026-12')).totals.expected).toBe(700);

    const manual = await inTenant(() => service.resolve(december.uuid, { resolution: 'paid_manually', paid_date: '2026-12-01', paid_amount: 88 }, userId, today));
    expect(manual).toMatchObject({ status: 'paid', paid: 88, paid_date: '2026-12-01' });

    const undone = await inTenant(() => service.resolve(december.uuid, { resolution: null }, userId, today));
    expect(undone).toMatchObject({ status: 'upcoming', resolution: null, paid: 0 });
  });

  // The API refuses a frequency below 1; a bill holding one from before has no
  // schedule, so the month, the forecast and its due dates leave it out (the pages say so).
  it('leaves out a bill whose frequency is below 1: no due dates, nothing forecast', async () => {
    const before = { month: await month('2026-11'), forecast: await inTenant(() => service.forecast(3, today)) };
    const legacy = await inTenant(() => getDb().insertInto('budget_items').values({
      name: `No schedule ${stamp}`, expense_type: 'Expense', type: 'Monthly', subtype: 'Fixed', isbill: true, recurring_payment: true,
      recurring_payment_amount: '50.00', recurring_payment_frequency: 0, recurring_next_payment_date: '2026-11-20',
    }).returning(['id', 'uuid']).executeTakeFirstOrThrow());
    try {
      expect(await month('2026-11')).toEqual(before.month);
      expect(await inTenant(() => service.forecast(3, today))).toEqual(before.forecast);
      await expect(inTenant(() => service.dueDates(legacy.uuid, today))).rejects.toMatchObject({ status: 404 });
    } finally {
      await inTenant(() => getDb().deleteFrom('budget_period_items').where('budget_item_id', '=', legacy.id).execute());
      await inTenant(() => getDb().deleteFrom('budget_items').where('id', '=', legacy.id).execute());
    }
  });

  it('forecasts each month from what was paid, what is expected, and the schedule beyond', async () => {
    const forecast = await inTenant(() => service.forecast(8, today));
    expect(forecast.map((m) => [m.month, m.total])).toEqual([
      // Internet paid 92.50 (relinked), Electric paid 95.
      ['2026-11', 187.5],
      // Internet 100, insurance 600, Electric at the average of its last three payments (95, 100, 90).
      ['2026-12', 795],
      ['2027-01', 195],
      ['2027-02', 195],
      ['2027-03', 195],
      ['2027-04', 195],
      ['2027-05', 195],
      // Insurance already paid early (600), plus Internet and Electric.
      ['2027-06', 795],
    ]);
    expect(forecast[7].items.find((i) => i.bill.name.startsWith('Car'))).toMatchObject({ basis: 'paid', amount: 600 });
  });

  it("gives notification rules each due date's facts, and says what's due", async () => {
    const subjects = await inTenant(() => service.subjects(today));
    const internet = subjects.find((s) => s.occurrence.due_date === '2026-12-05')!;
    expect(internet.facts).toMatchObject({ paid: false, skipped: false, days_until_due: 20, amount: 100 });
    expect(billMessage('A bill due soon', internet.occurrence, '2026-12-03', 'Pat')).toMatchObject({
      subject: `A bill due soon: Internet ${stamp}`,
      path: '/bills?month=2026-12',
      push: { body: '$100.00 due in 2 days. No payment has come in for it yet.' },
    });
  });
});
