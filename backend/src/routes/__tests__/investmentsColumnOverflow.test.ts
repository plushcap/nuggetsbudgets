import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A figure an investment route works out can be too large for the column it is written to
 * though every input fit: a lot's shares × its basis per share, rounded to 4 places,
 * can be more than its total basis, and more than a NUMERIC(12,2) holds. Postgres refused
 * those writes with an error, a 500. Each is now worked out in units and checked before the
 * first write: a 400 that names the figure and writes nothing, and the dry run answers the
 * same.
 */
describe('Investment figures too large for their columns', () => {
  let app: Express;
  let tenant: TestTenant;
  let pool: Pool;
  const stamp = Date.now() % 1_000_000;
  let n = 0;
  let account: string;
  const post = (path: string, body: object) => request(app).post(`/api/investments${path}`).send(body);
  const security = async (name: string) => {
    const res = await post('/securities', { ticker: `OV${stamp}${(n += 1)}`, name, security_type: 'stock' }).expect(201);
    return res.body.uuid as string;
  };
  /** Everything these routes write, so a refused request can be shown to have written nothing. */
  const fingerprint = async () => {
    const tables = ['holding_events', 'tax_lots', 'lot_consumptions', 'dividend_records', 'security_corporate_actions', 'wash_sale_records'];
    const parts = await Promise.all(tables.map(async (t) => (await pool.query(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS v FROM ${t} x`)).rows[0].v));
    return parts.join(',');
  };
  /**
   * 995,000,000,000 shares at $0.01 plus $49,750,000.00 in fees: a total basis of
   * $9,999,750,000.00, which fits, but $0.01005 a share, kept as $0.0101, and 995,000,000,000
   * × $0.0101 is $10,049,500,000.00, which doesn't.
   */
  const bigLot = async (sec: string) => {
    const res = await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2020-01-02', shares: '995000000000', price_per_share: '0.01', fees: '49750000.00' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.lot_uuid as string;
  };
  /** The request answers 400 with `code` and `error`, and its dry run the same; neither writes anything. */
  const refused = async (path: string, body: object, code: 'INVALID_AMOUNT' | 'INVALID_NUMBER', error: string) => {
    const before = await fingerprint();
    for (const dryRun of [true, false]) {
      const res = await post(path, { ...body, dry_run: dryRun });
      expect(res.status, `dry_run ${dryRun}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body, `dry_run ${dryRun}`).toMatchObject({ code, error });
    }
    expect(await fingerprint()).toBe(before);
  };
  const AMOUNT_MAX = 'at most 9,999,999,999.99';
  const PER_SHARE_MAX = 'at most 99,999,999.9999';

  beforeAll(async () => {
    tenant = await createTestTenant('Investment column overflow');
    pool = tenant.pool;
    app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    account = (await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'investment', 'investments', 'Asset') RETURNING uuid`, [`Brokerage ${stamp}`])).rows[0].uuid;
  });
  afterAll(async () => { await tenant.cleanup(); });

  // A sale and each corporate action take a lot's basis from its total, never more
  // than it, so the big lot's $9,999,750,000.00 is written as it is where shares × $0.0101
  // ($10,049,500,000.00) was too large and refused. A figure that can still be too large (a
  // basis per share over tiny shares, proceeds at a higher price) is refused as before.
  const BIG_TOTAL = '9999750000.00';
  /** A lot's shares, total and basis per share as stored. */
  const lotRow = async (lotUuid: string) =>
    (await pool.query('SELECT shares_remaining::text AS shares, total_cost_basis::text AS total, cost_basis_per_share::text AS per_share, is_open FROM tax_lots WHERE uuid = $1', [lotUuid])).rows[0];
  /** A security's lots' totals and bases per share, as stored. */
  const lotsOf = async (sec: string) =>
    (await pool.query('SELECT tl.total_cost_basis::text AS total, tl.cost_basis_per_share::text AS per_share FROM tax_lots tl JOIN securities s ON s.id = tl.security_id WHERE s.uuid = $1 ORDER BY tl.id', [sec])).rows;
  /** 1 share at $60,000,000: half a share of it is $120,000,000 a share, too large. */
  const pricyShare = async (sec: string) => post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2020-01-02', shares: '1', price_per_share: '60000000' }).expect(201);

  it('a spinoff moves part of the lot\'s total, which fits, and refuses a basis per share too large', async () => {
    const src = await security('spin1'); const child = await security('spin1child');
    const lot = await bigLot(src);
    await post('/corporate-actions/spinoff', { source_security_uuid: src, new_security_uuid: child, action_date: '2021-01-04', allocation_fraction: '1', share_ratio: '1' }).expect(201);
    expect(await lotsOf(child)).toEqual([{ total: BIG_TOTAL, per_share: '0.0101' }]);
    expect(await lotRow(lot)).toMatchObject({ total: '0.00', per_share: '0.0000' });
    const tiny = await security('spin2'); const tinyChild = await security('spin2child');
    await pricyShare(tiny);
    await refused('/corporate-actions/spinoff', { source_security_uuid: tiny, new_security_uuid: tinyChild, action_date: '2021-01-04', allocation_fraction: '1', share_ratio: '0.5' },
      'INVALID_NUMBER', `A spun-off lot's cost basis per share is larger than can be stored (${PER_SHARE_MAX})`);
  });

  it('a spinoff that moves nothing leaves the lot its total', async () => {
    const src = await security('spin0'); const child = await security('spin0child');
    const lot = await bigLot(src);
    await post('/corporate-actions/spinoff', { source_security_uuid: src, new_security_uuid: child, action_date: '2021-01-04', allocation_fraction: '0', share_ratio: '1' }).expect(201);
    expect(await lotRow(lot)).toMatchObject({ total: BIG_TOTAL, per_share: '0.0101' });
  });

  it('a stock merger carries the lot\'s total, and refuses a basis per share too large', async () => {
    const src = await security('ms'); const acq = await security('msacq');
    await bigLot(src);
    await post('/corporate-actions/merger-stock', { security_uuid: src, acquirer_security_uuid: acq, action_date: '2021-01-04', exchange_ratio: '1' }).expect(201);
    expect(await lotsOf(acq)).toEqual([{ total: BIG_TOTAL, per_share: '0.0101' }]);
    const tiny = await security('ms2'); const tinyAcq = await security('ms2acq');
    await pricyShare(tiny);
    await refused('/corporate-actions/merger-stock', { security_uuid: tiny, acquirer_security_uuid: tinyAcq, action_date: '2021-01-04', exchange_ratio: '0.5' },
      'INVALID_NUMBER', `A converted lot's cost basis per share is larger than can be stored (${PER_SHARE_MAX})`);
  });

  it('a cash merger consumes the lot\'s total, and refuses proceeds too large', async () => {
    const src = await security('mc');
    const lot = await bigLot(src);
    // At $0.02 a share the lot's proceeds are $19,900,000,000.00.
    await refused('/corporate-actions/merger-cash', { security_uuid: src, action_date: '2021-01-04', cash_per_share: '0.02' },
      'INVALID_AMOUNT', `A lot's merger proceeds is larger than can be stored (${AMOUNT_MAX})`);
    const res = await post('/corporate-actions/merger-cash', { security_uuid: src, action_date: '2021-01-04', cash_per_share: '0.01' }).expect(201);
    // $9,950,000,000.00 for $9,999,750,000.00 of basis: the fees, $49,750,000.00, lost.
    expect(res.body.total_realized).toBe(-49750000);
    const consumed = (await pool.query('SELECT lc.basis_consumed::text AS basis FROM lot_consumptions lc JOIN tax_lots tl ON tl.id = lc.tax_lot_id WHERE tl.uuid = $1', [lot])).rows;
    expect(consumed).toEqual([{ basis: BIG_TOTAL }]);
  });

  it('a sale takes the lot\'s total pro rata, and refuses proceeds too large', async () => {
    const src = await security('sell');
    const lot = await bigLot(src);
    const sale = { account_uuid: account, security_uuid: src, event_date: '2021-01-04', price_per_share: '0.01', fees: '0' };
    // At $0.02 a share all of it brings $19,900,000,000.00.
    await refused('/events/sell', { ...sale, price_per_share: '0.02', shares: '995000000000' }, 'INVALID_AMOUNT', `The proceeds is larger than can be stored (${AMOUNT_MAX})`);
    // One share takes $9,999,750,000.00 / 995,000,000,000 = $0.01005: $0.01.
    const one = await post('/events/sell', { ...sale, shares: '1' }).expect(201);
    expect(one.body.plan.totalBasis).toBe(0.01);
    expect(await lotRow(lot)).toMatchObject({ total: '9999749999.99', per_share: '0.0101', is_open: true });
    // The rest takes what is left.
    const rest = await post('/events/sell', { ...sale, shares: '994999999999' }).expect(201);
    expect(rest.body.plan.totalBasis).toBe(9999749999.99);
    expect(await lotRow(lot)).toMatchObject({ shares: '0.000000', total: '0.00', is_open: false });
  });

  it('a return of capital takes what it pays off the lot\'s total', async () => {
    const src = await security('roc');
    const lot = await bigLot(src);
    // 1:1000 leaves 995,000,000 shares at $9,999,750,000.00 / 995,000,000 = $10.05 (the split
    // doesn't write a total); $0.0001 back is $99,500.00, leaving $9,999,650,500.00.
    await post('/corporate-actions/split', { security_uuid: src, action_date: '2021-01-04', numerator: '1', denominator: '1000', reverse: true }).expect(201);
    expect(await lotRow(lot)).toMatchObject({ total: BIG_TOTAL, per_share: '10.0500' });
    await post('/corporate-actions/return-of-capital', { security_uuid: src, action_date: '2021-01-05', amount_per_share: '0.0001' }).expect(201);
    expect(await lotRow(lot)).toMatchObject({ total: '9999650500.00', per_share: '10.0499' });
  });

  describe('the wash-sale adjustment', () => {
    // 1 share bought at $60,000,000 and sold at $0.0001: a loss of $60,000,000.00. A share
    // bought within 30 days replaces it, and $60,000,000 a share more is $120,000,000 a share.
    const lossSale = async (sec: string) => {
      await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2022-01-03', shares: '1', price_per_share: '60000000' }).expect(201);
      await post('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2022-01-04', shares: '1', price_per_share: '0.0001' }).expect(201);
    };
    const tooLarge = `The replacement lot's cost basis per share after the wash-sale adjustment is larger than can be stored (${PER_SHARE_MAX})`;

    it('on a buy', async () => {
      const sec = await security('washbuy');
      await lossSale(sec);
      await refused('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2022-01-05', shares: '1', price_per_share: '60000000' }, 'INVALID_NUMBER', tooLarge);
    });

    it('on a reinvested dividend', async () => {
      const sec = await security('washdrip');
      await lossSale(sec);
      await refused('/events/dividend', { account_uuid: account, security_uuid: sec, event_date: '2022-01-06', total_amount: '60000000', reinvest: true, price_per_share: '60000000' }, 'INVALID_NUMBER', tooLarge);
    });

    it('on a sale whose loss a lot bought before it replaces, and its dry run', async () => {
      // The dry run answered 200: it didn't preview the adjustment.
      const sec = await security('washsell');
      const lost = (await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2022-02-01', shares: '1', price_per_share: '60000000' }).expect(201)).body.lot_uuid;
      await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2022-02-10', shares: '1', price_per_share: '60000000' }).expect(201);
      await refused('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2022-02-15', shares: '1', price_per_share: '0.0001', method: 'specific_id', specific_lots: [{ lot_uuid: lost, shares: '1' }] }, 'INVALID_NUMBER', tooLarge);
    });

    it("a sale's dry run counts a replacement as the sale leaves it", async () => {
      // A: 100 shares at $99,999,999, sold at $1 for a $9,999,999,800.00 loss, with 150 of B's
      // shares (bought at $1, sold at $1: no loss) in a FIFO sale of 250. B replaces A's loss
      // with the shares it holds after the sale: with 50 left, 50 of A's 100 ($4,999,999,900.00,
      // $99,999,998 more a share), which fits; with 100 left, all of it, $9,999,999,900.00 in
      // all. Counted as it was before the sale (200 or 250 shares, $200 or $250), B would be
      // refused: $199,999,997 a share, or $10,000,000,000.00 or more in all.
      for (const [name, bShares, adds] of [['washleft50', '200', 4999999900], ['washleft100', '250', 9999999800]] as const) {
        const sec = await security(name);
        await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2022-06-01', shares: '100', price_per_share: '99999999' }).expect(201);
        await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2022-06-10', shares: bShares, price_per_share: '1' }).expect(201);
        const sale = { account_uuid: account, security_uuid: sec, event_date: '2022-06-15', shares: '250', price_per_share: '1', method: 'fifo' };
        const before = await fingerprint();
        const dry = await post('/events/sell', { ...sale, dry_run: true });
        expect(dry.status, `${name} dry run: ${JSON.stringify(dry.body)}`).toBe(200);
        expect(await fingerprint()).toBe(before);
        const sold = await post('/events/sell', sale);
        expect(sold.status, `${name}: ${JSON.stringify(sold.body)}`).toBe(201);
        expect(sold.body.wash_sale).toMatchObject({ flagged: 1, disallowed: adds });
      }
    });

    it('on a batch import, and its dry run', async () => {
      // The dry run answered 200 with each lot "created".
      const sec = await security('washimport');
      await lossSale(sec);
      const lot = { account_uuid: account, security_uuid: sec, acquisition_date: '2022-01-05', shares: '1', total_cost_basis: '60000000' };
      await refused('/lots/batch-import', { lots: [lot] }, 'INVALID_NUMBER', tooLarge);
      // The rows are checked in order, the dry run's too: this row is refused before the next
      // one's reference, which a dividend has (a 409 of its own), is reached.
      await post('/events/dividend', { account_uuid: account, security_uuid: sec, event_date: '2022-01-06', total_amount: '1', external_reference: `taken-${stamp}` }).expect(201);
      await refused('/lots/batch-import', { lots: [lot, { ...lot, total_cost_basis: '1', external_reference: `taken-${stamp}` }] }, 'INVALID_NUMBER', tooLarge);
    });

    it("a batch import's dry run counts the loss shares its earlier lots replace", async () => {
      // The first lot replaces the loss's one share ($60,000,001 a share, which fits); the
      // second replaces nothing. Matched against the loss as it was, the second would be
      // $120,000,000 a share and the dry run would refuse what the import takes.
      const sec = await security('washimport2');
      await lossSale(sec);
      const lots = [
        { account_uuid: account, security_uuid: sec, acquisition_date: '2022-01-05', shares: '1', total_cost_basis: '1' },
        { account_uuid: account, security_uuid: sec, acquisition_date: '2022-01-06', shares: '1', total_cost_basis: '60000000' },
      ];
      const before = await fingerprint();
      const dry = await post('/lots/batch-import', { lots, dry_run: true });
      expect(dry.status, JSON.stringify(dry.body)).toBe(200);
      expect(dry.body).toMatchObject({ dry_run: true, created: 2, skipped: 0 });
      expect(await fingerprint()).toBe(before);
      const real = await post('/lots/batch-import', { lots });
      expect(real.status, JSON.stringify(real.body)).toBe(201);
      const perShare = (await pool.query('SELECT cost_basis_per_share::text AS p FROM tax_lots WHERE uuid = ANY($1) ORDER BY acquisition_date', [real.body.results.map((r: { lot_uuid: string }) => r.lot_uuid)])).rows.map((r) => r.p);
      expect(perShare).toEqual(['60000001.0000', '60000000.0000']);
    });

    it('in its total basis', async () => {
      // 1,000,000 shares at $5,000 sold at $0.0001 lose $4,999,999,900.00; 1,000,000 bought
      // at $6,000 replace them: $10,999.9999 a share fits, $10,999,999,900.00 in all doesn't.
      const sec = await security('washtotal');
      await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2022-03-01', shares: '1000000', price_per_share: '5000' }).expect(201);
      await post('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2022-03-02', shares: '1000000', price_per_share: '0.0001' }).expect(201);
      await refused('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2022-03-03', shares: '1000000', price_per_share: '6000' },
        'INVALID_AMOUNT', `The replacement lot's cost basis after the wash-sale adjustment is larger than can be stored (${AMOUNT_MAX})`);
    });

    it('still adds what fits, exactly', async () => {
      // A $1,000 loss on 3 shares, replaced by 3: $333.3333... a share more, kept as $333.3333.
      const sec = await security('washfits');
      await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2022-04-01', shares: '3', price_per_share: '400' }).expect(201);
      await post('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2022-04-02', shares: '3', price_per_share: '66.6666' }).expect(201);
      const dry = await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2022-04-03', shares: '3', price_per_share: '100', dry_run: true });
      expect(dry.status, JSON.stringify(dry.body)).toBe(200);
      const buy = await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2022-04-03', shares: '3', price_per_share: '100' }).expect(201);
      // Sold 3 × $66.6666 = $200.00 (199.9998) for $1,200.00 of basis: $1,000.00 lost.
      expect(buy.body.wash_sale).toMatchObject({ flagged: 1, disallowed: 1000 });
      const lot = (await pool.query('SELECT cost_basis_per_share::text AS per_share, total_cost_basis::text AS total FROM tax_lots WHERE uuid = $1', [buy.body.lot_uuid])).rows[0];
      expect(lot).toEqual({ per_share: '433.3333', total: '1300.00' });
    });
  });

  it('a reinvested dividend\'s dry run refuses what the real call refuses', async () => {
    const sec = await security('dripdry');
    await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2023-01-03', shares: '10', price_per_share: '1' }).expect(201);
    const dividend = { account_uuid: account, security_uuid: sec, event_date: '2023-02-01', total_amount: '100', reinvest: true };
    // No price to reinvest at: the dry run answered 200.
    for (const dryRun of [true, false]) {
      const res = await post('/events/dividend', { ...dividend, dry_run: dryRun });
      expect(res.status, `dry_run ${dryRun}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_REQUEST', error: 'dividend_reinvest requires a positive price_per_share' });
    }
    // 100.00 at $99,999,999.9999 buys 0.000001 shares, whose basis per share is $100,000,000.
    await refused('/events/dividend', { ...dividend, price_per_share: '99999999.9999' }, 'INVALID_NUMBER', `The reinvested lot's cost basis per share is larger than can be stored (${PER_SHARE_MAX})`);
    // A dividend that fits: the dry run writes nothing and answers 200.
    const before = await fingerprint();
    const ok = await post('/events/dividend', { ...dividend, price_per_share: '10', dry_run: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toEqual({ dry_run: true, reinvest: true, total_amount: 100, wash_sale: { flagged: 0, disallowed: 0, adjustments: [] } });
    expect(await fingerprint()).toBe(before);
  });

  it("a batch import's dry run skips a row whose reference an earlier row writes, as the import does", async () => {
    const sec = await security('importdup');
    const lot = { account_uuid: account, security_uuid: sec, acquisition_date: '2023-03-01', shares: '1', total_cost_basis: '10', external_reference: `dup-${stamp}` };
    const statuses = (body: { results: Array<{ status: string }> }) => body.results.map((r) => r.status);
    const dry = await post('/lots/batch-import', { lots: [lot, lot], dry_run: true }).expect(200);
    expect(statuses(dry.body)).toEqual(['created', 'skipped']);
    const real = await post('/lots/batch-import', { lots: [lot, lot] }).expect(201);
    expect(statuses(real.body)).toEqual(['created', 'skipped']);
  });

  it('two sales of one lot at once sell it once: the second reads what the first left', async () => {
    // 100 shares; two sales of 60 recorded at once, both held after they read the lots. The
    // second must see 40 left and be refused: each sets the lot's shares and basis it worked
    // out, and without the lock both set 40 (or, as SQL arithmetic, -20).
    const sec = await security('race');
    const lot = (await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2024-01-02', shares: '100', price_per_share: '10' }).expect(201)).body.lot_uuid;
    const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 2 });
    const blocker = await owner.connect();
    let results: request.Response[];
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE holding_events IN ACCESS EXCLUSIVE MODE');
      const sale = () => post('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2024-02-01', shares: '60', price_per_share: '10', method: 'fifo' });
      const both = Promise.all([sale(), sale()]);
      for (let i = 0; i < 200; i++) {
        const waiting = await owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
        if (waiting.rows[0].n >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await blocker.query('COMMIT');
      results = await both;
    } finally {
      blocker.release();
      await owner.end();
    }
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(results.find((r) => r.status === 400)!.body.error).toBe('Insufficient shares: requested 60, available 40');
    const row = (await pool.query('SELECT shares_remaining::text AS shares, total_cost_basis::text AS total, is_open FROM tax_lots WHERE uuid = $1', [lot])).rows[0];
    expect(row).toEqual({ shares: '40.000000', total: '400.00', is_open: true });
  });

  it('a wash sale past 9 billion shares matches them exactly', async () => {
    // 123,456,789,012.345678 shares: 18 digits, which no double holds (Number() reads
    // 123456789012.34568). As doubles, the replacement absorbed 123,456,789,012.345680 shares,
    // two millionths more than it holds.
    const sec = await security('bigwash');
    const shares = '123456789012.345678';
    await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2024-03-01', shares, price_per_share: '0.0002' }).expect(201);
    await post('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2024-03-04', shares, price_per_share: '0.0001' }).expect(201);
    const replacement = await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2024-03-05', shares, price_per_share: '0.0001' }).expect(201);
    // Basis $24,691,357.80, proceeds $12,345,678.90: all $12,345,678.90 of the loss disallowed.
    expect(replacement.body.wash_sale).toMatchObject({ flagged: 1, disallowed: 12345678.9 });
    const record = (await pool.query(
      `SELECT w.replacement_shares::text AS shares, w.disallowed_loss::text AS disallowed FROM wash_sale_records w JOIN tax_lots tl ON tl.id = w.replacement_lot_id WHERE tl.uuid = $1`,
      [replacement.body.lot_uuid]
    )).rows;
    expect(record).toEqual([{ shares, disallowed: '12345678.90' }]);
  });
});
