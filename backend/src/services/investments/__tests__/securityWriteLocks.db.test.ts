import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import pg, { type PoolClient } from 'pg';
import { sql } from 'kysely';
import { getDb, withTenant } from '../../../db/withTenant.js';
import { SecurityService } from '../SecurityService.js';
import { LookThroughService } from '../LookThroughService.js';
import { createTestTenant, type TestTenant } from '../../../test/testTenant.js';

/**
 * The securities a catalog write touches are locked before it writes anything that points at
 * them, as lockSecuritiesForWrite says, and a security delete locks only
 * what it deletes. Each race is driven with a session holding a row, and the waits are seen
 * in pg_stat_activity, never timed.
 */
describe('security writes and the locks they take', () => {
  let tenant: TestTenant;
  let account: number;
  let n = 0;
  const DAY = '2026-03-02';

  beforeAll(async () => {
    tenant = await createTestTenant('Security write locks');
    account = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Locks brokerage', 'investment', 'investments', 'Asset') RETURNING id`
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const security = async (opts: { type?: string; passThrough?: boolean } = {}) =>
    (
      await tenant.pool.query<{ id: number; uuid: string; ticker: string }>(
        `INSERT INTO securities (ticker, name, security_type, is_pass_through) VALUES ($1, $1, $2, $3) RETURNING id, uuid, ticker`,
        [`SWL${++n}`, opts.type ?? 'stock', opts.passThrough ?? false]
      )
    ).rows[0]!;

  /** A session of the app's role in the tenant, in a transaction, and its pid. */
  const session = async (): Promise<{ client: PoolClient; pid: number }> => {
    const client = await tenant.pool.connect();
    await client.query('BEGIN');
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    return { client, pid };
  };
  const end = async (client: PoolClient) => {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  };

  /** Wait until a session waits for `pid`'s locks. */
  const waitForWaiter = async (pid: number) => {
    const deadline = Date.now() + 10_000;
    while ((await tenant.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rowCount === 0) {
      if (Date.now() > deadline) throw new Error(`nothing waited for ${pid}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  /** Wait until `count` sessions wait for `pid`, directly or behind each other. */
  const waitForWaiters = async (pid: number, count: number) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { n } = (
        await tenant.pool.query<{ n: number }>(
          `WITH RECURSIVE waiting(pid) AS (
             SELECT pid FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))
             UNION
             SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY (pg_blocking_pids(a.pid))
           ) SELECT count(*)::int AS n FROM waiting`,
          [pid]
        )
      ).rows[0]!;
      if (n >= count) return;
      if (Date.now() > deadline) throw new Error(`only ${n} of ${count} sessions waited for ${pid}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const outcome = (promise: Promise<unknown>) =>
    promise.then(
      () => 'ok',
      (err: { code?: string }) => err.code ?? 'no code'
    );

  /**
   * A delete of `securityId` (lockRowsForDelete: the row FOR UPDATE, then the DELETE, which
   * cascades to its prices and compositions), started first, while `write` runs: the write
   * waits for it, then the delete goes on. A write that touched a child row before it waited
   * for the security held that row against the delete's cascade, a deadlock.
   */
  const deleteDuring = async (securityId: number, write: () => Promise<unknown>) => {
    const { client, pid } = await session();
    try {
      await client.query('SELECT id FROM securities WHERE id = $1 FOR UPDATE', [securityId]);
      const writing = outcome(withTenant(tenant.tenantId, write));
      await waitForWaiter(pid);
      const deleting = await outcome(client.query('DELETE FROM securities WHERE id = $1', [securityId]));
      await client.query(deleting === 'ok' ? 'COMMIT' : 'ROLLBACK');
      return { deleting, writing: await writing };
    } finally {
      await end(client);
    }
  };

  it('POST /prices waits for a delete of its security before it touches the price, then finds it gone', async () => {
    const sec = await security();
    await tenant.pool.query('INSERT INTO security_prices (security_id, price_date, close) VALUES ($1, $2, 10)', [sec.id, DAY]);
    const result = await deleteDuring(sec.id, () => new SecurityService().upsertPrice({ security_uuid: sec.uuid, price_date: DAY, close: 12 }));
    // It took the price's row (ON CONFLICT DO UPDATE), then waited for the security in the freshness
    // trigger, while the delete's cascade waited for that price: 40P01.
    expect(result).toEqual({ deleting: 'ok', writing: 'SECURITY_NOT_FOUND' });
  });

  it('POST /compositions waits for a delete of its fund before it replaces a dimension, then finds it gone', async () => {
    const fund = await security({ type: 'etf', passThrough: true });
    await tenant.pool.query(
      `INSERT INTO fund_compositions (security_id, dimension, dimension_value, weight_percentage, snapshot_date) VALUES ($1, 'region', 'US', 100, $2)`,
      [fund.id, DAY]
    );
    const result = await deleteDuring(fund.id, () =>
      new LookThroughService().upsertComposition({
        securityUuid: fund.uuid,
        snapshotDate: DAY,
        dimensions: { region: [{ dimension_value: 'Europe', weight_percentage: 100 }] },
      })
    );
    // It deleted the dimension's rows, then its insert's foreign key waited for the fund, while
    // the delete's cascade waited for those rows: 40P01.
    expect(result).toEqual({ deleting: 'ok', writing: 'SECURITY_NOT_FOUND' });
  });

  it('a price and a composition written with nothing in the way are saved', async () => {
    const fund = await security({ type: 'etf', passThrough: true });
    await withTenant(tenant.tenantId, async () => {
      await new SecurityService().upsertPrice({ security_uuid: fund.uuid, price_date: DAY, close: 12 });
      await new LookThroughService().upsertComposition({
        securityUuid: fund.uuid,
        snapshotDate: DAY,
        dimensions: { region: [{ dimension_value: 'US', weight_percentage: 60 }, { dimension_value: 'Europe', weight_percentage: 40 }] },
      });
    });
    expect((await tenant.pool.query('SELECT close FROM security_prices WHERE security_id = $1', [fund.id])).rows).toEqual([{ close: '12.0000' }]);
    expect((await tenant.pool.query('SELECT dimension_value FROM fund_compositions WHERE security_id = $1 ORDER BY 1', [fund.id])).rows)
      .toEqual([{ dimension_value: 'Europe' }, { dimension_value: 'US' }]);
  });

  it('a bulk delete locks only the securities it deletes, not the held ones it skips', async () => {
    const held = await security();
    const free = await security();
    await tenant.pool.query(
      `INSERT INTO holding_events (account_id, security_id, event_type, event_date, shares, price_per_share, total_amount)
       VALUES ($1, $2, 'buy', $3, 1, 10, 10)`,
      [account, held.id, DAY]
    );
    const probe = await session();
    try {
      const answer = await withTenant(tenant.tenantId, async () => {
        const result = await new SecurityService().deleteMany([held.uuid, free.uuid, '00000000-0000-7000-8000-000000000000']);
        // While the delete's transaction is open: a buy of the held security (its lot's foreign
        // key, FOR KEY SHARE) isn't kept waiting. It was: the delete held it FOR UPDATE.
        const buy = await outcome(probe.client.query('SELECT id FROM securities WHERE id = $1 FOR KEY SHARE NOWAIT', [held.id]));
        return { result, buy };
      });
      expect(answer.buy).toBe('ok');
      expect(answer.result).toEqual({
        deleted: 1,
        deletedUuids: [free.uuid],
        skipped: [
          { uuid: held.uuid, reason: 'held: has positions or transaction history' },
          { uuid: '00000000-0000-7000-8000-000000000000', reason: 'not found' },
        ],
      });
    } finally {
      await end(probe.client);
    }
    expect((await tenant.pool.query('SELECT id FROM securities WHERE id = ANY($1) ORDER BY id', [[held.id, free.id]])).rows).toEqual([{ id: held.id }]);
  });

  it('a bulk delete waits for a buy of a security it was going to delete, then skips it as held', async () => {
    const sec = await security();
    const buyer = await session();
    try {
      // A buy under way: its event's foreign key holds the security FOR KEY SHARE.
      await buyer.client.query(
        `INSERT INTO holding_events (account_id, security_id, event_type, event_date, shares, price_per_share, total_amount)
         VALUES ($1, $2, 'buy', $3, 1, 10, 10)`,
        [account, sec.id, DAY]
      );
      const deleting = withTenant(tenant.tenantId, () => new SecurityService().deleteMany([sec.uuid]));
      await waitForWaiter(buyer.pid);
      await buyer.client.query('COMMIT');
      expect(await deleting).toEqual({
        deleted: 0,
        deletedUuids: [],
        skipped: [{ uuid: sec.uuid, reason: 'held: has positions or transaction history' }],
      });
    } finally {
      await end(buyer.client);
    }
    expect((await tenant.pool.query('SELECT 1 FROM securities WHERE id = $1', [sec.id])).rowCount).toBe(1);
  });

  it('two holdings snapshots that create the same new ticker at once create it once', async () => {
    const fundA = await security({ type: 'etf' });
    const fundB = await security({ type: 'etf' });
    const ticker = `NEW${Date.now() % 1_000_000}`;
    const holdings = [{ underlying_ticker: ticker, weight_percentage: 50 }];
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let first!: (pid: number) => void;
    const firstWrote = new Promise<number>((resolve) => (first = resolve));
    const one = withTenant(tenant.tenantId, async () => {
      await new LookThroughService().upsertUnderlyingHoldings({ securityUuid: fundA.uuid, snapshotDate: DAY, holdings });
      first((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(getDb())).rows[0]!.pid);
      await released;
    });
    let two: Promise<string> | undefined;
    try {
      const pid = await firstWrote;
      two = outcome(withTenant(tenant.tenantId, () =>
        new LookThroughService().upsertUnderlyingHoldings({ securityUuid: fundB.uuid, snapshotDate: DAY, holdings })
      ));
      // The second waits for the first, which has created the ticker and not committed. It
      // didn't: it read the ticker as missing and created it again (the unique key is
      // (tenant_id, ticker, exchange), and the exchange is null).
      const waited = await Promise.race([waitForWaiter(pid).then(() => true), two.then(() => false)]);
      expect.soft(waited).toBe(true);
    } finally {
      release();
      await one;
    }
    expect(await two).toBe('ok');
    const created = (await tenant.pool.query<{ id: number }>('SELECT id FROM securities WHERE ticker = $1', [ticker])).rows;
    expect(created).toHaveLength(1);
    const pointedAt = (
      await tenant.pool.query<{ security_id: number; underlying_security_id: number }>(
        'SELECT security_id, underlying_security_id FROM fund_underlying_holdings WHERE security_id = ANY($1) ORDER BY security_id',
        [[fundA.id, fundB.id]]
      )
    ).rows;
    expect(pointedAt).toEqual([
      { security_id: fundA.id, underlying_security_id: created[0]!.id },
      { security_id: fundB.id, underlying_security_id: created[0]!.id },
    ]);
  });

  it('two snapshots naming a security a delete removes while they wait create it again once', async () => {
    const fundA = await security({ type: 'etf' });
    const fundB = await security({ type: 'etf' });
    const doomed = await security();
    const holdings = [{ underlying_ticker: doomed.ticker, weight_percentage: 50 }];
    // Both read the ticker as there (so neither takes the create lock first), then wait for its row.
    const deleter = await session();
    let one: Promise<string> | undefined;
    let two: Promise<string> | undefined;
    try {
      await deleter.client.query('SELECT id FROM securities WHERE id = $1 FOR UPDATE', [doomed.id]);
      one = outcome(withTenant(tenant.tenantId, () =>
        new LookThroughService().upsertUnderlyingHoldings({ securityUuid: fundA.uuid, snapshotDate: DAY, holdings })
      ));
      two = outcome(withTenant(tenant.tenantId, () =>
        new LookThroughService().upsertUnderlyingHoldings({ securityUuid: fundB.uuid, snapshotDate: DAY, holdings })
      ));
      await waitForWaiters(deleter.pid, 2);
      await deleter.client.query('DELETE FROM securities WHERE id = $1', [doomed.id]);
      await deleter.client.query('COMMIT');
    } finally {
      await end(deleter.client);
    }
    expect({ one: await one, two: await two }).toEqual({ one: 'ok', two: 'ok' });
    // Each found it gone once locked and created it: twice, without the create lock.
    const created = (await tenant.pool.query<{ id: number }>('SELECT id FROM securities WHERE ticker = $1', [doomed.ticker])).rows;
    expect(created).toHaveLength(1);
    const pointedAt = (
      await tenant.pool.query<{ underlying_security_id: number }>(
        'SELECT underlying_security_id FROM fund_underlying_holdings WHERE security_id = ANY($1)',
        [[fundA.id, fundB.id]]
      )
    ).rows;
    expect(pointedAt).toEqual([{ underlying_security_id: created[0]!.id }, { underlying_security_id: created[0]!.id }]);
  });

  it("reads every holding's composition in one query, however many holdings there are", async () => {
    /** The statements the app's pool runs while `work` runs. */
    const statements = async (work: () => Promise<unknown>) => {
      const seen: string[] = [];
      const query = pg.Client.prototype.query;
      const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
        const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
        if (text) seen.push(text);
        return (query as (...a: unknown[]) => unknown).apply(this, args);
      } as typeof query);
      try {
        await work();
      } finally {
        spy.mockRestore();
      }
      return seen.length;
    };
    const hold = async (count: number) => {
      const brokerage = (
        await tenant.pool.query<{ id: number; uuid: string }>(
          `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'investment', 'investments', 'Asset') RETURNING id, uuid`,
          [`Look-through ${count}`]
        )
      ).rows[0]!;
      for (let i = 0; i < count; i++) {
        const sec = await security({ type: 'etf', passThrough: true });
        const event = (
          await tenant.pool.query<{ id: number }>(
            `INSERT INTO holding_events (account_id, security_id, event_type, event_date, shares, price_per_share, total_amount)
             VALUES ($1, $2, 'buy', $3, 1, 10, 10) RETURNING id`,
            [brokerage.id, sec.id, DAY]
          )
        ).rows[0]!.id;
        await tenant.pool.query(
          `INSERT INTO tax_lots (account_id, security_id, acquisition_date, holding_period_start, shares_original, shares_remaining,
                                 cost_basis_per_share, total_cost_basis, created_by_event_id)
           VALUES ($1, $2, $3, $3, 1, 1, 10, 10, $4)`,
          [brokerage.id, sec.id, DAY, event]
        );
        await tenant.pool.query('INSERT INTO security_prices (security_id, price_date, close) VALUES ($1, $2, 10)', [sec.id, DAY]);
        // Two snapshots: only the latest counts.
        await tenant.pool.query(
          `INSERT INTO fund_compositions (security_id, dimension, dimension_value, weight_percentage, snapshot_date)
           VALUES ($1, 'region', 'Old', 100, '2026-01-01'), ($1, 'region', 'US', 60, $2), ($1, 'region', 'Europe', 40, $2)`,
          [sec.id, DAY]
        );
      }
      return brokerage.uuid;
    };
    const few = await hold(1);
    const many = await hold(4);
    const allocation = (accountUuid: string) =>
      withTenant(tenant.tenantId, () => new LookThroughService().getLookThroughAllocation('region', accountUuid));

    const result = await allocation(many);
    expect(result.totalValue).toBe(40);
    expect(result.buckets.map((b) => [b.dimensionValue, b.amount])).toEqual([['US', 24], ['Europe', 16]]);
    expect(await statements(() => allocation(many))).toBe(await statements(() => allocation(few)));
  });
});
