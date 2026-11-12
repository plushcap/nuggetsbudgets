import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import http from 'http';
import request from 'supertest';
import { createApp } from '../../app.js';
import { mountRoutes } from '../../routes.js';
import { sessionService } from '../../middleware/auth.js';
import { sessionCookieName } from '../../utils/session-cookie-config.js';
import { csrfCookieName, csrfTokenFor } from '../../utils/csrfToken.js';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The investments routes read their query strings with shared schemas (validateQuery,
 * @nuggets/shared investments.ts), and the MCP tools call them with a token.
 * Each read tool that sends a query is run here through /api/mcp, as a client runs it, with
 * the arguments a model sends (numbers as numbers and as text, flags both ways, an amount as
 * text): every one must be answered, never refused by the schema (400 VALIDATION_ERROR).
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

describeDb('the MCP investments tools pass the routes query schemas', () => {
  let server: http.Server;
  let tenant: TestTenant;
  let token: string;
  let account: string;
  let security: string;

  beforeAll(async () => {
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // The MCP tools call the REST API at this address with the caller's own token.
    process.env.MCP_API_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub });
    server.on('request', app);

    tenant = await createTestTenant('Investments MCP queries');
    const session = await sessionService.createSession({ userId: tenant.userId });
    await tenant.pool.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [tenant.tenantId, session.sessionId]);
    const tenantUuid = (await tenant.pool.query<{ uuid: string }>('SELECT uuid FROM tenants WHERE id = current_tenant_id()')).rows[0]!.uuid;
    const post = (path: string, body: object) =>
      request(server)
        .post(path)
        .set('Cookie', `${sessionCookieName()}=${session.token}; ${csrfCookieName()}=${csrfTokenFor(session.token)}`)
        .set('X-CSRF-Token', csrfTokenFor(session.token))
        .send(body);
    const minted = await post('/api/auth/mcp-token', { label: 'investments-queries', tenantUuid, scope: 'read', expiresIn: '30d' });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    token = minted.body.token;

    account = (await tenant.pool.query<{ uuid: string }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('MCP brokerage', 'investment', 'investments', 'Asset') RETURNING uuid`)).rows[0]!.uuid;
    const sec = await tenant.pool.query<{ id: number; uuid: string }>(`INSERT INTO securities (ticker, name, security_type) VALUES ('MCPQ', 'MCP Query Co', 'stock') RETURNING id, uuid`);
    security = sec.rows[0]!.uuid;
    await tenant.pool.query(`INSERT INTO security_prices (security_id, price_date, close) VALUES ($1, '2026-01-02', 10), ($1, '2026-03-02', 12)`, [sec.rows[0]!.id]);
    const buy = await post('/api/investments/events/buy', { account_uuid: account, security_uuid: security, event_date: '2026-01-02', shares: '3', price_per_share: '10' });
    expect(buy.status, buy.text).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    delete process.env.MCP_API_BASE_URL;
    if (tenant) {
      await tenant.pool.query('DELETE FROM personal_access_tokens WHERE user_id = $1', [tenant.userId]).catch(() => undefined);
      await tenant.cleanup();
    }
  }, 60_000);

  const callTool = async (name: string, args: Record<string, unknown>) => {
    const res = await request(server)
      .post('/api/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    expect(res.status, res.text).toBe(200);
    const body = typeof res.body?.result === 'object' ? res.body : JSON.parse(/data: (.*)/.exec(res.text)?.[1] ?? '{}');
    return body.result as { isError?: boolean; content: Array<{ text: string }> };
  };

  it.each([
    ['list_securities', () => ({ includeInactive: true })],
    ['list_securities', () => ({ includeInactive: false })],
    ['list_unused_securities', () => ({ search: 'MCP', customOnly: true, limit: 100 })],
    ['list_unused_securities', () => ({ customOnly: false, limit: '2500' })],
    ['list_holdings', () => ({ accountUuid: account })],
    ['get_holding_lots', () => ({ securityUuid: security, accountUuid: account })],
    ['get_unrealized_gain_loss', () => ({ accountUuid: account })],
    ['get_realized_gain_loss', () => ({ startDate: '2026-01-01', endDate: '2026-07-01', accountUuid: account })],
    ['list_holding_events', () => ({ accountUuid: account, securityUuid: security, eventType: 'buy', startDate: '2026-01-01', endDate: '2026-07-01', page: 2, limit: '200' })],
    ['list_holding_events', () => ({ eventType: 'all' })],
    ['get_data_freshness_report', () => ({ minHoldingValue: 100 })],
    ['get_data_freshness_report', () => ({ minHoldingValue: '0.5' })],
    ['get_fees_summary', () => ({ startDate: '2026-01-01', endDate: '2026-07-01', accountUuid: account })],
    ['get_total_cost_of_ownership', () => ({ accountUuid: account })],
    ['preview_sell_tax_impact', () => ({ accountUuid: account, securityUuid: security, shares: 0.5, date: '2026-07-01', method: 'hifo', pricePerShare: '99.5', shortTermRate: 0.24, longTermRate: '0.15' })],
    ['find_tax_loss_harvest_candidates', () => ({ accountUuid: account, minLoss: '99.50' })],
    ['find_tax_loss_harvest_candidates', () => ({ minLoss: 100 })],
    ['suggest_lot_selection', () => ({ accountUuid: account, securityUuid: security, objective: 'longest_held', date: '2026-07-01', pricePerShare: 11 })],
    ['get_concentration_risk', () => ({ thresholdPct: '15' })],
    ['get_wash_sale_report', () => ({ startDate: '2026-01-01', endDate: '2026-07-01' })],
    ['get_securities_needing_data', () => ({ category: 'expense_ratio' })],
    ['get_securities_needing_data', () => ({})],
    ['get_price_history_gaps', () => ({ securityUuid: security, thresholdDays: '7' })],
    ['get_portfolio_performance', () => ({ accountUuid: account, startDate: '2026-01-01', endDate: '2026-07-01' })],
    ['get_dividend_history', () => ({ startDate: '2026-01-01', endDate: '2026-07-01', accountUuid: account })],
    ['get_lookthrough_allocation', () => ({ dimension: 'sector', accountUuid: account })],
    ['get_lookthrough_allocation', () => ({})],
    ['find_underlying_exposure', () => ({ accountUuid: account })],
    ['get_portfolio_value_series', () => ({ startDate: '2026-01-01', limit: 90 })],
  ] as const)('%s answers what the tool asks', async (name, args) => {
    const result = await callTool(name, args());
    expect(result.isError ?? false, result.content.map((c) => c.text).join('\n')).toBe(false);
  });
});
