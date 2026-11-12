import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { withTenant } from '../db/withTenant.js';
import { createSettingsRoutes } from '../routes/settings.js';
import type { TenantRequest } from '../middleware/tenant.js';
import { readTenantMoneyFormat, tenantMoneyText } from '../services/tenantMoneyFormat.js';
import { adjustAccountBalance } from '../services/accounts/AccountService.js';
import { BalanceRebalanceService } from '../services/BalanceRebalanceService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * A ledger's currency and locale: General Settings beside its time zone (tenant_settings),
 * set by its admins, read by every member, USD in en-US until set. The texts the server
 * writes for the ledger name its amounts in them: a balance adjustment's description and
 * notes here (the refusals, the transfer message and the notifications use the same
 * tenantMoneyText / moneyText). Another ledger keeps its own.
 */
describe("a ledger's money format", () => {
  let tenant: TestTenant;
  let other: TestTenant;
  let app: Express;
  /** Intl separates a currency from its number with a no-break space in some locales. */
  const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

  const stored = async () =>
    (
      await tenant.pool.query<{ setting_key: string; setting_value: string }>(
        `SELECT setting_key, setting_value FROM tenant_settings
          WHERE setting_key IN ('application_currency', 'application_locale') ORDER BY setting_key`
      )
    ).rows;

  beforeAll(async () => {
    tenant = await createTestTenant('Money format');
    other = await createTestTenant('Money format, other ledger');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use((req, _res, next) => {
      (req as TenantRequest).tenant = { id: tenant.tenantId, isAdmin: true };
      next();
    });
    app.use('/api/settings', createSettingsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
    await other?.cleanup();
  });

  it('is USD in en-US until the ledger sets one, and General Settings says so', async () => {
    const res = await request(app).get('/api/settings/general').expect(200);
    const values = Object.fromEntries((res.body as Array<{ setting_key: string; setting_value: string }>).map((s) => [s.setting_key, s.setting_value]));
    expect(values).toMatchObject({ application_currency: 'USD', application_locale: 'en-US' });
    expect(await withTenant(tenant.tenantId, () => readTenantMoneyFormat())).toEqual({ currency: 'USD', locale: 'en-US' });
    expect(await withTenant(tenant.tenantId, () => tenantMoneyText(-1234.5))).toBe('-$1,234.50');
    expect(await stored()).toEqual([]);
  });

  it('refuses a currency or a locale that is not one, and writes nothing', async () => {
    for (const settings of [
      { application_currency: 'XYZ' },
      { application_currency: 'eur' },
      { application_currency: 'EURO' },
      { application_currency: 5 },
      // Only currencies with cents: amounts are kept to two decimals.
      { application_currency: 'JPY' },
      { application_currency: 'KRW' },
      { application_currency: 'KWD' },
      { application_locale: 'en_us' },
      { application_locale: 'xx' },
      { application_locale: '' },
      // Not one Chrome formats in, so not offered.
      { application_locale: 'is-IS' },
      { application_currency: 'EUR', application_locale: 'not a locale' },
    ]) {
      const res = await request(app).post('/api/settings/general').send({ settings });
      expect(res.status, JSON.stringify(settings)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
    const named = await request(app).post('/api/settings/general').send({ settings: { application_currency: 'XYZ' } });
    expect(named.body.error).toBe('Choose a currency by its ISO 4217 code, such as USD or EUR.');
    const yen = await request(app).post('/api/settings/general').send({ settings: { application_currency: 'JPY' } });
    expect(yen.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      error: 'JPY has no decimal places, and amounts here are kept to two (cents). Choose a currency with two, such as USD or EUR.',
    });
    const icelandic = await request(app).post('/api/settings/general').send({ settings: { application_locale: 'is-IS' } });
    expect(icelandic.body.error).toBe('Choose a number format from the list, such as en-US or de-DE.');
    expect(await stored()).toEqual([]);
  });

  it("saves the admin's choice, which the ledger's texts then use, and another ledger keeps its own", async () => {
    await request(app)
      .post('/api/settings/general')
      .send({ settings: { application_currency: 'EUR', application_locale: 'de-DE' } })
      .expect(200);
    expect(await stored()).toEqual([
      { setting_key: 'application_currency', setting_value: 'EUR' },
      { setting_key: 'application_locale', setting_value: 'de-DE' },
    ]);
    const res = await request(app).get('/api/settings/general').expect(200);
    expect(res.body.map((s: { setting_value: string }) => s.setting_value)).toEqual(expect.arrayContaining(['EUR', 'de-DE']));

    expect(await withTenant(tenant.tenantId, () => readTenantMoneyFormat())).toEqual({ currency: 'EUR', locale: 'de-DE' });
    expect(plain(await withTenant(tenant.tenantId, () => tenantMoneyText(-1234.5)))).toBe('-1.234,50 €');
    expect(await withTenant(other.tenantId, () => tenantMoneyText(-1234.5))).toBe('-$1,234.50');
    // Outside any transaction, a short one of the ledger's own.
    expect(await readTenantMoneyFormat(other.tenantId)).toEqual({ currency: 'USD', locale: 'en-US' });
  });

  it("names a balance adjustment's amount in the ledger's format", async () => {
    const { rows: [account] } = await tenant.pool.query<{ id: number; uuid: string }>(
      `INSERT INTO accounts (name, type, account_type, account_group) VALUES ('Money format checking', 'Asset', 'checking', 'cash') RETURNING id, uuid`
    );
    const result = await withTenant(tenant.tenantId, () => adjustAccountBalance(account!.uuid, '1234.50', tenant.userId));
    expect(result.adjusted).toBe(true);
    // The bank sync's adjustment notes say the imported balance the same way.
    await withTenant(tenant.tenantId, () =>
      new BalanceRebalanceService().createBalanceAdjustmentTransaction(account!.id, 10, 1244.5, null)
    );
    const { rows } = await tenant.pool.query<{ description: string; notes: string | null }>(
      `SELECT description, notes FROM transactions WHERE account_id = $1 ORDER BY id`,
      [account!.id]
    );
    expect(rows.map((row) => ({ description: plain(row.description), notes: row.notes && plain(row.notes) }))).toEqual([
      { description: 'Balance adjustment to 1.234,50 €', notes: 'Manual balance adjustment to 1.234,50 €' },
      { description: 'Balance adjustment to match imported balance', notes: 'Adjusted to match imported balance of 1.244,50 €' },
    ]);
  });
});
