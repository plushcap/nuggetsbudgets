import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { defaultNotificationRules, notificationRulesSchema } from '@nuggets/shared';
import { withTenant, getDb, inTenantTransaction } from '../../../db/withTenant.js';
import { NotificationRulesEngine } from '../../../services/NotificationRulesEngine.js';
import { NotificationQueueService } from '../../../services/NotificationQueueService.js';
import { EmailTemplateService } from '../../../services/EmailTemplateService.js';
import { NotificationRuleService } from '../../../services/notifications/NotificationRuleService.js';
import { addDays } from '../../../services/notifications/schedule.js';
import { appDateOf } from '../../../utils/appDate.js';
import type { EmailDeliveryService } from '../../../services/EmailDeliveryService.js';
import type { PushNotificationService } from '../../../services/PushNotificationService.js';
import { createTestTenant, type TestTenant } from '../../../test/testTenant.js';
import { fixtureAccountId } from '../../../test/fixtureAccount.js';

/**
 * Sending a notification is network I/O (SMTP, push services), so it must not run while
 * a tenant transaction holds a pooled connection and the claimed rows. The queue
 * claims in one short transaction, sends with none open, and records the result in
 * another; a claim whose sender stopped is claimed again once its lease runs out.
 */
describe('Notification queue transactions', () => {
  const now = new Date();
  let tenant: TestTenant;
  const ruleService = new NotificationRuleService(async () => 'a-test-secret-that-is-at-least-32-chars');
  const push = { sendToUser: vi.fn().mockResolvedValue({ sent: 0, failed: 0, removed: 0 }) };
  const email = { isConfigured: vi.fn().mockResolvedValue(true), sendEmailWithRetry: vi.fn() };
  const engine = new NotificationRulesEngine(
    new NotificationQueueService(),
    new EmailTemplateService(),
    email as unknown as EmailDeliveryService,
    push as unknown as PushNotificationService,
    ruleService
  );
  const inTenant = <T>(fn: () => Promise<T>) => withTenant(tenant.tenantId, fn);
  const statuses = async () =>
    (await tenant.pool.query<{ status: string }>('SELECT status FROM notifications ORDER BY id')).rows.map((r) => r.status);

  beforeAll(async () => {
    tenant = await createTestTenant('Notification queue transactions');
    await inTenant(async () => {
      const db = getDb();
      // The engine's day at `now`, in the ledger's time zone as the engine reads it.
      const today = await appDateOf(now);
      const period = await db
        .insertInto('budget_period')
        .values({ name: `Queue ${Date.now()}`, month: 'Test', year: 2026, month_number: 1, start_date: addDays(today, -9), end_date: addDays(today, 20) })
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
    expect(await inTenant(() => engine.queueDueNotifications(now))).toBe(1);
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('sends with no transaction open, once the claim is committed', async () => {
    let seenDuringSend: { inTransaction: boolean; statuses: string[] } | undefined;
    email.sendEmailWithRetry.mockImplementationOnce(async () => {
      seenDuringSend = { inTransaction: inTenantTransaction(), statuses: await statuses() };
      return 'msg-1';
    });

    expect(await engine.processNotificationQueue(tenant.tenantId, now)).toMatchObject({ processed: 1, sent: 1 });
    // Another connection sees the claim while the email goes.
    expect(seenDuringSend).toEqual({ inTransaction: false, statuses: ['processing'] });
    expect(await statuses()).toEqual(['sent']);
  });

  it('claims again a send that stopped before recording its result, once the lease ran out', async () => {
    // A sender that stopped a minute ago may still be sending: leave it.
    await tenant.pool.query("UPDATE notifications SET status = 'processing', last_attempt_at = now() - interval '1 minute', retry_count = 0");
    email.sendEmailWithRetry.mockClear().mockResolvedValue('msg-2');
    expect(await engine.processNotificationQueue(tenant.tenantId, now)).toMatchObject({ processed: 0 });
    expect(email.sendEmailWithRetry).not.toHaveBeenCalled();

    // One that stopped 20 minutes ago lost its lease.
    await tenant.pool.query("UPDATE notifications SET last_attempt_at = now() - interval '20 minutes'");
    expect(await engine.processNotificationQueue(tenant.tenantId, now)).toMatchObject({ processed: 1, sent: 1 });
    expect(email.sendEmailWithRetry).toHaveBeenCalledTimes(1);
    expect(await statuses()).toEqual(['sent']);
  });

  it('refuses to run inside a transaction, whose uncommitted rows it could not see', async () => {
    await expect(inTenant(() => engine.processNotificationQueue(tenant.tenantId, now))).rejects.toThrow(/outside one/);
  });
});
