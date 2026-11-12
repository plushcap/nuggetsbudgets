import type { NotificationSampleType, NotificationSettingsUpdate, TestNotificationEmailRequest } from '@nuggets/shared';
import { NOTIFICATION_SAMPLE_TYPES, NOTIFICATION_SAMPLE_TYPE_ERROR } from '@nuggets/shared';
import { globalDb, withTenant } from '../../db/withTenant.js';
import { getActiveTenantIds } from '../../db/forEachTenant.js';
import { DomainError } from '../domainErrors.js';
import { EmailDeliveryService, SmtpNotConfiguredError, mailErrorFields, mailFailureReason } from '../EmailDeliveryService.js';
import { EmailTemplateService } from '../EmailTemplateService.js';
import { EncryptionService } from '../EncryptionService.js';
import { NotificationQueueService } from '../NotificationQueueService.js';
import { readSystemSetting, readSystemSettingsIn, writeSystemSetting } from '../systemSettings.js';
import { budgetItemMessage, reviewReminderMessage, type MessageContent } from './messages.js';
import { createLogger, maskEmail } from '../../utils/logger.js';

const logger = createLogger({ service: 'NotificationAdminService' });

/** A deployment admin's request about notifications that can't be carried out: answered with its status. */
export class NotificationAdminError extends DomainError {}

/** A preview of a sample that doesn't exist. */
export const invalidSampleType = (): NotificationAdminError =>
  new NotificationAdminError(400, 'BAD_REQUEST', NOTIFICATION_SAMPLE_TYPE_ERROR);

/**
 * The mail server didn't take the test email: 502, with what to check (mailFailureReason),
 * never the mailer's own text, which names hosts and quotes the server's replies.
 */
export const testEmailNotSent = (reason: string): NotificationAdminError =>
  new NotificationAdminError(502, 'MAIL_SEND_FAILED', reason, {}, { heading: 'Failed to send test email' });

/** A setting as the Email Notifications page shows it. */
export interface NotificationSettingView {
  value: string | null;
  type: string | null;
  description: string | null;
}

/** The settings that, changed, restart the notification scheduler. */
const SCHEDULER_KEYS = ['notification_system_enabled', 'notification_rules_check_interval', 'notification_queue_process_interval'] as const;

export function isSampleType(value: string): value is NotificationSampleType {
  return (NOTIFICATION_SAMPLE_TYPES as readonly string[]).includes(value);
}

/** A made-up message of each default kind, for the test email and preview. */
function sampleMessage(templateType: NotificationSampleType, firstName: string | null): MessageContent {
  if (templateType === 'transaction-review') {
    return reviewReminderMessage(
      'Transactions waiting for review',
      { unreviewed_count: 15, unreviewed_total: 1234.56, oldest_unreviewed_days: 7 },
      firstName
    );
  }
  return budgetItemMessage(
    'A budget item over budget',
    {
      periodItemUuid: 'sample',
      itemUuid: 'sample',
      name: 'Groceries',
      periodName: 'This month',
      facts: { kind: 'expense', budgeted: 500, spent: 650, remaining: -150, percent_used: 130, days_left: 10 },
    },
    firstName
  );
}

function templates(): EmailTemplateService {
  const service = new EmailTemplateService();
  service.registerHelpers();
  return service;
}

/**
 * The deployment's notification settings (SMTP, the scheduler's intervals), its queue,
 * and the test email and preview, for the deployment admin's Email Notifications page
 * (/api/admin/notifications). system_settings is the deployment's (services/systemSettings.ts);
 * each ledger's queue is its own, read in a short transaction per ledger.
 */
export class NotificationAdminService {
  constructor(
    private readonly emailService: EmailDeliveryService = new EmailDeliveryService(),
    private readonly queueService: NotificationQueueService = new NotificationQueueService()
  ) {}

  /**
   * Every notification setting but the SMTP password, which is never returned, even
   * encrypted: only whether one is set (the page's field is write-only).
   */
  async readSettings(): Promise<{ settings: Record<string, NotificationSettingView>; passwordConfigured: boolean }> {
    let passwordConfigured = false;
    const settings: Record<string, NotificationSettingView> = {};
    for (const row of await readSystemSettingsIn('notifications')) {
      if (row.setting_key === 'notification_smtp_password') {
        passwordConfigured = !!row.setting_value;
        continue;
      }
      settings[row.setting_key] = { value: row.setting_value, type: row.setting_type, description: row.description };
    }
    return { settings, passwordConfigured };
  }

  /**
   * Save the settings given (only notificationSettingsUpdateSchema's keys get here),
   * and say whether one the scheduler reads changed. The SMTP password is a secret: stored
   * encrypted, never in the clear, and an empty one leaves the stored one as it is.
   */
  async saveSettings(settings: NotificationSettingsUpdate, userId: number): Promise<{ schedulerChanged: boolean; keys: string[] }> {
    const { notification_smtp_password: password, ...plain } = settings;
    if (typeof password === 'string' && password.trim() !== '') {
      await writeSystemSetting('notification_smtp_password', await new EncryptionService().encryptString(password), {
        category: 'notifications',
      });
      logger.info({ userId }, 'Updated encrypted SMTP password');
    }
    const keys: string[] = [];
    for (const [key, value] of Object.entries(plain)) {
      if (value === undefined) continue;
      await writeSystemSetting(key, value, { category: 'notifications', onlyInCategory: true });
      keys.push(key);
    }
    return { schedulerChanged: SCHEDULER_KEYS.some((key) => key in plain), keys };
  }

  /**
   * Whether email can go (a host, a username and a password, as sending needs: a host
   * alone said "Configured" while every send was refused), whether the system is on,
   * and the last week's queue: every ledger's the scheduler sends for, added up.
   */
  async status(): Promise<{ configured: boolean; enabled: boolean; queue: Awaited<ReturnType<NotificationQueueService['getQueueStats']>> }> {
    const queue = { pending: 0, processing: 0, sent: 0, failed: 0, total: 0 };
    for (const tenantId of await getActiveTenantIds()) {
      const stats = await withTenant(tenantId, () => this.queueService.getQueueStats());
      for (const key of Object.keys(queue) as (keyof typeof queue)[]) queue[key] += stats[key];
    }
    return {
      configured: await this.emailService.isConfigured(),
      enabled: (await readSystemSetting('notification_system_enabled')) === 'true',
      queue,
    };
  }

  /**
   * Send a sample message to `recipient` through the deployment's SMTP account, in its
   * sender's name, and return the message id. Waits on the mail server, so call it with no
   * transaction open. SMTP not set up is a 503 that says what to set up;
   * another failure a 502 that says what to check.
   */
  async sendTestEmail(request: TestNotificationEmailRequest, userId: number, clientUrl: string): Promise<string> {
    const { recipient, templateType } = request;
    logger.info({ userId, recipient: maskEmail(recipient), templateType }, 'Sending test email');
    const sender = await globalDb.selectFrom('users').select('first_name').where('id', '=', userId).executeTakeFirst();
    const content = sampleMessage(templateType, sender?.first_name ?? null);
    const base = clientUrl.replace(/\/$/, '');
    const subject = `[TEST] ${content.subject}`;
    const { html, text } = await templates().renderTemplate('rule_message', {
      subject,
      heading: content.heading,
      paragraphs: content.paragraphs,
      buttonText: content.buttonText,
      buttonUrl: `${base}${content.path}`,
      fromName: 'your household',
      unsubscribeUrl: `${base}/profile`,
    });

    let messageId: string;
    try {
      messageId = await this.emailService.sendEmailWithRetry(recipient, subject, html, text, 1); // one retry for a test
    } catch (error) {
      if (error instanceof SmtpNotConfiguredError) {
        logger.warn({ err: error, userId }, 'Test email not sent: SMTP is not set up');
        throw error;
      }
      logger.error({ ...mailErrorFields(error), userId, recipient: maskEmail(recipient) }, 'Failed to send test email');
      throw testEmailNotSent(mailFailureReason(error));
    }
    logger.info({ userId, recipient: maskEmail(recipient), templateType, messageId }, 'Test email sent successfully');
    return messageId;
  }

  /** A sample message as the email's HTML, for the browser (no links that go anywhere). */
  async previewEmail(templateType: string): Promise<string> {
    if (!isSampleType(templateType)) throw invalidSampleType();
    const content = sampleMessage(templateType, 'John');
    const { html } = await templates().renderTemplate('rule_message', {
      subject: content.subject,
      heading: content.heading,
      paragraphs: content.paragraphs,
      buttonText: content.buttonText,
      buttonUrl: '#',
      fromName: 'your household',
      unsubscribeUrl: '#',
    });
    return html;
  }
}
