import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { ImportService } from '../ImportService.js';
import type { MerchantMatcher } from '../import/MerchantMatcher.js';
import { withTenant } from '../../db/withTenant.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import globalPool from '../../db.js';

// SimpleFin payee full switch (requires Postgres test DB): when the provider
// sends a payee, it is THE merchant-matching signal — rules, exact-name match,
// and auto-create naming all use it, and the raw description is ignored. The
// description remains the signal only for transactions without a payee
// (manual entries / providers that omit it).
describe('MerchantMatcher payee-first matching', () => {
  let pool: Pool;
  let tenant: TestTenant;
  let service: ImportService;
  const stamp = Date.now();
  const payeeMerchantName = `Payee Target ${stamp}`;
  const ruleMerchantName = `Rule Target ${stamp}`;
  const junkMerchantName = `TST* JUNK DESC ${stamp} XX`;
  let payeeMerchantId: number;
  let ruleMerchantId: number;
  let junkMerchantId: number;

  // The matcher the import uses, reached through the ImportService that owns it.
  const processMerchant = (description: string, payee: string | null | undefined, rules = true): Promise<number | null> =>
    withTenant(tenant.tenantId, () => (service as unknown as { merchants: MerchantMatcher }).merchants.match(description, payee, rules));

  beforeAll(async () => {
    tenant = await createTestTenant('ImportService payee matching');
    pool = tenant.pool;
    service = new ImportService(globalPool);
    const payeeM = await pool.query(`INSERT INTO merchants (name) VALUES ($1) RETURNING id`, [payeeMerchantName]);
    payeeMerchantId = payeeM.rows[0].id;
    const ruleM = await pool.query(`INSERT INTO merchants (name) VALUES ($1) RETURNING id`, [ruleMerchantName]);
    ruleMerchantId = ruleM.rows[0].id;
    // A merchant literally named like a raw statement description — the legacy
    // junk pattern. Under the full switch it must NOT attract payee-bearing rows.
    const junkM = await pool.query(`INSERT INTO merchants (name) VALUES ($1) RETURNING id`, [junkMerchantName]);
    junkMerchantId = junkM.rows[0].id;
    await pool.query(
      `INSERT INTO merchant_matching_rules (merchant_id, matching_text, method) VALUES ($1, $2, 'contains')`,
      [ruleMerchantId, `RULEHOOK${stamp}`],
    );
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('matches an existing merchant by exact payee name (raw description would miss)', async () => {
    const id = await processMerchant(`RAW STATEMENT NOISE 000-000 XX ${stamp}`, payeeMerchantName.toUpperCase());
    expect(id).toBe(payeeMerchantId);
  });

  it('rules fire against the payee when one is present', async () => {
    const id = await processMerchant(`RAW NOISE ${stamp}`, `XX RULEHOOK${stamp} YY`);
    expect(id).toBe(ruleMerchantId);
  });

  it('FULL SWITCH: a description-hook rule does NOT fire on a payee-bearing transaction', async () => {
    // Description contains the rule hook, but a payee is present — the payee is
    // the only signal, so the rule is bypassed and the payee resolves instead.
    const id = await processMerchant(`XX RULEHOOK${stamp} YY`, payeeMerchantName);
    expect(id).toBe(payeeMerchantId);
    expect(id).not.toBe(ruleMerchantId);
  });

  it('FULL SWITCH: a legacy description-named merchant does not attract payee-bearing rows', async () => {
    // The description exactly equals an existing (junk) merchant's name, but a
    // fresh payee is present — a NEW clean merchant is created from the payee
    // instead of feeding the junk one.
    const payee = `Clean Payee ${stamp}`;
    const id = await processMerchant(junkMerchantName, payee);
    expect(id).not.toBe(junkMerchantId);
    const row = await pool.query('SELECT name FROM merchants WHERE id = $1', [id]);
    expect(row.rows[0].name).toBe(payee);
  });

  it('description rules still fire when the provider sends no payee', async () => {
    const id = await processMerchant(`XX RULEHOOK${stamp} YY`, undefined);
    expect(id).toBe(ruleMerchantId);
  });

  it('auto-creates the merchant named by payee, not the raw description', async () => {
    const payee = `Fresh Payee ${stamp}`;
    const id = await processMerchant(`TST* FRESHP-ANYTOWN ${stamp} XX`, payee);
    expect(id).toBeTruthy();
    const row = await pool.query('SELECT name FROM merchants WHERE id = $1', [id]);
    expect(row.rows[0].name).toBe(payee);
  });

  it('falls back to description naming when the provider sends no payee', async () => {
    const description = `LEGACY DESC ONLY ${stamp}`;
    const id = await processMerchant(description, undefined);
    expect(id).toBeTruthy();
    const row = await pool.query('SELECT name FROM merchants WHERE id = $1', [id]);
    expect(row.rows[0].name).toBe(description);
  });

  it('returns null when both description and payee are empty', async () => {
    expect(await processMerchant('', '')).toBeNull();
    expect(await processMerchant('   ', undefined)).toBeNull();
  });
});
