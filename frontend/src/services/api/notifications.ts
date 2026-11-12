/**
 * API Notifications Module — the deployment's email-notification settings, scheduler,
 * queue and test email (/admin/notifications, deployment admins, no ledger), and the
 * active ledger's history, notification rules and each person's choices (/notifications).
 * Each answer is parsed with its `@nuggets/shared` schema.
 */
import {
  notificationAdminActionResponseSchema,
  notificationAdminSettingsResponseSchema,
  notificationHistoryClearedResponseSchema,
  notificationHistoryQuery,
  notificationHistoryResponseSchema,
  notificationPreferencesResponseSchema,
  notificationRulesResponseSchema,
  notificationStatusResponseSchema,
  notificationTestEmailResponseSchema,
  queryString,
  unsubscribeResultSchema,
  type NotificationAdminSettings,
  type NotificationHistoryItem,
  type NotificationHistoryResponse,
  type NotificationPreferences,
  type NotificationRules,
  type NotificationRulesInput,
  type NotificationSettingsMap,
  type NotificationSystemStatus,
  type SetNotificationPreferencesRequest,
  type TestNotificationEmailRequest,
  type UnsubscribeResult,
} from '@nuggets/shared';
import { apiGet, apiPost, apiPut, apiDelete } from './base';
import { parseAnswer } from './parseAnswer';

export type { NotificationHistoryItem, NotificationHistoryResponse, NotificationSettingsMap };
/** GET /admin/notifications/status: email set up and on, the scheduler, and the queue. */
export type NotificationStatus = NotificationSystemStatus;

export const getNotificationStatus = async (): Promise<NotificationStatus> =>
  parseAnswer(notificationStatusResponseSchema, await apiGet<unknown>('/admin/notifications/status'), 'notification status');

export const getNotificationSettings = async (): Promise<NotificationAdminSettings> =>
  parseAnswer(notificationAdminSettingsResponseSchema, await apiGet<unknown>('/admin/notifications/settings'), 'notification settings');

export const getNotificationHistory = async (page = 1, limit = 20): Promise<NotificationHistoryResponse> =>
  parseAnswer(
    notificationHistoryResponseSchema,
    await apiGet<unknown>(`/notifications/history${queryString(notificationHistoryQuery, { page, limit })}`),
    'notification history'
  );

export const updateNotificationSettings = async (settings: Record<string, string>) =>
  parseAnswer(notificationAdminActionResponseSchema, await apiPost<unknown>('/admin/notifications/settings', { settings }), 'notification settings saved');

export const notificationSchedulerAction = async (action: 'start' | 'stop' | 'restart') =>
  parseAnswer(notificationAdminActionResponseSchema, await apiPost<unknown>(`/admin/notifications/scheduler/${action}`), `notification scheduler ${action}`);

export const clearNotificationHistory = async () =>
  parseAnswer(notificationHistoryClearedResponseSchema, await apiDelete<unknown>('/notifications/history'), 'notification history cleared');

export const sendTestNotification = async (body: TestNotificationEmailRequest) =>
  parseAnswer(notificationTestEmailResponseSchema, await apiPost<unknown>('/admin/notifications/test', body), 'test email');

// ------------------------------------------------------- notification rules

/** The active tenant's notification rules (its saved ones, or the defaults). */
export const getNotificationRules = async (): Promise<NotificationRules> =>
  parseAnswer(notificationRulesResponseSchema, await apiGet<unknown>('/notifications/rules'), 'notification rules');

/** Replace the active tenant's rules (tenant admins). */
export const saveNotificationRules = async (rules: NotificationRulesInput): Promise<NotificationRules> =>
  parseAnswer(notificationRulesResponseSchema, await apiPut<unknown>('/notifications/rules', rules), 'notification rules saved');

/** How each of the tenant's enabled rules reaches the signed-in person. */
export const getNotificationPreferences = async (): Promise<NotificationPreferences> =>
  parseAnswer(notificationPreferencesResponseSchema, await apiGet<unknown>('/notifications/preferences'), 'notification preferences');

export const setNotificationPreferences = async (request: SetNotificationPreferencesRequest): Promise<NotificationPreferences> =>
  parseAnswer(notificationPreferencesResponseSchema, await apiPut<unknown>('/notifications/preferences', request), 'notification preferences saved');

/** Which rule an email's unsubscribe link would stop; changes nothing. */
export const inspectUnsubscribeLink = async (token: string): Promise<UnsubscribeResult> =>
  parseAnswer(unsubscribeResultSchema, await apiPost<unknown>('/notification-links/inspect', { token }), 'unsubscribe link');

/** Stop the email the link came in. */
export const unsubscribeByLink = async (token: string): Promise<UnsubscribeResult> =>
  parseAnswer(unsubscribeResultSchema, await apiPost<unknown>('/notification-links/unsubscribe', { token }), 'unsubscribe');
