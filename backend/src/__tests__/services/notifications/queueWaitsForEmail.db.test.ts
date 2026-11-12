import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { defaultNotificationRules, notificationRulesSchema } from '@nuggets/shared';
import { globalDb, withTenant, getDb } from '../../../db/withTenant.js';
import { NotificationRulesEngine } from '../../../services/NotificationRulesEngine.js';
import { NotificationQueueService } from '../../../services/NotificationQueueService.js';
import { EmailTemplateService } from '../../../services/EmailTemplateService.js';
import { NotificationRuleService } from '../../../services/notifications/NotificationRuleService.js';
import { addDays } from '../../../services/notifications/schedule.js';
import { DEFAULT_APP_TIMEZONE } from '../../../utils/appDate.js';
import { calendarDateIn } from '../../../utils/calendarDate.js';
import { SmtpNotConfiguredError, type EmailDeliveryService } from '../../../services/EmailDeliveryService.js';
import type { PushNotificationService } from '../../../services/PushNotificationService.js';
import { createTestTenant, type TestTenant } from '../../../test/testTenant.js';
import { fixtureAccountId } from '../../../test/fixtureAccount.js';

/**
 * A notification queued to go by email, while SMTP isn't set up (its settings cleared
 * after it was queued, or refused as not set up when it went), waits for it: it
 * stays pending without counting an attempt, out of the way of the rest of the queue for
 * a while, and goes on the first pass after an admin sets SMTP up. It used to be marked
 * failed for good ("What this notification was about had changed"), or to spend its
 * attempts on a refusal that could only repeat, and was never sent once SMTP was fixed.
 */
describe('A queued email while SMTP is not set up', () => {
  const now = new Date();
  const today = calendarDateIn(DEFAULT_APP_TIMEZONE, now);
  let tenant: TestTenant;
  const ruleService = new NotificationRuleService(async () => 'a-test-secret-that-is-at-least-32-chars');
  const push = { sendToUser: vi.fn() };
  const email = { isConfigured: vi.fn(), sendEmailWithRetry: vi.fn() };
  const engine = new NotificationRulesEngine(
    new NotificationQueueService(),
    new EmailTemplateService(),
    email as unknown as EmailDeliveryService,
    push as unknown as PushNotificationService,
    ruleService
  );
  const inTenant = <T>(fn: () => Promise<T>) => withTenant(tenant.tenantId, fn);

  type Row = { status: string; retry_count: number; error_message: string | null; later: boolean };
  const row = async (): Promise<Row> =>
    (
      await tenant.pool.query<Row>(
        'SELECT status, retry_count, error_message, scheduled_for > now() AS later FROM notifications ORDER BY id DESC LIMIT 1'
      )
    ).rows[0];
  /** As if the wait had run out: due again. */
  const waitRunsOut = () => tenant.pool.query("UPDATE notifications SET scheduled_for = now() - interval '1 minute'");

  beforeAll(async () => {
    tenant = await createTestTenant('Queued email waits for SMTP');
    await inTenant(async () => {
      const db = getDb();
      const period = await db
        .insertInto('budget_period')
        .values({ name: `Wait ${Date.now()}`, month: 'Test', year: 2026, month_number: 1, start_date: addDays(today, -9), end_date: addDays(today, 20) })
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

  // Each test queues the one notification afresh, while email is set up. The member has
  // the default choice (email and push) and no push device: email is the only way it goes.
  beforeEach(async () => {
    await tenant.pool.query('DELETE FROM notifications');
    await tenant.pool.query('DELETE FROM notification_deliveries');
    email.isConfigured.mockReset().mockResolvedValue(true);
    email.sendEmailWithRetry.mockReset().mockResolvedValue('msg-1');
    push.sendToUser.mockReset().mockResolvedValue({ sent: 0, failed: 0, removed: 0 });
    expect(await inTenant(() => engine.queueDueNotifications(now))).toBe(1);
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('waits, without counting an attempt, and goes once SMTP is set up', async () => {
    email.isConfigured.mockResolvedValue(false);
    await engine.processNotificationQueue(tenant.tenantId, now);

    expect(email.sendEmailWithRetry).not.toHaveBeenCalled();
    expect(await row()).toEqual({ status: 'pending', retry_count: 0, error_message: 'Waiting for email to be set up', later: true });

    // Out of the way for a while: the next pass doesn't take it again.
    expect(await engine.processNotificationQueue(tenant.tenantId, now)).toMatchObject({ processed: 0 });

    // Still not set up when its wait runs out: it waits again, still uncounted.
    await waitRunsOut();
    await engine.processNotificationQueue(tenant.tenantId, now);
    expect(await row()).toMatchObject({ status: 'pending', retry_count: 0, later: true });

    // An admin sets SMTP up; the first pass after the wait sends it.
    email.isConfigured.mockResolvedValue(true);
    await waitRunsOut();
    expect(await engine.processNotificationQueue(tenant.tenantId, now)).toMatchObject({ processed: 1, sent: 1 });
    expect(email.sendEmailWithRetry).toHaveBeenCalledTimes(1);
    expect(await row()).toMatchObject({ status: 'sent', retry_count: 1, error_message: null });
  });

  it('waits the same when the send is refused as not set up (SMTP cleared while it was being sent)', async () => {
    email.sendEmailWithRetry.mockRejectedValueOnce(new SmtpNotConfiguredError("Email isn't set up yet."));
    expect(await engine.processNotificationQueue(tenant.tenantId, now)).toMatchObject({ processed: 1, sent: 0 });

    // The refused attempt isn't one of its three.
    expect(await row()).toEqual({ status: 'pending', retry_count: 0, error_message: 'Waiting for email to be set up', later: true });

    await waitRunsOut();
    expect(await engine.processNotificationQueue(tenant.tenantId, now)).toMatchObject({ processed: 1, sent: 1 });
    expect(await row()).toMatchObject({ status: 'sent', retry_count: 1, error_message: null });
  });

  it('waits up to a week from when it was queued, then fails, not sent weeks late', async () => {
    email.isConfigured.mockResolvedValue(false);
    await tenant.pool.query("UPDATE notifications SET created_at = now() - interval '6 days'");
    await engine.processNotificationQueue(tenant.tenantId, now);
    expect(await row()).toMatchObject({ status: 'pending', retry_count: 0, error_message: 'Waiting for email to be set up' });

    await tenant.pool.query("UPDATE notifications SET created_at = now() - interval '8 days'");
    await waitRunsOut();
    expect(await engine.processNotificationQueue(tenant.tenantId, now)).toMatchObject({ processed: 1, sent: 0, failed: 1 });
    expect(await row()).toEqual({ status: 'failed', retry_count: 0, error_message: "Not sent: email wasn't set up in time", later: false });

    // Set up afterwards, it isn't sent.
    email.isConfigured.mockResolvedValue(true);
    await waitRunsOut();
    expect(await engine.processNotificationQueue(tenant.tenantId, now)).toMatchObject({ processed: 0 });
    expect(email.sendEmailWithRetry).not.toHaveBeenCalled();
  });

  it('goes by push instead, without waiting, to someone with a push device', async () => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/wait-for-email-${Date.now()}`;
    await globalDb.insertInto('push_subscriptions').values({ user_id: tenant.userId, endpoint, keys_encrypted: 'x' }).execute();
    try {
      email.isConfigured.mockResolvedValue(false);
      push.sendToUser.mockResolvedValue({ sent: 1, failed: 0, removed: 0 });
      expect(await engine.processNotificationQueue(tenant.tenantId, now)).toMatchObject({ processed: 1, sent: 1 });
      expect(push.sendToUser).toHaveBeenCalledTimes(1);
      expect(email.sendEmailWithRetry).not.toHaveBeenCalled();
      expect(await row()).toMatchObject({ status: 'sent' });
    } finally {
      await globalDb.deleteFrom('push_subscriptions').where('endpoint', '=', endpoint).execute();
    }
  });

  it("doesn't wait when what it was about has changed: that fails as before", async () => {
    email.isConfigured.mockResolvedValue(false);
    await inTenant(() => ruleService.saveRules(notificationRulesSchema.parse({ rules: [] }), tenant.userId));
    try {
      await engine.processNotificationQueue(tenant.tenantId, now);
      expect(await row()).toMatchObject({ status: 'failed', error_message: 'What this notification was about had changed before it could go' });
    } finally {
      await inTenant(() =>
        ruleService.saveRules(
          notificationRulesSchema.parse({ rules: defaultNotificationRules.rules.filter((r) => r.key === 'over_budget') }),
          tenant.userId
        )
      );
    }
  });
});
