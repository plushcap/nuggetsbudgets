import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { defaultNotificationRules, notificationRulesSchema } from '@nuggets/shared';
import globalPool from '../db.js';
import { withTenant, getDb } from '../db/withTenant.js';
import { NotificationRulesEngine } from '../services/NotificationRulesEngine.js';
import { NotificationQueueService } from '../services/NotificationQueueService.js';
import { EmailTemplateService } from '../services/EmailTemplateService.js';
import { NotificationRuleService } from '../services/notifications/NotificationRuleService.js';
import { addDays } from '../services/notifications/schedule.js';
import { DEFAULT_APP_TIMEZONE } from '../utils/appDate.js';
import { calendarDateIn } from '../utils/calendarDate.js';
import { ImportService } from '../services/ImportService.js';
import { BalanceRebalanceService } from '../services/BalanceRebalanceService.js';
import { createInvestmentsRoutes } from '../routes/investments.js';
import type { EmailDeliveryService } from '../services/EmailDeliveryService.js';
import type { PushNotificationService } from '../services/PushNotificationService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import { fixtureAccountId } from '../test/fixtureAccount.js';

/**
 * Savepoints let work fail without aborting the request's transaction.
 * They also roll back whatever ran inside them, which could
 * undo too much. These pin three such cases.
 */

describe('A notification that keeps failing', () => {
  const now = new Date();
  // The application time zone: the test DB has the seeded default (UTC).
  const today = calendarDateIn(DEFAULT_APP_TIMEZONE, now);
  let tenant: TestTenant;
  const ruleService = new NotificationRuleService(async () => 'a-test-secret-that-is-at-least-32-chars');
  const push = { sendToUser: vi.fn().mockResolvedValue({ sent: 0, failed: 1, removed: 0 }) };
  const email = {
    isConfigured: vi.fn().mockResolvedValue(true),
    sendEmailWithRetry: vi.fn().mockRejectedValue(new Error('SMTP down')),
  };
  const engine = new NotificationRulesEngine(
    new NotificationQueueService(),
    new EmailTemplateService(),
    email as unknown as EmailDeliveryService,
    push as unknown as PushNotificationService,
    ruleService
  );
  const inTenant = <T>(fn: () => Promise<T>) => withTenant(tenant.tenantId, fn);

  beforeAll(async () => {
    tenant = await createTestTenant('Savepoints: failing notification');
    await inTenant(async () => {
      const db = getDb();
      const period = await db
        .insertInto('budget_period')
        .values({ name: `Notify ${Date.now()}`, month: 'Test', year: 2026, month_number: 1, start_date: addDays(today, -9), end_date: addDays(today, 20) })
        .returning('id')
        .executeTakeFirstOrThrow();
      const item = await db.insertInto('budget_items').values({ name: 'Groceries', expense_type: 'Expense', type: 'Monthly' }).returning('id').executeTakeFirstOrThrow();
      const pi = await db.insertInto('budget_period_items').values({ budget_period_id: period.id, budget_item_id: item.id }).returning('id').executeTakeFirstOrThrow();
      await db
        .insertInto('budget_period_transactions')
        .values({ budget_period_item_id: pi.id, budget_item_id: item.id, transaction_type: 'add', type: 'budget_update', amount: '500.00' })
        .execute();
      await db
        .insertInto('transactions')
        .values({ account_id: await fixtureAccountId(db), type: 'expense', amount: '-650.00', transaction_date: today, budget_item_id: item.id, budget_period_id: period.id, budget_period_item_id: pi.id, review_status: 'reviewed' })
        .execute();
      await ruleService.saveRules(
        notificationRulesSchema.parse({ rules: defaultNotificationRules.rules.filter((r) => r.key === 'over_budget') }),
        tenant.userId
      );
    });
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('counts each attempt and ends failed, instead of retrying for ever', async () => {
    expect(await inTenant(() => engine.queueDueNotifications(now))).toBe(1);
    const row = () =>
      inTenant(() =>
        getDb().selectFrom('notifications').select(['status', 'retry_count', 'max_retries']).executeTakeFirstOrThrow()
      );
    const seen = [];
    for (let i = 0; i < 6; i++) {
      await engine.processNotificationQueue(tenant.tenantId, now);
      seen.push(await row());
    }
    const maxRetries = seen[0].max_retries ?? 3;
    expect(seen.map((r) => r.retry_count).slice(0, maxRetries)).toEqual(Array.from({ length: maxRetries }, (_, i) => i + 1));
    expect(seen.at(-1)?.status).toBe('failed');
    expect(email.sendEmailWithRetry.mock.calls.length).toBe(maxRetries);
  });
});

describe('An import where one account fails', () => {
  const stamp = Date.now();
  let tenant: TestTenant;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    tenant = await createTestTenant('Savepoints: failing import account');
    for (const id of [`ACT1-${stamp}`, `ACT2-${stamp}`]) {
      ids[id] = (
        await tenant.pool.query(
          `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled)
           VALUES ($1, 'checking', 'cash', 'Asset', $1, 'simplefin', true) RETURNING id`,
          [id]
        )
      ).rows[0].id;
    }
    // An import user lets the import create the month's budget period (the ledger's own
    // setting).
    await tenant.pool.query(
      `INSERT INTO tenant_settings (setting_key, setting_value) VALUES ('import_user_id', $1)`,
      [String(tenant.userId)]
    );
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await tenant?.cleanup();
  });

  it("still imports the other accounts' transactions into the month's budget period", async () => {
    // The first account creates the period, then fails, which rolls the period back.
    const original = BalanceRebalanceService.prototype.checkAndRebalanceAccount;
    vi.spyOn(BalanceRebalanceService.prototype, 'checkAndRebalanceAccount').mockImplementation(async function (
      this: BalanceRebalanceService,
      accountId: number,
      ...rest: unknown[]
    ) {
      if (accountId === ids[`ACT1-${stamp}`]) throw new Error('rebalance failed');
      return (original as (...args: unknown[]) => Promise<boolean>).call(this, accountId, ...rest);
    } as never);
    const service = new ImportService(globalPool);
    const posted = Math.floor(Date.now() / 1000) - 3600;
    const tx = (id: string, amount: string) => ({ id: `${id}-${stamp}`, posted, amount, description: `Import ${id}` });
    vi.spyOn(service, 'fetchAccounts').mockResolvedValue({
      errors: [],
      errlist: [],
      connections: [],
      accounts: [
        { id: `ACT1-${stamp}`, name: 'A1', currency: 'USD', balance: '-30.00', 'balance-date': posted, transactions: [tx('A', '-10.00'), tx('B', '-20.00')] },
        { id: `ACT2-${stamp}`, name: 'A2', currency: 'USD', balance: '-5.00', 'balance-date': posted, transactions: [tx('C', '-5.00')] },
      ],
    } as never);

    await service.runFullSync(tenant.tenantId, { syncType: 'manual', syncTrigger: 'user', userId: tenant.userId });

    const imported = (
      await tenant.pool.query('SELECT import_transaction_id, budget_period_id FROM transactions ORDER BY 1')
    ).rows;
    expect(imported.map((r) => r.import_transaction_id)).toEqual([`C-${stamp}`]);
    expect(imported[0].budget_period_id).not.toBeNull();
  });
});

describe('A single-account sync that hits a database error', () => {
  const stamp = Date.now();
  let tenant: TestTenant;
  let accountUuid = '';

  beforeAll(async () => {
    tenant = await createTestTenant('Savepoints: failing single-account sync');
    accountUuid = (
      await tenant.pool.query(
        `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled)
         VALUES ($1, 'checking', 'cash', 'Asset', $1, 'simplefin', true) RETURNING uuid`,
        [`ONE-${stamp}`]
      )
    ).rows[0].uuid;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await tenant?.cleanup();
  });

  it('answers a failed sync and records it, instead of aborting the request', async () => {
    const service = new ImportService(globalPool);
    const posted = Math.floor(Date.now() / 1000) - 3600;
    // A balance numeric(12,2) can't hold: the account's sync fails in the database.
    vi.spyOn(service, 'fetchAccounts').mockResolvedValue({
      errors: [],
      errlist: [],
      connections: [],
      accounts: [{ id: `ONE-${stamp}`, name: 'One', currency: 'IDR', balance: '99999999999.00', 'balance-date': posted, transactions: [] }],
    } as never);

    const result = await service.runSingleAccountSync(tenant.tenantId, accountUuid, { syncType: 'manual', syncTrigger: 'user', userId: tenant.userId });

    expect(result.success).toBe(false);
    const log = (await tenant.pool.query('SELECT sync_status FROM import_sync_log')).rows;
    expect(log).toEqual([{ sync_status: 'failed' }]);
  });
});

describe('Bulk prices with one bad record', () => {
  let tenant: TestTenant;
  let securityUuid = '';
  const app = express();

  beforeAll(async () => {
    tenant = await createTestTenant('Savepoints: bulk prices');
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    securityUuid = (
      await tenant.pool.query(`INSERT INTO securities (name, ticker) VALUES ('Test Fund', $1) RETURNING uuid`, [`TS${Date.now() % 100000}`])
    ).rows[0].uuid;
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('keeps the good records, as the route promises', async () => {
    const res = await request(app)
      .post('/api/investments/prices/bulk')
      .send({
        prices: [
          { security_uuid: securityUuid, price_date: '2026-10-01', close: 10 },
          { security_uuid: securityUuid, price_date: 'not-a-date', close: 11 },
          { security_uuid: securityUuid, price_date: '2026-10-02', close: 12 },
        ],
      })
      .expect(200);
    expect(res.body).toMatchObject({ total: 3, succeeded: 2 });
    const saved = (
      await tenant.pool.query(
        'SELECT price_date::text FROM security_prices sp JOIN securities s ON s.id = sp.security_id WHERE s.uuid = $1 ORDER BY 1',
        [securityUuid]
      )
    ).rows.map((r) => r.price_date);
    expect(saved).toEqual(['2026-10-01', '2026-10-02']);
  });
});
