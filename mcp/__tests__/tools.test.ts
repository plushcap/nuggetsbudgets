import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { callTool, callToolValidated, inputSchemaOf, makeFetchStub, registeredTools, resultJson } from './harness.js';

/**
 * Scenario tests of the MCP server's tool surface without touching the network: the stubbed
 * fetch the tools' API client receives records each request, and the tests assert the verb,
 * path, query, and body the tool forwards. tool-coverage.test.ts holds a case for every
 * tool; the cases here are the ones worth spelling out.
 */

describe('MCP tools (end-to-end with stubbed fetch)', () => {
  let fetchStub: ReturnType<typeof makeFetchStub>;

  beforeEach(() => {
    fetchStub = makeFetchStub({ transactions: [], pagination: {} });
  });

  it('list_tasks queries the paginated endpoint with review_status=needs review', async () => {
    await callTool(fetchStub.fetchImpl, 'list_tasks', { limit: 10 });
    expect(fetchStub.calls).toHaveLength(1);
    const url = new URL(fetchStub.calls[0].url);
    expect(url.pathname).toBe('/api/transactions/paginated');
    expect(url.searchParams.get('review_status')).toBe('needs review');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(fetchStub.calls[0].method).toBe('GET');
    expect(fetchStub.calls[0].headers.authorization).toBe('Bearer test-token');
  });

  // The query is built and checked with the route's own schema, so a day the
  // route would refuse (a date shape that isn't a real day) goes nowhere, with its message.
  it("get_goal_progress_history checks its range with the route's own schema before calling", async () => {
    const goal = '0190a000-0000-7000-8000-000000000001';
    const refused = await callToolValidated(fetchStub.fetchImpl, 'get_goal_progress_history', { uuid: goal, startDate: '2026-02-30' });
    expect(fetchStub.calls).toHaveLength(0);
    expect(JSON.stringify(refused)).toContain('start_date');
    await callToolValidated(fetchStub.fetchImpl, 'get_goal_progress_history', { uuid: goal, startDate: '2026-02-28' });
    expect(new URL(fetchStub.calls[0].url).search).toBe('?start_date=2026-02-28');
  });

  // The period's totals are the Budget page's, from @nuggets/shared, in whole cents.
  it("list_budget_period_items adds the period's totals and subtotals, worked out as the Budget page does", async () => {
    const row = (name: string, over: Record<string, unknown>) => ({
      uuid: `0190a000-0000-7000-8000-00000000000${name.length}`, budget_item_name: name, goal_target_date: null,
      calculated_budget: '0.00', calculated_actual: '0.00', calculated_transfers: '0.00', calculated_remaining: '0.00', ...over,
    });
    const items = [
      row('Pay', { expense_type: 'Income', type: 'Monthly', subtype: 'Paycheck', calculated_budget: '850.60', calculated_actual: '600.10' }),
      row('Bonus', { expense_type: 'Income', type: 'Monthly', subtype: 'Paycheck', calculated_actual: '250.20' }),
      row('Tips', { expense_type: 'Income', type: 'Monthly', subtype: 'Paycheck', calculated_actual: '0.30' }),
      row('Car fund', { expense_type: 'Expense', type: 'Envelope', subtype: 'Flexible', calculated_budget: '850.60', calculated_remaining: '850.60' }),
      row('Rent', { expense_type: 'Expense', type: 'Monthly', subtype: 'Fixed', calculated_budget: '0.10', calculated_remaining: '0.10' }),
      row('Water', { expense_type: 'Expense', type: 'Monthly', subtype: 'Fixed', calculated_budget: '0.20', calculated_remaining: '0.20' }),
    ];
    fetchStub = makeFetchStub({ success: true, data: items });
    const result = resultJson(await callTool(fetchStub.fetchImpl, 'list_budget_period_items', { uuid: '0190a000-0000-7000-8000-000000000001' })) as {
      totals: Record<string, number>;
      subtotals: { income: Record<string, number>; bySubtype: Record<string, Record<string, number>> };
    };
    // 600.10 + 250.20 + 0.30 of income against an 850.60 plan: exactly 0 (as floats, -1.1e-13).
    expect(result.totals).toMatchObject({ actualIncome: 850.6, envelopeBudgetAmount: 850.6, remaining: 0, fixedRemaining: 0.3, estimatedRemaining: -0.3 });
    expect(Object.is(result.totals.remaining, -0)).toBe(false);
    expect(result.subtotals.income).toEqual({ budget: 850.6, actual: 850.6, transfers: 0, remaining: 0 });
    // 0.10 + 0.20 is 0.3, not 0.30000000000000004.
    expect(result.subtotals.bySubtype['Monthly::Fixed']).toEqual({ budget: 0.3, actual: 0, transfers: 0, remaining: 0.3 });
  });

  it('list_merchants paginates and omits the fields param by default', async () => {
    await callTool(fetchStub.fetchImpl, 'list_merchants', { limit: 25 });
    expect(fetchStub.calls).toHaveLength(1);
    const url = new URL(fetchStub.calls[0].url);
    expect(url.pathname).toBe('/api/merchants/paginated');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.has('fields')).toBe(false);
  });

  it('list_merchants with lite=true requests the lightweight (no-counts) shape', async () => {
    await callTool(fetchStub.fetchImpl, 'list_merchants', { lite: true });
    expect(fetchStub.calls).toHaveLength(1);
    const url = new URL(fetchStub.calls[0].url);
    expect(url.pathname).toBe('/api/merchants/paginated');
    expect(url.searchParams.get('fields')).toBe('lite');
  });

  it('accept_task issues PUT with review_status=reviewed', async () => {
    await callTool(fetchStub.fetchImpl, 'accept_task', {
      uuid: '00000000-0000-0000-0000-000000000001',
      budgetItemId: 7,
      budgetPeriodId: 3,
    });
    expect(fetchStub.calls).toHaveLength(1);
    const call = fetchStub.calls[0];
    expect(call.method).toBe('PUT');
    expect(new URL(call.url).pathname).toBe('/api/transactions/00000000-0000-0000-0000-000000000001');
    expect(call.body).toEqual({
      budget_item_id: 7,
      review_status: 'reviewed',
      budget_period_id: 3,
    });
  });

  it('classify_transaction PUTs classification fields WITHOUT review_status', async () => {
    await callTool(fetchStub.fetchImpl, 'classify_transaction', {
      uuid: '00000000-0000-0000-0000-000000000002',
      budgetItemId: 5,
      budgetPeriodId: 9,
      merchantId: 4,
    });
    expect(fetchStub.calls).toHaveLength(1);
    const call = fetchStub.calls[0];
    expect(call.method).toBe('PUT');
    expect(new URL(call.url).pathname).toBe('/api/transactions/00000000-0000-0000-0000-000000000002');
    expect(call.body).toEqual({ budget_item_id: 5, budget_period_id: 9, merchant_id: 4 });
    expect((call.body as Record<string, unknown>).review_status).toBeUndefined();
  });

  it('classify_transaction attaches tags via the per-tag endpoint and re-fetches', async () => {
    await callTool(fetchStub.fetchImpl, 'classify_transaction', {
      uuid: '00000000-0000-0000-0000-000000000003',
      budgetItemId: 5,
      tagUuids: [
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      ],
    });
    const steps = fetchStub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(steps).toEqual([
      'PUT /api/transactions/00000000-0000-0000-0000-000000000003',
      'POST /api/transactions/00000000-0000-0000-0000-000000000003/tags/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'POST /api/transactions/00000000-0000-0000-0000-000000000003/tags/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      'GET /api/transactions/00000000-0000-0000-0000-000000000003',
    ]);
    // The classification PUT still carries no review_status.
    expect((fetchStub.calls[0].body as Record<string, unknown>).review_status).toBeUndefined();
  });

  it('classify_transaction with only tags skips the PUT', async () => {
    await callTool(fetchStub.fetchImpl, 'classify_transaction', {
      uuid: '00000000-0000-0000-0000-000000000004',
      tagUuids: ['cccccccc-cccc-cccc-cccc-cccccccccccc'],
    });
    const steps = fetchStub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(steps).toEqual([
      'POST /api/transactions/00000000-0000-0000-0000-000000000004/tags/cccccccc-cccc-cccc-cccc-cccccccccccc',
      'GET /api/transactions/00000000-0000-0000-0000-000000000004',
    ]);
  });

  it('classify_transaction coerces stringified numeric ids (LLMs often send "155")', async () => {
    await callToolValidated(fetchStub.fetchImpl, 'classify_transaction', {
      uuid: '11111111-1111-4111-8111-111111111111',
      budgetItemId: '155',
      budgetPeriodId: '19',
    });
    expect(fetchStub.calls).toHaveLength(1);
    const call = fetchStub.calls[0];
    expect(call.method).toBe('PUT');
    // Strings coerced to numbers before reaching the API.
    expect(call.body).toEqual({ budget_item_id: 155, budget_period_id: 19 });
  });

  it('create_merchant POSTs the expected field mapping', async () => {
    await callTool(fetchStub.fetchImpl, 'create_merchant', {
      name: 'Local Coffee',
      website: 'https://example.com',
      notes: 'Morning spot',
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/merchants');
    expect(call.body).toEqual({
      name: 'Local Coffee',
      merchant_website: 'https://example.com',
      merchant_accountid: undefined,
      notes: 'Morning spot',
    });
  });

  it('bulk_classify sends transactionUuids + updates', async () => {
    await callTool(fetchStub.fetchImpl, 'bulk_classify', {
      uuids: ['11111111-1111-1111-1111-111111111111'],
      budgetItemId: 2,
      reviewStatus: 'reviewed',
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('PUT');
    expect(new URL(call.url).pathname).toBe('/api/transactions/bulk');
    expect(call.body).toEqual({
      transactionUuids: ['11111111-1111-1111-1111-111111111111'],
      updates: { budget_item_id: 2, review_status: 'reviewed' },
    });
  });

  it('update_transaction maps external id/link to snake_case body', async () => {
    await callTool(fetchStub.fetchImpl, 'update_transaction', {
      uuid: '11111111-1111-4111-8111-111111111111',
      externalTransactionId: 'ORD-1234567',
      externalLink: 'https://shop.example.com/orders/ORD-1234567',
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('PUT');
    expect(new URL(call.url).pathname).toBe('/api/transactions/11111111-1111-4111-8111-111111111111');
    expect(call.body).toEqual({
      external_transaction_id: 'ORD-1234567',
      external_link: 'https://shop.example.com/orders/ORD-1234567',
    });
  });

  // The transaction answers name the account's Asset/Liability account_class; account_type
  // is the account's own kind (checking, credit_card) on the account answers.
  it('get_transaction passes account_class through, and says what it is', async () => {
    const uuid = '0190a000-0000-7000-8000-000000000001';
    const stub = makeFetchStub({ uuid, type: 'expense', account_name: 'Card', account_class: 'Liability' });
    const result = await callTool(stub.fetchImpl, 'get_transaction', { uuid });
    expect(resultJson(result)).toMatchObject({ account_class: 'Liability' });
    for (const name of ['get_transaction', 'list_transactions']) {
      const description = registeredTools(stub.fetchImpl).get(name)?.config.description;
      expect(description, name).toMatch(/account_class/);
      expect(description, name).not.toMatch(/account_type/);
    }
  });

  it('list_accounts is readonly and hits /api/accounts', async () => {
    await callTool(fetchStub.fetchImpl, 'list_accounts', {});
    expect(fetchStub.calls[0].method).toBe('GET');
    expect(new URL(fetchStub.calls[0].url).pathname).toBe('/api/accounts');
  });
});

describe('MCP investment tools', () => {
  let fetchStub: ReturnType<typeof makeFetchStub>;

  beforeEach(() => {
    fetchStub = makeFetchStub({ ok: true });
  });

  const acctUuid = '11111111-1111-4111-8111-111111111111';
  const secUuid = '22222222-2222-4222-8222-222222222222';
  const lotUuid = '33333333-3333-4333-8333-333333333333';

  it('list_securities GETs the securities endpoint and omits include_inactive by default', async () => {
    await callTool(fetchStub.fetchImpl, 'list_securities', {});
    const call = fetchStub.calls[0];
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.pathname).toBe('/api/investments/securities');
    expect(url.searchParams.has('include_inactive')).toBe(false);
  });

  it('list_securities with includeInactive sets include_inactive=true', async () => {
    await callTool(fetchStub.fetchImpl, 'list_securities', { includeInactive: true });
    const url = new URL(fetchStub.calls[0].url);
    expect(url.searchParams.get('include_inactive')).toBe('true');
  });

  it('get_security GETs by uuid', async () => {
    await callTool(fetchStub.fetchImpl, 'get_security', { uuid: secUuid });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('GET');
    expect(new URL(call.url).pathname).toBe(`/api/investments/securities/${secUuid}`);
  });

  it('create_security POSTs camelCase args mapped to snake_case', async () => {
    await callTool(fetchStub.fetchImpl, 'create_security', {
      ticker: 'STKIDX',
      name: 'Sample Total Stock Market ETF',
      securityType: 'etf',
      expenseRatioPercentage: 0.03,
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/investments/securities');
    expect(call.body).toEqual({
      ticker: 'STKIDX',
      name: 'Sample Total Stock Market ETF',
      security_type: 'etf',
      expense_ratio_percentage: 0.03,
    });
  });

  it('update_security PUTs a partial patch to the uuid path', async () => {
    await callTool(fetchStub.fetchImpl, 'update_security', { uuid: secUuid, isActive: false });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('PUT');
    expect(new URL(call.url).pathname).toBe(`/api/investments/securities/${secUuid}`);
    expect(call.body).toEqual({ is_active: false });
  });

  it('list_unused_securities GETs cleanup/unused with filters', async () => {
    await callTool(fetchStub.fetchImpl, 'list_unused_securities', { customOnly: true, search: 'AAP' });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('GET');
    const u = new URL(call.url);
    expect(u.pathname).toBe('/api/investments/securities/cleanup/unused');
    expect(u.searchParams.get('custom_only')).toBe('true');
    expect(u.searchParams.get('search')).toBe('AAP');
  });

  it('delete_securities POSTs uuids to bulk-delete', async () => {
    await callTool(fetchStub.fetchImpl, 'delete_securities', { uuids: [secUuid] });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/investments/securities/bulk-delete');
    expect(call.body).toEqual({ uuids: [secUuid] });
  });

  it('get_security_price_history GETs the prices path', async () => {
    await callTool(fetchStub.fetchImpl, 'get_security_price_history', { uuid: secUuid });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('GET');
    expect(new URL(call.url).pathname).toBe(`/api/investments/securities/${secUuid}/prices`);
  });

  it('update_security_price POSTs a single price with snake_case body', async () => {
    await callTool(fetchStub.fetchImpl, 'update_security_price', {
      securityUuid: secUuid,
      priceDate: '2026-06-26',
      close: 250.5,
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/investments/prices');
    expect(call.body).toEqual({
      security_uuid: secUuid,
      price_date: '2026-06-26',
      close: 250.5,
    });
  });

  it('update_security_prices_bulk maps each price to snake_case and POSTs to /prices/bulk', async () => {
    await callTool(fetchStub.fetchImpl, 'update_security_prices_bulk', {
      prices: [
        { securityUuid: secUuid, priceDate: '2026-06-25', close: 100, volume: 1000 },
        { securityUuid: secUuid, priceDate: '2026-06-26', close: 101, adjustedClose: 100.9 },
      ],
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/investments/prices/bulk');
    expect(call.body).toEqual({
      prices: [
        { security_uuid: secUuid, price_date: '2026-06-25', close: 100, volume: 1000 },
        { security_uuid: secUuid, price_date: '2026-06-26', close: 101, adjusted_close: 100.9 },
      ],
    });
  });

  it('record_buy_event POSTs the buy event with mapped body', async () => {
    await callTool(fetchStub.fetchImpl, 'record_buy_event', {
      accountUuid: acctUuid,
      securityUuid: secUuid,
      eventDate: '2026-06-26',
      shares: 10,
      pricePerShare: 250,
      fees: 1.5,
      dryRun: true,
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/investments/events/buy');
    expect(call.body).toEqual({
      account_uuid: acctUuid,
      security_uuid: secUuid,
      event_date: '2026-06-26',
      shares: 10,
      price_per_share: 250,
      fees: 1.5,
      dry_run: true,
    });
  });

  // The route answers 400 for a limit that isn't a positive whole number; the tool says so first.
  it('get_portfolio_value_series takes a positive whole limit, as the route does', async () => {
    await callToolValidated(fetchStub.fetchImpl, 'get_portfolio_value_series', { limit: '30' });
    expect(fetchStub.calls[0].url).toContain('limit=30');
    for (const limit of ['1.5', '0', '-2']) {
      await expect(callToolValidated(fetchStub.fetchImpl, 'get_portfolio_value_series', { limit })).rejects.toThrow();
    }
  });

  // Decimal text goes to the backend as sent, which reads it exactly.
  it('record_buy_event sends decimal text on as text', async () => {
    await callToolValidated(fetchStub.fetchImpl, 'record_buy_event', {
      accountUuid: acctUuid,
      securityUuid: secUuid,
      eventDate: '2026-06-26',
      shares: '100',
      pricePerShare: '50.5',
    });
    const call = fetchStub.calls[0];
    expect(call.body).toEqual({
      account_uuid: acctUuid,
      security_uuid: secUuid,
      event_date: '2026-06-26',
      shares: '100',
      price_per_share: '50.5',
    });
  });

  it('record_buy_event trims decimal text, as the backend does', async () => {
    await callToolValidated(fetchStub.fetchImpl, 'record_buy_event', {
      accountUuid: acctUuid, securityUuid: secUuid, eventDate: '2026-06-26', shares: ' 12.3', pricePerShare: '250.1 ', fees: ' 1.50 ',
    });
    expect(fetchStub.calls[0].body).toMatchObject({ shares: '12.3', price_per_share: '250.1', fees: '1.50' });
    for (const shares of [' ', '1'.repeat(65)]) {
      await expect(callToolValidated(fetchStub.fetchImpl, 'record_buy_event', { accountUuid: acctUuid, securityUuid: secUuid, eventDate: '2026-06-26', shares, pricePerShare: '1' })).rejects.toThrow();
    }
  });

  it('record_buy_event refuses text that is not a decimal, before any request', async () => {
    for (const shares of ['1e2', 'ten', '']) {
      const stub = makeFetchStub();
      await expect(callToolValidated(stub.fetchImpl, 'record_buy_event', {
        accountUuid: acctUuid, securityUuid: secUuid, eventDate: '2026-06-26', shares, pricePerShare: 1,
      }), shares).rejects.toThrow();
      expect(stub.calls).toHaveLength(0);
    }
  });

  it('record_sell_event maps specificLots to specific_lots[{lot_uuid,shares}]', async () => {
    await callTool(fetchStub.fetchImpl, 'record_sell_event', {
      accountUuid: acctUuid,
      securityUuid: secUuid,
      eventDate: '2026-06-26',
      shares: 5,
      pricePerShare: 260,
      method: 'specific_id',
      specificLots: [{ lotUuid: lotUuid, shares: 5 }],
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/investments/events/sell');
    expect(call.body).toEqual({
      account_uuid: acctUuid,
      security_uuid: secUuid,
      event_date: '2026-06-26',
      shares: 5,
      price_per_share: 260,
      method: 'specific_id',
      specific_lots: [{ lot_uuid: lotUuid, shares: 5 }],
    });
  });

  it('record_sell_event sends decimal text inside specificLots on as text', async () => {
    await callToolValidated(fetchStub.fetchImpl, 'record_sell_event', {
      accountUuid: acctUuid,
      securityUuid: secUuid,
      eventDate: '2026-06-26',
      shares: '5',
      pricePerShare: '260',
      specificLots: [{ lotUuid: lotUuid, shares: '5' }],
    });
    const call = fetchStub.calls[0];
    expect(call.body).toMatchObject({
      shares: '5',
      price_per_share: '260',
      specific_lots: [{ lot_uuid: lotUuid, shares: '5' }],
    });
  });

  it('record_dividend_event POSTs with total_amount mapping', async () => {
    await callTool(fetchStub.fetchImpl, 'record_dividend_event', {
      accountUuid: acctUuid,
      securityUuid: secUuid,
      eventDate: '2026-06-26',
      totalAmount: 42.5,
      reinvest: true,
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/investments/events/dividend');
    expect(call.body).toEqual({
      account_uuid: acctUuid,
      security_uuid: secUuid,
      event_date: '2026-06-26',
      total_amount: 42.5,
      reinvest: true,
    });
  });

  it('record_buy_event maps dataQuality to data_quality', async () => {
    await callTool(fetchStub.fetchImpl, 'record_buy_event', {
      accountUuid: acctUuid,
      securityUuid: secUuid,
      eventDate: '2026-06-26',
      shares: 10,
      pricePerShare: 250,
      dataQuality: 'imputed_basis',
    });
    const call = fetchStub.calls[0];
    expect(new URL(call.url).pathname).toBe('/api/investments/events/buy');
    expect(call.body).toMatchObject({ data_quality: 'imputed_basis' });
  });

  it('record_dividend_event maps reinvestIntoSecurityUuid to reinvest_into_security_uuid', async () => {
    const targetSecUuid = '44444444-4444-4444-8444-444444444444';
    await callTool(fetchStub.fetchImpl, 'record_dividend_event', {
      accountUuid: acctUuid,
      securityUuid: secUuid,
      eventDate: '2026-06-26',
      totalAmount: 42.5,
      reinvest: true,
      pricePerShare: 55.25,
      reinvestIntoSecurityUuid: targetSecUuid,
    });
    const call = fetchStub.calls[0];
    expect(new URL(call.url).pathname).toBe('/api/investments/events/dividend');
    expect(call.body).toEqual({
      account_uuid: acctUuid,
      security_uuid: secUuid,
      event_date: '2026-06-26',
      total_amount: 42.5,
      reinvest: true,
      price_per_share: 55.25,
      reinvest_into_security_uuid: targetSecUuid,
    });
  });

  it('record_fee_event POSTs the fee with externalReference mapped', async () => {
    await callTool(fetchStub.fetchImpl, 'record_fee_event', {
      accountUuid: acctUuid,
      feeType: 'advisory',
      amount: 0.03,
      eventDate: '2026-06-26',
      externalReference: 'advisor:fee:2026-06',
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/investments/events/fee');
    expect(call.body).toEqual({
      account_uuid: acctUuid,
      fee_type: 'advisory',
      amount: 0.03,
      event_date: '2026-06-26',
      external_reference: 'advisor:fee:2026-06',
    });
  });

  // Backfilling behind a split: the flag as a model may send it, text included.
  it('takes adjusted_for_splits as a boolean or its text, on a buy, a sale, a dividend and each imported lot', async () => {
    const event = { accountUuid: acctUuid, securityUuid: secUuid, eventDate: '2021-03-01', shares: '20', pricePerShare: '10' };
    await callToolValidated(fetchStub.fetchImpl, 'record_buy_event', { ...event, adjustedForSplits: 'true' });
    await callToolValidated(fetchStub.fetchImpl, 'record_sell_event', { ...event, adjustedForSplits: 'false' });
    await callToolValidated(fetchStub.fetchImpl, 'record_dividend_event', {
      accountUuid: acctUuid, securityUuid: secUuid, eventDate: '2021-03-01', totalAmount: '50', reinvest: true, pricePerShare: '12.5', adjustedForSplits: true,
    });
    await callToolValidated(fetchStub.fetchImpl, 'batch_import_lots', {
      lots: [{ account_uuid: acctUuid, security_uuid: secUuid, acquisition_date: '2021-02-01', shares: 10, total_cost_basis: 100, adjusted_for_splits: 'true' }],
    });
    expect(fetchStub.calls.map((call) => (call.body as { adjusted_for_splits?: boolean; lots?: Array<{ adjusted_for_splits?: boolean }> })))
      .toMatchObject([{ adjusted_for_splits: true }, { adjusted_for_splits: false }, { adjusted_for_splits: true }, { lots: [{ adjusted_for_splits: true }] }]);
    for (const adjustedForSplits of ['yes', 1]) {
      await expect(callToolValidated(fetchStub.fetchImpl, 'record_buy_event', { ...event, adjustedForSplits })).rejects.toThrow();
    }
  });

  it('batch_import_lots POSTs a valid acquisition_method through to the API', async () => {
    await callToolValidated(fetchStub.fetchImpl, 'batch_import_lots', {
      lots: [{
        account_uuid: acctUuid,
        security_uuid: secUuid,
        acquisition_date: '2020-01-02',
        shares: 10,
        total_cost_basis: 500,
        acquisition_method: 'transfer_in',
      }],
      dryRun: true,
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/investments/lots/batch-import');
    expect(call.body).toMatchObject({
      dry_run: true,
      lots: [expect.objectContaining({ acquisition_method: 'transfer_in' })],
    });
  });

  // A day the backend refuses (a timestamp, 2026-02-30) is refused before anything is sent, by the
  // read reports' date filters and a buy's acquisition method too.
  it('refuses a read date that is not a real day, and an acquisition method that is not one, before sending', async () => {
    for (const [name, args] of [
      ['get_realized_gain_loss', { startDate: '2026-01-01T00:00:00Z' }],
      ['list_holding_events', { endDate: '2026-02-30' }],
      ['get_wash_sale_report', { startDate: '2026/01/01' }],
      ['get_portfolio_performance', { endDate: 'today' }],
      ['get_portfolio_value_series', { startDate: '2026-1-1' }],
      ['record_buy_event', { accountUuid: acctUuid, securityUuid: secUuid, eventDate: '2026-06-26', shares: '1', pricePerShare: '1', acquisitionMethod: 'bogus' }],
    ] as const) {
      await expect(callToolValidated(fetchStub.fetchImpl, name, args), name).rejects.toThrow();
    }
    expect(fetchStub.calls).toHaveLength(0);
    await callToolValidated(fetchStub.fetchImpl, 'get_realized_gain_loss', { startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(fetchStub.calls).toHaveLength(1);
  });

  it('batch_import_lots rejects an unrecognized acquisition_method at the MCP boundary (no 500 round-trip)', async () => {
    await expect(
      callToolValidated(fetchStub.fetchImpl, 'batch_import_lots', {
        lots: [{
          account_uuid: acctUuid,
          security_uuid: secUuid,
          acquisition_date: '2020-01-02',
          shares: 10,
          total_cost_basis: 500,
          acquisition_method: 'bogus_method',
        }],
        dryRun: true,
      }),
    ).rejects.toThrow();
    // Rejected before dispatch — nothing was sent to the backend.
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('create_account POSTs the account with mapped snake_case body', async () => {
    await callToolValidated(fetchStub.fetchImpl, 'create_account', {
      name: 'Example Rainy Day Fund',
      category: 'Asset',
      accountType: 'investment',
      accountGroup: 'investments',
      initialBalance: '1000.50',
      instructions: 'broker goal id: 12345',
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/accounts');
    expect(call.body).toEqual({
      name: 'Example Rainy Day Fund',
      type: 'Asset',
      account_type: 'investment',
      account_group: 'investments',
      initial_balance: 1000.5,
      instructions: 'broker goal id: 12345',
    });
  });

  it('adjust_account_balance POSTs the target balance to the adjust endpoint', async () => {
    await callToolValidated(fetchStub.fetchImpl, 'adjust_account_balance', {
      uuid: acctUuid,
      targetBalance: '-250.75',
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe(`/api/accounts/${acctUuid}/adjust-balance`);
    expect(call.body).toEqual({ targetBalance: -250.75 });
  });

  it('create_transaction maps externalTransactionId to external_transaction_id', async () => {
    await callTool(fetchStub.fetchImpl, 'create_transaction', {
      accountUuid: acctUuid,
      amount: 42.5,
      transactionDate: '2026-07-01',
      type: 'expense',
      externalTransactionId: 'stmt-2026-07:line-17',
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/transactions');
    expect(call.body).toMatchObject({
      account_uuid: acctUuid,
      external_transaction_id: 'stmt-2026-07:line-17',
    });
  });

  it('create_transactions POSTs the bulk body with per-row snake_case mapping', async () => {
    await callToolValidated(fetchStub.fetchImpl, 'create_transactions', {
      transactions: [
        {
          accountUuid: acctUuid,
          amount: '12.34',
          transactionDate: '2026-07-01',
          type: 'expense',
          description: 'Coffee',
          externalTransactionId: 'stmt-2026-07:line-1',
        },
        {
          accountUuid: acctUuid,
          amount: 2500,
          transactionDate: '2026-07-02',
          type: 'income',
        },
      ],
      dryRun: true,
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/transactions/bulk');
    expect(call.body).toEqual({
      dry_run: true,
      transactions: [
        {
          account_uuid: acctUuid,
          amount: 12.34,
          transaction_date: '2026-07-01',
          type: 'expense',
          description: 'Coffee',
          external_transaction_id: 'stmt-2026-07:line-1',
        },
        {
          account_uuid: acctUuid,
          amount: 2500,
          transaction_date: '2026-07-02',
          type: 'income',
        },
      ],
    });
  });

  it('create_transactions rejects an invalid row type at the MCP boundary', async () => {
    await expect(
      callToolValidated(fetchStub.fetchImpl, 'create_transactions', {
        transactions: [{ accountUuid: acctUuid, amount: 5, transactionDate: '2026-07-01', type: 'withdrawal' }],
      }),
    ).rejects.toThrow();
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('list_holdings GETs holdings with optional account filter', async () => {
    await callTool(fetchStub.fetchImpl, 'list_holdings', { accountUuid: acctUuid });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.pathname).toBe('/api/investments/holdings');
    expect(url.searchParams.get('account')).toBe(acctUuid);
  });

  it('get_holding_lots GETs the lots path with account query', async () => {
    await callTool(fetchStub.fetchImpl, 'get_holding_lots', { securityUuid: secUuid, accountUuid: acctUuid });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.pathname).toBe(`/api/investments/holdings/${secUuid}/lots`);
    expect(url.searchParams.get('account')).toBe(acctUuid);
  });

  it('get_unrealized_gain_loss GETs the unrealized report', async () => {
    await callTool(fetchStub.fetchImpl, 'get_unrealized_gain_loss', {});
    const call = fetchStub.calls[0];
    expect(call.method).toBe('GET');
    expect(new URL(call.url).pathname).toBe('/api/investments/reports/unrealized-gain-loss');
  });

  it('get_realized_gain_loss GETs the realized report with date range', async () => {
    await callTool(fetchStub.fetchImpl, 'get_realized_gain_loss', {
      startDate: '2026-01-01',
      endDate: '2026-06-30',
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.pathname).toBe('/api/investments/reports/realized-gain-loss');
    expect(url.searchParams.get('start_date')).toBe('2026-01-01');
    expect(url.searchParams.get('end_date')).toBe('2026-06-30');
  });

  it('set_cost_basis_method POSTs the mapped body', async () => {
    await callTool(fetchStub.fetchImpl, 'set_cost_basis_method', {
      accountUuid: acctUuid,
      securityUuid: secUuid,
      method: 'fifo',
      dripEnabled: true,
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/investments/cost-basis-method');
    expect(call.body).toEqual({
      account_uuid: acctUuid,
      method: 'fifo',
      security_uuid: secUuid,
      drip_enabled: true,
    });
  });

  it('update_underlying_holdings POSTs the mapped body with holdings + default source', async () => {
    await callTool(fetchStub.fetchImpl, 'update_underlying_holdings', {
      securityUuid: secUuid,
      snapshotDate: '2026-06-26',
      holdings: [
        { underlying_ticker: 'ACMEC', weight_percentage: 7 },
        { underlying_ticker: 'WIDGT', weight_percentage: 6.5, shares: 12 },
      ],
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/investments/underlying-holdings');
    expect(call.body).toEqual({
      security_uuid: secUuid,
      snapshot_date: '2026-06-26',
      holdings: [
        { underlying_ticker: 'ACMEC', weight_percentage: 7 },
        { underlying_ticker: 'WIDGT', weight_percentage: 6.5, shares: 12 },
      ],
      source: 'mcp_manual',
    });
  });

  it('update_underlying_holdings sends string weights/shares on as text through the schema', async () => {
    await callToolValidated(fetchStub.fetchImpl, 'update_underlying_holdings', {
      securityUuid: secUuid,
      snapshotDate: '2026-06-26',
      holdings: [{ underlying_ticker: 'ACMEC', weight_percentage: '7', shares: '12' }],
    });
    expect(fetchStub.calls[0].body).toMatchObject({
      holdings: [{ underlying_ticker: 'ACMEC', weight_percentage: '7', shares: '12' }],
    });
  });

  it('set_underlying_holdings_tracking POSTs the mapped body', async () => {
    await callTool(fetchStub.fetchImpl, 'set_underlying_holdings_tracking', { securityUuid: secUuid, trackUnderlyingHoldings: true });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/investments/underlying-tracking');
    expect(call.body).toEqual({ security_uuid: secUuid, track_underlying_holdings: true });
  });

  // z.coerce.boolean() read any non-empty string as true, so a model's "false" turned tracking on.
  it('set_underlying_holdings_tracking reads "false" as false, as models send it', async () => {
    for (const [sent, meant] of [['false', false], ['true', true], [false, false], [true, true]] as const) {
      const stub = makeFetchStub();
      await callToolValidated(stub.fetchImpl, 'set_underlying_holdings_tracking', { securityUuid: secUuid, trackUnderlyingHoldings: sent });
      expect(stub.calls[0].body, JSON.stringify(sent)).toEqual({ security_uuid: secUuid, track_underlying_holdings: meant });
    }
    for (const sent of ['no', 'False', '', 0, 1]) {
      const stub = makeFetchStub();
      await expect(
        callToolValidated(stub.fetchImpl, 'set_underlying_holdings_tracking', { securityUuid: secUuid, trackUnderlyingHoldings: sent }),
        JSON.stringify(sent)
      ).rejects.toThrow();
      expect(stub.calls).toHaveLength(0);
    }
  });

  it('get_underlying_holdings GETs the fund underlying-holdings path', async () => {
    await callTool(fetchStub.fetchImpl, 'get_underlying_holdings', { securityUuid: secUuid });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('GET');
    expect(new URL(call.url).pathname).toBe(`/api/investments/securities/${secUuid}/underlying-holdings`);
  });

  it('find_underlying_exposure GETs the exposure report, scoping to an account when given', async () => {
    await callTool(fetchStub.fetchImpl, 'find_underlying_exposure', { accountUuid: acctUuid });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.pathname).toBe('/api/investments/reports/underlying-exposure');
    expect(url.searchParams.get('account')).toBe(acctUuid);
  });

  // It promised every leaf security, but one worth less than a cent isn't listed.
  it("find_underlying_exposure's description says what isn't listed, and where it is", () => {
    const description = registeredTools(fetchStub.fetchImpl).get('find_underlying_exposure')?.config.description ?? '';
    expect(description).toMatch(/worth less than a cent each are not listed but summed in below_a_cent/);
    expect(description).toMatch(/below_a_cent\.amount and unknown_value add up to total_value/);
  });

  it('get_portfolio_value_series GETs the value-series report with optional bounds', async () => {
    await callTool(fetchStub.fetchImpl, 'get_portfolio_value_series', { startDate: '2026-01-01', limit: 90 });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.pathname).toBe('/api/investments/reports/value-series');
    expect(url.searchParams.get('start_date')).toBe('2026-01-01');
    expect(url.searchParams.get('limit')).toBe('90');
  });

  it('list_budget_items leaves out archived items unless asked for them', async () => {
    const stub = makeFetchStub([{ name: 'Groceries', status: 'active' }, { name: 'Old gym', status: 'archived' }]);
    const names = async (args: Record<string, unknown>) =>
      (JSON.parse((await callTool(stub.fetchImpl, 'list_budget_items', args)).content[0].text) as { name: string }[]).map((item) => item.name);
    expect(await names({})).toEqual(['Groceries']);
    expect(await names({ includeArchived: true })).toEqual(['Groceries', 'Old gym']);
    expect(new URL(stub.calls[0].url).pathname).toBe('/api/budgets/items');
  });

  it('create_budget_item POSTs to /api/budgets/items including expense_type and instructions', async () => {
    await callTool(fetchStub.fetchImpl, 'create_budget_item', {
      name: 'Groceries',
      expense_type: 'Expense',
      type: 'Monthly',
      subtype: 'Flexible',
      priority: 'Optional',
      default_budget_amount: 400,
      rollover: true,
      instructions: 'Match grocery stores and warehouse clubs here.',
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/budgets/items');
    expect(call.body).toMatchObject({
      name: 'Groceries',
      expense_type: 'Expense',
      subtype: 'Flexible',
      default_budget_amount: 400,
      rollover: true,
      instructions: 'Match grocery stores and warehouse clubs here.',
    });
  });

  it('create_budget_item coerces a string recurring_payment_frequency to a number', async () => {
    await callToolValidated(fetchStub.fetchImpl, 'create_budget_item', {
      name: 'Auto Insurance',
      expense_type: 'Expense',
      isbill: true,
      recurring_payment: true,
      recurring_payment_amount: '600',
      recurring_payment_frequency: '6',
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/budgets/items');
    expect(call.body).toMatchObject({
      name: 'Auto Insurance',
      isbill: true,
      recurring_payment_amount: 600,
      recurring_payment_frequency: 6,
    });
  });

  // The API refuses a frequency below 1 (no schedule), so the tool does too.
  it('refuses a recurring_payment_frequency below 1, sending nothing', async () => {
    for (const tool of ['create_budget_item', 'update_budget_item']) {
      for (const months of [0, '0', -3]) {
        const args = tool === 'create_budget_item' ? { name: 'Gym', recurring_payment_frequency: months } : { uuid: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b', recurring_payment_frequency: months };
        await expect(callToolValidated(fetchStub.fetchImpl, tool, args), `${tool} ${JSON.stringify(months)}`).rejects.toThrow();
      }
    }
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('update_budget_item PUTs to the uuid path and strips uuid from the body', async () => {
    await callTool(fetchStub.fetchImpl, 'update_budget_item', {
      uuid: '11111111-1111-4111-8111-111111111111',
      instructions: 'AI: treat refunds as income for this envelope.',
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('PUT');
    expect(new URL(call.url).pathname).toBe('/api/budgets/items/11111111-1111-4111-8111-111111111111');
    expect(call.body).toEqual({ instructions: 'AI: treat refunds as income for this envelope.' });
  });

  it('update_budget_item sends an envelope target date, and null to clear it', async () => {
    await callToolValidated(fetchStub.fetchImpl, 'update_budget_item', {
      uuid: '11111111-1111-4111-8111-111111111111',
      rollover_target_amount: '175',
      rollover_target_date: '2027-04-01',
    });
    expect(fetchStub.calls[0].body).toEqual({ rollover_target_amount: 175, rollover_target_date: '2027-04-01' });

    await callToolValidated(fetchStub.fetchImpl, 'update_budget_item', {
      uuid: '11111111-1111-4111-8111-111111111111',
      rollover_target_date: null,
    });
    expect(fetchStub.calls[1].body).toEqual({ rollover_target_date: null });
  });

  // The route takes a calendar day there and refuses a timestamp: refused here, before sending.
  it('update_budget_item takes the next payment date as a day, not a timestamp', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    await expect(
      callToolValidated(fetchStub.fetchImpl, 'update_budget_item', { uuid, recurring_next_payment_date: '2027-04-01T00:00:00Z' }),
    ).rejects.toThrow();
    expect(fetchStub.calls).toHaveLength(0);
    await callToolValidated(fetchStub.fetchImpl, 'update_budget_item', { uuid, recurring_next_payment_date: '2027-04-01' });
    expect(fetchStub.calls[0].body).toEqual({ recurring_next_payment_date: '2027-04-01' });
  });

  it('list_annotations GETs /api/annotations scoped to the subject', async () => {
    await callTool(fetchStub.fetchImpl, 'list_annotations', {
      subjectType: 'transaction',
      subjectUuid: '11111111-1111-4111-8111-111111111111',
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.pathname).toBe('/api/annotations');
    expect(url.searchParams.get('subject_type')).toBe('transaction');
    expect(url.searchParams.get('subject_uuid')).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('create_annotation POSTs an agent-authored root with snake_case body', async () => {
    await callTool(fetchStub.fetchImpl, 'create_annotation', {
      subjectType: 'transaction',
      subjectUuid: '11111111-1111-4111-8111-111111111111',
      kind: 'question',
      body: 'Is this SAMPLE WHSE charge Groceries or Household?',
      notify: true,
      severity: 'action_required',
      meta: { confidence: 0.62 },
      agentRunId: 'run-123',
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/annotations');
    expect(call.body).toEqual({
      kind: 'question',
      body: 'Is this SAMPLE WHSE charge Groceries or Household?',
      author_kind: 'agent',
      subject_type: 'transaction',
      subject_uuid: '11111111-1111-4111-8111-111111111111',
      notify: true,
      severity: 'action_required',
      meta: { confidence: 0.62 },
      agent_run_id: 'run-123',
    });
  });

  it('create_annotation POSTs a reply using parent_uuid', async () => {
    await callTool(fetchStub.fetchImpl, 'create_annotation', {
      parentUuid: '22222222-2222-4222-8222-222222222222',
      kind: 'answer',
      body: 'Classified as Groceries.',
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/annotations');
    expect(call.body).toEqual({
      kind: 'answer',
      body: 'Classified as Groceries.',
      author_kind: 'agent',
      parent_uuid: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('get_annotation_inbox GETs the inbox with the since cursor', async () => {
    await callTool(fetchStub.fetchImpl, 'get_annotation_inbox', { since: '2026-06-28T00:00:00Z', limit: 25 });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.pathname).toBe('/api/annotations/inbox');
    expect(url.searchParams.get('since')).toBe('2026-06-28T00:00:00Z');
    expect(url.searchParams.get('limit')).toBe('25');
  });

  it('reply_annotation POSTs an agent reply with parent_uuid', async () => {
    await callTool(fetchStub.fetchImpl, 'reply_annotation', {
      parentUuid: '22222222-2222-4222-8222-222222222222',
      kind: 'decision',
      body: 'Classified as Groceries per your answer.',
      agentRunId: 'run-9',
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/annotations');
    expect(call.body).toEqual({
      parent_uuid: '22222222-2222-4222-8222-222222222222',
      kind: 'decision',
      body: 'Classified as Groceries per your answer.',
      author_kind: 'agent',
      agent_run_id: 'run-9',
    });
  });

  it('resolve_annotation PATCHes status=resolved (no note → one call)', async () => {
    await callTool(fetchStub.fetchImpl, 'resolve_annotation', {
      uuid: '33333333-3333-4333-8333-333333333333',
    });
    expect(fetchStub.calls).toHaveLength(1);
    const call = fetchStub.calls[0];
    expect(call.method).toBe('PATCH');
    expect(new URL(call.url).pathname).toBe('/api/annotations/33333333-3333-4333-8333-333333333333');
    expect(call.body).toEqual({ status: 'resolved' });
  });

  it('resolve_annotation with a note posts a decision reply then resolves', async () => {
    await callTool(fetchStub.fetchImpl, 'resolve_annotation', {
      uuid: '33333333-3333-4333-8333-333333333333',
      note: 'Done — applied your guidance.',
    });
    expect(fetchStub.calls).toHaveLength(2);
    expect(fetchStub.calls[0].method).toBe('POST');
    expect(new URL(fetchStub.calls[0].url).pathname).toBe('/api/annotations');
    expect(fetchStub.calls[0].body).toEqual({
      parent_uuid: '33333333-3333-4333-8333-333333333333',
      kind: 'decision',
      body: 'Done — applied your guidance.',
      author_kind: 'agent',
    });
    expect(fetchStub.calls[1].method).toBe('PATCH');
    expect(fetchStub.calls[1].body).toEqual({ status: 'resolved' });
  });

  it('set_annotation_feedback PATCHes feedback + reason', async () => {
    await callTool(fetchStub.fetchImpl, 'set_annotation_feedback', {
      uuid: '44444444-4444-4444-8444-444444444444',
      feedback: 'incorrect',
      reason: 'This is reimbursable, not an expense.',
    });
    const call = fetchStub.calls[0];
    expect(call.method).toBe('PATCH');
    expect(new URL(call.url).pathname).toBe('/api/annotations/44444444-4444-4444-8444-444444444444');
    expect(call.body).toEqual({ feedback: 'incorrect', feedback_reason: 'This is reimbursable, not an expense.' });
  });

  it('apply_annotation_learning logs a correction then marks learning applied', async () => {
    await callTool(fetchStub.fetchImpl, 'apply_annotation_learning', {
      uuid: '44444444-4444-4444-8444-444444444444',
      note: 'Updated Groceries instructions to exclude reimbursable items.',
      appliedRef: { type: 'budget_item', uuid: '55555555-5555-4555-8555-555555555555', field: 'instructions' },
    });
    expect(fetchStub.calls).toHaveLength(2);
    expect(fetchStub.calls[0].method).toBe('POST');
    expect(new URL(fetchStub.calls[0].url).pathname).toBe('/api/annotations');
    expect(fetchStub.calls[0].body).toEqual({
      parent_uuid: '44444444-4444-4444-8444-444444444444',
      kind: 'correction',
      body: 'Updated Groceries instructions to exclude reimbursable items.',
      author_kind: 'agent',
      meta: { type: 'budget_item', uuid: '55555555-5555-4555-8555-555555555555', field: 'instructions' },
    });
    expect(fetchStub.calls[1].method).toBe('PATCH');
    expect(new URL(fetchStub.calls[1].url).pathname).toBe('/api/annotations/44444444-4444-4444-8444-444444444444');
    expect(fetchStub.calls[1].body).toEqual({
      learning_status: 'applied',
      applied_ref: { type: 'budget_item', uuid: '55555555-5555-4555-8555-555555555555', field: 'instructions' },
    });
  });
});

describe('MCP notification rule tools', () => {
  let fetchStub: ReturnType<typeof makeFetchStub>;
  beforeEach(() => {
    fetchStub = makeFetchStub();
  });

  it('get_notification_rules GETs the tenant rules', async () => {
    await callTool(fetchStub.fetchImpl, 'get_notification_rules', {});
    expect(`${fetchStub.calls[0].method} ${new URL(fetchStub.calls[0].url).pathname}`).toBe('GET /api/notifications/rules');
  });

  it('set_notification_rules validates the rules and coerces what models send as strings', async () => {
    await callToolValidated(fetchStub.fetchImpl, 'set_notification_rules', {
      rules: [
        {
          key: 'large_purchase',
          label: 'A large purchase',
          enabled: 'true',
          kind: 'transaction',
          audience: 'everyone',
          when: { all: [{ fact: 'direction', is: 'out' }, { fact: 'size', gte: '500' }] },
        },
        { key: 'weekly_digest', label: 'The week', enabled: 'false', sendBy: 'email', kind: 'digest', weekday: '7', hour: '18' },
      ],
    });
    const call = fetchStub.calls[0];
    expect(`${call.method} ${new URL(call.url).pathname}`).toBe('PUT /api/notifications/rules');
    expect(call.body).toEqual({
      rules: [
        {
          key: 'large_purchase',
          label: 'A large purchase',
          enabled: true,
          // Left out, so the schema's default: both channels.
          sendBy: 'both',
          kind: 'transaction',
          audience: 'everyone',
          when: { all: [{ fact: 'direction', is: 'out' }, { fact: 'size', gte: '500' }] },
        },
        { key: 'weekly_digest', label: 'The week', enabled: false, sendBy: 'email', kind: 'digest', weekday: 7, hour: 18 },
      ],
    });
  });

  it('set_notification_rules refuses a condition on a fact the kind lacks before calling the API', async () => {
    await expect(
      callToolValidated(fetchStub.fetchImpl, 'set_notification_rules', {
        rules: [{ key: 'x', label: 'X', enabled: true, kind: 'budget_item', when: { fact: 'merchant', is: 'Sample Wholesale' } }],
      })
    ).rejects.toThrow(/doesn’t know “merchant”/);
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('set_my_notification_preferences PUTs only the channels given', async () => {
    await callToolValidated(fetchStub.fetchImpl, 'set_my_notification_preferences', {
      rules: [{ rule: 'over_budget', push: 'false' }],
    });
    expect(fetchStub.calls[0].body).toEqual({ rules: [{ rule: 'over_budget', push: false }] });
  });

  it('lists the notification tools with JSON Schema inputs', async () => {
    const tools = registeredTools(fetchStub.fetchImpl);
    for (const name of ['get_notification_rules', 'set_notification_rules', 'get_my_notification_preferences', 'set_my_notification_preferences']) {
      expect(tools.get(name)).toBeDefined();
    }
    // The recursive condition schema has to survive conversion for tools/list.
    const json = z.toJSONSchema(inputSchemaOf(tools.get('set_notification_rules')!), { io: 'input' });
    expect(JSON.stringify(json)).toContain('hasWords');
  });
});
