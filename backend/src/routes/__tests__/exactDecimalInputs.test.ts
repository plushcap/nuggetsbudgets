import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createGoalRoutes } from '../goals.js';
import { createBillRoutes } from '../bills.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { addDays } from '../../utils/calendarDate.js';

/**
 * Every request decimal on the bills, goals and investments routes is read as it was sent,
 * at its column's scale. z.coerce.number() read "12.3400000000000001" as
 * 12.34, "1e2" as 100, "0x10" as 16, "" as 0 and true as 1, and Postgres rounded whatever
 * had more places than its column. Now each answers 400 and writes nothing, as do a value
 * with more places than the column keeps and one too large for it; a valid value sent as
 * decimal text (FormData's form) and as a JSON number stores the same.
 *
 * One table row per route and field: how to send it, the column's limits, and how to read
 * what it stored.
 */

/** Values that aren't the decimal they look like, which every field refuses. */
const NOT_EXACT: unknown[] = ['1e2', '0x10', '', true, '12.3400000000000001'];

interface FieldCase {
  /** The route and field. */
  name: string;
  /** Send the request with the field set to `value`. */
  send: (value: unknown) => Promise<request.Response>;
  /** More decimal places than the column keeps. */
  tooPrecise: string;
  /** A value too large for the column. */
  tooLarge: string;
  /** A valid value, as decimal text (it is also sent as the JSON number). */
  valid: string;
  /** What the column holds after it, as pg reads it. */
  stored: string;
  /** Read the column a successful `send` wrote, from its answer. */
  read: (res: request.Response) => Promise<string | null>;
}

describe('Request decimals are read exactly', () => {
  let app: Express;
  let tenant: TestTenant;
  let pool: Pool;
  const stamp = Date.now() % 1_000_000;
  let n = 0;
  /** A fresh day for each action (corporate actions refuse a second one on a day), all after 2020's lots. */
  const nextDay = () => addDays('2021-01-01', (n += 1));
  const ticker = (prefix: string) => `${prefix}${stamp}${(n += 1)}`;
  const one = async <T>(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows[0] as T;
  const value = async (text: string, params: unknown[]) => (await pool.query(text, params)).rows[0]?.v ?? null;

  let account: string;
  const sec = {} as Record<'main' | 'ca' | 'spinSource' | 'spinNew' | 'mergerCash' | 'mergerStock' | 'acquirer' | 'comp' | 'fund' | 'soldDown', { uuid: string; id: number }>;
  let mainLot: string;
  let goalUuid: string;
  let occurrenceUuid: string;

  const post = (path: string, body: object) => request(app).post(`/api/investments${path}`).send(body);
  const security = async (key: keyof typeof sec, extra: object = {}) => {
    const res = await post('/securities', { ticker: ticker(key.slice(0, 3).toUpperCase()), name: key, security_type: 'stock', ...extra }).expect(201);
    sec[key] = { uuid: res.body.uuid, id: res.body.id };
  };
  const buy = (security: keyof typeof sec, eventDate: string, shares: unknown, price: unknown = 10, fees: unknown = 0) =>
    post('/events/buy', { account_uuid: account, security_uuid: sec[security].uuid, event_date: eventDate, shares, price_per_share: price, fees });
  const eventId = (res: request.Response) => one<{ id: number }>('SELECT id FROM holding_events WHERE uuid = $1', [res.body.event_uuid]).then((r) => r.id);

  /** Everything these routes write, so a refused request can be shown to have written nothing. */
  const fingerprint = async () => {
    const tables = ['holding_events', 'tax_lots', 'lot_consumptions', 'dividend_records', 'security_prices', 'security_corporate_actions', 'fund_compositions', 'fund_underlying_holdings', 'securities', 'budget_items', 'bill_occurrences'];
    const parts = await Promise.all(tables.map((t) => value(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS v FROM ${t} x`, [])));
    return parts.join(',');
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Exact request decimals');
    pool = tenant.pool;
    app = express();
    app.use(express.json({ limit: '1mb' })); // as app.ts
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    app.use('/api/goals', createGoalRoutes());
    app.use('/api/bills', createBillRoutes());

    account = (await one<{ uuid: string }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'investment', 'investments', 'Asset') RETURNING uuid`, [`Brokerage ${stamp}`])).uuid;
    for (const key of ['main', 'ca', 'spinSource', 'spinNew', 'mergerCash', 'mergerStock', 'acquirer', 'comp'] as const) await security(key);
    await security('fund', { security_type: 'etf', is_pass_through: true });
    mainLot = (await buy('main', '2020-01-02', 1000).expect(201)).body.lot_uuid;
    for (const key of ['ca', 'spinSource', 'mergerCash', 'mergerStock'] as const) await buy(key, '2020-01-02', 100).expect(201);

    goalUuid = (await request(app).post('/api/goals').send({ name: `Goal ${stamp}`, target_amount: 1000, target_date: '2030-01-01' }).expect(201)).body.goal.uuid;
    const bill = await one<{ id: number }>(
      `INSERT INTO budget_items (name, status, isbill, recurring_payment_frequency, recurring_next_payment_date, recurring_payment_amount)
       VALUES ($1, 'active', true, 1, app_today(), 600) RETURNING id`,
      [`Bill ${stamp}`]
    );
    occurrenceUuid = (await one<{ uuid: string }>('INSERT INTO bill_occurrences (budget_item_id, due_date, expected_amount) VALUES ($1, app_today(), 600) RETURNING uuid', [bill.id])).uuid;
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  /** The corporate-action catalog's figure for a security on the day last used. */
  let lastDay = '';
  const action = (key: keyof typeof sec, column: string) => () =>
    value(`SELECT ${column}::text AS v FROM security_corporate_actions WHERE security_id = $1 AND action_date = $2`, [sec[key].id, lastDay]);
  const onNewDay = (send: (day: string, v: unknown) => request.Test) => (v: unknown) => {
    lastDay = nextDay();
    return send(lastDay, v);
  };

  const CASES: FieldCase[] = [
    // ------------------------------------------------------------------ bills
    {
      name: 'PUT /bills/occurrences/:uuid/resolution paid_amount',
      send: (v) => request(app).put(`/api/bills/occurrences/${occurrenceUuid}/resolution`).send({ resolution: 'paid_manually', paid_date: '2026-01-05', paid_amount: v }),
      tooPrecise: '612.405', tooLarge: '10000000000', valid: '612.4', stored: '-612.40',
      read: () => value('SELECT manual_paid_amount::text AS v FROM bill_occurrences WHERE uuid = $1', [occurrenceUuid]),
    },
    // ------------------------------------------------------------------ goals
    {
      name: 'POST /goals target_amount',
      send: (v) => request(app).post('/api/goals').send({ name: `Goal ${ticker('G')}`, target_amount: v, target_date: '2030-01-01' }),
      tooPrecise: '1234.567', tooLarge: '10000000000', valid: '1234.5', stored: '1234.50',
      read: (res) => value('SELECT goal_target_amount::text AS v FROM budget_items WHERE uuid = $1', [res.body.goal.uuid]),
    },
    {
      name: 'POST /goals estimated_monthly_contribution',
      send: (v) => request(app).post('/api/goals').send({ name: `Goal ${ticker('G')}`, target_amount: 100, target_date: '2030-01-01', estimated_monthly_contribution: v }),
      tooPrecise: '100.505', tooLarge: '10000000000', valid: '100.5', stored: '100.50',
      read: (res) => value('SELECT default_budget_amount::text AS v FROM budget_items WHERE uuid = $1', [res.body.goal.uuid]),
    },
    {
      name: 'PUT /goals/:uuid target_amount',
      send: (v) => request(app).put(`/api/goals/${goalUuid}`).send({ target_amount: v }),
      tooPrecise: '1234.567', tooLarge: '10000000000', valid: '2500.75', stored: '2500.75',
      read: () => value('SELECT goal_target_amount::text AS v FROM budget_items WHERE uuid = $1', [goalUuid]),
    },
    {
      name: 'PUT /goals/:uuid estimated_monthly_contribution',
      send: (v) => request(app).put(`/api/goals/${goalUuid}`).send({ estimated_monthly_contribution: v }),
      tooPrecise: '0.001', tooLarge: '10000000000', valid: '75', stored: '75.00',
      read: () => value('SELECT default_budget_amount::text AS v FROM budget_items WHERE uuid = $1', [goalUuid]),
    },
    // ------------------------------------------------------------- securities
    {
      name: 'POST /securities expense_ratio_percentage',
      send: (v) => post('/securities', { ticker: ticker('ER'), name: 'Fund', security_type: 'etf', expense_ratio_percentage: v }),
      tooPrecise: '0.12345', tooLarge: '100', valid: '0.0945', stored: '0.0945',
      read: (res) => value('SELECT expense_ratio_percentage::text AS v FROM securities WHERE uuid = $1', [res.body.uuid]),
    },
    {
      name: 'PUT /securities/:uuid expense_ratio_percentage',
      send: (v) => request(app).put(`/api/investments/securities/${sec.fund.uuid}`).send({ expense_ratio_percentage: v }),
      tooPrecise: '0.12345', tooLarge: '100', valid: '0.03', stored: '0.0300',
      read: () => value('SELECT expense_ratio_percentage::text AS v FROM securities WHERE uuid = $1', [sec.fund.uuid]),
    },
    {
      name: 'POST /expense-ratio expense_ratio_percentage',
      send: (v) => post('/expense-ratio', { security_uuid: sec.fund.uuid, expense_ratio_percentage: v }),
      tooPrecise: '0.12345', tooLarge: '100', valid: '1.25', stored: '1.2500',
      read: () => value('SELECT expense_ratio_percentage::text AS v FROM securities WHERE uuid = $1', [sec.fund.uuid]),
    },
    // ----------------------------------------------------------------- prices
    ...(['close', 'adjusted_close'] as const).map((field): FieldCase => ({
      name: `POST /prices ${field}`,
      send: onNewDay((day, v) => post('/prices', { security_uuid: sec.main.uuid, price_date: day, close: 10, [field]: v })),
      tooPrecise: '12.34567', tooLarge: '100000000', valid: '123.4567', stored: '123.4567',
      read: () => value(`SELECT ${field}::text AS v FROM security_prices WHERE security_id = $1 AND price_date = $2`, [sec.main.id, lastDay]),
    })),
    {
      name: 'POST /prices volume',
      send: onNewDay((day, v) => post('/prices', { security_uuid: sec.main.uuid, price_date: day, close: 10, volume: v })),
      tooPrecise: '1000.5', tooLarge: '1000000000000000000', valid: '1234567', stored: '1234567',
      read: () => value('SELECT volume::text AS v FROM security_prices WHERE security_id = $1 AND price_date = $2', [sec.main.id, lastDay]),
    },
    {
      name: 'POST /prices/bulk close',
      send: onNewDay((day, v) => post('/prices/bulk', { prices: [{ security_uuid: sec.main.uuid, price_date: day, close: v }] })),
      tooPrecise: '12.34567', tooLarge: '100000000', valid: '99.9999', stored: '99.9999',
      read: () => value('SELECT close::text AS v FROM security_prices WHERE security_id = $1 AND price_date = $2', [sec.main.id, lastDay]),
    },
    // ----------------------------------------------------------------- events
    {
      name: 'POST /events/buy shares',
      send: (v) => buy('main', '2020-06-01', v),
      tooPrecise: '1.0000001', tooLarge: '1000000000000', valid: '12.345678', stored: '12.345678',
      read: async (res) => value('SELECT shares_original::text AS v FROM tax_lots WHERE uuid = $1', [res.body.lot_uuid]),
    },
    {
      name: 'POST /events/buy price_per_share',
      send: (v) => buy('main', '2020-06-01', 1, v),
      tooPrecise: '10.12345', tooLarge: '100000000', valid: '10.1234', stored: '10.1234',
      read: async (res) => value('SELECT price_per_share::text AS v FROM holding_events WHERE id = $1', [await eventId(res)]),
    },
    {
      name: 'POST /events/buy fees',
      send: (v) => buy('main', '2020-06-01', 1, 10, v),
      tooPrecise: '1.234', tooLarge: '10000000000', valid: '4.95', stored: '4.95',
      read: async (res) => value('SELECT fees::text AS v FROM holding_events WHERE id = $1', [await eventId(res)]),
    },
    ...([
      ['shares', '1.0000001', '1000000000000', '1.5', '1.500000', 'shares'],
      ['price_per_share', '10.12345', '100000000', '11.1234', '11.1234', 'price_per_share'],
      ['fees', '1.234', '10000000000', '0.5', '0.50', 'fees'],
    ] as const).map(([field, tooPrecise, tooLarge, valid, stored, column]): FieldCase => ({
      name: `POST /events/sell ${field}`,
      send: (v) => post('/events/sell', { account_uuid: account, security_uuid: sec.main.uuid, event_date: '2025-01-15', shares: 1, price_per_share: 11, fees: 0, method: 'fifo', [field]: v }),
      tooPrecise, tooLarge, valid, stored,
      read: async (res) => value(`SELECT ${column}::text AS v FROM holding_events WHERE id = $1`, [await eventId(res)]),
    })),
    {
      name: 'POST /events/sell specific_lots[].shares',
      send: (v) => post('/events/sell', {
        account_uuid: account, security_uuid: sec.main.uuid, event_date: '2025-01-15', shares: '0.123456', price_per_share: 11,
        method: 'specific_id', specific_lots: [{ lot_uuid: mainLot, shares: v }],
      }),
      tooPrecise: '0.1234561', tooLarge: '1000000000000', valid: '0.123456', stored: '0.123456',
      read: async (res) => value('SELECT shares_consumed::text AS v FROM lot_consumptions WHERE sell_event_id = $1', [await eventId(res)]),
    },
    {
      name: 'POST /events/dividend total_amount',
      send: (v) => post('/events/dividend', { account_uuid: account, security_uuid: sec.main.uuid, event_date: '2025-02-01', total_amount: v }),
      tooPrecise: '12.345', tooLarge: '10000000000', valid: '12.3', stored: '12.30',
      read: async (res) => value('SELECT total_amount::text AS v FROM dividend_records WHERE event_id = $1', [await eventId(res)]),
    },
    {
      name: 'POST /events/dividend amount_per_share',
      send: (v) => post('/events/dividend', { account_uuid: account, security_uuid: sec.main.uuid, event_date: '2025-02-01', total_amount: 10, amount_per_share: v }),
      tooPrecise: '0.12345', tooLarge: '100000000', valid: '0.1234', stored: '0.1234',
      read: async (res) => value('SELECT amount_per_share::text AS v FROM dividend_records WHERE event_id = $1', [await eventId(res)]),
    },
    {
      // The reinvested lot's shares are the dividend over this price: 10.00 / 25.1234 = 0.398035…
      name: 'POST /events/dividend price_per_share (reinvested)',
      send: (v) => post('/events/dividend', { account_uuid: account, security_uuid: sec.main.uuid, event_date: '2025-02-01', total_amount: 10, reinvest: true, price_per_share: v }),
      tooPrecise: '25.12345', tooLarge: '100000000', valid: '25.1234', stored: '0.398035',
      read: (res) => value('SELECT shares_original::text AS v FROM tax_lots WHERE uuid = $1', [res.body.lot_uuid]),
    },
    {
      name: 'POST /events/fee amount',
      send: (v) => post('/events/fee', { account_uuid: account, fee_type: 'advisory', amount: v, event_date: '2025-03-01' }),
      tooPrecise: '1.234', tooLarge: '10000000000', valid: '7.5', stored: '7.50',
      read: async (res) => value('SELECT total_amount::text AS v FROM holding_events WHERE id = $1', [await eventId(res)]),
    },
    ...([
      ['shares', '1.0000001', '1000000000000', '3.000001', '3.000001', 'shares_original'],
      ['total_cost_basis', '1.234', '10000000000', '30.01', '30.01', 'total_cost_basis'],
    ] as const).map(([field, tooPrecise, tooLarge, valid, stored, column]): FieldCase => ({
      name: `POST /lots/batch-import lots[].${field}`,
      send: (v) => post('/lots/batch-import', { lots: [{ account_uuid: account, security_uuid: sec.main.uuid, acquisition_date: '2019-05-01', shares: 3, total_cost_basis: 30, [field]: v }] }),
      tooPrecise, tooLarge, valid, stored,
      read: (res) => value(`SELECT ${column}::text AS v FROM tax_lots WHERE uuid = $1`, [res.body.results[0].lot_uuid]),
    })),
    // ------------------------------------------------------ corporate actions
    ...(['numerator', 'denominator'] as const).map((field): FieldCase => ({
      name: `POST /corporate-actions/split ${field}`,
      send: onNewDay((day, v) => post('/corporate-actions/split', { security_uuid: sec.ca.uuid, action_date: day, numerator: 1, denominator: 1, [field]: v })),
      tooPrecise: '1.0000001', tooLarge: '1000000000000', valid: '1.000001', stored: '1.000001',
      read: action('ca', field),
    })),
    {
      name: 'POST /corporate-actions/return-of-capital amount_per_share',
      send: onNewDay((day, v) => post('/corporate-actions/return-of-capital', { security_uuid: sec.ca.uuid, action_date: day, amount_per_share: v })),
      tooPrecise: '0.12345', tooLarge: '100000000', valid: '0.0123', stored: '0.0123',
      read: action('ca', 'amount_per_share'),
    },
    {
      name: 'POST /corporate-actions/spinoff share_ratio',
      send: onNewDay((day, v) => post('/corporate-actions/spinoff', { source_security_uuid: sec.spinSource.uuid, new_security_uuid: sec.spinNew.uuid, action_date: day, allocation_fraction: 0.1, share_ratio: v })),
      tooPrecise: '0.5000001', tooLarge: '1000000000000', valid: '0.333333', stored: '0.333333',
      read: action('spinSource', 'numerator'),
    },
    {
      name: 'POST /corporate-actions/spinoff allocation_fraction',
      send: onNewDay((day, v) => post('/corporate-actions/spinoff', { source_security_uuid: sec.spinSource.uuid, new_security_uuid: sec.spinNew.uuid, action_date: day, allocation_fraction: v, share_ratio: 1 })),
      tooPrecise: '0.1234567', tooLarge: '10', valid: '0.123456', stored: '0.123456',
      read: () => value(`SELECT metadata->>'allocationFraction' AS v FROM holding_events WHERE security_id = $1 AND event_type = 'spinoff' AND event_date = $2`, [sec.spinNew.id, lastDay]),
    },
    {
      name: 'POST /corporate-actions/merger-cash cash_per_share',
      send: onNewDay((day, v) => post('/corporate-actions/merger-cash', { security_uuid: sec.mergerCash.uuid, action_date: day, cash_per_share: v })),
      tooPrecise: '12.34567', tooLarge: '100000000', valid: '12.3456', stored: '12.3456',
      read: action('mergerCash', 'amount_per_share'),
    },
    {
      name: 'POST /corporate-actions/merger-stock exchange_ratio',
      send: onNewDay((day, v) => post('/corporate-actions/merger-stock', { security_uuid: sec.mergerStock.uuid, acquirer_security_uuid: sec.acquirer.uuid, action_date: day, exchange_ratio: v })),
      tooPrecise: '1.0000001', tooLarge: '1000000000000', valid: '1.5', stored: '1.500000',
      read: action('mergerStock', 'numerator'),
    },
    // ------------------------------------------------------------ look-through
    {
      name: 'POST /compositions weight_percentage',
      send: onNewDay((day, v) => post('/compositions', { security_uuid: sec.comp.uuid, snapshot_date: day, dimensions: { asset_class: [{ dimension_value: 'equity', weight_percentage: v }] } })),
      tooPrecise: '99.1234567', tooLarge: '1000', valid: '99.123456', stored: '99.123456',
      read: () => value('SELECT weight_percentage::text AS v FROM fund_compositions WHERE security_id = $1 AND snapshot_date = $2', [sec.comp.id, lastDay]),
    },
    ...([
      ['weight_percentage', '12.3456789', '1000', '12.345678', '12.345678'],
      ['shares', '1.0000001', '1000000000000', '1234.567891', '1234.567891'],
    ] as const).map(([field, tooPrecise, tooLarge, valid, stored]): FieldCase => ({
      name: `POST /underlying-holdings holdings[].${field}`,
      send: onNewDay((day, v) => post('/underlying-holdings', { security_uuid: sec.fund.uuid, snapshot_date: day, holdings: [{ underlying_ticker: `UND${stamp}`, weight_percentage: 10, [field]: v }] })),
      tooPrecise, tooLarge, valid, stored,
      read: () => value(`SELECT ${field}::text AS v FROM fund_underlying_holdings WHERE security_id = $1 AND snapshot_date = $2`, [sec.fund.id, lastDay]),
    })),
  ];

  it('stores what was sent digit for digit, and rounds a result once, to its column', async () => {
    // 18 digits, which no double holds: Number() made it 123456789012.12346.
    const big = await buy('ca', '2020-03-01', '123456789012.123456', '0.0001').expect(201);
    expect(await value('SELECT shares_original::text AS v FROM tax_lots WHERE uuid = $1', [big.body.lot_uuid])).toBe('123456789012.123456');
    // 90 × $1.2345 is $111.105: $111.11. The float product, 111.10499999999999, stored $111.10.
    const lot = await buy('ca', '2020-03-01', 90, '1.2345').expect(201);
    expect(await value('SELECT total_cost_basis::text AS v FROM tax_lots WHERE uuid = $1', [lot.body.lot_uuid])).toBe('111.11');
    expect(lot.body.total_cost_basis).toBe(111.11);
  });

  it('answers 400, writing nothing, to a megabyte of decimal text, in milliseconds', async () => {
    // "0." + "0" × n + "1": trimming the zeros with /0+$/, and DECIMAL_TEXT's \d+\.?\d*, took
    // time quadratic in n (150,000 characters took 9.5 s, blocking every other request).
    const long = '0.' + '0'.repeat(999_000) + '1';
    const before = await fingerprint();
    for (const field of ['shares', 'price_per_share', 'fees'] as const) {
      const body = { account_uuid: account, security_uuid: sec.main.uuid, event_date: '2020-06-01', shares: 1, price_per_share: 10, fees: 0, [field]: long };
      // The fastest of three, so a busy machine doesn't fail it: the quadratic scan took minutes.
      let fastest = Infinity;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const start = performance.now();
        const res = await post('/events/buy', body);
        fastest = Math.min(fastest, performance.now() - start);
        expect(res.status, field).toBe(400);
        expect(res.body.code, field).toBe('VALIDATION_ERROR');
      }
      expect(fastest, field).toBeLessThan(50);
    }
    expect(await fingerprint()).toBe(before);
  });

  it('answers 400, writing nothing, when a reinvested dividend\'s lot would not fit its columns', async () => {
    const dividend = (totalAmount: string, price: string) =>
      post('/events/dividend', { account_uuid: account, security_uuid: sec.main.uuid, event_date: '2025-02-01', total_amount: totalAmount, reinvest: true, price_per_share: price });
    const before = await fingerprint();
    // 100.00 buys 0.000001 shares at 99,999,999.9999 (rounded), whose basis per share is 100,000,000.
    const perShare = await dividend('100', '99999999.9999');
    expect(perShare.status, JSON.stringify(perShare.body)).toBe(400);
    expect(perShare.body).toMatchObject({ code: 'INVALID_NUMBER', error: "The reinvested lot's cost basis per share is larger than can be stored (at most 99,999,999.9999)" });
    // 133.553174 shares (rounded up), whose basis is 10,000,000,003.96: 3.97 past the largest amount.
    const total = await dividend('9999999999.99', '74876543.2109');
    expect(total.status, JSON.stringify(total.body)).toBe(400);
    expect(total.body).toMatchObject({ code: 'INVALID_AMOUNT', error: "The reinvested lot's cost basis is larger than can be stored (at most 9,999,999,999.99)" });
    expect(await fingerprint()).toBe(before);
  });

  it('answers 400, writing nothing, when a split would make a lot\'s original shares too many to store', async () => {
    await security('soldDown');
    // A lot of 999,999,999,999 shares sold down to 1: a 10:1 split leaves 10, but the
    // shares it was opened with would be 9,999,999,999,990, more than NUMERIC(18,6) holds.
    const lot = (await buy('soldDown', '2020-01-02', '999999999999', '0.0001').expect(201)).body.lot_uuid;
    await post('/events/sell', { account_uuid: account, security_uuid: sec.soldDown.uuid, event_date: '2020-02-03', shares: '999999999998', price_per_share: '0.0001', method: 'fifo' }).expect(201);
    const before = await fingerprint();
    const res = await post('/corporate-actions/split', { security_uuid: sec.soldDown.uuid, action_date: nextDay(), numerator: 10, denominator: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_NUMBER', error: "A lot's original shares after the split is larger than can be stored (at most 999,999,999,999.999999)" });
    expect(await fingerprint()).toBe(before);
    // A split that fits scales both counts, exactly.
    await post('/corporate-actions/split', { security_uuid: sec.soldDown.uuid, action_date: nextDay(), numerator: 1, denominator: 3 }).expect(201);
    expect(await one('SELECT shares_original::text AS original, shares_remaining::text AS remaining FROM tax_lots WHERE uuid = $1', [lot]))
      .toEqual({ original: '333333333333.000000', remaining: '0.333333' });
  });

  for (const c of CASES) {
    describe(c.name, () => {
      it('answers 400, writing nothing, to a value that is not exactly a decimal the column holds', async () => {
        const before = await fingerprint();
        for (const v of [...NOT_EXACT, c.tooPrecise, c.tooLarge]) {
          const res = await c.send(v);
          expect(res.status, `${JSON.stringify(v)}: ${JSON.stringify(res.body)}`).toBe(400);
          expect(['VALIDATION_ERROR', 'INVALID_AMOUNT', 'INVALID_NUMBER'], `${JSON.stringify(v)}: ${JSON.stringify(res.body)}`).toContain(res.body.code);
        }
        expect(await fingerprint()).toBe(before);
      });

      it('stores a valid value sent as decimal text and as a number the same', async () => {
        for (const v of [c.valid, Number(c.valid)]) {
          const res = await c.send(v);
          expect(res.status, `${JSON.stringify(v)}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
          expect(await c.read(res), JSON.stringify(v)).toBe(c.stored);
        }
      });
    });
  }
});
