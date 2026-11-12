import { sql } from 'kysely';
import { getDb } from '../../db/withTenant.js';

/**
 * The active tenant's notification history (its `notifications` rows, under RLS), for its
 * admins: it names every member and their address.
 */

export interface NotificationHistoryFilter {
  page: number;
  limit: number;
  status?: string | undefined;
  type?: string | undefined;
}

/** A page of the history, newest first, with who each went to, and the page's place in the whole. */
export async function notificationHistory({ page, limit, status, type }: NotificationHistoryFilter) {
  const offset = (page - 1) * limit;

  let countQuery = getDb().selectFrom('notifications as n').select((eb) => eb.fn.countAll().as('count'));
  if (status) countQuery = countQuery.where('n.status', '=', status);
  if (type) countQuery = countQuery.where('n.notification_type', '=', type);
  const totalCount = Number((await countQuery.executeTakeFirstOrThrow()).count);

  let historyQuery = getDb()
    .selectFrom('notifications as n')
    .innerJoin('users as u', 'u.id', 'n.user_id')
    .select([
      'n.id',
      'n.uuid',
      'n.user_id',
      'u.email as user_email',
      sql<string>`CONCAT(u.first_name, ' ', u.last_name)`.as('user_name'),
      'n.notification_type',
      'n.status',
      'n.template_data',
      'n.scheduled_for',
      'n.sent_at',
      'n.last_attempt_at',
      'n.error_message',
      'n.retry_count',
      'n.ses_message_id',
      'n.created_at',
    ]);
  if (status) historyQuery = historyQuery.where('n.status', '=', status);
  if (type) historyQuery = historyQuery.where('n.notification_type', '=', type);
  const notifications = await historyQuery.orderBy('n.created_at', 'desc').orderBy('n.id', 'desc').limit(limit).offset(offset).execute();

  return {
    notifications,
    pagination: {
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      hasMore: offset + limit < totalCount,
    },
  };
}

/** Delete the tenant's whole history; returns how many rows went. */
export async function clearNotificationHistory(): Promise<number> {
  const result = await getDb().deleteFrom('notifications').executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}
