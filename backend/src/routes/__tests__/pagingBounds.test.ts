import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';

/**
 * Every list route reads its paging parameters with utils/pagination.ts or its bounds:
 * a value that isn't a whole number, is below 1, or is huge is the default
 * or the cap, never a negative or NaN LIMIT/OFFSET (a 500). The investments routes refuse
 * one with a 400 first (their query schemas). Through the real app, under RLS.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

/** Values a client (or a typo) may send for page, limit or offset. */
const BAD_VALUES = ['abc', '-1', '0', '1.5', '-0.5', '99999999999999999999', '1e3', ''];

describeDb('Paging parameters are bounded on every list route', () => {
  let h: RouteHarness;
  let tenant: TestTenant;
  let session: string;
  let accountUuid: string;
  let tagUuid: string;

  beforeAll(async () => {
    h = await startRouteHarness('Paging bounds');
    tenant = await createTestTenant('Paging bounds');
    // Tenant admin, for the notification history.
    await h.owner.query('UPDATE tenant_users SET is_admin = true WHERE tenant_id = $1 AND user_id = $2', [tenant.tenantId, tenant.userId]);
    session = await h.signIn(tenant.userId, tenant.tenantId);
    const account = (
      await tenant.pool.query<{ id: number; uuid: string }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id, uuid`
      )
    ).rows[0];
    accountUuid = account.uuid;
    await tenant.pool.query(
      `INSERT INTO transactions (account_id, amount, transaction_date, description, type)
       SELECT $1, -1.00 * g, DATE '2026-10-01' + g, 'Purchase ' || g, 'expense' FROM generate_series(1, 5) g`,
      [account.id]
    );
    tagUuid = (await tenant.pool.query<{ uuid: string }>(`INSERT INTO tags (name) VALUES ('Trip') RETURNING uuid`)).rows[0].uuid;
    await tenant.pool.query(`INSERT INTO merchants (name) SELECT 'Merchant ' || g FROM generate_series(1, 3) g`);
  });

  afterAll(async () => {
    await tenant?.cleanup();
    await h?.close();
  });

  /**
   * Each route and the parameters it pages by (`:account` and `:tag` are this ledger's);
   * `refuses` when it answers 400 to a bad one.
   */
  const ROUTES: { path: string; params: string[]; refuses?: boolean }[] = [
    { path: '/api/accounts/:account/balance-history', params: ['limit'] },
    { path: '/api/accounts/:account/transactions', params: ['page', 'limit'] },
    { path: '/api/annotations/threads', params: ['limit'] },
    { path: '/api/annotations/inbox', params: ['limit'] },
    { path: '/api/budgets/events', params: ['limit'] },
    { path: '/api/import/sync-log', params: ['limit', 'offset'] },
    { path: '/api/merchants/paginated', params: ['page', 'limit'] },
    { path: '/api/net-worth/history', params: ['limit'] },
    { path: '/api/notifications/history', params: ['page', 'limit'] },
    { path: '/api/tags/:tag/transactions', params: ['limit', 'offset'] },
    { path: '/api/transactions', params: ['limit'] },
    { path: '/api/transactions/paginated', params: ['page', 'limit'] },
    { path: '/api/investments/securities/paginated', params: ['page', 'limit'], refuses: true },
    { path: '/api/investments/securities/cleanup/unused', params: ['limit'], refuses: true },
    { path: '/api/investments/events', params: ['page', 'limit'], refuses: true },
    { path: '/api/investments/reports/value-series', params: ['limit'], refuses: true },
  ];

  it.each(ROUTES)('$path bounds its paging parameters, never a 500', async (route) => {
    const path = route.path.replace(':account', accountUuid).replace(':tag', tagUuid);
    const failures: string[] = [];
    for (const param of route.params) {
      const queries = [
        ...BAD_VALUES.map((value) => `${param}=${encodeURIComponent(value)}`),
        `${param}=1&${param}=2`, // sent twice: a list
      ];
      for (const query of queries) {
        const res = await h.call(session, 'get', `${path}?${query}`);
        const ok = res.status === 200 || (route.refuses && res.status === 400 && res.body?.code === 'VALIDATION_ERROR');
        if (!ok) failures.push(`${route.path}?${query} -> ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('caps a huge limit and answers the page it read', async () => {
    const merchants = await h.call(session, 'get', '/api/merchants/paginated?limit=100000&page=99999999999999999999').expect(200);
    expect(merchants.body.pagination).toMatchObject({ limit: 100, page: 100000, total: 3 });
    expect(merchants.body.merchants).toEqual([]);

    const history = await h.call(session, 'get', `/api/accounts/${accountUuid}/balance-history?limit=100000`).expect(200);
    expect(history.body.balance_history).toHaveLength(120);
    const fallback = await h.call(session, 'get', `/api/accounts/${accountUuid}/balance-history?limit=abc`).expect(200);
    expect(fallback.body.balance_history).toHaveLength(12);

    const events = await h.call(session, 'get', '/api/budgets/events?limit=-3').expect(200);
    expect(events.body.success).toBe(true);

    const threads = await h.call(session, 'get', '/api/annotations/threads?limit=-5').expect(200);
    expect(threads.body.threads).toEqual([]);

    const securities = await h.call(session, 'get', '/api/investments/securities/paginated?limit=500&page=999999999').expect(200);
    expect(securities.body.pagination).toMatchObject({ limit: 500, page: 100000 });
  });
});
