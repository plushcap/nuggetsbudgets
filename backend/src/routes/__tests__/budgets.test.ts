import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool, type PoolClient } from 'pg';
import { answerProblem, budgetItemResponseSchema } from '@nuggets/shared';
import { createBudgetRoutes } from '../budgets.js';
import { createBudgetPeriodRoutes } from '../budget-periods.js';
import globalPool from '../../db.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// Integration tests for the budgets /items routes. These require a Postgres
// test database (CI provides one via the test-backend job:
// DATABASE_URL=postgresql://test_user:test_password@localhost:5432/test_db,
// with schema + migrations loaded). They will not run in an environment without
// a database.
describe('Budgets /items API', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;

  // Track budget_items we create so each test cleans up after itself, including
  // the dependent rows the create + update paths can produce.
  const createdItemUuids = new Set<string>();
  // Budget periods seeded by individual tests, cleaned up after each test.
  const seededPeriodIds = new Set<number>();

  // Seed a budget_period and remember it for cleanup. Returns the new period id.
  const seedPeriod = async () => {
    const yr = 4000 + Math.floor(Math.random() * 100000);
    const res = await pool.query(
      `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
       VALUES ($1, 'January', $2, 1, make_date($2, 1, 1), make_date($2, 1, 31))
       RETURNING id`,
      [`Test Period ${yr}`, yr]
    );
    const id = res.rows[0].id;
    seededPeriodIds.add(id);
    return id;
  };

  const cleanupItem = async (uuid: string) => {
    const idRes = await pool.query('SELECT id FROM budget_items WHERE uuid = $1', [uuid]);
    if (idRes.rows.length > 0) {
      const id = idRes.rows[0].id;
      await pool.query('DELETE FROM budget_period_transactions WHERE budget_item_id = $1', [id]);
      await pool.query('DELETE FROM budget_period_items WHERE budget_item_id = $1', [id]);
    }
    await pool.query('DELETE FROM budget_items WHERE uuid = $1', [uuid]);
  };

  /** An item's own starting-balance events, oldest first. */
  const startingEvents = async (itemId: number) => (await pool.query(
    `SELECT transaction_type, amount FROM budget_period_transactions
      WHERE budget_item_id = $1 AND type = 'starting_balance' ORDER BY id`,
    [itemId]
  )).rows;

  /** An item's remaining in a period, as the budget page shows it. */
  const remainingIn = async (periodId: number, itemId: number): Promise<string> => (await pool.query(
    `SELECT calculate_remaining_for_period_item(id) AS remaining FROM budget_period_items
      WHERE budget_period_id = $1 AND budget_item_id = $2`,
    [periodId, itemId]
  )).rows[0].remaining;

  // Create an item via the API and remember it for cleanup.
  const createItem = async (overrides: Record<string, unknown> = {}) => {
    const res = await request(app)
      .post('/api/budgets/items')
      .send({ name: `Test Item ${Date.now()}-${Math.random()}`, type: 'Envelope', expense_type: 'Expense', ...overrides })
      .expect(201);
    createdItemUuids.add(res.body.uuid);
    return res.body;
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Budgets items API');
    pool = tenant.pool;

    app = express();
    app.use(express.json());
    // Tenant context (stands in for authenticateToken + tenant middleware).
    app.use(tenant.context());
    app.use('/api/budgets', createBudgetRoutes());
    app.use('/api/budget-periods', createBudgetPeriodRoutes());
  });

  afterEach(async () => {
    for (const uuid of createdItemUuids) {
      await cleanupItem(uuid);
    }
    createdItemUuids.clear();
    for (const id of seededPeriodIds) {
      await pool.query('DELETE FROM budget_period_items WHERE budget_period_id = $1', [id]);
      await pool.query('DELETE FROM budget_period WHERE id = $1', [id]);
    }
    seededPeriodIds.clear();
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  // The budget item forms' Notes field was dropped on create and on update.
  it('keeps the notes a budget item is created or edited with', async () => {
    const created = await createItem({ name: `Notes ${Date.now()}`, notes: 'Paid from the joint account' });
    expect(created.notes).toBe('Paid from the joint account');
    const res = await request(app).put(`/api/budgets/items/${created.uuid}`).send({ notes: 'Due on the 3rd' }).expect(200);
    expect(res.body.notes).toBe('Due on the 3rd');
    expect((await pool.query('SELECT notes FROM budget_items WHERE uuid = $1', [created.uuid])).rows[0].notes).toBe('Due on the 3rd');
  });

  describe('POST /items', () => {
    it('creates a budget item and returns it with a uuid', async () => {
      const res = await createItem({ name: `Create Test ${Date.now()}` });
      expect(res).toHaveProperty('id');
      expect(res).toHaveProperty('uuid');
      expect(res.name).toContain('Create Test');
    });

    it('assigns a UUIDv7 from the column default, not a v4', async () => {
      const res = await createItem();
      // The version nibble is the 13th hex digit (first char of the third group).
      expect(res.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('returns 400 when name is missing', async () => {
      const res = await request(app)
        .post('/api/budgets/items')
        .send({ type: 'Envelope' })
        .expect(400);
      expect(res.body).toHaveProperty('error');
    });

    it('fans out one budget_period_item per existing period in a single batch', async () => {
      // Seed two periods so we can assert the batched fan-out covers all of them.
      const p1 = await seedPeriod();
      const p2 = await seedPeriod();

      const item = await createItem({ rollover: true, rollover_starting_balance: 75 });

      // NUMERIC arrives from pg as a string.
      const rows = await pool.query<{ budget_period_id: number; starting: string }>(
        'SELECT budget_period_id, starting FROM budget_period_items WHERE budget_item_id = $1',
        [item.id]
      );
      const byPeriod = new Map<number, number>(
        rows.rows.map((r) => [r.budget_period_id, parseFloat(r.starting)])
      );
      // Both seeded periods got a period item. The starting balance is an event,
      // not a copy in every period.
      expect(byPeriod.get(p1)).toBe(0);
      expect(byPeriod.get(p2)).toBe(0);
      expect(await startingEvents(item.id)).toEqual([{ transaction_type: 'add', amount: '75.00' }]);
    });

    it('uses starting 0 when rollover is off, across all periods', async () => {
      const p1 = await seedPeriod();
      const item = await createItem({ rollover: false, rollover_starting_balance: 500 });

      const row = await pool.query(
        'SELECT starting FROM budget_period_items WHERE budget_item_id = $1 AND budget_period_id = $2',
        [item.id, p1]
      );
      expect(row.rows.length).toBe(1);
      expect(parseFloat(row.rows[0].starting)).toBe(0);
      // A starting balance counts for an envelope only, so none is recorded.
      expect(await startingEvents(item.id)).toEqual([]);
    });

    // The Add Expense form's starting balance was stored on the item
    // and copied into every period's `starting`, which no balance reads.
    it("records an envelope's starting balance in the log, so its balance has it", async () => {
      const period = await seedPeriod();
      const item = await createItem({ rollover: true, rollover_starting_balance: 800, default_budget_amount: 100 });
      expect(await startingEvents(item.id)).toEqual([{ transaction_type: 'add', amount: '800.00' }]);
      expect(await remainingIn(period, item.id)).toBe('800.00');

      // With this month's $100 budgeted, the envelope holds $900.
      const periodItem = (await pool.query('SELECT uuid FROM budget_period_items WHERE budget_period_id = $1 AND budget_item_id = $2', [period, item.id])).rows[0];
      await request(app).put(`/api/budgets/period-items/${periodItem.uuid}/budget`).send({ amount: 100 }).expect(200);
      expect(await remainingIn(period, item.id)).toBe('900.00');
    });

    it('records the starting balance in the period of its date', async () => {
      // A year no other test here uses, in the years a request may name (CALENDAR_DAY_YEARS: to 2999).
      const year = 2600 + Math.floor(Math.random() * 399);
      const monthly = async (month: number) => {
        const res = await pool.query(
          `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
           VALUES ($1, to_char(make_date($2, $3, 1), 'FMMonth'), $2, $3, make_date($2, $3, 1),
                   (make_date($2, $3, 1) + interval '1 month - 1 day')::date)
           RETURNING id`,
          [`Test Period ${year}-${month}`, year, month]
        );
        seededPeriodIds.add(res.rows[0].id);
        return res.rows[0].id as number;
      };
      const [jan, mar, jun] = [await monthly(1), await monthly(3), await monthly(6)];
      const periodOfStart = async (item: { id: number }) => (await pool.query(
        `SELECT bpi.budget_period_id FROM budget_period_transactions bpt
           JOIN budget_period_items bpi ON bpi.id = bpt.budget_period_item_id
          WHERE bpt.budget_item_id = $1 AND bpt.type = 'starting_balance'`,
        [item.id]
      )).rows.map((r) => r.budget_period_id);

      // The day's own period; a month with no period, the next one there is; after
      // every period, the latest.
      expect(await periodOfStart(await createItem({ rollover: true, rollover_starting_balance: 10, rollover_starting_balance_date: `${year}-03-31` }))).toEqual([mar]);
      expect(await periodOfStart(await createItem({ rollover: true, rollover_starting_balance: 10, rollover_starting_balance_date: `${year}-04-15` }))).toEqual([jun]);
      expect(await periodOfStart(await createItem({ rollover: true, rollover_starting_balance: 10, rollover_starting_balance_date: `${year + 1}-01-01` }))).toEqual([jun]);
      expect(await periodOfStart(await createItem({ rollover: true, rollover_starting_balance: 10, rollover_starting_balance_date: `${year - 1}-12-01` }))).toEqual([jan]);
    });

    it("refuses a starting balance it has no budget period to record in, or one that isn't an amount", async () => {
      const name = `No period ${Date.now()}`;
      const res = await request(app).post('/api/budgets/items')
        .send({ name, type: 'Envelope', expense_type: 'Expense', rollover: true, rollover_starting_balance: 50 })
        .expect(409);
      expect(res.body.code).toBe('NO_BUDGET_PERIOD');
      expect((await pool.query('SELECT 1 FROM budget_items WHERE name = $1', [name])).rows).toHaveLength(0);

      await seedPeriod();
      await request(app).post('/api/budgets/items')
        .send({ name, type: 'Envelope', rollover: true, rollover_starting_balance: 12.345 })
        .expect(400);
      expect((await pool.query('SELECT 1 FROM budget_items WHERE name = $1', [name])).rows).toHaveLength(0);
    });

  });

  // The amounts went to the database unchecked, which rounded 12.345 to 12.35 and answered
  // text that isn't a number with a 500.
  describe('the amounts, on create and update', () => {
    const AMOUNTS = ['default_budget_amount', 'recurring_payment_amount', 'rollover_target_amount', 'goal_target_amount'] as const;
    const stored = async (uuid: string) => (await pool.query(
      `SELECT default_budget_amount, recurring_payment_amount, rollover_target_amount, goal_target_amount FROM budget_items WHERE uuid = $1`,
      [uuid]
    )).rows[0];

    it.each(AMOUNTS)('refuses %s with more than 2 decimal places, or not a number, and keeps cents as sent', async (field) => {
      for (const bad of [12.345, '12.345', 'twelve', '1e2', true, 12345678901]) {
        const res = await request(app).post('/api/budgets/items').send({ name: `Amounts ${field}`, [field]: bad });
        expect(res.status, `${field}: ${JSON.stringify(bad)}`).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(res.body.details[0]).toMatchObject({ field, message: expect.stringContaining(field) });
      }
      // A goal's target is the goal routes' to set: these take it checked, and keep none.
      const kept = field === 'goal_target_amount' ? null : '12.34';
      const item = await createItem({ [field]: '12.34' });
      expect((await stored(item.uuid))[field]).toBe(kept);

      for (const bad of [0.005, 'lots']) {
        const res = await request(app).put(`/api/budgets/items/${item.uuid}`).send({ [field]: bad });
        expect(res.status, `${field}: ${JSON.stringify(bad)}`).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
      expect((await stored(item.uuid))[field]).toBe(kept);
    });

    it('takes numbers, decimal text, null and empty, as the forms and the MCP tools send them', async () => {
      const item = await createItem({ default_budget_amount: 25.5, recurring_payment_amount: '300', rollover_target_amount: null, goal_target_amount: '' });
      expect(await stored(item.uuid)).toEqual({ default_budget_amount: '25.50', recurring_payment_amount: '300.00', rollover_target_amount: null, goal_target_amount: null });
      await request(app).put(`/api/budgets/items/${item.uuid}`).send({ default_budget_amount: 0, rollover_target_amount: '1,000' }).expect(400);
      await request(app).put(`/api/budgets/items/${item.uuid}`).send({ default_budget_amount: -0.5, rollover_target_amount: '9999999999.99' }).expect(200);
      expect(await stored(item.uuid)).toMatchObject({ default_budget_amount: '-0.50', rollover_target_amount: '9999999999.99' });
    });

    // The starting balance is an amount as these are. One past the column (1e11)
    // reached the editor, which answered 400 BAD_REQUEST saying "at most 2 decimal places".
    it('refuses a starting balance past the column, with more than 2 decimals, or not a number: 400 VALIDATION_ERROR saying which', async () => {
      await seedPeriod();
      const field = 'rollover_starting_balance';
      const range = `${field} must be between -9,999,999,999.99 and 9,999,999,999.99`;
      const cases: Array<[unknown, string]> = [
        [1e11, range], ['99999999999.99', range], [-1e11, range],
        [12.345, `${field} must be a number with at most 2 decimal places`],
        ['abc', `${field} must be a number`], ['1e2', `${field} must be a number`], ['1,234.56', `${field} must be a number`],
      ];
      for (const [bad, message] of cases) {
        const res = await request(app).post('/api/budgets/items').send({ name: `Start ${String(bad)}`, rollover: true, [field]: bad });
        expect([res.status, res.body.code, res.body.details?.[0]], JSON.stringify(bad)).toEqual([400, 'VALIDATION_ERROR', expect.objectContaining({ field, message })]);
      }
      const item = await createItem({ rollover: true, [field]: '100.00' });
      for (const [bad, message] of cases) {
        const res = await request(app).put(`/api/budgets/items/${item.uuid}`).send({ name: 'Nope', [field]: bad });
        expect([res.status, res.body.code, res.body.details?.[0]], JSON.stringify(bad)).toEqual([400, 'VALIDATION_ERROR', expect.objectContaining({ field, message })]);
      }
      const row = await pool.query('SELECT name, rollover_starting_balance FROM budget_items WHERE uuid = $1', [item.uuid]);
      expect(row.rows[0]).toEqual({ name: item.name, rollover_starting_balance: '100.00' });
      expect(await startingEvents(item.id)).toEqual([{ transaction_type: 'add', amount: '100.00' }]);
      // The largest the column holds is taken, and '' (a cleared field) is none, as before.
      await request(app).put(`/api/budgets/items/${item.uuid}`).send({ [field]: '9999999999.99' }).expect(200);
      expect((await pool.query('SELECT rollover_starting_balance FROM budget_items WHERE uuid = $1', [item.uuid])).rows[0]).toEqual({ rollover_starting_balance: '9999999999.99' });
      const cleared = await createItem({ rollover: true, [field]: '' });
      expect((await pool.query('SELECT rollover_starting_balance FROM budget_items WHERE uuid = $1', [cleared.uuid])).rows[0]).toEqual({ rollover_starting_balance: null });
    });
  });

  // A frequency of 0 or less (no schedule: the Bills page leaves the bill out) was
  // stored as sent.
  describe('the payment frequency', () => {
    const frequencyOf = async (uuid: string) =>
      (await pool.query('SELECT recurring_payment_frequency AS f FROM budget_items WHERE uuid = $1', [uuid])).rows[0].f;
    const message = 'recurring_payment_frequency must be a whole number of months, at least 1';

    it('refuses one below 1 on create and update, 400 VALIDATION_ERROR, and takes 1 and up', async () => {
      for (const bad of [0, -1, -5, '0', 12.5]) {
        const res = await request(app).post('/api/budgets/items').send({ name: `Freq ${String(bad)}`, recurring_payment_frequency: bad });
        expect([res.status, res.body.code, res.body.details?.[0]], JSON.stringify(bad)).toEqual([400, 'VALIDATION_ERROR', expect.objectContaining({ field: 'recurring_payment_frequency', message })]);
      }
      const item = await createItem({ recurring_payment_frequency: 1 });
      expect(await frequencyOf(item.uuid)).toBe(1);
      for (const bad of [0, -1]) {
        const res = await request(app).put(`/api/budgets/items/${item.uuid}`).send({ recurring_payment_frequency: bad });
        expect([res.status, res.body.code], JSON.stringify(bad)).toEqual([400, 'VALIDATION_ERROR']);
      }
      await request(app).put(`/api/budgets/items/${item.uuid}`).send({ recurring_payment_frequency: '24' }).expect(200);
      expect(await frequencyOf(item.uuid)).toBe(24);
    });

    it('reads an item that holds 0 from before, and saves an edit that leaves the frequency out', async () => {
      const { rows: [row] } = await pool.query(
        `INSERT INTO budget_items (name, type, expense_type, isbill, recurring_payment, recurring_payment_frequency, recurring_next_payment_date)
         VALUES ($1, 'Monthly', 'Expense', true, true, 0, '2026-12-01') RETURNING uuid`,
        [`Legacy frequency ${Date.now()}`]
      );
      createdItemUuids.add(row.uuid);
      const listed = (await request(app).get('/api/budgets/items').expect(200)).body.find((i: { uuid: string }) => i.uuid === row.uuid);
      expect(answerProblem(budgetItemResponseSchema, listed)).toBeNull();
      expect(listed.recurring_payment_frequency).toBe(0);
      await request(app).put(`/api/budgets/items/${row.uuid}`).send({ name: 'Legacy renamed' }).expect(200);
      expect(await frequencyOf(row.uuid)).toBe(0);
      await request(app).put(`/api/budgets/items/${row.uuid}`).send({ recurring_payment_frequency: 0 }).expect(400);
      await request(app).put(`/api/budgets/items/${row.uuid}`).send({ recurring_payment_frequency: 1 }).expect(200);
      expect(await frequencyOf(row.uuid)).toBe(1);
    });
  });

  describe('GET /items', () => {
    it('lists created items', async () => {
      const created = await createItem();
      const res = await request(app).get('/api/budgets/items').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.some((i: { uuid: string }) => i.uuid === created.uuid)).toBe(true);
    });
  });

  describe('PUT /items/:uuid', () => {
    it('records a changed starting balance as the difference, keeping the events there', async () => {
      const period = await seedPeriod();
      const item = await createItem({ rollover: true, rollover_starting_balance: 100 });

      await request(app)
        .put(`/api/budgets/items/${item.uuid}`)
        .send({ rollover_starting_balance: 250 })
        .expect(200);

      const itemRow = await pool.query('SELECT rollover_starting_balance FROM budget_items WHERE uuid = $1', [item.uuid]);
      expect(parseFloat(itemRow.rows[0].rollover_starting_balance)).toBe(250);
      expect(await startingEvents(item.id)).toEqual([
        { transaction_type: 'add', amount: '100.00' },
        { transaction_type: 'add', amount: '150.00' },
      ]);
      expect(await remainingIn(period, item.id)).toBe('250.00');

      await request(app).put(`/api/budgets/items/${item.uuid}`).send({ rollover_starting_balance: -20 }).expect(200);
      expect((await startingEvents(item.id))[2]).toEqual({ transaction_type: 'remove', amount: '270.00' });
      expect(await remainingIn(period, item.id)).toBe('-20.00');
    });

    // The stored value is a NUMERIC string and the form sends a number,
    // so every save "changed" it and set the events to the gross amount.
    it("adds nothing for a whole-form save that sends the starting balance back", async () => {
      const period = await seedPeriod();
      // An envelope as bulk import used to record it: its starting balance less the
      // default budget, $400 of $500.
      const item = (await pool.query<{ id: number; uuid: string; name: string }>(
        `INSERT INTO budget_items (name, type, expense_type, rollover, rollover_starting_balance, default_budget_amount)
         VALUES ($1, 'Envelope', 'Expense', true, 500, 100) RETURNING id, uuid, name`,
        [`Bulk envelope ${Date.now()}`]
      )).rows[0];
      createdItemUuids.add(item.uuid);
      await pool.query(
        `WITH bpi AS (INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id)
         INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
         SELECT id, $2, 'add', 'starting_balance', 400 FROM bpi`,
        [period, item.id]
      );

      await request(app).put(`/api/budgets/items/${item.uuid}`)
        .send({ name: 'Renamed envelope', rollover: true, rollover_starting_balance: 500, rollover_starting_balance_date: '' })
        .expect(200);
      expect(await startingEvents(item.id)).toEqual([{ transaction_type: 'add', amount: '400.00' }]);
      expect(await remainingIn(period, item.id)).toBe('400.00');
    });

    it("refuses a starting balance that isn't an amount, changing nothing", async () => {
      await seedPeriod();
      const item = await createItem({ rollover: true, rollover_starting_balance: 100 });
      await request(app).put(`/api/budgets/items/${item.uuid}`).send({ name: 'Nope', rollover_starting_balance: 'lots' }).expect(400);
      const row = await pool.query('SELECT name, rollover_starting_balance FROM budget_items WHERE uuid = $1', [item.uuid]);
      expect(row.rows[0]).toEqual({ name: item.name, rollover_starting_balance: '100.00' });
      expect(await startingEvents(item.id)).toEqual([{ transaction_type: 'add', amount: '100.00' }]);
    });

    it('updates a non-balance field (name only) without touching balance branches', async () => {
      const item = await createItem();
      const res = await request(app)
        .put(`/api/budgets/items/${item.uuid}`)
        .send({ name: 'Renamed Item' })
        .expect(200);
      expect(res.body.name).toBe('Renamed Item');
    });

    it("saves, changes and clears an envelope's target date", async () => {
      const targetDate = async (uuid: string) =>
        (await pool.query(`SELECT rollover_target_date::TEXT AS d FROM budget_items WHERE uuid = $1`, [uuid])).rows[0].d;

      const item = await createItem({ rollover: true, rollover_target_amount: 175, rollover_target_date: '2027-04-01' });
      expect(await targetDate(item.uuid)).toBe('2027-04-01');

      await request(app).put(`/api/budgets/items/${item.uuid}`).send({ rollover_target_date: '2027-06-15' }).expect(200);
      expect(await targetDate(item.uuid)).toBe('2027-06-15');

      // A cleared date input sends ''.
      await request(app).put(`/api/budgets/items/${item.uuid}`).send({ rollover_target_date: '' }).expect(200);
      expect(await targetDate(item.uuid)).toBeNull();

      const undated = await createItem({ rollover: true, rollover_target_amount: 175, rollover_target_date: '' });
      expect(await targetDate(undated.uuid)).toBeNull();
    });

    // The envelope form sends '' for an empty starting-balance date; '' isn't a date, and
    // saving answered 500. The same goes for an empty next payment date.
    it("saves an envelope whose starting-balance or next payment date is left empty", async () => {
      const dates = async (uuid: string) =>
        (await pool.query(
          `SELECT rollover_starting_balance_date::TEXT AS start, recurring_next_payment_date::TEXT AS next FROM budget_items WHERE uuid = $1`,
          [uuid])).rows[0];

      await seedPeriod();
      const item = await createItem({ rollover: true, rollover_starting_balance: 40, rollover_starting_balance_date: '', recurring_next_payment_date: '' });
      expect(await dates(item.uuid)).toEqual({ start: null, next: null });

      await request(app).put(`/api/budgets/items/${item.uuid}`).send({ rollover_starting_balance_date: '2026-09-01', recurring_next_payment_date: '2026-11-01' }).expect(200);
      expect(await dates(item.uuid)).toEqual({ start: '2026-09-01', next: '2026-11-01' });

      await request(app).put(`/api/budgets/items/${item.uuid}`).send({ name: 'Envelope saved again', rollover_starting_balance_date: '', recurring_next_payment_date: '' }).expect(200);
      expect(await dates(item.uuid)).toEqual({ start: null, next: null });
    });

    // A new starting-balance date moves the item's starting-balance event to that date's
    // period; clearing the date leaves it where it is.
    it('moves the starting balance to the period of a new starting-balance date, and leaves it on clear', async () => {
      // A year no other test here uses, in the years a request may name (CALENDAR_DAY_YEARS: to 2999).
      const year = 2600 + Math.floor(Math.random() * 399);
      const period = async (month: number) => {
        const res = await pool.query(
          `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
           VALUES ($1, to_char(make_date($2, $3, 1), 'FMMonth'), $2, $3, make_date($2, $3, 1),
                   (make_date($2, $3, 1) + interval '1 month - 1 day')::date)
           RETURNING id`,
          [`Test Period ${year}-${month}`, year, month]
        );
        seededPeriodIds.add(res.rows[0].id);
        return res.rows[0].id as number;
      };
      const march = await period(3);
      const may = await period(5);
      // Created with a March date, so its starting balance is recorded in March.
      const item = await createItem({ rollover: true, rollover_starting_balance: 60, rollover_starting_balance_date: `${year}-03-04` });
      const periodItem = async (periodId: number) =>
        (await pool.query('SELECT id FROM budget_period_items WHERE budget_period_id = $1 AND budget_item_id = $2', [periodId, item.id])).rows[0].id;
      const startingEvents = async () => (await pool.query(
        `SELECT budget_period_item_id, (created_at AT TIME ZONE 'UTC')::date::text AS day
           FROM budget_period_transactions WHERE budget_item_id = $1 AND type = 'starting_balance'`,
        [item.id]
      )).rows;

      expect((await startingEvents()).map((e) => e.budget_period_item_id)).toEqual([await periodItem(march)]);

      await request(app).put(`/api/budgets/items/${item.uuid}`).send({ rollover_starting_balance_date: `${year}-05-10` }).expect(200);
      const moved = [{ budget_period_item_id: await periodItem(may), day: `${year}-05-10` }];
      expect(await startingEvents()).toEqual(moved);

      await request(app).put(`/api/budgets/items/${item.uuid}`).send({ rollover_starting_balance_date: '' }).expect(200);
      expect(await startingEvents()).toEqual(moved);
    });

    it('returns 404 for an unknown uuid', async () => {
      await request(app)
        .put('/api/budgets/items/00000000-0000-0000-0000-000000000000')
        .send({ name: 'Nope' })
        .expect(404);
    });

    it('returns 400 when no valid fields are provided', async () => {
      const item = await createItem();
      await request(app)
        .put(`/api/budgets/items/${item.uuid}`)
        .send({ notAField: 'x' })
        .expect(400);
    });

    it('is atomic: a failure in a dependent write rolls back the item update', async () => {
      await seedPeriod();
      const item = await createItem({ rollover: true, rollover_starting_balance: 100 });

      // The handler runs on the per-request withTenant transaction (the global db
      // pool), not the factory pool, so inject the fault there: the transaction's
      // connection throws on the dependent starting-balance event, after
      // budget_items was already updated in the same tx. The handler must propagate
      // the error so withTenant ROLLBACKs and the item change is undone. The patched
      // client restores itself on release so it returns to the pool clean.
      // Kysely calls the promise form of connect(); query keeps every form pg has.
      const originalConnect = globalPool.connect.bind(globalPool);
      globalPool.connect = async (): Promise<PoolClient> => {
        const client = await originalConnect();
        const realQuery = client.query;
        const realRelease = client.release;
        client.query = (...args: unknown[]) => {
          const first = args[0];
          const sqlText = typeof first === 'string'
            ? first
            : typeof first === 'object' && first !== null && 'text' in first ? first.text : undefined;
          // The starting balance's change goes into the log through this function.
          if (typeof sqlText === 'string' && /record_budget_change_event/i.test(sqlText)) {
            return Promise.reject(new Error('injected failure'));
          }
          return Reflect.apply(realQuery, client, args);
        };
        client.release = (err?: Error | boolean) => {
          client.query = realQuery;
          client.release = realRelease;
          return realRelease.call(client, err);
        };
        return client;
      };

      try {
        await request(app)
          .put(`/api/budgets/items/${item.uuid}`)
          .send({ rollover_starting_balance: 999 })
          .expect(500);
      } finally {
        globalPool.connect = originalConnect;
      }

      // The item's starting balance must be unchanged (rolled back), not 999.
      const itemRow = await pool.query('SELECT rollover_starting_balance FROM budget_items WHERE uuid = $1', [item.uuid]);
      expect(parseFloat(itemRow.rows[0].rollover_starting_balance)).toBe(100);
    });
  });

  /** An envelope with `budget` budgeted in a fresh period, and a monthly item there; their period items. */
  const twoItemsInAPeriod = async (budget = 100) => {
    const period = await seedPeriod();
    const envelope = await createItem({ rollover: true });
    const monthly = await createItem({ type: 'Monthly', rollover: false });
    const periodItem = async (itemId: number) => (await pool.query<{ id: number; uuid: string }>(
      'SELECT id, uuid FROM budget_period_items WHERE budget_period_id = $1 AND budget_item_id = $2', [period, itemId]
    )).rows[0];
    const from = await periodItem(envelope.id);
    const to = await periodItem(monthly.id);
    await request(app).put(`/api/budgets/period-items/${from.uuid}/budget`).send({ amount: budget }).expect(200);
    const periodUuid = (await pool.query<{ uuid: string }>('SELECT uuid FROM budget_period WHERE id = $1', [period])).rows[0].uuid;
    return { period: periodUuid, envelope, monthly, from, to };
  };

  const budgetOf = async (periodItemId: number): Promise<string> =>
    (await pool.query('SELECT calculate_budget_for_period_item($1) AS budget', [periodItemId])).rows[0].budget;
  const remainingOf = async (periodItemId: number): Promise<string> =>
    (await pool.query('SELECT calculate_remaining_for_period_item($1) AS remaining', [periodItemId])).rows[0].remaining;

  // The transfer the budget page makes (BudgetService.transferBetweenBudgetItems). Its
  // checks were tested through POST /api/budgets/transfer, which nothing called.
  // The period is named by its uuid.
  const transfer = (periodUuid: string, body: Record<string, unknown>) =>
    request(app).post(`/api/budget-periods/${periodUuid}/transfer`).send(body);

  describe('POST /budget-periods/:periodUuid/transfer', () => {
    // A negative amount always passed `remaining < amount`, and took
    // the money from the destination without checking its funds.
    it('refuses an amount that is not more than zero, a transfer to the same item, and one across periods', async () => {
      const { period, from, to } = await twoItemsInAPeriod();
      const send = (body: Record<string, unknown>) =>
        transfer(period, { fromBudgetPeriodItemId: from.id, toBudgetPeriodItemId: to.id, amount: 10, ...body });

      await send({ amount: -50 }).expect(400);
      await send({ amount: 0 }).expect(400);
      expect((await send({ amount: 10.005 }).expect(400)).body.code).toBe('INVALID_AMOUNT');
      await send({ toBudgetPeriodItemId: from.id }).expect(400);

      const other = await twoItemsInAPeriod();
      await send({ toBudgetPeriodItemId: other.to.id }).expect(404);
      expect([await remainingOf(from.id), await remainingOf(to.id), await remainingOf(other.to.id)]).toEqual(['100.00', '0.00', '0.00']);
    });

    it("moves the money, and refuses more than the item has", async () => {
      const { period, from, to } = await twoItemsInAPeriod();
      const res = await transfer(period, { fromBudgetPeriodItemId: from.id, toBudgetPeriodItemId: to.id, amount: 100.01 }).expect(400);
      expect(res.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS', error: 'Insufficient funds. Available: 100, Requested: 100.01' });

      await transfer(period, { fromBudgetPeriodItemId: from.id, toBudgetPeriodItemId: to.id, amount: 60 }).expect(200);
      expect([await remainingOf(from.id), await remainingOf(to.id)]).toEqual(['40.00', '60.00']);
    });
  });

  // "set the budget to X" and a transfer's funds check read the log
  // and then wrote to it, so two requests at once worked from the same stale value.
  // Another request holds the period item (as one in flight does); this one must
  // wait for it, then read what it left.
  describe('made at the same time as another change', () => {
    const whileHeld = async (periodItemId: number, send: () => Promise<request.Response>, meanwhile: (client: PoolClient) => Promise<void>) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT 1 FROM budget_period_items WHERE id = $1 FOR NO KEY UPDATE', [periodItemId]);
        const pending = send();
        // Wait (up to 2s) for the request to block on the period item.
        for (let i = 0; i < 100; i++) {
          const waiting = await pool.query(
            `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%budget_period_items%for no key update%' AND pid <> pg_backend_pid()`
          );
          if (waiting.rows.length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await meanwhile(client);
        await client.query('COMMIT');
        return await pending;
      } finally {
        client.release();
      }
    };

    it('sets the budget to the amount asked, from the budget the other change left', async () => {
      const { envelope, from } = await twoItemsInAPeriod(100);
      const res = await whileHeld(
        from.id,
        () => request(app).put(`/api/budgets/period-items/${from.uuid}/budget`).send({ amount: 150 }).then((r) => r),
        // The other request set it to 1.
        async (client) => {
          await client.query(
            `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount, previous_amount)
             VALUES ($1, $2, 'remove', 'budget_update', 99, 100)`,
            [from.id, envelope.id]
          );
        },
      );
      expect(res.status).toBe(200);
      expect(await budgetOf(from.id)).toBe('150.00');
      // The event it returns is the one it recorded.
      const event = await pool.query('SELECT transaction_type, amount, previous_amount FROM budget_period_transactions WHERE uuid = $1', [res.body.eventUuid]);
      expect(event.rows).toEqual([{ transaction_type: 'add', amount: '149.00', previous_amount: '1.00' }]);
    });

    it('checks the funds the other change left', async () => {
      const { period, envelope, from, to } = await twoItemsInAPeriod(100);
      const res = await whileHeld(
        from.id,
        () => transfer(period, { fromBudgetPeriodItemId: from.id, toBudgetPeriodItemId: to.id, amount: 80 }).then((r) => r),
        // The other request moved $80 out first.
        async (client) => {
          await client.query(
            `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
             VALUES ($1, $2, 'move_out', 'transfer', 80)`,
            [from.id, envelope.id]
          );
        },
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INSUFFICIENT_FUNDS');
      expect([await remainingOf(from.id), await remainingOf(to.id)]).toEqual(['20.00', '0.00']);
    });
  });

  // The bill page sent uuids, which were ignored (every item's latest
  // events came back), and read `data` off the bare array the route answered.
  describe('GET /events', () => {
    it("answers { success, data } with one item's events, newest period first", async () => {
      const { envelope, monthly, from, to } = await twoItemsInAPeriod(100);
      await request(app).put(`/api/budgets/period-items/${to.uuid}/budget`).send({ amount: 30 }).expect(200);
      await request(app).put(`/api/budgets/period-items/${from.uuid}/budget`).send({ amount: 120 }).expect(200);

      const res = await request(app).get(`/api/budgets/events?budget_item_uuid=${envelope.uuid}`).expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.map((e: { budgetItemName: string; transactionType: string; amount: number }) =>
        [e.budgetItemName, e.transactionType, e.amount])).toEqual([[envelope.name, 'add', 100], [envelope.name, 'add', 20]]);
      expect(res.body.data[0]).toMatchObject({ eventType: 'budget_update', periodName: expect.stringContaining('Test Period') });

      const limited = await request(app).get(`/api/budgets/events?budget_item_uuid=${monthly.uuid}&limit=1`).expect(200);
      expect(limited.body.data).toHaveLength(1);
      await request(app).get('/api/budgets/events?budget_item_uuid=00000000-0000-0000-0000-000000000000').expect(404);
      // A value that isn't a uuid is checked before anything is read: 400, naming it.
      const malformed = await request(app).get('/api/budgets/events?budget_item_uuid=not-a-uuid').expect(400);
      expect(malformed.body).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'budget_item_uuid' }] });
    });
  });

  describe('DELETE /items/:uuid', () => {
    it('deletes an item so it no longer lists', async () => {
      const item = await createItem();
      await request(app).delete(`/api/budgets/items/${item.uuid}`).expect(200);
      createdItemUuids.delete(item.uuid);

      const res = await request(app).get('/api/budgets/items').expect(200);
      expect(res.body.some((i: { uuid: string }) => i.uuid === item.uuid)).toBe(false);
    });
  });
});
