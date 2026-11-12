import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { answerProblem, defaultBillNotificationRules, queuedNotificationDataSchemas } from '@nuggets/shared';
import { globalDb, withTenant, getDb } from '../../../db/withTenant.js';
import { NotificationRulesEngine } from '../../../services/NotificationRulesEngine.js';
import { NotificationQueueService } from '../../../services/NotificationQueueService.js';
import { EmailTemplateService } from '../../../services/EmailTemplateService.js';
import { NotificationRuleService } from '../../../services/notifications/NotificationRuleService.js';
import { addDays } from '../../../services/notifications/schedule.js';
import { DEFAULT_APP_TIMEZONE } from '../../../utils/appDate.js';
import { calendarDateIn } from '../../../utils/calendarDate.js';
import type { EmailDeliveryService } from '../../../services/EmailDeliveryService.js';
import type { PushNotificationService } from '../../../services/PushNotificationService.js';
import { fixtureAccountId } from '../../../test/fixtureAccount.js';

/**
 * The default bill reminders through the rules engine, in a tenant of its own:
 * a monthly bill due in two days and nothing paid queues "A bill due soon"
 * once per person and due date, and the email names the bill. Once a payment
 * arrives, a reminder still queued for it doesn't go.
 */
describe('NotificationRulesEngine bill reminders (database)', () => {
  const now = new Date();
  // The engine reads the application time zone; the test DB has the seeded default (UTC).
  const today = calendarDateIn(DEFAULT_APP_TIMEZONE, now);
  const due = addDays(today, 2);
  const stamp = Date.now();

  let tenantId: number;
  let organizationId: number;
  let userId: number;
  let billId: number;

  const ruleService = new NotificationRuleService(async () => 'a-test-secret-that-is-at-least-32-chars');
  const push = { sendToUser: vi.fn().mockResolvedValue({ sent: 0, failed: 0, removed: 0 }) };
  const email = {
    isConfigured: vi.fn().mockResolvedValue(true),
    sendEmailWithRetry: vi.fn().mockResolvedValue('msg-1'),
  };
  const engine = new NotificationRulesEngine(
    new NotificationQueueService(),
    new EmailTemplateService(),
    email as unknown as EmailDeliveryService,
    push as unknown as PushNotificationService,
    ruleService
  );
  const inTenant = <T>(fn: () => Promise<T>) => withTenant(tenantId, fn);
  const deliveries = () => inTenant(() => getDb()
    .selectFrom('notification_deliveries')
    .select(['rule_key', 'subject_key'])
    .where('tenant_id', '=', tenantId)
    .execute());

  beforeAll(async () => {
    organizationId = (await globalDb.insertInto('organizations').values({ name: `Bill reminders org ${stamp}` }).returning('id').executeTakeFirstOrThrow()).id;
    tenantId = (await globalDb.insertInto('tenants').values({ name: `Bill reminders ${stamp}`, organization_id: organizationId }).returning('id').executeTakeFirstOrThrow()).id;
    userId = (await globalDb.insertInto('users').values({ email: `bill-reminders-${stamp}@test.local`, password_hash: 'x', first_name: 'Pat' }).returning('id').executeTakeFirstOrThrow()).id;
    await globalDb.insertInto('tenant_users').values({ tenant_id: tenantId, user_id: userId }).execute();

    await inTenant(async () => {
      billId = (await getDb().insertInto('budget_items')
        .values({
          name: `Water ${stamp}`, expense_type: 'Expense', type: 'Monthly', subtype: 'Fixed', isbill: true,
          recurring_payment: true, recurring_payment_amount: '45.00', recurring_payment_frequency: 1, recurring_next_payment_date: due,
        })
        .returning('id')
        .executeTakeFirstOrThrow()).id;
      await ruleService.saveRules({ rules: defaultBillNotificationRules }, userId);
    });
  });

  afterAll(async () => {
    await inTenant(async () => {
      await getDb().deleteFrom('notifications').where('tenant_id', '=', tenantId).execute();
      await getDb().deleteFrom('bill_occurrence_transactions').where('tenant_id', '=', tenantId).execute();
      await getDb().deleteFrom('bill_occurrences').where('tenant_id', '=', tenantId).execute();
      await getDb().deleteFrom('transactions').where('tenant_id', '=', tenantId).execute();
      await getDb().deleteFrom('accounts').where('tenant_id', '=', tenantId).execute();
      await getDb().deleteFrom('budget_items').where('tenant_id', '=', tenantId).execute();
    });
    await globalDb.deleteFrom('tenant_users').where('tenant_id', '=', tenantId).execute();
    await globalDb.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await globalDb.deleteFrom('organizations').where('id', '=', organizationId).execute();
    await globalDb.deleteFrom('users').where('id', '=', userId).execute();
  });

  it('queues "a bill due soon" once for the due date, and sends it naming the bill', async () => {
    expect(await inTenant(() => engine.queueDueNotifications(now))).toBe(1);
    // What it names is what the history's answer reads for a bill.
    const [queued] = await inTenant(() => getDb().selectFrom('notifications').select(['notification_type', 'template_data']).execute());
    expect(queued?.notification_type).toBe('bill');
    expect(answerProblem(queuedNotificationDataSchemas.bill, queued?.template_data)).toBeNull();
    const occurrence = await inTenant(() => getDb().selectFrom('bill_occurrences').select('uuid').where('budget_item_id', '=', billId).where('due_date', '=', due as never).executeTakeFirstOrThrow());
    expect(await deliveries()).toEqual([{ rule_key: 'bill_due_soon', subject_key: `bill:${occurrence.uuid}` }]);
    expect(await inTenant(() => engine.queueDueNotifications(now))).toBe(0);

    expect(await engine.processNotificationQueue(tenantId, now)).toMatchObject({ sent: 1 });
    expect(email.sendEmailWithRetry).toHaveBeenCalledWith(
      `bill-reminders-${stamp}@test.local`,
      `A bill due soon: Water ${stamp}`,
      expect.stringContaining('No payment has come in for it yet.'),
      expect.any(String),
      expect.any(Number),
      expect.any(Object),
    );
  });

  it("doesn't send a queued reminder once the bill is paid", async () => {
    // Queue the overdue reminder by hand, as if it had been due, then pay the bill.
    await inTenant(async () => {
      const occurrence = await getDb().selectFrom('bill_occurrences').select('uuid').where('budget_item_id', '=', billId).where('due_date', '=', due as never).executeTakeFirstOrThrow();
      await getDb().insertInto('notifications')
        .values({ user_id: userId, recipient_email: 'x@test.local', notification_type: 'bill', subject: 'x', template_data: JSON.stringify({ rule: 'bill_due_soon', occurrence: occurrence.uuid }), rule_key: 'bill_due_soon', status: 'pending' })
        .execute();
      await getDb().insertInto('transactions').values({ account_id: await fixtureAccountId(getDb()), type: 'expense', amount: '-45.00', transaction_date: today, budget_item_id: billId }).execute();
    });
    email.sendEmailWithRetry.mockClear();
    expect(await engine.processNotificationQueue(tenantId, now)).toMatchObject({ sent: 0, failed: 1 });
    expect(email.sendEmailWithRetry).not.toHaveBeenCalled();
  });
});
