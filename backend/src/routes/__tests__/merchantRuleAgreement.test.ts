import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import globalPool from '../../db.js';
import { createMerchantsRoutes } from '../merchants.js';
import { withTenant } from '../../db/withTenant.js';
import { ImportService } from '../../services/ImportService.js';
import type { MerchantMatcher } from '../../services/import/MerchantMatcher.js';
import { MAX_REGEX_RULES_PER_TENANT, resetUserRegex } from '../../utils/userRegex.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A merchant rule's preview ("Test Rules") and the import agree: an exact
 * rule matches ignoring case in both (the import compared case-sensitively), and a regex
 * rule, which the rule form and the MCP tools say links imported transactions to the
 * merchant, does so in the import (it never ran there; only the preview applied it).
 */
describe('merchant rules: the preview and the import agree on exact and regex rules', () => {
  let tenant: TestTenant;
  let app: Express;
  let accountId: number;
  const service = new ImportService(globalPool);

  const q = (text: string, params: unknown[] = []) => tenant.pool.query(text, params);
  const importMerchant = (payee: string) =>
    withTenant(tenant.tenantId, () =>
      (service as unknown as { merchants: MerchantMatcher }).merchants.match('', payee, true)
    );
  const merchant = async (name: string) =>
    (await q(`INSERT INTO merchants (name) VALUES ($1) RETURNING id, uuid`, [name])).rows[0] as { id: number; uuid: string };
  const rule = (merchantId: number, method: string, text: string) =>
    q(`INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, $2, $3)`, [merchantId, method, text]);
  const transaction = (description: string) =>
    q(`INSERT INTO transactions (account_id, type, amount, transaction_date, description) VALUES ($1, 'expense', -1.00, '2026-10-02', $2)`, [
      accountId,
      description,
    ]);
  const previewed = async (uuid: string) =>
    (await request(app).post(`/api/merchants/${uuid}/test-rules`).expect(200)).body.matchingTransactions
      .map((t: { description: string }) => t.description)
      .sort();

  beforeAll(async () => {
    tenant = await createTestTenant('Merchant rule agreement');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/merchants', createMerchantsRoutes());
    accountId = (
      await q(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`)
    ).rows[0].id;
  });

  afterAll(async () => {
    await resetUserRegex();
    await tenant?.cleanup();
  });

  it('an exact rule matches ignoring case, in the preview and the import', async () => {
    // Named unlike the text, so the import's match by merchant name doesn't stand in for the rule.
    const exact = await merchant('Exact rule merchant');
    await rule(exact.id, 'exact', 'Sample Bean Coffee');
    await transaction('SAMPLE BEAN COFFEE');
    await transaction('Sample Bean Coffee Roasters');

    expect(await previewed(exact.uuid)).toEqual(['SAMPLE BEAN COFFEE']);
    expect(await importMerchant('SAMPLE BEAN COFFEE')).toBe(exact.id);
    expect(await importMerchant('sample bean coffee')).toBe(exact.id);
    expect(await importMerchant('Sample Bean Coffee Roasters')).not.toBe(exact.id);
  });

  it('a regex rule matches in the import as in the preview, after the other methods', async () => {
    const regex = await merchant('Regex rule merchant');
    await rule(regex.id, 'regex', '^green\\s+(tea|leaf)\\s+[0-9]+$');
    await transaction('GREEN  TEA 42');
    await transaction('GREEN TEA FORTY');

    expect(await previewed(regex.uuid)).toEqual(['GREEN  TEA 42']);
    expect(await importMerchant('GREEN  TEA 42')).toBe(regex.id);
    expect(await importMerchant('GREEN TEA FORTY')).not.toBe(regex.id);

    // A contains rule that also matches wins: regex rules come after the others.
    const contains = await merchant('Contains rule merchant');
    await rule(contains.id, 'contains', 'leaf 7');
    expect(await importMerchant('Green Leaf 7')).toBe(contains.id);
  });

  it(`refuses a regex merchant rule past the ledger's ${MAX_REGEX_RULES_PER_TENANT}, and applies only the first ones of a ledger that has more`, async () => {
    await q(`DELETE FROM merchant_matching_rules`);
    const capped = await merchant('Capped merchant');
    // Longer patterns sort first; none of these matches.
    await q(
      `INSERT INTO merchant_matching_rules (merchant_id, method, matching_text)
       SELECT $1, 'regex', '^no-such-payee-number-' || lpad(n::text, 4, '0') || '$' FROM generate_series(1, $2::int) n`,
      [capped.id, MAX_REGEX_RULES_PER_TENANT]
    );
    const refused = await request(app).post(`/api/merchants/${capped.uuid}/rules`).send({ method: 'regex', matching_text: '^one more' });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('TOO_MANY_REGEX_RULES');
    await request(app).post(`/api/merchants/${capped.uuid}/rules`).send({ method: 'contains', matching_text: 'one more' }).expect(201);
    const counted = (await q(`SELECT uuid FROM merchant_matching_rules WHERE method = 'regex' ORDER BY id LIMIT 1`)).rows[0].uuid;
    await request(app).put(`/api/merchants/rules/${counted}`).send({ method: 'regex', matching_text: '^changed-but-counted$' }).expect(200);

    // Saved before the cap: one more, shorter, which would match. It is past the first ones.
    const late = await merchant('Past the cap merchant');
    await rule(late.id, 'regex', '^late');
    expect(await importMerchant('LATE NIGHT DINER')).not.toBe(late.id);
    await q(`DELETE FROM merchant_matching_rules WHERE merchant_id = $1 AND method = 'regex'`, [capped.id]);
    expect(await importMerchant('LATE NIGHT CAFE')).toBe(late.id);
  });
});
