import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { Express } from 'express';
import { createBudgetRoutes } from '../budgets.js';
import { createBudgetPeriodRoutes } from '../budget-periods.js';
import { createGoalRoutes } from '../goals.js';
import { rejectMalformedIds } from '../../middleware/routeParams.js';
import { requestScope } from '../../middleware/requestScope.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The budget routes check what they are sent before anything reads it:
 * a value of the wrong kind is a 400 naming its field, where it was a 500 (Postgres
 * refusing it) or was written as sent. The matching-rule routes make one check for create
 * and update, read their amount bounds in cents, and refuse a budget item or merchant that
 * isn't the ledger's with 400 INVALID_REFERENCE, another ledger's alike.
 */
describe('Budget routes: what they are sent', () => {
  let a: TestTenant;
  let b: TestTenant;
  let app: Express;
  type Ref = { id: number; uuid: string };
  let groceries: Ref;
  let corner: Ref;
  let otherItem: Ref;
  let otherMerchant: Ref;
  let period: Ref;

  const one = async <T = Ref>(t: TestTenant, text: string, params: unknown[] = []) => (await t.pool.query(text, params)).rows[0] as T;
  const rulesCount = async () => Number((await one<{ n: string }>(a, 'SELECT COUNT(*) AS n FROM budget_item_matching_rules')).n);

  beforeAll(async () => {
    a = await createTestTenant('Budget request checks');
    b = await createTestTenant('Budget request checks, the other ledger');
    app = express();
    app.use(express.json());
    app.use(requestScope);
    app.use(a.context());
    app.use('/api/budgets', rejectMalformedIds(createBudgetRoutes()));
    app.use('/api/budget-periods', rejectMalformedIds(createBudgetPeriodRoutes()));
    app.use('/api/goals', rejectMalformedIds(createGoalRoutes()));

    groceries = await one(a, `INSERT INTO budget_items (name, expense_type, type) VALUES ('Groceries', 'Expense', 'Monthly') RETURNING id, uuid`);
    corner = await one(a, `INSERT INTO merchants (name) VALUES ('Corner Shop') RETURNING id, uuid`);
    otherItem = await one(b, `INSERT INTO budget_items (name, expense_type, type) VALUES ('Theirs', 'Expense', 'Monthly') RETURNING id, uuid`);
    otherMerchant = await one(b, `INSERT INTO merchants (name) VALUES ('Their shop') RETURNING id, uuid`);
    period = await one(
      a,
      `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
       VALUES ('March 2024', 'March', 2024, 3, '2024-03-01', '2024-03-31') RETURNING id, uuid`,
    );
    await a.pool.query('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2)', [period.id, groceries.id]);
  });

  afterAll(async () => {
    await Promise.all([a?.cleanup(), b?.cleanup()]);
  });

  describe('matching rules', () => {
    const create = (body: Record<string, unknown>) => request(app).post('/api/budgets/item-matching-rules').send(body);
    const update = (uuid: string, body: Record<string, unknown>) => request(app).put(`/api/budgets/item-matching-rules/${uuid}`).send(body);
    let rule: string;

    beforeAll(async () => {
      const res = await create({ budget_item_id: groceries.id, method: 'contains', matching_text: 'corner' }).expect(201);
      rule = res.body.uuid;
    });

    it('refuses an update without the text a text method needs, or the merchant merchant_exact needs, as a create does', async () => {
      for (const send of [(body: Record<string, unknown>) => create(body), (body: Record<string, unknown>) => update(rule, body)]) {
        const noText = await send({ budget_item_id: groceries.id, method: 'starts_with', matching_text: '  ' }).expect(400);
        expect(noText.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Matching text is required for this method' });
        const noMerchant = await send({ budget_item_id: groceries.id, method: 'merchant_exact' }).expect(400);
        expect(noMerchant.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Merchant is required for merchant_exact method' });
      }
      const kept = await one<{ method: string; matching_text: string }>(a, 'SELECT method, matching_text FROM budget_item_matching_rules WHERE uuid = $1', [rule]);
      expect(kept).toEqual({ method: 'contains', matching_text: 'corner' });
    });

    // The add form's "Rule is active" was sent and dropped: every new rule was active.
    it('creates a rule inactive when the body says so, and active by default', async () => {
      const inactive = await create({ budget_item_id: groceries.id, method: 'contains', matching_text: 'paused', is_active: false }).expect(201);
      expect(inactive.body.is_active).toBe(false);
      const stored = await one<{ is_active: boolean }>(a, 'SELECT is_active FROM budget_item_matching_rules WHERE uuid = $1', [inactive.body.uuid]);
      expect(stored).toEqual({ is_active: false });
      const active = await create({ budget_item_id: groceries.id, method: 'contains', matching_text: 'running' }).expect(201);
      expect(active.body.is_active).toBe(true);

      // The lists answered active rules only, so an inactive one couldn't be found,
      // edited or switched on again. Both lists answer it, with its is_active, after the active.
      const listed = async (path: string) => {
        const rows = (await request(app).get(path).expect(200)).body as Array<{ uuid: string; is_active: boolean }>;
        return rows.filter((r) => r.uuid === inactive.body.uuid || r.uuid === active.body.uuid).map((r) => [r.uuid, r.is_active]);
      };
      const both = [[active.body.uuid, true], [inactive.body.uuid, false]];
      expect(await listed('/api/budgets/item-matching-rules')).toEqual(both);
      expect(await listed(`/api/budgets/item-matching-rules?budget_item_id=${groceries.id}`)).toEqual(both);
      expect(await listed(`/api/budgets/item-matching-rules?budget_item_uuid=${groceries.uuid}`)).toEqual(both);
    });

    // A bound of 0 was stored as none, so a maximum of 0 meant no maximum.
    it('keeps a bound of 0', async () => {
      const zero = await create({ budget_item_id: groceries.id, method: 'contains', matching_text: 'refund', amount_min: 0, amount_max: '0' }).expect(201);
      expect(zero.body).toMatchObject({ amount_min: '0.00', amount_max: '0.00' });
      expect(await one(a, 'SELECT amount_min, amount_max FROM budget_item_matching_rules WHERE uuid = $1', [zero.body.uuid])).toEqual({ amount_min: '0.00', amount_max: '0.00' });
      const cleared = await update(zero.body.uuid, { budget_item_id: groceries.id, method: 'contains', matching_text: 'refund', amount_min: null, amount_max: '' }).expect(200);
      expect(cleared.body).toMatchObject({ amount_min: null, amount_max: null });
    });

    it('reads the amount bounds in cents, refusing more than 2 decimals or what is not a number', async () => {
      const before = await rulesCount();
      const tooFine = await create({ budget_item_id: groceries.id, method: 'contains', matching_text: 'x', amount_min: 12.345 }).expect(400);
      expect(tooFine.body).toMatchObject({ code: 'INVALID_AMOUNT', error: 'amount_min must be a number with at most 2 decimal places' });
      // Past what DECIMAL(12,2) holds, as text or as a JSON number, the request's schema refuses
      // it (a number had no bound there).
      const tooBig = await update(rule, { budget_item_id: groceries.id, method: 'contains', matching_text: 'x', amount_max: '100000000000' }).expect(400);
      expect(tooBig.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'amount_max must be between -9,999,999,999.99 and 9,999,999,999.99' });
      const tooBigNumber = await create({ budget_item_id: groceries.id, method: 'contains', matching_text: 'x', amount_min: 1e12 }).expect(400);
      expect(tooBigNumber.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'amount_min must be between -9,999,999,999.99 and 9,999,999,999.99' });
      for (const amount of ['1e2', '0x10', true, 'ten']) {
        const res = await create({ budget_item_id: groceries.id, method: 'contains', matching_text: 'x', amount_min: amount }).expect(400);
        expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'amount_min' }] });
      }
      expect(await rulesCount()).toBe(before);

      const exact = await update(rule, { budget_item_id: groceries.id, method: 'contains', matching_text: 'corner', amount_min: '5.1', amount_max: 99.99 }).expect(200);
      expect(exact.body).toMatchObject({ amount_min: '5.10', amount_max: '99.99' });
    });

    it('answers 400 for an id or uuid that is not one, where it was a 500', async () => {
      for (const [field, value] of [
        ['budget_item_id', 'abc'], ['budget_item_id', 0], ['budget_item_id', 2147483648], ['merchant_id', '12abc'],
        ['budget_item_uuid', 'not-a-uuid'], ['merchant_uuid', 7], ['matching_text', 7], ['priority', 'high'], ['is_active', 'yes'],
      ] as const) {
        const res = await create({ budget_item_id: groceries.id, method: 'contains', matching_text: 'x', [field]: value });
        expect([res.status, res.body.code, res.body.details?.[0]?.field], `${field}: ${String(value)}`).toEqual([400, 'VALIDATION_ERROR', field]);
      }
      for (const query of ['budget_item_id=abc', 'budget_item_id=-1', 'budget_item_uuid=x']) {
        const res = await request(app).get(`/api/budgets/item-matching-rules?${query}`);
        expect([res.status, res.body.code], query).toEqual([400, 'VALIDATION_ERROR']);
      }
      await request(app).get(`/api/budgets/item-matching-rules?budget_item_id=${groceries.id}`).expect(200);
    });

    it("refuses a budget item or merchant that is not the ledger's with 400 INVALID_REFERENCE, another ledger's alike", async () => {
      const before = await rulesCount();
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ budget_item_id: otherItem.id }, 'budget_item_id'],
        [{ budget_item_id: 2147483647 }, 'budget_item_id'],
        [{ budget_item_id: undefined, budget_item_uuid: otherItem.uuid }, 'budget_item_uuid'],
        [{ merchant_id: otherMerchant.id }, 'merchant_id'],
        [{ method: 'merchant_exact', merchant_uuid: otherMerchant.uuid }, 'merchant_uuid'],
      ];
      for (const [fields, field] of cases) {
        const body = { budget_item_id: groceries.id, method: 'contains', matching_text: 'x', ...fields };
        for (const res of [await create(body), await update(rule, body)]) {
          expect([res.status, res.body.code, res.body.field], JSON.stringify(fields)).toEqual([400, 'INVALID_REFERENCE', field]);
        }
      }
      expect(await rulesCount()).toBe(before);

      const byUuid = await update(rule, { budget_item_uuid: groceries.uuid, merchant_uuid: corner.uuid, method: 'merchant_exact' }).expect(200);
      expect(byUuid.body).toMatchObject({ budget_item_id: groceries.id, merchant_id: corner.id, matching_text: null });
    });

    it('refuses a regex that could stall the server on update as on create (INVALID_PATTERN)', async () => {
      const res = await update(rule, { budget_item_id: groceries.id, method: 'regex', matching_text: '(a+)+$' }).expect(400);
      expect(res.body).toMatchObject({ code: 'INVALID_PATTERN', error: 'Invalid pattern' });
    });
  });

  describe('periods and their items', () => {
    it('answers 400 for a budget_item_uuid that is not a uuid, where it was a 500', async () => {
      const res = await request(app).get(`/api/budgets/periods/${period.uuid}/items?budget_item_uuid=not-a-uuid`).expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'budget_item_uuid' }] });
      const one = await request(app).get(`/api/budgets/periods/${period.uuid}/items?budget_item_uuid=${groceries.uuid}`).expect(200);
      expect(one.body.data.map((r: { budget_item_uuid: string }) => r.budget_item_uuid)).toEqual([groceries.uuid]);
    });

    it('takes a budget as a number or decimal text, refusing anything else', async () => {
      const { uuid } = await one<{ uuid: string }>(a, 'SELECT uuid FROM budget_period_items WHERE budget_period_id = $1', [period.id]);
      await request(app).put(`/api/budgets/period-items/${uuid}/budget`).send({ amount: '12.50' }).expect(200);
      const budget = await one<{ b: string }>(a, `SELECT calculate_budget_for_period_item(id) AS b FROM budget_period_items WHERE uuid = $1`, [uuid]);
      expect(budget.b).toBe('12.50');
      for (const amount of ['1e2', null, true, '']) {
        const res = await request(app).put(`/api/budgets/period-items/${uuid}/budget`).send({ amount });
        expect([res.status, res.body.code], String(amount)).toEqual([400, 'VALIDATION_ERROR']);
      }
    });

    it("refuses a period's year outside the dates a request may name, and a month that is not one", async () => {
      for (const route of ['/api/budgets/periods', '/api/budget-periods']) {
        for (const body of [{ year: 1799, month: 1 }, { year: 3000, month: 1 }, { year: 2024, month: 0 }, { year: '20x4', month: 2 }, { year: 2024, month: 2.5 }]) {
          const res = await request(app).post(route).send(body);
          expect([res.status, res.body.code], `${route} ${JSON.stringify(body)}`).toEqual([400, 'VALIDATION_ERROR']);
        }
      }
      const res = await request(app).post('/api/budget-periods').send({ year: 2024, month: 4, associate_transactions: 'yes' }).expect(400);
      expect(res.body.details).toEqual([{ field: 'associate_transactions', message: 'associate_transactions must be true or false' }]);
    });

    it('refuses a goal date that is not a real day in the years a request may name, and a link that names no row', async () => {
      const bad = await request(app).post('/api/goals').send({ name: 'House', target_amount: 100, target_date: '2026-02-30' }).expect(400);
      expect(bad.body).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'target_date' }] });
      const goal = (await request(app).post('/api/goals').send({ name: 'House', target_amount: 100, target_date: '2027-06-30' }).expect(201)).body.goal;
      // isCalendarDate took years 1 to 9999; a goal's history takes calendarDay's 1800 to 2999.
      const early = await request(app).get(`/api/goals/${goal.uuid}/progress-history?start_date=1799-12-01&end_date=1799-12-31`).expect(400);
      expect(early.body).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'start_date' }, { field: 'end_date' }] });
      await request(app).get(`/api/goals/${goal.uuid}/progress-history?start_date=1800-01-01&end_date=1800-01-31`).expect(200);
      for (const body of [{ account_id: 'abc' }, { account_id: 0 }, { account_id: '12abc' }]) {
        const res = await request(app).post(`/api/goals/${goal.uuid}/accounts`).send(body).expect(400);
        expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'account_id' }] });
      }
      const envelope = await request(app).post(`/api/goals/${goal.uuid}/budget-items`).send({ budget_item_id: 1.5 }).expect(400);
      expect(envelope.body).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'budget_item_id' }] });
    });

    it("refuses a budget item's date that is not a real day (400, where it was a 500)", async () => {
      const created = await request(app).post('/api/budgets/items').send({ name: 'Car', rollover_target_date: '2026-02-30' }).expect(400);
      expect(created.body).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'rollover_target_date' }] });
      for (const field of ['rollover_target_date', 'rollover_starting_balance_date', 'recurring_next_payment_date']) {
        const res = await request(app).put(`/api/budgets/items/${groceries.uuid}`).send({ [field]: '2026-13-01' }).expect(400);
        expect(res.body.details, field).toEqual([{ field, message: expect.stringContaining('Give a real date') }]);
      }
      const blank = await request(app).put(`/api/budgets/items/${groceries.uuid}`).send({ name: ' ' }).expect(400);
      expect(blank.body.details).toEqual([{ field: 'name', message: 'Budget item name is required' }]);
      // A cleared date input sends '', which is none.
      const cleared = await request(app).put(`/api/budgets/items/${groceries.uuid}`).send({ rollover_target_date: '' }).expect(200);
      expect(cleared.body.rollover_target_date).toBeNull();
    });
  });
});
