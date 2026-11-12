import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from 'vitest';
import { sql } from 'kysely';
import { answerProblem, defaultNotificationRules, notificationRulesSchema, queuedNotificationDataSchemas, type NotificationRules } from '@nuggets/shared';
import { globalDb, withTenant, getDb } from '../../../db/withTenant.js';
import { NotificationRulesEngine } from '../../../services/NotificationRulesEngine.js';
import { NotificationQueueService } from '../../../services/NotificationQueueService.js';
import { EmailTemplateService } from '../../../services/EmailTemplateService.js';
import { NotificationRuleError, NotificationRuleService } from '../../../services/notifications/NotificationRuleService.js';
import { addDays, weekdayOf } from '../../../services/notifications/schedule.js';
import { appLocalTime } from '../../../utils/appDate.js';
import type { EmailDeliveryService } from '../../../services/EmailDeliveryService.js';
import type { PushNotificationService } from '../../../services/PushNotificationService.js';
import { fixtureAccountId } from '../../../test/fixtureAccount.js';

/**
 * The rules engine end to end against Postgres: a tenant of its own with three
 * members, a budget period around today, an overspent and an on-track budget
 * item, a large purchase, and the default rules plus the two that start off.
 * Email and push are stubbed at the transport; templates render for real.
 *
 * The CI database role is a superuser, which bypasses RLS, so the test's own
 * writes and deletes name its tenant explicitly.
 */
describe('NotificationRulesEngine (database)', () => {
  // One instant for the whole file, passed to the engine wherever it takes one.
  const now = new Date();
  // The engine's day at `now`: in the application_timezone setting, read as the engine reads
  // it, not taken from the default zone, which the setting needn't be.
  let today = '';
  const stamp = Date.now();

  let tenantId: number;
  let organizationId: number;
  const users = { pat: 0, sam: 0, locked: 0 };
  let groceriesPeriodItem = '';
  let purchaseUuid = '';

  const ruleService = new NotificationRuleService(async () => 'a-test-secret-that-is-at-least-32-chars');
  const push = { sendToUser: vi.fn().mockResolvedValue({ sent: 1, failed: 0, removed: 0 }) };
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

  // Parsed as the API would, so fields left out (sendBy) take their defaults.
  const buildRules = (): NotificationRules => notificationRulesSchema.parse({
    rules: [
      ...defaultNotificationRules.rules.filter((rule) => rule.key === 'over_budget'),
      {
        key: 'review_reminder',
        label: 'Transactions waiting for review',
        enabled: true,
        kind: 'review_reminder',
        when: { fact: 'unreviewed_count', gte: 1 },
        everyDays: 3,
        // From midnight, so it's due whenever the test runs.
        hour: 0,
      },
      {
        key: 'large_purchase',
        label: 'A large purchase',
        enabled: true,
        kind: 'transaction',
        audience: 'assignee',
        when: { all: [{ fact: 'direction', is: 'out' }, { fact: 'size', gte: 500 }, { fact: 'merchant', hasWords: ['sample'] }] },
      },
      // Due from midnight today, so it's due whenever the test runs.
      { key: 'weekly_digest', label: 'The week in review', enabled: true, kind: 'digest', weekday: weekdayOf(today), hour: 0 },
    ],
  });

  async function deliveries() {
    return inTenant(() =>
      getDb()
        .selectFrom('notification_deliveries')
        .select(['rule_key', 'user_id', 'subject_key'])
        .where('tenant_id', '=', tenantId)
        .orderBy('rule_key')
        .execute()
    );
  }

  beforeAll(async () => {
    today = (await appLocalTime(now)).day;
    const organization = await globalDb.insertInto('organizations').values({ name: `Notify org ${stamp}` }).returning('id').executeTakeFirstOrThrow();
    organizationId = organization.id;
    const tenant = await globalDb.insertInto('tenants')
      .values({ name: `Notify tenant ${stamp}`, organization_id: organizationId })
      .returning('id')
      .executeTakeFirstOrThrow();
    tenantId = tenant.id;

    for (const [name, locked] of [['pat', false], ['sam', false], ['locked', true]] as const) {
      const user = await globalDb.insertInto('users')
        .values({ email: `${name}-${stamp}@test.local`, password_hash: 'x', first_name: name, is_locked: locked })
        .returning('id')
        .executeTakeFirstOrThrow();
      users[name] = user.id;
      await globalDb.insertInto('tenant_users').values({ tenant_id: tenantId, user_id: user.id }).execute();
    }

    await inTenant(async () => {
      const db = getDb();
      const period = await db.insertInto('budget_period')
        .values({
          name: `Test period ${stamp}`, month: 'Test', year: 2026, month_number: 1,
          start_date: addDays(today, -9), end_date: addDays(today, 20),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const addItem = async (name: string, budget: number, spent: number) => {
        const item = await db.insertInto('budget_items')
          .values({ name, expense_type: 'Expense', type: 'Monthly' })
          .returning(['id'])
          .executeTakeFirstOrThrow();
        const periodItem = await db.insertInto('budget_period_items')
          .values({ budget_period_id: period.id, budget_item_id: item.id })
          .returning(['id', 'uuid'])
          .executeTakeFirstOrThrow();
        // Budgets are event-sourced: the budget is an 'add' event, not a stored figure.
        await db.insertInto('budget_period_transactions')
          .values({ budget_period_item_id: periodItem.id, budget_item_id: item.id, transaction_type: 'add', type: 'budget_update', amount: budget.toFixed(2) })
          .execute();
        await db.insertInto('transactions')
          .values({
            account_id: await fixtureAccountId(db),
            type: 'expense', amount: (-spent).toFixed(2), transaction_date: today, budget_item_id: item.id,
            budget_period_id: period.id, budget_period_item_id: periodItem.id, review_status: 'reviewed',
          })
          .execute();
        return periodItem.uuid;
      };
      groceriesPeriodItem = await addItem('Groceries', 500, 650);
      await addItem('Dining', 300, 100);

      const merchant = await db.insertInto('merchants').values({ name: 'Sample Wholesale' }).returning('id').executeTakeFirstOrThrow();
      const purchase = await db.insertInto('transactions')
        .values({
          account_id: await fixtureAccountId(db),
          type: 'expense', amount: '-812.40', transaction_date: today, merchant_id: merchant.id,
          assigned_to: users.pat, review_status: 'needs review', description: 'SAMPLE WHSE ' + '#' + '123',
        })
        .returning('uuid')
        .executeTakeFirstOrThrow();
      purchaseUuid = purchase.uuid;

      await ruleService.saveRules(buildRules(), users.pat);
      // Sam turns the overspending alert off on both channels.
      await ruleService.setPreferences(users.sam, { rules: [{ rule: 'over_budget', email: false, push: false }] }, true);
    });
  });

  afterAll(async () => {
    await inTenant(async () => {
      const db = getDb();
      await db.deleteFrom('notifications').where('tenant_id', '=', tenantId).execute();
      await db.deleteFrom('transactions').where('tenant_id', '=', tenantId).execute();
      await db.deleteFrom('accounts').where('tenant_id', '=', tenantId).execute();
      await db.deleteFrom('budget_period_transactions').where('tenant_id', '=', tenantId).execute();
      await db.deleteFrom('budget_period_items').where('tenant_id', '=', tenantId).execute();
      await db.deleteFrom('budget_items').where('tenant_id', '=', tenantId).execute();
      await db.deleteFrom('budget_period').where('tenant_id', '=', tenantId).execute();
      await db.deleteFrom('merchants').where('tenant_id', '=', tenantId).execute();
    });
    await globalDb.deleteFrom('tenant_users').where('tenant_id', '=', tenantId).execute();
    await globalDb.deleteFrom('tenants').where('id', '=', tenantId).execute(); // cascades the notification tables
    await globalDb.deleteFrom('organizations').where('id', '=', organizationId).execute();
    await globalDb.deleteFrom('users').where('id', 'in', Object.values(users)).execute();
  });

  it('queues one notification per rule, person and subject, for the people each rule reaches', async () => {
    const queued = await inTenant(() => engine.queueDueNotifications(now));

    const rows = await deliveries();
    const forPat = rows.filter((row) => row.user_id === users.pat).map((row) => row.rule_key);
    const forSam = rows.filter((row) => row.user_id === users.sam).map((row) => row.rule_key);

    // Pat: overspent Groceries (pre-signed amounts: -650 against a 500 budget),
    // the Sample Wholesale purchase assigned to them, their review backlog, the digest.
    expect(forPat).toEqual(['large_purchase', 'over_budget', 'review_reminder', 'weekly_digest']);
    expect(rows).toContainEqual({ rule_key: 'over_budget', user_id: users.pat, subject_key: `budget_item:${groceriesPeriodItem}` });
    expect(rows).toContainEqual({ rule_key: 'large_purchase', user_id: users.pat, subject_key: `transaction:${purchaseUuid}` });
    // Sam turned over_budget off, has nothing to review, and isn't the purchase's assignee.
    expect(forSam).toEqual(['weekly_digest']);
    // A locked account gets nothing.
    expect(rows.some((row) => row.user_id === users.locked)).toBe(false);
    expect(queued).toBe(5);

    // What each queued notification names is exactly what the history's answer reads for its
    // kind: queuedNotificationDataSchemas, strict.
    const stored = await inTenant(() => getDb().selectFrom('notifications').select(['notification_type', 'template_data']).execute());
    expect(new Set(stored.map((row) => row.notification_type))).toEqual(new Set(['budget_item', 'transaction', 'review_reminder', 'digest']));
    for (const row of stored) {
      const schema = queuedNotificationDataSchemas[row.notification_type as keyof typeof queuedNotificationDataSchemas];
      expect(answerProblem(schema, row.template_data), row.notification_type).toBeNull();
    }
  });

  it('queues nothing new on the next run', async () => {
    expect(await inTenant(() => engine.queueDueNotifications(now))).toBe(0);
  });

  it('reminds about the review backlog at most once every everyDays days, measured from the last one', async () => {
    const reviewDeliveries = async () => (await deliveries()).filter((row) => row.rule_key === 'review_reminder' && row.user_id === users.pat);
    const later = (hours: number) => new Date(now.getTime() + hours * 3_600_000);

    // A day, then two days later: still inside three days of the first.
    await inTenant(() => engine.queueDueNotifications(later(24)));
    await inTenant(() => engine.queueDueNotifications(later(48)));
    expect(await reviewDeliveries()).toHaveLength(1);

    // Three days on, it's due again.
    await inTenant(() => engine.queueDueNotifications(later(72)));
    expect(await reviewDeliveries()).toHaveLength(2);
    await inTenant(() => getDb().deleteFrom('notifications').where('tenant_id', '=', tenantId).where('rule_key', '=', 'review_reminder').where('status', '=', 'pending').execute());
  });

  it('sends each by push and by email, built when it goes, with a working unsubscribe link', async () => {
    await engine.processNotificationQueue(tenantId, now);
    await engine.processNotificationQueue(tenantId, now);

    const sent = await inTenant(() =>
      getDb().selectFrom('notifications').select(['user_id', 'rule_key', 'status', 'subject'])
        .where('tenant_id', '=', tenantId).orderBy('id').execute()
    );
    expect(sent.every((row) => row.status === 'sent')).toBe(true);
    expect(sent).toContainEqual({ user_id: users.pat, rule_key: 'over_budget', status: 'sent', subject: 'A budget item over budget: Groceries' });
    expect(sent).toContainEqual({ user_id: users.pat, rule_key: 'large_purchase', status: 'sent', subject: 'A large purchase: $812.40 at Sample Wholesale' });

    expect(push.sendToUser).toHaveBeenCalledWith(users.pat, expect.objectContaining({
      title: 'A budget item over budget: Groceries',
      body: "$650.00 of $500.00. That's $150.00 over budget.",
      url: expect.stringMatching(/^\/budget-items\/.+\/view$/),
    }));

    const overBudgetEmail = email.sendEmailWithRetry.mock.calls.find(([, subject]) => subject === 'A budget item over budget: Groceries');
    expect(overBudgetEmail?.[0]).toBe(`pat-${stamp}@test.local`);
    const html = String(overBudgetEmail?.[2]);
    expect(html).toContain('Groceries has spent $650.00 of its $500.00 budget (130%)');
    // The text part is composed, not stripped from the HTML: readable, with both links.
    const text = String(overBudgetEmail?.[3]);
    expect(text).toContain("That's $150.00 over budget.");
    expect(text).toMatch(/Open the budget item:\nhttp:\/\/[^\n]+\/budget-items\/.+\/view/);
    expect(text).toContain('/unsubscribe#');
    expect(overBudgetEmail?.[5]).toEqual({ 'List-Unsubscribe': expect.stringMatching(/^<http.+\/unsubscribe#.+>$/) });
    const token = html.match(/\/unsubscribe#([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeDefined();

    expect(await ruleService.inspectUnsubscribeLink(token!)).toEqual({ label: 'A budget item over budget' });
    expect(await ruleService.unsubscribe(token!)).toEqual({ label: 'A budget item over budget' });
    const choices = await inTenant(() => ruleService.choicesOf(users.pat));
    // The link stops email only; push stays on.
    expect(choices.get(`${users.pat}:over_budget`)).toEqual({ email: false, push: true });

    const [payload, signature] = token!.split('.');
    await expect(ruleService.unsubscribe(`${payload}.${signature.slice(0, -2)}xx`)).rejects.toMatchObject({ status: 404 });
    await expect(ruleService.inspectUnsubscribeLink(token!, new Date(now.getTime() + 61 * 86_400_000))).rejects.toBeInstanceOf(NotificationRuleError);
  });

  it("doesn't send what stopped matching after it was queued", async () => {
    await inTenant(async () => {
      const db = getDb();
      // Re-arm the purchase for Pat: a new delivery subject by deleting the old record.
      await db.deleteFrom('notification_deliveries').where('tenant_id', '=', tenantId).where('rule_key', '=', 'large_purchase').execute();
      expect(await engine.queueDueNotifications(now)).toBe(1);
      // Reassigned to Sam before it goes; the rule is for the assignee.
      await db.updateTable('transactions').set({ assigned_to: users.sam }).where('uuid', '=', purchaseUuid).execute();
    });
    await engine.processNotificationQueue(tenantId, now);

    const last = await inTenant(() =>
      getDb().selectFrom('notifications').select(['status', 'error_message'])
        .where('tenant_id', '=', tenantId).where('rule_key', '=', 'large_purchase').orderBy('id', 'desc').executeTakeFirstOrThrow()
    );
    expect(last).toEqual({ status: 'failed', error_message: 'What this notification was about had changed before it could go' });
  });

  // error_message is in the notification history members read. It kept the mailer's
  // own text (the SMTP server's reply, its host); now it says what to check.
  it("records why a notification couldn't go in words to act on, not the mail server's reply", async () => {
    await inTenant(async () => {
      await getDb().deleteFrom('notification_deliveries').where('tenant_id', '=', tenantId).where('rule_key', '=', 'large_purchase').execute();
      expect(await engine.queueDueNotifications(now)).toBeGreaterThanOrEqual(1);
    });
    // No device takes the push, and the mail server refuses the sign-in.
    push.sendToUser.mockResolvedValue({ sent: 0, failed: 0, removed: 0 });
    email.sendEmailWithRetry.mockRejectedValue(
      Object.assign(new Error('Invalid login: 535 5.7.8 Authentication failed for internal_secret_xyz@smtp.internal'), { code: 'EAUTH' })
    );
    onTestFinished(() => {
      push.sendToUser.mockResolvedValue({ sent: 1, failed: 0, removed: 0 });
      email.sendEmailWithRetry.mockResolvedValue('msg-1');
    });
    await engine.processNotificationQueue(tenantId, now);

    const failed = await inTenant(() =>
      getDb().selectFrom('notifications').select(['error_message'])
        .where('tenant_id', '=', tenantId).where('rule_key', '=', 'large_purchase').where('error_message', 'is not', null)
        .orderBy('id', 'desc').execute()
    );
    expect(failed[0]?.error_message).toBe('The mail server refused the sign-in: check the SMTP username and password');
    expect(JSON.stringify(failed)).not.toContain('internal_secret_xyz');
  });

  it('keeps both of two changes to one rule made at the same time', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      await inTenant(() => getDb().deleteFrom('notification_preferences').where('tenant_id', '=', tenantId).where('user_id', '=', users.sam).where('rule_key', '=', 'weekly_digest').execute());
      // Separate transactions, as two requests would be.
      await Promise.all([
        inTenant(() => ruleService.setPreferences(users.sam, { rules: [{ rule: 'weekly_digest', email: false }] }, true)),
        inTenant(() => ruleService.setPreferences(users.sam, { rules: [{ rule: 'weekly_digest', push: false }] }, true)),
      ]);
      const choice = (await inTenant(() => ruleService.choicesOf(users.sam))).get(`${users.sam}:weekly_digest`);
      expect(choice).toEqual({ email: false, push: false });
    }
  });

  it("applies a person's default row to every rule they haven't set, including new ones", async () => {
    await inTenant(async () => {
      await getDb().insertInto('notification_preferences').values({ user_id: users.sam, rule_key: '*', email: false, push: true }).execute();
      const preferences = await ruleService.getPreferences(users.sam, true);
      // over_budget has Sam's own row (both off); the others follow the default.
      expect(preferences.rules.map(({ rule, email, push }) => ({ rule, email, push }))).toEqual([
        { rule: 'over_budget', email: false, push: false },
        { rule: 'review_reminder', email: false, push: true },
        { rule: 'large_purchase', email: false, push: true },
        { rule: 'weekly_digest', email: false, push: false },
      ]);
      // Turning one channel on for a rule starts that rule's row from the default.
      await ruleService.setPreferences(users.sam, { rules: [{ rule: 'large_purchase', email: true }] }, true);
      expect((await ruleService.choicesOf(users.sam)).get(`${users.sam}:large_purchase`)).toEqual({ email: true, push: true });
    });
  });

  it('sends a rule only by the channels it sends by, whatever people chose', async () => {
    email.sendEmailWithRetry.mockClear();
    push.sendToUser.mockClear();
    // A phone-only rule reaches only people with a phone registered.
    const endpoint = `https://fcm.googleapis.com/fcm/send/sendby-push-${Date.now()}`;
    await globalDb.insertInto('push_subscriptions').values({ user_id: users.pat, endpoint, keys_encrypted: 'x' }).execute();
    onTestFinished(() => globalDb.deleteFrom('push_subscriptions').where('endpoint', '=', endpoint).execute().then(() => undefined));
    await inTenant(async () => {
      const db = getDb();
      // The purchase goes to Pat again, by phone only.
      await db.updateTable('transactions').set({ assigned_to: users.pat }).where('uuid', '=', purchaseUuid).execute();
      await db.deleteFrom('notification_deliveries').where('tenant_id', '=', tenantId).where('rule_key', '=', 'large_purchase').execute();
      const current = await ruleService.readRules();
      await ruleService.saveRules({
        rules: current.rules.rules.map((rule) => (rule.key === 'large_purchase' ? { ...rule, sendBy: 'push' as const } : rule)),
      }, users.pat);

      expect((await ruleService.getPreferences(users.pat, true)).rules.find((rule) => rule.rule === 'large_purchase'))
        .toMatchObject({ sendBy: 'push', email: true, push: true });

      expect(await engine.queueDueNotifications(now)).toBe(1);
    });
    await engine.processNotificationQueue(tenantId, now);

    expect(push.sendToUser).toHaveBeenCalledWith(users.pat, expect.objectContaining({ title: 'A large purchase' }));
    expect(email.sendEmailWithRetry).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('A large purchase'), expect.anything(), expect.anything(), expect.anything(), expect.anything());
    const last = await inTenant(() =>
      getDb().selectFrom('notifications').select(['status', 'ses_message_id'])
        .where('tenant_id', '=', tenantId).where('rule_key', '=', 'large_purchase').orderBy('id', 'desc').executeTakeFirstOrThrow()
    );
    expect(last).toEqual({ status: 'sent', ses_message_id: null });
  });

  it('records nothing for an email-only rule when email is not set up, even for someone with a phone', async () => {
    await inTenant(async () => {
      await getDb().insertInto('notification_preferences').values({ user_id: users.pat, rule_key: 'weekly_digest', email: true, push: true })
        .onConflict((oc) => oc.constraint('notification_preferences_person_rule_key').doNothing()).execute();
      const current = await ruleService.readRules();
      await ruleService.saveRules({
        rules: current.rules.rules.map((rule) => (rule.key === 'weekly_digest' ? { ...rule, sendBy: 'email' as const } : rule)),
      }, users.pat);
      await getDb().deleteFrom('notification_deliveries').where('tenant_id', '=', tenantId).where('rule_key', '=', 'weekly_digest').execute();
    });
    // Pat has a push device; with no SMTP an email-only rule can't reach anyone.
    const endpoint = `https://fcm.googleapis.com/fcm/send/sendby-${Date.now()}`;
    await globalDb.insertInto('push_subscriptions').values({ user_id: users.pat, endpoint, keys_encrypted: 'x' }).execute();
    email.isConfigured.mockResolvedValueOnce(false);
    try {
      await inTenant(() => engine.queueDueNotifications(now));
      expect((await deliveries()).filter((row) => row.rule_key === 'weekly_digest')).toEqual([]);
    } finally {
      await globalDb.deleteFrom('push_subscriptions').where('endpoint', '=', endpoint).execute();
    }
  });

  it('keeps preferences to the tenant’s own rules', async () => {
    await expect(inTenant(() => ruleService.setPreferences(users.pat, { rules: [{ rule: 'nope', email: false }] }, true)))
      .rejects.toMatchObject({ status: 400, message: 'There is no notification “nope”.' });
  });

  it('records nothing for a rule nobody can be reached by', async () => {
    email.isConfigured.mockResolvedValueOnce(false);
    await inTenant(async () => {
      await getDb().deleteFrom('notification_deliveries').where('tenant_id', '=', tenantId).execute();
      // No email and no push devices in this tenant: nothing may be recorded,
      // or turning a channel on later would never deliver these.
      expect(await engine.queueDueNotifications(now)).toBe(0);
    });
    expect(await deliveries()).toEqual([]);
  });

  it('falls back to the defaults, and to nothing for rules that no longer validate', async () => {
    await inTenant(async () => {
      await getDb().updateTable('notification_rule_sets').set({ rules: sql`'{"rules":[{"kind":"bogus"}]}'::jsonb` }).where('tenant_id', '=', tenantId).execute();
      expect(await ruleService.readRules()).toEqual({ rules: { rules: [] }, fits: false });
      await getDb().deleteFrom('notification_rule_sets').where('tenant_id', '=', tenantId).execute();
      expect(await ruleService.readRules()).toEqual({ rules: defaultNotificationRules, fits: true });
    });
  });
});
