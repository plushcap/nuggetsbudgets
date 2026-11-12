import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import globalPool from '../../db.js';
import { createMerchantsRoutes } from '../merchants.js';
import { createAccountsRoutes } from '../accounts.js';
import { createInvestmentsRoutes } from '../investments.js';
import { getDb, withTenant } from '../../db/withTenant.js';
import { ImportService } from '../../services/ImportService.js';
import type { MerchantMatcher } from '../../services/import/MerchantMatcher.js';
import { BillService } from '../../services/bills/BillService.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A search term or merchant-rule text means its own characters: a
 * `%`, `_` or `\` in it is matched as itself, not as a LIKE wildcard or escape. Each
 * search below has a row with the literal text and a row the unescaped pattern would
 * also have matched; only the first may come back.
 */
describe('LIKE patterns from input match literally', () => {
  let tenant: TestTenant;
  let app: Express;
  let accountUuid: string;
  const today = '2026-11-02';

  const q = (sql: string, params: unknown[] = []) => tenant.pool.query(sql, params);

  beforeAll(async () => {
    tenant = await createTestTenant('LIKE patterns');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/merchants', createMerchantsRoutes());
    app.use('/api/accounts', createAccountsRoutes());
    app.use('/api/investments', createInvestmentsRoutes());

    // Merchants: "50% Off" and "50 Off Today" (which `50%` would also match); "A_B" and
    // "AXB" (which `A_B` would match); "C\D" and "CD" (which `C\D` would match).
    for (const name of ['50% Off', '50 Off Today', 'A_B Store', 'AXB Store', 'C\\D Shop', 'CD Shop']) {
      await q(`INSERT INTO merchants (name) VALUES ($1)`, [name]);
    }
    const account = await q(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id, uuid`
    );
    accountUuid = account.rows[0].uuid;
    for (const description of ['Refund 100%', 'Refund 1000 and more', 'Ref_1', 'RefX1']) {
      await q(
        `INSERT INTO transactions (account_id, type, amount, transaction_date, description) VALUES ($1, 'expense', -5.00, $2, $3)`,
        [account.rows[0].id, '2026-10-01', description]
      );
    }
    for (const [ticker, name] of [['PCT%', 'Percent fund'], ['PCTX', 'Percent other'], ['U_1', 'Under fund'], ['UX1', 'Under other']]) {
      await q(`INSERT INTO securities (ticker, name) VALUES ($1, $2)`, [ticker, name]);
    }
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  const merchantNames = (body: { merchants?: { name: string }[] } | { name: string }[]) =>
    (Array.isArray(body) ? body : body.merchants ?? []).map((m) => m.name).sort();

  it('merchant search and both paginated variants', async () => {
    for (const [term, expected] of [['50%', ['50% Off']], ['a_b', ['A_B Store']], ['c\\d', ['C\\D Shop']]] as const) {
      const search = await request(app).get('/api/merchants/search').query({ q: term }).expect(200);
      expect(merchantNames(search.body)).toEqual(expected);
      const full = await request(app).get('/api/merchants/paginated').query({ search: term }).expect(200);
      expect(merchantNames(full.body)).toEqual(expected);
      expect(full.body.pagination.total).toBe(expected.length);
      const lite = await request(app).get('/api/merchants/paginated').query({ search: term, fields: 'lite' }).expect(200);
      expect(merchantNames(lite.body)).toEqual(expected);
    }
  });

  it("an account's transaction search", async () => {
    const descriptions = async (search: string) =>
      (await request(app).get(`/api/accounts/${accountUuid}/transactions`).query({ search }).expect(200)).body.transactions
        .map((t: { description: string }) => t.description)
        .sort();
    expect(await descriptions('100%')).toEqual(['Refund 100%']);
    expect(await descriptions('ref_1')).toEqual(['Ref_1']);
  });

  it('the securities list and the unused-securities cleanup list', async () => {
    const tickers = async (path: string, search: string) => {
      const body = (await request(app).get(`/api/investments/${path}`).query({ search }).expect(200)).body;
      return (body.data ?? body.items).map((s: { ticker: string }) => s.ticker).sort();
    };
    expect(await tickers('securities/paginated', 'pct%')).toEqual(['PCT%']);
    expect(await tickers('securities/paginated', 'u_1')).toEqual(['U_1']);
    expect(await tickers('securities/cleanup/unused', 'pct%')).toEqual(['PCT%']);
    expect(await tickers('securities/cleanup/unused', 'u_1')).toEqual(['U_1']);
  });

  it("a bill's payment candidates", async () => {
    const occurrenceUuid = await withTenant(tenant.tenantId, async () => {
      const bill = await getDb()
        .insertInto('budget_items')
        .values({
          name: 'Water', expense_type: 'Expense', type: 'Monthly', subtype: 'Fixed', isbill: true,
          recurring_payment: true, recurring_payment_amount: '5.00', recurring_payment_frequency: 1,
          recurring_next_payment_date: '2026-11-05',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const occurrence = await getDb()
        .insertInto('bill_occurrences')
        .values({ budget_item_id: bill.id, due_date: '2026-11-05', expected_amount: '-5.00' })
        .returning('uuid')
        .executeTakeFirstOrThrow();
      return occurrence.uuid;
    });
    const found = (words: string) =>
      withTenant(tenant.tenantId, () => new BillService().candidates(occurrenceUuid, words, today));
    expect((await found('100%')).map((c) => c.description)).toEqual(['Refund 100%']);
    expect((await found('Ref_1')).map((c) => c.description)).toEqual(['Ref_1']);
  });

  describe('merchant rules: the preview and the import agree', () => {
    const service = new ImportService(globalPool);
    const importMerchant = (payee: string) =>
      withTenant(tenant.tenantId, () =>
        (service as unknown as { merchants: MerchantMatcher }).merchants.match('', payee, true)
      );

    // One merchant per rule; each rule's text has a LIKE metacharacter in it.
    const rules = [
      { merchant: 'Rule contains', method: 'contains', text: 'ZZ_Q', literal: 'pay ZZ_Q here', lookalike: 'pay ZZXQ here' },
      { merchant: 'Rule starts', method: 'starts_with', text: 'YY%', literal: 'YY% shop', lookalike: 'YYanything' },
      { merchant: 'Rule ends', method: 'ends_with', text: 'W\\W', literal: 'shop W\\W', lookalike: 'shop WW' },
    ] as const;
    const merchantIds = new Map<string, { id: number; uuid: string }>();

    beforeAll(async () => {
      const account = (await q(`SELECT id FROM accounts WHERE name = 'Checking'`)).rows[0].id;
      for (const rule of rules) {
        const m = (await q(`INSERT INTO merchants (name) VALUES ($1) RETURNING id, uuid`, [rule.merchant])).rows[0];
        merchantIds.set(rule.merchant, m);
        await q(`INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, $2, $3)`, [m.id, rule.method, rule.text]);
        for (const description of [rule.literal, rule.lookalike]) {
          await q(
            `INSERT INTO transactions (account_id, type, amount, transaction_date, description) VALUES ($1, 'expense', -1.00, '2026-10-02', $2)`,
            [account, description]
          );
        }
      }
    });

    for (const rule of rules) {
      it(`${rule.method} "${rule.text}"`, async () => {
        const merchant = merchantIds.get(rule.merchant)!;
        const preview = await request(app).post(`/api/merchants/${merchant.uuid}/test-rules`).expect(200);
        expect(preview.body.matchingTransactions.map((t: { description: string }) => t.description)).toEqual([rule.literal]);

        expect(await importMerchant(rule.literal)).toBe(merchant.id);
        expect(await importMerchant(rule.lookalike)).not.toBe(merchant.id);
      });
    }
  });
});
