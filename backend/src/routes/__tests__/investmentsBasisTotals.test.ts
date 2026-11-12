import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { withTenant } from '../../db/withTenant.js';
import { PortfolioValuationService } from '../../services/investments/PortfolioValuationService.js';

/**
 * The holdings and the portfolio valuation total a position's cost basis from its lots'
 * remaining basis (total_cost_basis), what their sales take (pro rata). They summed
 * shares × the 4-place basis per share, which agrees with it until a partial sale: 2 shares
 * at $12.505 are $25.01, $12.5050 a share; one sold takes $12.51 and leaves $12.50, but 1 ×
 * $12.5050 still read $12.51. Each test has its own ledger, so the valuation is of its lots.
 */
describe('Holdings and valuation total the lots\' remaining basis', () => {
  const stamp = Date.now() % 1_000_000;

  /** Runs `test` in a tenant of its own: one account, one security, 2 shares bought at $12.505, a $13 close. */
  const inTenant = async (name: string, test: (l: {
    tenant: TestTenant; app: Express; account: string; sec: string;
    post: (path: string, body: object) => request.Test;
    holding: () => Promise<Record<string, unknown>>;
    valuation: () => Promise<{ total_value: number | string; cost_basis: number | string }>;
  }) => Promise<void>) => {
    const tenant = await createTestTenant(`Investment basis totals: ${name}`);
    try {
      const app = express();
      app.use(express.json());
      app.use(tenant.context());
      app.use('/api/investments', createInvestmentsRoutes());
      const post = (path: string, body: object) => request(app).post(`/api/investments${path}`).send(body);
      const account = (await tenant.pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'investment', 'investments', 'Asset') RETURNING uuid`, [`Totals ${name} ${stamp}`])).rows[0].uuid;
      const sec = (await post('/securities', { ticker: `BT${stamp}${name.length}`, name: 'Totals Co', security_type: 'stock' }).expect(201)).body.uuid;
      await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2024-01-02', shares: '2', price_per_share: '12.505' }).expect(201);
      await post('/prices', { security_uuid: sec, price_date: '2025-03-03', close: '13' }).expect(201);
      const holding = async () => {
        const res = await request(app).get(`/api/investments/holdings?account=${account}`).expect(200);
        return res.body.find((h: { security_uuid: string }) => h.security_uuid === sec);
      };
      const valuation = () => withTenant(tenant.tenantId, () => new PortfolioValuationService().computeValueAsOf('2025-03-03'));
      await test({ tenant, app, account, sec, post, holding, valuation });
    } finally {
      await tenant.cleanup();
    }
  };
  const sellOne = (post: (path: string, body: object) => request.Test, account: string, sec: string) =>
    post('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2025-03-03', shares: '1', price_per_share: '13', method: 'fifo' }).expect(201);

  it('agree with the lots before a sale and after a partial one', async () => {
    await inTenant('partial', async ({ tenant, account, sec, post, holding, valuation }) => {
      expect(await holding()).toMatchObject({ total_shares: 2, total_cost_basis: 25.01, market_value: 26, unrealized_gain_loss: 0.99 });
      expect(await valuation()).toMatchObject({ total_value: 26, cost_basis: 25.01 });

      await sellOne(post, account, sec);
      const lot = (await tenant.pool.query('SELECT total_cost_basis::text AS total, cost_basis_per_share::text AS per_share FROM tax_lots WHERE security_id = (SELECT id FROM securities WHERE uuid = $1)', [sec])).rows;
      expect(lot).toEqual([{ total: '12.50', per_share: '12.5050' }]);
      // $12.50, the lot's; shares × per-share said $12.51. (Each checked on its own.)
      expect.soft(await holding()).toMatchObject({ total_shares: 1, total_cost_basis: 12.5, average_cost_per_share: 12.5, market_value: 13, unrealized_gain_loss: 0.5 });
      expect.soft(await valuation()).toMatchObject({ total_value: 13, cost_basis: 12.5 });
    });
  });

  it('leave out the basis of an open lot with no shares', async () => {
    await inTenant('stranded', async ({ tenant, account, sec, post, holding, valuation }) => {
      // After the partial sale the lot holds $12.50 (shares × per-share said $12.51). A lot a
      // reverse split rounded to no shares before v2.1.0 stayed open with its basis ($7.00 here):
      // it has nothing left to sell, and the totals count none of it ($19.50 if they did).
      await sellOne(post, account, sec);
      const stranded = (await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2024-02-01', shares: '1', price_per_share: '7' }).expect(201)).body.lot_uuid;
      await tenant.pool.query('UPDATE tax_lots SET shares_remaining = 0 WHERE uuid = $1', [stranded]);
      expect.soft(await holding()).toMatchObject({ total_shares: 1, total_cost_basis: 12.5 });
      expect.soft(await valuation()).toMatchObject({ cost_basis: 12.5 });
    });
  });
});
