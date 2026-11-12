import { sql } from 'kysely';
import { getDb } from '../db/withTenant.js';
import { createLogger } from '../utils/logger.js';
import { notificationStatus } from '@nuggets/shared';

const logger = createLogger({ service: 'NotificationQueueService' });

// The queue is read under RLS; naming the tenant as well keeps a role that
// bypasses RLS (the CI database role is a superuser) from sending another
// tenant's notifications.
const currentTenant = sql<number>`current_setting('app.current_tenant_id', true)::int`;

export interface QueuedNotification {
  id: number;
  uuid: string;
  userId: number;
  recipientEmail: string;
  notificationType: string;
  /** The notification rule that queued it; null for rows from before rules. */
  ruleKey: string | null;
  subject: string;
  /** Identifiers of what it's about; the message is built from them when it goes. */
  templateData: Record<string, unknown>;
  status: string;
  scheduledFor: Date;
  priority: number;
  retryCount: number;
  maxRetries: number;
  lastAttemptAt: Date | null;
  createdAt: Date;
}

/**
 * NotificationQueueService
 *
 * The notification queue's lifecycle once a row is in it (the rules engine
 * queues rows itself, together with their delivery record):
 * - Get next batch for processing
 * - Update notification status
 * - Queue statistics
 */
/**
 * How long a claim lasts. Sending one notification takes at most a few minutes (push
 * and SMTP have timeouts, email a few retries), so a claim older than this was lost.
 */
const CLAIM_LEASE = '15 minutes';

/**
 * How long a notification waiting for email to be set up stays out of the batch before
 * it is looked at again (waitForEmail). Without a wait, five waiting ones would fill
 * every batch, ahead of everything due after them.
 */
const EMAIL_WAIT = '15 minutes';

/** A waiting notification's error_message, which its history shows; cleared when it goes. */
const WAITING_FOR_EMAIL = 'Waiting for email to be set up';

export class NotificationQueueService {
  /**
   * The next due notifications to send: pending ones, and claims (status
   * 'processing', set by markProcessing) older than the lease, whose sender stopped
   * before recording a result. The caller must claim each in the same transaction.
   *
   * @param batchSize - Number of notifications to retrieve (default: 5)
   * @returns Array of queued notifications
   */
  async getNextBatch(batchSize: number = 5): Promise<QueuedNotification[]> {
    try {
      const rows = await getDb()
        .selectFrom('notifications')
        .select([
          'id', 'uuid', 'user_id', 'recipient_email', 'notification_type', 'rule_key',
          'subject', 'template_data', 'status', 'scheduled_for', 'priority',
          'retry_count', 'max_retries', 'last_attempt_at', 'created_at',
        ])
        .where('tenant_id', '=', currentTenant)
        .where((eb) => eb.or([
          eb('status', '=', notificationStatus.enum.pending),
          eb.and([
            eb('status', '=', notificationStatus.enum.processing),
            eb('last_attempt_at', '<', sql<Date>`CURRENT_TIMESTAMP - ${CLAIM_LEASE}::interval`),
          ]),
        ]))
        .where('scheduled_for', '<=', sql<Date>`CURRENT_TIMESTAMP`)
        .orderBy('priority', 'asc')
        .orderBy('scheduled_for', 'asc')
        .limit(batchSize)
        .forUpdate()
        .skipLocked()
        .execute();

      const notifications = rows.map(row => ({
        id: row.id,
        uuid: row.uuid as string,
        userId: row.user_id,
        recipientEmail: row.recipient_email,
        notificationType: row.notification_type,
        ruleKey: row.rule_key,
        subject: row.subject,
        templateData: row.template_data as Record<string, unknown>,
        status: row.status as string,
        scheduledFor: row.scheduled_for as Date,
        priority: row.priority as number,
        retryCount: row.retry_count as number,
        maxRetries: row.max_retries as number,
        lastAttemptAt: row.last_attempt_at,
        createdAt: row.created_at as Date,
      }));

      logger.debug({ count: notifications.length, batchSize }, 'Retrieved notification batch');

      return notifications;

    } catch (error) {
      logger.error({ err: error }, 'Failed to get notification batch');
      throw error;
    }
  }

  /**
   * Mark notification as processing
   */
  async markProcessing(id: number): Promise<void> {
    await getDb()
      .updateTable('notifications')
      .set((eb) => ({
        status: 'processing',
        last_attempt_at: sql<Date>`CURRENT_TIMESTAMP`,
        retry_count: eb('retry_count', '+', 1),
      }))
      .where('id', '=', id)
      .execute();
  }

  /**
   * Mark notification as sent successfully
   *
   * @param id - Notification ID
   * @param sesMessageId - The email's Message-ID (the column's name is from when email went
   *   through SES); null when it went by push only
   * @param subject - The subject it went out with (built when it was sent)
   */
  async markSent(id: number, sesMessageId: string | null, subject: string): Promise<void> {
    try {
      await getDb()
        .updateTable('notifications')
        .set({
          status: 'sent',
          sent_at: sql<Date>`CURRENT_TIMESTAMP`,
          ses_message_id: sesMessageId,
          subject: subject.slice(0, 255),
          error_message: null,
        })
        .where('id', '=', id)
        .execute();

      logger.debug({ id, sesMessageId }, 'Notification marked as sent');

    } catch (error) {
      logger.error({ err: error, id }, 'Failed to mark notification as sent');
      throw error;
    }
  }

  /**
   * Mark notification as failed
   *
   * @param id - Notification ID
   * @param errorMessage - Error message
   * @param shouldRetry - Whether to retry or mark as permanently failed
   */
  async markFailed(id: number, errorMessage: string, shouldRetry: boolean): Promise<void> {
    try {
      const notification = await getDb()
        .selectFrom('notifications')
        .select(['retry_count', 'max_retries'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      const retryCount = notification.retry_count ?? 0;
      const maxRetries = notification.max_retries ?? 0;

      // Determine final status
      let status = 'pending'; // Retry
      if (!shouldRetry || retryCount >= maxRetries) {
        status = 'failed'; // Permanent failure
      }

      await getDb()
        .updateTable('notifications')
        .set({
          status,
          error_message: errorMessage,
        })
        .where('id', '=', id)
        .execute();

      logger.info({
        id,
        status,
        retryCount,
        maxRetries,
        errorMessage: errorMessage.substring(0, 100),
      }, 'Notification marked as failed');

    } catch (error) {
      logger.error({ err: error, id }, 'Failed to mark notification as failed');
      throw error;
    }
  }

  /**
   * Leave a notification pending while email isn't set up: due again after
   * EMAIL_WAIT, and not counted as an attempt, so it isn't failed for a refusal that can
   * only repeat until an admin sets SMTP up. `attemptCounted`: markProcessing counted this
   * attempt (it was claimed, then refused as not set up), so it is given back.
   */
  async waitForEmail(id: number, attemptCounted: boolean): Promise<void> {
    await getDb()
      .updateTable('notifications')
      .set((eb) => ({
        status: 'pending',
        scheduled_for: sql<Date>`CURRENT_TIMESTAMP + ${EMAIL_WAIT}::interval`,
        error_message: WAITING_FOR_EMAIL,
        ...(attemptCounted ? { retry_count: sql<number>`GREATEST(${eb.ref('retry_count')} - 1, 0)` } : {}),
      }))
      .where('id', '=', id)
      .execute();
  }

  /**
   * Check if notification should be retried
   */
  async shouldRetry(id: number): Promise<boolean> {
    const row = await getDb()
      .selectFrom('notifications')
      .select(['retry_count', 'max_retries'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) {
      return false;
    }

    return (row.retry_count ?? 0) < (row.max_retries ?? 0);
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<{
    pending: number;
    processing: number;
    sent: number;
    failed: number;
    total: number;
  }> {
    const row = await getDb()
      .selectFrom('notifications')
      .select((eb) => [
        eb.fn.countAll().filterWhere('status', '=', 'pending').as('pending'),
        eb.fn.countAll().filterWhere('status', '=', 'processing').as('processing'),
        eb.fn.countAll().filterWhere('status', '=', 'sent').as('sent'),
        eb.fn.countAll().filterWhere('status', '=', 'failed').as('failed'),
        eb.fn.countAll().as('total'),
      ])
      .where('created_at', '>=', sql<Date>`now() - INTERVAL '7 days'`)
      .executeTakeFirstOrThrow();

    return {
      pending: Number(row.pending),
      processing: Number(row.processing),
      sent: Number(row.sent),
      failed: Number(row.failed),
      total: Number(row.total),
    };
  }
}
