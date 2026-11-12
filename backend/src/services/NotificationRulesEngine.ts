import type { QueuedNotificationData } from '@nuggets/shared';
import { sql } from 'kysely';
import type { MoneyFormat, NotificationRule } from '@nuggets/shared';
import { getDb, globalDb, inTenantTransaction, withSavepoint, withTenant } from '../db/withTenant.js';
import { NotificationQueueService, type QueuedNotification } from './NotificationQueueService.js';
import { EmailTemplateService } from './EmailTemplateService.js';
import { EmailDeliveryService, SmtpNotConfiguredError, isPermanentMailError, mailErrorFields, mailFailureReason } from './EmailDeliveryService.js';
import { ControlPlaneError } from './controlPlaneErrors.js';
import { PushNotificationService } from './PushNotificationService.js';
import { readSystemSetting, updateSystemSetting } from './systemSettings.js';
import { NotificationRuleService, type Choice } from './notifications/NotificationRuleService.js';
import { evaluate, type Facts } from './notifications/conditions.js';
import {
  loadBudgetItemSubjects,
  loadReviewFacts,
  loadTransactionSubjects,
  loadWeekSummary,
  type BudgetItemSubject,
  type TransactionSubject,
} from './notifications/facts.js';
import {
  billMessage,
  budgetItemMessage,
  digestMessage,
  plainText,
  reviewReminderMessage,
  transactionMessage,
  type MessageContent,
} from './notifications/messages.js';
import { digestDueOn, mondayOf } from './notifications/schedule.js';
import { BillService, type BillSubject } from './bills/BillService.js';
import { createLogger } from '../utils/logger.js';
import { appDateOf, appLocalTime } from '../utils/appDate.js';
import { readTenantMoneyFormat } from './tenantMoneyFormat.js';
import { config } from '../config.js';
import { notificationStatus } from '@nuggets/shared';

const logger = createLogger({ service: 'NotificationRulesEngine' });

// A transaction is news for a week after it's added, so turning a rule on
// doesn't send one message for every transaction ever imported.
const transactionLookbackMs = 7 * 86_400_000;

// How long a notification waits for email to be set up: as long as a transaction is
// news. Older, it's failed with this, rather than sent weeks late once SMTP is set up.
const emailWaitLimitMs = transactionLookbackMs;
const EMAIL_NOT_SET_UP_IN_TIME = "Not sent: email wasn't set up in time";

// Every query here also runs under RLS; naming the tenant as well keeps a role
// that bypasses RLS (the CI database role is a superuser) from mixing tenants.
const currentTenant = sql<number>`current_setting('app.current_tenant_id', true)::int`;

/** Where links in messages point: the app's public URL. */
function baseUrl(): string {
  return (config().CLIENT_URL || config().DOMAIN_URL || 'http://localhost:3000').replace(/\/$/, '');
}

interface Member {
  id: number;
  uuid: string;
  email: string;
  firstName: string | null;
}

/**
 * Neither channel took a notification: its email failed with `cause`, and its push reached
 * no device. `pushMayRetry` when a device refused the push for now (not one that's gone), so
 * another attempt may reach it even if the email's failure is permanent.
 */
class NotDelivered extends Error {
  constructor(
    override readonly cause: unknown,
    readonly pushMayRetry: boolean
  ) {
    super('The notification reached no one');
    this.name = 'NotDelivered';
  }
}

/** A claimed notification with its message built, ready to send. */
interface ReadyNotification {
  notification: QueuedNotification;
  rule: NotificationRule;
  member: Member;
  push: boolean;
  content: MessageContent;
  email: { html: string; text: string; headers: Record<string, string> } | null;
}

/**
 * What a queued notification names (template_data); its message is built when it goes. The
 * history's answer reads it with the same shapes (`@nuggets/shared`'s queuedNotificationDataSchemas).
 */
type Queued = QueuedNotificationData;

/**
 * NotificationRulesEngine — runs the active tenant's notification rules.
 *
 * `queueDueNotifications` (every few minutes, per tenant) finds each enabled
 * rule's subjects — budget items, transactions, review backlogs, digest weeks —
 * for each member the rule can reach, and queues one notification per rule,
 * person and subject. The notification_deliveries row written with it is what
 * stops a subject from being queued twice.
 *
 * `processNotificationQueue` sends what's due. The message is built at that
 * moment from identifiers, after checking again that the rule is still on,
 * the person still a member who wants it, and the subject still matches; if
 * not, nothing goes. Push goes to every device the person turned it on for;
 * email goes when SMTP is set up and the person wants it.
 *
 * `queueDueNotifications` runs inside a tenant transaction (forEachTenant);
 * `processNotificationQueue` opens its own short ones around its network I/O.
 * Either way the tenant's queries are on getDb() and RLS-scoped to it.
 */
export class NotificationRulesEngine {
  constructor(
    private readonly queueService: NotificationQueueService,
    private readonly templateService: EmailTemplateService,
    private readonly emailService: EmailDeliveryService,
    private readonly pushService: PushNotificationService,
    private readonly ruleService: NotificationRuleService = new NotificationRuleService(),
    private readonly billService: BillService = new BillService()
  ) {
    this.templateService.registerHelpers();
  }

  /** Queue every notification that's due in the active tenant. Returns how many were queued. */
  async queueDueNotifications(now = new Date()): Promise<number> {
    const rules = (await this.ruleService.readRules()).rules.rules.filter((rule) => rule.enabled);
    if (rules.length === 0) return 0;

    const members = await this.loadMembers();
    if (members.length === 0) return 0;

    const emailAvailable = await this.emailService.isConfigured();
    const pushUsers = await this.usersWithPush(members.map((m) => m.id));
    const choices = await this.ruleService.allChoices();
    const sentToday = await this.countRecent(now);
    const maxPerDay = await this.maxPerDay();
    const local = await appLocalTime(now);

    // Each kind's subjects are loaded at most once per run.
    let budgetItems: BudgetItemSubject[] | undefined;
    let transactions: TransactionSubject[] | undefined;
    let reviewFacts: Map<number, Facts> | undefined;
    let bills: BillSubject[] | undefined;

    let queued = 0;
    const deliver = async (rule: NotificationRule, member: Member, subjectKey: string, data: Queued) => {
      // Over the daily limit: skip without recording, so it can go on a later run.
      if ((sentToday.get(member.id) ?? 0) >= maxPerDay) return;
      if (await this.record(rule, member, subjectKey, data)) {
        sentToday.set(member.id, (sentToday.get(member.id) ?? 0) + 1);
        queued++;
      }
    };

    for (const rule of rules) {
      // Only people the rule can reach. Recording a delivery for anyone else
      // would mean they never get it, even after turning a channel on.
      const recipients = members.filter((member) => {
        const channels = NotificationRuleService.channelsFor(choices, member.id, rule);
        return (channels.email && emailAvailable) || (channels.push && pushUsers.has(member.id));
      });
      if (recipients.length === 0) continue;

      switch (rule.kind) {
        case 'budget_item': {
          budgetItems ??= await loadBudgetItemSubjects(local.day);
          for (const item of budgetItems) {
            if (!evaluate(rule.when, item.facts)) continue;
            for (const member of recipients) {
              await deliver(rule, member, `budget_item:${item.periodItemUuid}`, { rule: rule.key, periodItem: item.periodItemUuid });
            }
          }
          break;
        }
        case 'transaction': {
          transactions ??= await loadTransactionSubjects({ since: new Date(now.getTime() - transactionLookbackMs) }, now);
          for (const transaction of transactions) {
            if (!evaluate(rule.when, transaction.facts)) continue;
            const targets = rule.audience === 'assignee'
              ? recipients.filter((member) => member.id === transaction.assignedTo)
              : recipients;
            for (const member of targets) {
              await deliver(rule, member, `transaction:${transaction.uuid}`, { rule: rule.key, transaction: transaction.uuid });
            }
          }
          break;
        }
        case 'review_reminder': {
          if (local.minutes < rule.hour * 60) break;
          reviewFacts ??= await loadReviewFacts(members.map((m) => m.id), local.day);
          const lastSent = await this.lastDelivered(rule.key);
          // At most once every everyDays days, measured from the last one (an
          // hour's slack so a run a few minutes early doesn't skip a whole day).
          const gapMs = rule.everyDays * 86_400_000 - 3_600_000;
          for (const member of recipients) {
            const last = lastSent.get(member.id);
            if (last && now.getTime() - last.getTime() < gapMs) continue;
            const facts = reviewFacts.get(member.id);
            if (!facts || !evaluate(rule.when, facts)) continue;
            await deliver(rule, member, `review:${local.day}`, { rule: rule.key, day: local.day });
          }
          break;
        }
        case 'digest': {
          const dueOn = digestDueOn(rule.weekday, rule.hour, local.day, local.minutes);
          if (!dueOn) break;
          for (const member of recipients) {
            await deliver(rule, member, `digest:${mondayOf(dueOn)}`, { rule: rule.key, dueOn });
          }
          break;
        }
        case 'bill': {
          bills ??= await this.billService.subjects(local.day);
          for (const bill of bills) {
            if (!evaluate(rule.when, bill.facts)) continue;
            for (const member of recipients) {
              await deliver(rule, member, `bill:${bill.occurrence.uuid}`, { rule: rule.key, occurrence: bill.occurrence.uuid });
            }
          }
          break;
        }
      }
    }

    await this.updateLastCheckTimestamp('notification_last_rules_check');
    if (queued > 0) logger.info({ queued }, 'Queued notifications');
    return queued;
  }

  /**
   * Record the delivery and queue its notification. False when this rule,
   * person and subject were already recorded (by this run or an earlier one).
   */
  private async record(rule: NotificationRule, member: Member, subjectKey: string, data: Queued): Promise<boolean> {
    const delivery = await getDb()
      .insertInto('notification_deliveries')
      .values({ rule_key: rule.key, user_id: member.id, subject_key: subjectKey })
      .onConflict((oc) => oc.constraint('notification_deliveries_subject_key').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!delivery) return false;

    await getDb()
      .insertInto('notifications')
      .values({
        user_id: member.id,
        recipient_email: member.email,
        notification_type: rule.kind,
        // Replaced by the real subject when the message is built.
        subject: rule.label.slice(0, 255),
        template_data: JSON.stringify(data),
        rule_key: rule.key,
        status: 'pending',
      })
      .execute();
    return true;
  }

  /** When `ruleKey` last went to each person in this tenant. */
  private async lastDelivered(ruleKey: string): Promise<Map<number, Date>> {
    const rows = await getDb()
      .selectFrom('notification_deliveries')
      .select((eb) => ['user_id', eb.fn.max('created_at').as('last')])
      .where('tenant_id', '=', currentTenant)
      .where('rule_key', '=', ruleKey)
      .groupBy('user_id')
      .execute();
    return new Map(rows.map((row) => [row.user_id, new Date(row.last)]));
  }

  /** Members of the active tenant whose sign-in isn't locked or disabled. */
  private async loadMembers(): Promise<Member[]> {
    const rows = await getDb()
      .selectFrom('tenant_users as tu')
      .innerJoin('users as u', 'u.id', 'tu.user_id')
      .select(['u.id', 'u.uuid', 'u.email', 'u.first_name'])
      .where('tu.tenant_id', '=', currentTenant)
      .where('u.is_locked', '=', false)
      .where('u.login_disabled', '=', false)
      .execute();
    return rows.map((row) => ({ id: row.id, uuid: row.uuid, email: row.email, firstName: row.first_name }));
  }

  private async usersWithPush(userIds: number[]): Promise<Set<number>> {
    if (userIds.length === 0) return new Set();
    const rows = await globalDb
      .selectFrom('push_subscriptions')
      .select('user_id')
      .distinct()
      .where('user_id', 'in', userIds)
      .execute();
    return new Set(rows.map((row) => row.user_id));
  }

  /** Notifications queued or sent to each person in the last 24 hours, for the daily limit. */
  private async countRecent(now: Date): Promise<Map<number, number>> {
    const rows = await getDb()
      .selectFrom('notifications')
      .select((eb) => ['user_id', eb.fn.countAll().as('count')])
      .where('tenant_id', '=', currentTenant)
      .where('status', 'in', [notificationStatus.enum.pending, notificationStatus.enum.processing, notificationStatus.enum.sent])
      .where('created_at', '>=', new Date(now.getTime() - 86_400_000))
      .groupBy('user_id')
      .execute();
    return new Map(rows.map((row) => [row.user_id, Number(row.count)]));
  }

  private async maxPerDay(): Promise<number> {
    const limit = parseInt((await readSystemSetting('notification_max_per_user_per_day', globalDb)) ?? '', 10);
    return Number.isFinite(limit) && limit >= 0 ? limit : 5;
  }

  /** The active tenant's name and public id (tenants is control-plane; read the GUC's row). */
  private async tenant(): Promise<{ name: string; uuid: string }> {
    return getDb()
      .selectFrom('tenants')
      .select(['name', 'uuid'])
      .where('id', '=', currentTenant)
      .executeTakeFirstOrThrow();
  }

  /**
   * Build what `notification` says now, or undefined when it shouldn't go any
   * more: its subject no longer matches the rule (the item came back under
   * budget, the transaction was deleted or reassigned).
   */
  private async render(
    notification: QueuedNotification,
    rule: NotificationRule,
    member: Member,
    tenantName: string,
    today: string,
    now: Date,
    budgetItems: () => Promise<BudgetItemSubject[]>,
    money: MoneyFormat
  ): Promise<MessageContent | undefined> {
    const data = notification.templateData;

    switch (rule.kind) {
      case 'budget_item': {
        const item = (await budgetItems()).find((candidate) => candidate.periodItemUuid === data.periodItem);
        if (!item || !evaluate(rule.when, item.facts)) return undefined;
        return budgetItemMessage(rule.label, item, member.firstName, money);
      }
      case 'transaction': {
        if (typeof data.transaction !== 'string') return undefined;
        const [transaction] = await loadTransactionSubjects({ uuid: data.transaction }, now);
        if (!transaction || !evaluate(rule.when, transaction.facts)) return undefined;
        if (rule.audience === 'assignee' && transaction.assignedTo !== member.id) return undefined;
        return transactionMessage(rule.label, transaction, member.firstName, money);
      }
      case 'review_reminder': {
        const facts = (await loadReviewFacts([member.id], today)).get(member.id);
        if (!facts || !evaluate(rule.when, facts)) return undefined;
        return reviewReminderMessage(rule.label, facts, member.firstName, money);
      }
      case 'digest': {
        if (typeof data.dueOn !== 'string') return undefined;
        return digestMessage(rule.label, await loadWeekSummary(data.dueOn, today), data.dueOn, tenantName, member.firstName, money);
      }
      case 'bill': {
        if (typeof data.occurrence !== 'string') return undefined;
        const [bill] = await this.billService.subjects(today, data.occurrence);
        if (!bill || !evaluate(rule.when, bill.facts)) return undefined;
        return billMessage(rule.label, bill.occurrence, today, member.firstName, money);
      }
    }
  }

  /**
   * Send what's due in a tenant's queue, in three steps so no tenant transaction is
   * open during network I/O:
   *
   * 1. claim a batch and build each message, in one short transaction. A claim
   *    (status 'processing') is a lease: one not finished within the lease is
   *    claimed again, so a crash mid-send doesn't strand it;
   * 2. send each by push and email, with no transaction open;
   * 3. record each result in its own short transaction.
   */
  async processNotificationQueue(
    tenantId: number,
    now = new Date()
  ): Promise<{ processed: number; sent: number; failed: number }> {
    if (inTenantTransaction()) {
      // A transaction of its own couldn't see the caller's uncommitted rows, and would
      // keep the caller's open through the sends.
      throw new Error('processNotificationQueue opens its own transactions; call it outside one');
    }
    const { ready, processed, failed: notSendable } = await withTenant(tenantId, () => this.claimBatch(now));
    let sent = 0;
    let failed = notSendable;

    for (const item of ready) {
      const { notification, rule } = item;
      try {
        const messageId = await this.deliver(item);
        await withTenant(tenantId, () => this.queueService.markSent(notification.id, messageId, item.content.subject));
        sent++;
        logger.info({ notificationId: notification.id, rule: rule.key, messageId }, 'Notification sent');
      } catch (thrown) {
        const error = thrown instanceof NotDelivered ? thrown.cause : thrown;
        if (error instanceof SmtpNotConfiguredError) {
          // SMTP was cleared after the claim: it waits for email, as the claim would have
          // made it, and this refused attempt isn't one of its retries.
          logger.warn({ notificationId: notification.id }, 'Notification waits for email to be set up');
          await withTenant(tenantId, () => this.queueService.waitForEmail(notification.id, true));
          continue;
        }
        logger.error({ ...mailErrorFields(error), notificationId: notification.id }, 'Failed to send notification');
        // An email the mail server will refuse again (a recipient it rejects) fails it now,
        // whatever attempts it has left, unless a device may take the push next time.
        const mayGoNextTime = !isPermanentMailError(error) || (thrown instanceof NotDelivered && thrown.pushMayRetry);
        await withTenant(tenantId, async () => {
          const shouldRetry = mayGoNextTime && (await this.queueService.shouldRetry(notification.id));
          await this.queueService.markFailed(notification.id, mailFailureReason(error), shouldRetry);
        });
        failed++;
      }
    }

    if (processed > 0) {
      await this.updateLastCheckTimestamp('notification_last_queue_process');
      logger.info({ processed, sent, failed }, 'Queue processing completed');
    }
    return { processed, sent, failed };
  }

  /**
   * Step 1, in the tenant's transaction: claim up to 5 due notifications and build
   * each one's message from identifiers, after checking again that the rule is still
   * on, the person still a member who wants it, and the subject still matches; one
   * that no longer applies is marked failed here and isn't sent.
   *
   * One that would go by email while email isn't set up (EmailDeliveryService.isConfigured),
   * and that push can't take instead (not chosen, or no device), waits for it: left
   * pending without counting an attempt, and out of the way of the batch for a while
   * (NotificationQueueService.waitForEmail). It goes on the first pass after an admin sets
   * SMTP up, built then, so what it says is checked again then. One queued more than a
   * week before (emailWaitLimitMs) is failed instead, not sent that late.
   */
  private async claimBatch(now: Date): Promise<{ ready: ReadyNotification[]; processed: number; failed: number }> {
    const batch = await this.queueService.getNextBatch(5);
    const ready: ReadyNotification[] = [];
    let failed = 0;
    if (batch.length === 0) return { ready, processed: 0, failed };

    const rules = (await this.ruleService.readRules()).rules.rules;
    const members = new Map((await this.loadMembers()).map((member) => [member.id, member]));
    const choices = await this.ruleService.allChoices();
    const emailAvailable = await this.emailService.isConfigured();
    // Who push could reach instead, needed only while email isn't set up.
    const pushUsers = emailAvailable ? new Set<number>() : await this.usersWithPush([...members.keys()]);
    let waiting = 0;
    const tenant = await this.tenant();
    // The ledger's currency and locale, for the amounts its messages name.
    const money = await readTenantMoneyFormat();
    const today = await appDateOf(now);
    const clientUrl = baseUrl();
    // The period's budget items with their figures, loaded once for the batch: each
    // load runs the calculate_* functions for every item. Kept only
    // once it has loaded, so a failure in one notification's savepoint isn't reused.
    let budgetItemSubjects: BudgetItemSubject[] | undefined;
    const budgetItems = async () => (budgetItemSubjects ??= await loadBudgetItemSubjects(today));

    for (const notification of batch) {
      if (!emailAvailable) {
        const rule = rules.find((candidate) => candidate.key === notification.ruleKey);
        const member = members.get(notification.userId);
        const choice = rule?.enabled && rule.kind === notification.notificationType && member
          ? NotificationRuleService.channelsFor(choices, member.id, rule)
          : undefined;
        if (member && choice?.email && !(choice.push && pushUsers.has(member.id))) {
          if (now.getTime() - notification.createdAt.getTime() > emailWaitLimitMs) {
            await this.queueService.markFailed(notification.id, EMAIL_NOT_SET_UP_IN_TIME, false);
            failed++;
          } else {
            await this.queueService.waitForEmail(notification.id, false);
            waiting++;
          }
          continue;
        }
      }
      // Counts the attempt (retry_count) and takes the lease. It stays outside the
      // savepoint below: a failure there rolls that back, and the notification would
      // then retry forever and hold up the queue behind it.
      await this.queueService.markProcessing(notification.id);
      try {
        // A savepoint per notification, so a database error in one doesn't abort the
        // transaction and lose the whole batch's claims.
        const item = await withSavepoint(async (): Promise<ReadyNotification | null> => {
          const rule = rules.find((candidate) => candidate.key === notification.ruleKey);
          const member = members.get(notification.userId);
          const choice: Choice | undefined = rule && member
            ? NotificationRuleService.channelsFor(choices, member.id, rule)
            : undefined;
          const wantsEmail = (choice?.email ?? false) && emailAvailable;
          const content = rule?.enabled && rule.kind === notification.notificationType && member && (choice?.push || wantsEmail)
            ? await this.render(notification, rule, member, tenant.name, today, now, budgetItems, money)
            : undefined;
          if (!rule || !member || !choice || !content) return null;

          let email: ReadyNotification['email'] = null;
          if (wantsEmail) {
            const token = await this.ruleService.unsubscribeToken(member.uuid, tenant.uuid, rule.key, now);
            const buttonUrl = `${clientUrl}${content.path}`;
            const unsubscribeUrl = `${clientUrl}/unsubscribe#${token}`;
            const { html } = await this.templateService.renderTemplate('rule_message', {
              subject: content.subject,
              heading: content.heading,
              paragraphs: content.paragraphs,
              buttonText: content.buttonText,
              buttonUrl,
              fromName: tenant.name,
              unsubscribeUrl,
            });
            email = {
              html,
              text: plainText(content, buttonUrl, unsubscribeUrl, tenant.name),
              headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>` },
            };
          }
          return { notification, rule, member, push: choice.push, content, email };
        });
        if (item) {
          ready.push(item);
        } else {
          await this.queueService.markFailed(notification.id, 'What this notification was about had changed before it could go', false);
          failed++;
        }
      } catch (error) {
        logger.error({ err: error, notificationId: notification.id }, 'Failed to prepare notification');
        const shouldRetry = await this.queueService.shouldRetry(notification.id);
        await this.queueService.markFailed(notification.id, 'This notification could not be prepared; the server log has the details', shouldRetry);
        failed++;
      }
    }
    if (waiting > 0) logger.info({ waiting }, 'Notifications wait for email to be set up');
    return { ready, processed: batch.length, failed };
  }

  /**
   * Step 2, with no transaction open: push first, then email. A push that reached a
   * device makes the notification delivered, so an email failure afterwards doesn't
   * requeue it (a retry would push it to the phone a second time). Returns the
   * email's message id, or null when it went by push only; throws when nothing went
   * (NotDelivered when the email failed).
   */
  private async deliver(item: ReadyNotification): Promise<string | null> {
    const { notification, rule, member, content } = item;
    const push = item.push
      ? await this.pushService.sendToUser(member.id, { ...content.push, url: content.path, tag: `${rule.key}:${notification.uuid}` })
      : null;
    const pushed = (push?.sent ?? 0) > 0;

    if (!item.email) {
      if (!pushed) throw new ControlPlaneError(502, 'PUSH_NOT_ACCEPTED', 'No device accepted the push');
      return null;
    }
    try {
      // The person's current address: it may have changed since this was queued.
      return await this.emailService.sendEmailWithRetry(
        member.email,
        content.subject,
        item.email.html,
        item.email.text,
        notification.maxRetries,
        item.email.headers
      );
    } catch (emailError) {
      if (!pushed) throw new NotDelivered(emailError, (push?.failed ?? 0) > 0);
      logger.warn({ ...mailErrorFields(emailError), notificationId: notification.id }, 'Email failed; notification was delivered by push');
      return null;
    }
  }

  private async updateLastCheckTimestamp(settingKey: string): Promise<void> {
    try {
      // On globalDb: the check's own transaction may roll back, and the catch carries on.
      await updateSystemSetting(settingKey, sql<string>`to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')`, globalDb);
    } catch (error) {
      logger.warn({ err: error, settingKey }, 'Failed to update last check timestamp');
    }
  }
}
