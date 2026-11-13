import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import bcrypt from 'bcryptjs';
import type request from 'supertest';
import type { z } from 'zod';
import {
  activeTenantResponseSchema,
  adminPasswordResetResponseSchema,
  adminUserListResponseSchema,
  adminUserUpdatedResponseSchema,
  answerProblem,
  authMeResponseSchema,
  authMessageResponseSchema,
  backupFileResponseSchema,
  backupListResponseSchema,
  backupOneDriveStatusResponseSchema,
  backupSettingsResponseSchema,
  createdInvitationDtoSchema,
  createdUserResponseSchema,
  deploymentSettingsResponseSchema,
  deploymentSettingsSavedResponseSchema,
  generalSettingsResponseSchema,
  importAccountSyncResponseSchema,
  importAccountsResponseSchema,
  importBudgetPeriodRepairResponseSchema,
  importSchedulerResponseSchema,
  importSettingsResponseSchema,
  importStatusResponseSchema,
  importSyncResponseSchema,
  importTestSyncResponseSchema,
  importUsersResponseSchema,
  invitationListResponseSchema,
  invitationPreviewDtoSchema,
  acceptedInvitationDtoSchema,
  loginResponseSchema,
  memberCandidateListResponseSchema,
  memberDtoSchema,
  memberListResponseSchema,
  membershipChangedResponseSchema,
  membershipSummarySchema,
  notificationAdminActionResponseSchema,
  notificationAdminSettingsResponseSchema,
  notificationHistoryClearedResponseSchema,
  notificationHistoryItemResponseSchema,
  notificationHistoryResponseSchema,
  notificationPreferencesResponseSchema,
  notificationRulesResponseSchema,
  notificationStatusResponseSchema,
  notificationTestEmailResponseSchema,
  oneDriveAuthResponseSchema,
  oneDriveConfigResponseSchema,
  oneDriveStatusResponseSchema,
  organizationDetailSchema,
  ownProfileResponseSchema,
  ownSessionsResponseSchema,
  passkeyChangedResponseSchema,
  passkeyListResponseSchema,
  passwordChangedResponseSchema,
  personalAccessTokenListResponseSchema,
  personalAccessTokenMintedResponseSchema,
  personalAccessTokenRevokedResponseSchema,
  pushDeviceCountResponseSchema,
  pushPublicKeyResponseSchema,
  pushSendResultSchema,
  pushSubscribedResponseSchema,
  pushUnsubscribedResponseSchema,
  reauthenticatedResponseSchema,
  restoreStatusResponseSchema,
  settingsActionResponseSchema,
  setupStatusResponseSchema,
  simpleFinAccountDetailResponseSchema,
  simpleFinAccountsResponseSchema,
  simpleFinConnectionDtoSchema,
  syncLogPageResponseSchema,
  tenantDetailSchema,
  tenantUserListResponseSchema,
  timeZoneOptionsResponseSchema,
  unsubscribeResultSchema,
  userTokensRevokedResponseSchema,
  backupCreateStatusResponseSchema,
  backupKeyStatusResponseSchema,
  backupStatusResponseSchema,
  bankLinkChangedResponseSchema,
} from '@nuggets/shared';
import pool from '../../db.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness, type Verb } from './routeHarness.js';
import type { ImportService } from '../../services/ImportService.js';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';
import type { SimplefinAccountSet } from '../../services/import/types.js';
import { BackupService } from '../../services/BackupService.js';
import { OneDriveService } from '../../services/OneDriveService.js';
import { PushNotificationService } from '../../services/PushNotificationService.js';
import { NotificationRuleService } from '../../services/notifications/NotificationRuleService.js';
import { NotificationAdminService } from '../../services/notifications/NotificationAdminService.js';

/**
 * The answers of the people, sign-in, settings, import, notification and admin routes, each
 * checked with its `@nuggets/shared` schema: `answerProblem` fails on a field
 * the schema refuses and on one it doesn't name, so a route that adds a field, or a schema that
 * names one the route never sends as it says, fails here. Through the real app, with the
 * services that would reach a third party (SimpleFin, Microsoft, SMTP, a push service, the
 * backup directory) stubbed at the edge, and the global settings left as they were.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const now = Math.floor(Date.now() / 1000);
const accountSet: SimplefinAccountSet = {
  errlist: [{ code: 'con.auth', msg: 'Reconnect', conn_id: 'CON-1' }],
  connections: [{ conn_id: 'CON-1', name: 'Bank', org_id: 'ORG-1', sfin_url: 'https://bank.example' }],
  accounts: [
    {
      id: 'ACT-answers', conn_id: 'CON-1', name: 'Checking', currency: 'USD', balance: '100.50', 'available-balance': '90.00', 'balance-date': now,
      transactions: [{ id: 'T1', posted: now - 100, amount: '-5.00', description: 'Coffee', payee: 'Cafe' }],
    },
    // Not heard from in weeks, with no transactions.
    { id: 'ACT-OLD', name: 'Old savings', currency: 'USD', balance: '7.00', 'balance-date': now - 30 * 86400 },
  ],
};
const importService = {
  testConnection: async () => true,
  fetchAccounts: async () => accountSet,
  runFullSync: async () => ({ status: 'partial', message: '1 transaction could not be saved' }),
  runSingleAccountSync: async () => ({
    success: true,
    status: 'partial',
    notice: '1 transaction could not be saved',
    transactionsImported: 2,
    transactionsUpdated: 1,
    transactionsFailed: 1,
    balanceAdjustments: 0,
    message: 'Synced',
  }),
} satisfies Partial<Record<keyof ImportService, unknown>> as unknown as ImportService;

/** The lifecycle the routes read, answering as ApplicationLifecycleService's methods do. */
const lifecycle = {
  isSchedulerRunning: async () => true,
  getNotificationSchedulerStatus: async () => ({
    running: true,
    shuttingDown: false,
    hasRunningOperations: false,
    settings: { systemEnabled: true, rulesCheckIntervalMinutes: 15, queueProcessIntervalMinutes: 5 },
  }),
  getBackupSchedulerStatus: async () => ({
    enabled: true,
    running: true,
    hasRunningBackup: false,
    nextBackupTime: new Date(Date.now() + 3600_000).toISOString(),
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    lastRunOutcome: null,
    waitingForBackupKey: false,
    usingOldBackupKey: false,
  }),
} satisfies Partial<{ [K in keyof ApplicationLifecycleService]: ApplicationLifecycleService[K] }>;
const lifecycleService = new Proxy(lifecycle as Record<string, unknown>, {
  get: (target, prop) => (prop === 'then' ? undefined : prop in target ? target[prop as string] : async () => undefined),
}) as unknown as ApplicationLifecycleService;

describeDb('People, sign-in, settings, import and notification answers', () => {
  let h: RouteHarness;
  let tenant: TestTenant;
  let admin: { id: number; uuid: string; email: string };
  let session: string;
  let orgUuid: string;
  const backupService = new BackupService(pool);
  const oneDriveService = new OneDriveService();
  const pushService = new PushNotificationService();
  const notificationRuleService = new NotificationRuleService();
  const createdUserIds: number[] = [];

  /** The answer has `status`, and is exactly what `schema` describes. */
  function expectAnswer(res: request.Response, status: number, schema: z.ZodType, label: string) {
    expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(status);
    expect(answerProblem(schema, res.body), label).toBeNull();
  }
  const call = (verb: Verb, path: string, body?: object, who = session) => h.call(who, verb, path, body);

  beforeAll(async () => {
    tenant = await createTestTenant('People answers');
    h = await startRouteHarness('People answers', { importService, lifecycleService, backupService, oneDriveService, pushService, notificationRuleService });
    admin = await h.addUser('admin');
    await h.owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, true)', [tenant.organizationId, admin.id]);
    await h.owner.query('INSERT INTO tenant_users (tenant_id, user_id, is_admin) VALUES ($1, $2, true)', [tenant.tenantId, admin.id]);
    await h.makeDeploymentAdmin(admin.id);
    session = await h.signIn(admin.id, tenant.tenantId);
    orgUuid = (await h.owner.query('SELECT uuid FROM organizations WHERE id = $1', [tenant.organizationId])).rows[0].uuid;
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) await h?.owner.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
    await h?.close();
    await tenant?.cleanup();
  });

  describe('notifications', () => {
    it('answers the rules, the choices, the history and the admin pages as their schemas say', async () => {
      const rules = await call('get', '/api/notifications/rules');
      expectAnswer(rules, 200, notificationRulesResponseSchema, 'GET rules');
      expectAnswer(await call('put', '/api/notifications/rules', rules.body), 200, notificationRulesResponseSchema, 'PUT rules');

      expectAnswer(await call('get', '/api/notifications/preferences'), 200, notificationPreferencesResponseSchema, 'GET preferences');
      const chosen = await call('put', '/api/notifications/preferences', { rules: [{ rule: 'over_budget', push: false }] });
      expectAnswer(chosen, 200, notificationPreferencesResponseSchema, 'PUT preferences');

      // A notification sent, and one that failed, so every column has a value or null.
      await tenant.pool.query(
        `INSERT INTO notifications (user_id, notification_type, status, recipient_email, subject, template_data, sent_at, ses_message_id, rule_key)
         VALUES ($1, 'budget_item', 'sent', 'a@test.local', 'Over budget', $2, now(), '<id@smtp>', 'over_budget'),
                ($1, 'bill', 'failed', 'a@test.local', 'Bill due', $3, NULL, NULL, 'bill_due_soon'),
                ($1, 'review_reminder', 'pending', 'a@test.local', 'To review', $4, NULL, NULL, 'review_reminder'),
                ($1, 'digest', 'pending', 'a@test.local', 'The week', $5, NULL, NULL, 'weekly_digest'),
                ($1, 'transaction', 'pending', 'a@test.local', 'A purchase', $6, NULL, NULL, 'large_purchase'),
                ($1, 'budget_overspending', 'pending', 'a@test.local', 'From before the rules', '{"budgetItemName": "Food", "spent": 120}', NULL, NULL, NULL)`,
        [
          admin.id,
          JSON.stringify({ rule: 'over_budget', periodItem: '0190a000-0000-7000-8000-000000000101' }),
          JSON.stringify({ rule: 'bill_due_soon', occurrence: '0190a000-0000-7000-8000-000000000102' }),
          JSON.stringify({ rule: 'review_reminder', day: '2026-11-09' }),
          JSON.stringify({ rule: 'weekly_digest', dueOn: '2026-11-08' }),
          JSON.stringify({ rule: 'large_purchase', transaction: '0190a000-0000-7000-8000-000000000103' }),
        ]
      );
      const history = await call('get', '/api/notifications/history?page=1&limit=10');
      expectAnswer(history, 200, notificationHistoryResponseSchema, 'GET history');
      expect(history.body.notifications).toHaveLength(6);
      // A kind's template data is what that kind queues: another kind's, or anything else, is refused.
      const [budgetRow] = history.body.notifications.filter((n: { notification_type: string }) => n.notification_type === 'budget_item');
      expect(answerProblem(notificationHistoryItemResponseSchema, { ...budgetRow, template_data: { rule: 'over_budget', day: '2026-11-09' } })).not.toBeNull();
      expect(answerProblem(notificationHistoryItemResponseSchema, { ...budgetRow, template_data: { item: 'Food' } })).not.toBeNull();
      expect(answerProblem(notificationHistoryItemResponseSchema, { ...budgetRow, notification_type: 'something_else' })).not.toBeNull();
      expectAnswer(await call('delete', '/api/notifications/history'), 200, notificationHistoryClearedResponseSchema, 'DELETE history');

      expectAnswer(await call('get', '/api/admin/notifications/settings'), 200, notificationAdminSettingsResponseSchema, 'GET admin settings');
      // Saved as the service saves them (the settings are the deployment's: left as they are).
      vi.spyOn(NotificationAdminService.prototype, 'saveSettings').mockResolvedValue({ schedulerChanged: false, keys: [] });
      const saved = await call('post', '/api/admin/notifications/settings', { settings: { notification_system_enabled: 'true' } });
      expectAnswer(saved, 200, notificationAdminActionResponseSchema, 'POST admin settings');
      expectAnswer(await call('get', '/api/admin/notifications/status'), 200, notificationStatusResponseSchema, 'GET status');
      for (const action of ['start', 'stop', 'restart']) {
        expectAnswer(await call('post', `/api/admin/notifications/scheduler/${action}`), 200, notificationAdminActionResponseSchema, `scheduler ${action}`);
      }
      vi.spyOn(NotificationAdminService.prototype, 'sendTestEmail').mockResolvedValue('<test@smtp.example>');
      const test = await call('post', '/api/admin/notifications/test', { recipient: 'someone@test.local', templateType: 'transaction-review' });
      expectAnswer(test, 200, notificationTestEmailResponseSchema, 'POST test email');
    });

    it("answers an email's unsubscribe link", async () => {
      const tenantUuid = (await h.owner.query('SELECT uuid FROM tenants WHERE id = $1', [tenant.tenantId])).rows[0].uuid;
      // Links are signed with a key from the data encryption key, which tests don't have.
      vi.spyOn(notificationRuleService as unknown as { signingKey: () => Promise<Buffer> }, 'signingKey').mockResolvedValue(Buffer.from('made-up signing key'));
      const token = await notificationRuleService.unsubscribeToken(admin.uuid, tenantUuid, 'over_budget');
      const inspected = await call('post', '/api/notification-links/inspect', { token });
      expectAnswer(inspected, 200, unsubscribeResultSchema, 'inspect link');
      expectAnswer(await call('post', '/api/notification-links/unsubscribe', { token }), 200, unsubscribeResultSchema, 'unsubscribe');
    });

    it("answers the person's own push devices", async () => {
      // The VAPID key and a subscription are sealed with the data encryption key, which tests don't have.
      vi.spyOn(pushService, 'getPublicKey').mockResolvedValue('BPublicKeyMadeUpForTheTest');
      vi.spyOn(pushService, 'subscribe').mockResolvedValue('0190a000-0000-7000-8000-0000000000a1');
      expectAnswer(await call('get', '/api/push/public-key'), 200, pushPublicKeyResponseSchema, 'public key');
      expectAnswer(await call('get', '/api/push/subscriptions/count'), 200, pushDeviceCountResponseSchema, 'count');
      const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/answers-push', keys: { p256dh: 'p256dh-key', auth: 'auth-key' } };
      expectAnswer(await call('post', '/api/push/subscriptions', subscription), 201, pushSubscribedResponseSchema, 'subscribe');
      expectAnswer(await call('post', '/api/push/subscriptions/remove', { endpoint: subscription.endpoint }), 200, pushUnsubscribedResponseSchema, 'remove');
      expectAnswer(await call('post', '/api/push/test'), 200, pushSendResultSchema, 'test push');
    });
  });

  describe('settings', () => {
    it("answers the ledger's general settings, the time zones and the deployment's settings", async () => {
      const general = await call('get', '/api/settings/general');
      expectAnswer(general, 200, generalSettingsResponseSchema, 'GET general');
      expect(general.body.map((s: { setting_key: string }) => s.setting_key)).toContain('application_timezone');
      const saved = await call('post', '/api/settings/general', { settings: { application_timezone: 'America/Chicago' } });
      expectAnswer(saved, 200, settingsActionResponseSchema, 'POST general');
      expectAnswer(await call('get', '/api/settings/timezones'), 200, timeZoneOptionsResponseSchema, 'GET timezones');
      expectAnswer(await call('get', '/api/admin/deployment-settings'), 200, deploymentSettingsResponseSchema, 'GET deployment');
      // Nothing to change: the settings as they are (the full save is deploymentSettings.test.ts's).
      expectAnswer(await call('put', '/api/admin/deployment-settings', { settings: {} }), 200, deploymentSettingsSavedResponseSchema, 'PUT deployment');
    });
  });

  describe('the bank import', () => {
    it('answers its status, settings, users, syncs, log and SimpleFin pages', async () => {
      const linked = (
        await tenant.pool.query<{ uuid: string }>(
          `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled)
           VALUES ('Linked', 'checking', 'cash', 'Asset', 'ACT-answers', 'simplefin', true) RETURNING uuid`
        )
      ).rows[0];
      await tenant.pool.query(
        `INSERT INTO import_sync_log (sync_type, sync_status, sync_trigger, import_provider, sync_start_time, sync_end_time, records_processed,
           accounts_synced, transactions_imported, transactions_updated, balance_adjustments_created, error_message, api_response_time_ms, user_id)
         VALUES ('manual', 'partial', 'user', 'simplefin', now() - interval '1 minute', now(), 4, 1, 2, 1, 0, 'Some transactions could not be saved', 850, $1),
                ('automatic', 'started', 'schedule', 'simplefin', now(), NULL, 0, 0, 0, 0, 0, NULL, NULL, NULL)`,
        [admin.id]
      );

      expectAnswer(await call('get', '/api/import/status'), 200, importStatusResponseSchema, 'status');
      expectAnswer(await call('get', '/api/import/settings'), 200, importSettingsResponseSchema, 'GET settings');
      const saved = await call('post', '/api/import/settings', { settings: { import_sync_time: '06:00', import_user_id: String(admin.id) } });
      expectAnswer(saved, 200, settingsActionResponseSchema, 'POST settings');
      // Now with settings stored.
      expectAnswer(await call('get', '/api/import/status'), 200, importStatusResponseSchema, 'status with settings');
      expectAnswer(await call('get', '/api/import/settings'), 200, importSettingsResponseSchema, 'GET settings, stored');
      expectAnswer(await call('post', '/api/import/scheduler/start'), 200, importSchedulerResponseSchema, 'scheduler start');
      expectAnswer(await call('post', '/api/import/scheduler/stop'), 200, importSchedulerResponseSchema, 'scheduler stop');
      expectAnswer(await call('get', '/api/import/users'), 200, importUsersResponseSchema, 'users');
      expectAnswer(await call('get', '/api/import/accounts'), 200, importAccountsResponseSchema, 'accounts');
      expectAnswer(await call('post', '/api/import/sync'), 200, importSyncResponseSchema, 'sync');
      expectAnswer(await call('post', `/api/import/sync/${linked.uuid}`), 200, importAccountSyncResponseSchema, 'account sync');
      const log = await call('get', '/api/import/sync-log?limit=5&offset=0');
      expectAnswer(log, 200, syncLogPageResponseSchema, 'sync log');
      expect(log.body.syncLogs).toHaveLength(2);
      expectAnswer(await call('post', '/api/import/test-sync'), 200, importTestSyncResponseSchema, 'test sync');
      expectAnswer(await call('post', '/api/import/fix-budget-period-items'), 200, importBudgetPeriodRepairResponseSchema, 'fix items');
      const sfAccounts = await call('get', '/api/import/simplefin-accounts');
      expectAnswer(sfAccounts, 200, simpleFinAccountsResponseSchema, 'SimpleFin accounts');
      expect(sfAccounts.body.accounts.map((a: { status: string }) => a.status)).toEqual(['Connected', 'Disconnected']);
      const detail = await call('get', '/api/import/simplefin-account-transactions?account_id=ACT-answers&days=30');
      expectAnswer(detail, 200, simpleFinAccountDetailResponseSchema, 'SimpleFin account detail');

      // An account's own link to its bank account (the account routes).
      const cash = (
        await tenant.pool.query<{ uuid: string }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Cash', 'checking', 'cash', 'Asset') RETURNING uuid`)
      ).rows[0];
      expectAnswer(await call('post', `/api/accounts/${cash.uuid}/connect-bank`, { import_account_id: 'ACT-OLD' }), 200, bankLinkChangedResponseSchema, 'connect bank');
      expectAnswer(await call('patch', `/api/accounts/${cash.uuid}/import-settings`, { import_auto_review: true }), 200, bankLinkChangedResponseSchema, 'account import settings');
      expectAnswer(await call('post', `/api/accounts/${cash.uuid}/disconnect-bank`), 200, bankLinkChangedResponseSchema, 'disconnect bank');
    });
  });

  describe('backups and OneDrive', () => {
    it('answers the backup pages, the restore status and OneDrive', async () => {
      const created = new Date('2026-11-01T03:00:00.000Z');
      vi.spyOn(backupService, 'listBackups').mockResolvedValue([
        { fileName: 'nuggets_backup_2026-11-01.enc', filePath: '/backups/nuggets_backup_2026-11-01.enc', size: 2048, created, format: 'legacy' },
      ]);
      // The schedulers' start and stop save backup_enabled, a deployment setting: left as it is.
      vi.spyOn(backupService, 'saveBackupSetting').mockResolvedValue(undefined);

      const list = await call('get', '/api/backup/list');
      expectAnswer(list, 200, backupListResponseSchema, 'list');
      expect(answerProblem(backupFileResponseSchema, list.body.backups[0])).toBeNull();
      expectAnswer(await call('get', '/api/backup/create-status'), 200, backupCreateStatusResponseSchema, 'create status');
      expectAnswer(await call('get', '/api/backup/key/status'), 200, backupKeyStatusResponseSchema, 'key status');
      expectAnswer(await call('get', '/api/backup/restore-status'), 200, restoreStatusResponseSchema, 'restore status');
      expectAnswer(await call('get', '/api/backup/status'), 200, backupStatusResponseSchema, 'status');
      expectAnswer(await call('get', '/api/backup/settings'), 200, backupSettingsResponseSchema, 'GET settings');
      expectAnswer(await call('post', '/api/backup/settings', { settings: { backup_retention_days: '90' } }), 200, settingsActionResponseSchema, 'POST settings');
      expectAnswer(await call('post', '/api/backup/scheduler/start'), 200, settingsActionResponseSchema, 'scheduler start');
      expectAnswer(await call('post', '/api/backup/scheduler/stop'), 200, settingsActionResponseSchema, 'scheduler stop');
      // OneDrive not set up: no file is in it.
      vi.spyOn(oneDriveService, 'isConfigured').mockResolvedValue(false);
      const notChecked = await call('post', '/api/backup/check-onedrive-status', { fileNames: ['nuggets_backup_2026-11-01.enc'] });
      expectAnswer(notChecked, 200, backupOneDriveStatusResponseSchema, 'OneDrive status, none');
      expectAnswer(await call('get', '/api/onedrive/config'), 200, oneDriveConfigResponseSchema, 'OneDrive config');
      expectAnswer(await call('get', '/api/onedrive/status'), 200, oneDriveStatusResponseSchema, 'OneDrive status, not set up');

      // Set up and connected (Microsoft stubbed).
      vi.spyOn(oneDriveService, 'isConfigured').mockResolvedValue(true);
      vi.spyOn(oneDriveService, 'checkFilesExistence').mockResolvedValue({ 'nuggets_backup_2026-11-01.enc': true });
      vi.spyOn(oneDriveService, 'getStatus').mockResolvedValue({
        connected: true,
        autoSyncEnabled: true,
        folderPath: '/Backups/Nuggets',
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        email: 'admin@example.com',
      });
      vi.spyOn(oneDriveService, 'assertTokenKeyAvailable').mockReturnValue(undefined);
      vi.spyOn(oneDriveService, 'getAuthorizationUrl').mockResolvedValue('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=x');
      vi.spyOn(oneDriveService, 'updateSettings').mockResolvedValue(undefined);
      vi.spyOn(oneDriveService, 'uploadFile').mockResolvedValue(undefined as never);
      vi.spyOn(oneDriveService, 'disconnect').mockResolvedValue(undefined);
      vi.spyOn(backupService, 'findBackup').mockResolvedValue({ fileName: 'nuggets_backup_2026-11-01.enc', filePath: '/backups/nuggets_backup_2026-11-01.enc' } as never);
      const listChecked = await call('get', '/api/backup/list?checkOneDrive=true');
      expectAnswer(listChecked, 200, backupListResponseSchema, 'list, checked');
      expect(listChecked.body.backups[0].onedriveUploaded).toBe(true);
      const checked = await call('post', '/api/backup/check-onedrive-status', { fileNames: ['nuggets_backup_2026-11-01.enc'] });
      expectAnswer(checked, 200, backupOneDriveStatusResponseSchema, 'OneDrive status');
      expectAnswer(await call('get', '/api/onedrive/status'), 200, oneDriveStatusResponseSchema, 'OneDrive status, connected');
      expectAnswer(await call('get', '/api/onedrive/auth'), 200, oneDriveAuthResponseSchema, 'OneDrive auth');
      expectAnswer(await call('post', '/api/onedrive/settings', { autoSyncEnabled: false }), 200, settingsActionResponseSchema, 'OneDrive settings');
      expectAnswer(await call('post', '/api/onedrive/upload', { fileName: 'nuggets_backup_2026-11-01.enc' }), 200, settingsActionResponseSchema, 'OneDrive upload');
      expectAnswer(await call('post', '/api/onedrive/test-upload'), 200, settingsActionResponseSchema, 'OneDrive test upload');
      expectAnswer(await call('delete', '/api/onedrive/disconnect'), 200, settingsActionResponseSchema, 'OneDrive disconnect');
    });
  });

  describe('people and their sign-in', () => {
    it("answers the person's own account, sessions, re-authentication and tokens", async () => {
      const password = 'Answers Kq7 password!';
      const person = await h.addUser('own-account');
      await h.owner.query('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(password, 4), person.id]);
      await h.owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [tenant.tenantId, person.id]);
      const own = await h.signIn(person.id, tenant.tenantId);
      const tenantUuid = (await h.owner.query('SELECT uuid FROM tenants WHERE id = $1', [tenant.tenantId])).rows[0].uuid;

      expectAnswer(await call('get', '/api/auth/setup-status', undefined, own), 200, setupStatusResponseSchema, 'setup status');
      // Signing in ends the session the browser came with: a browser of its own.
      const login = await call('post', '/api/auth/login', { email: person.email, password }, await h.signIn(person.id));
      expectAnswer(login, 200, loginResponseSchema, 'login');
      expectAnswer(await call('get', '/api/auth/me', undefined, own), 200, authMeResponseSchema, 'me');
      expectAnswer(await call('get', '/api/auth/tenants', undefined, own), 200, membershipSummarySchema, 'tenants');
      expectAnswer(await call('post', '/api/auth/active-tenant', { tenantUuid }, own), 200, activeTenantResponseSchema, 'active tenant');
      const profile = await h.call(own, 'put', '/api/auth/profile').field('first_name', 'Ada').field('icon', 'Star');
      expectAnswer(profile, 200, ownProfileResponseSchema, 'profile');

      const sessions = await call('get', '/api/auth/sessions', undefined, own);
      expectAnswer(sessions, 200, ownSessionsResponseSchema, 'sessions');
      const other = sessions.body.sessions.find((s: { isCurrent: boolean }) => !s.isCurrent);
      expectAnswer(await call('delete', `/api/auth/sessions/${other.uuid}`, undefined, own), 200, authMessageResponseSchema, 'end a session');

      expectAnswer(await call('post', '/api/auth/reauthenticate', { password }, own), 200, reauthenticatedResponseSchema, 'reauthenticate');
      const minted = await call('post', '/api/auth/mcp-token', { label: 'Answers', tenantUuid, scope: 'read' }, own);
      expectAnswer(minted, 201, personalAccessTokenMintedResponseSchema, 'mint token');
      expectAnswer(await call('get', '/api/auth/mcp-tokens', undefined, own), 200, personalAccessTokenListResponseSchema, 'tokens');
      expectAnswer(await call('get', `/api/admin/users/${person.uuid}/tokens`), 200, personalAccessTokenListResponseSchema, "an account's tokens");
      expectAnswer(await call('delete', `/api/auth/mcp-tokens/${minted.body.uuid}`, undefined, own), 200, personalAccessTokenRevokedResponseSchema, 'revoke token');
      expectAnswer(await call('delete', `/api/admin/users/${person.uuid}/tokens`), 200, userTokensRevokedResponseSchema, "revoke an account's tokens");

      expectAnswer(await call('get', '/api/passkeys', undefined, own), 200, passkeyListResponseSchema, 'passkeys, none');
      await h.owner.query(
        `INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, device_name, credential_device_type, credential_backed_up, last_used_at, discoverable)
         VALUES ($1, 'answers-key-a', 'key', 0, 'Laptop', 'multiDevice', true, now(), true), ($1, 'answers-key-b', 'key', 0, NULL, NULL, NULL, NULL, NULL)`,
        [person.id]
      );
      expectAnswer(await call('get', '/api/passkeys', undefined, own), 200, passkeyListResponseSchema, 'passkeys');
      expectAnswer(await call('put', '/api/passkeys/answers-key-b', { deviceName: 'Key' }, own), 200, passkeyChangedResponseSchema, 'rename passkey');
      expectAnswer(await call('get', `/api/admin/users/${person.uuid}/passkeys`), 200, passkeyListResponseSchema, "an account's passkeys");
      expectAnswer(await call('delete', `/api/admin/users/${person.uuid}/passkeys/answers-key-b`), 200, passkeyChangedResponseSchema, "remove an account's passkey");

      const changed = await call('put', '/api/auth/change-password', { currentPassword: password, newPassword: 'Answers Kq7 new password!' }, own);
      expectAnswer(changed, 200, passwordChangedResponseSchema, 'change password');
      const again = await h.signIn(person.id, tenant.tenantId);
      expectAnswer(await call('post', '/api/auth/logout', undefined, again), 200, authMessageResponseSchema, 'logout');
    });

    // users.first_name and last_name are nullable. A person with no last name
    // (and one with no name at all) through every route that answers a person.
    it('answers a person with no last name, or no name, through every route that names people', async () => {
      const password = 'Answers Kq7 no-name password!';
      const mono = await h.addUser('no-last-name');
      await h.owner.query('UPDATE users SET password_hash = $1, last_name = NULL, default_color = NULL, icon = NULL WHERE id = $2', [
        bcrypt.hashSync(password, 4),
        mono.id,
      ]);
      await h.owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [tenant.tenantId, mono.id]);
      await h.owner.query('INSERT INTO organization_users (organization_id, user_id) VALUES ($1, $2)', [tenant.organizationId, mono.id]);
      // A member of the organization, not of the ledger, with no name at all.
      const nameless = await h.addUser('no-name');
      await h.owner.query('UPDATE users SET first_name = NULL, last_name = NULL WHERE id = $1', [nameless.id]);
      await h.owner.query('INSERT INTO organization_users (organization_id, user_id) VALUES ($1, $2)', [tenant.organizationId, nameless.id]);

      const own = await h.signIn(mono.id, tenant.tenantId);
      const me = await call('get', '/api/auth/me', undefined, own);
      expectAnswer(me, 200, authMeResponseSchema, 'me');
      expect(me.body.user.last_name).toBeNull();
      const login = await call('post', '/api/auth/login', { email: mono.email, password }, await h.signIn(mono.id));
      expectAnswer(login, 200, loginResponseSchema, 'login');
      const profile = await h.call(own, 'put', '/api/auth/profile').field('icon', 'Star');
      expectAnswer(profile, 200, ownProfileResponseSchema, 'profile');
      const people = await call('get', '/api/tenants/current/users');
      expectAnswer(people, 200, tenantUserListResponseSchema, 'ledger people');
      expect(people.body.find((p: { id: number }) => p.id === mono.id).last_name).toBeNull();
      expectAnswer(await call('get', '/api/admin/users'), 200, adminUserListResponseSchema, 'admin users');
      expectAnswer(await call('get', '/api/import/users'), 200, importUsersResponseSchema, 'import users');
      expectAnswer(await call('get', '/api/tenants/current/members'), 200, memberListResponseSchema, 'ledger members');
      expectAnswer(await call('get', `/api/organizations/${orgUuid}/members`), 200, memberListResponseSchema, 'organization members');
      const candidates = await call('get', '/api/tenants/current/member-candidates');
      expectAnswer(candidates, 200, memberCandidateListResponseSchema, 'candidates');
      expect(candidates.body.find((c: { email: string }) => c.email === nameless.email)).toMatchObject({ firstName: null, lastName: null });
      // Out of the organization again: the next test counts its candidates.
      await h.owner.query('DELETE FROM organization_users WHERE user_id = $1', [nameless.id]);
    });

    it("answers a deployment admin's edits of an account", async () => {
      const email = `answers-created-${Date.now()}@test.local`;
      const created = await call('post', '/api/admin/users', { first_name: 'New', last_name: 'Person', email, password: 'Answers Kq7 created password!' });
      expectAnswer(created, 201, createdUserResponseSchema, 'create user');
      createdUserIds.push(created.body.user.id);
      const uuid = (await h.owner.query('SELECT uuid FROM users WHERE id = $1', [created.body.user.id])).rows[0].uuid;
      const updated = await h.call(session, 'put', `/api/admin/users/${uuid}`).field('first_name', 'Renamed').field('is_locked', 'false');
      expectAnswer(updated, 200, adminUserUpdatedResponseSchema, 'update user');
      const reset = await call('put', `/api/admin/users/${uuid}/change-password`, { newPassword: 'Answers Kq7 reset password!' });
      expectAnswer(reset, 200, adminPasswordResetResponseSchema, 'reset password');
    });

    it("answers the ledger's and the organization's people, and an invitation's", async () => {
      expectAnswer(await call('get', '/api/tenants/current'), 200, tenantDetailSchema, 'current tenant');
      expectAnswer(await call('patch', '/api/tenants/current', { name: 'Answers ledger' }), 200, tenantDetailSchema, 'rename tenant');
      const merchant = (await tenant.pool.query<{ uuid: string }>(`INSERT INTO merchants (name) VALUES ('Adjustments') RETURNING uuid`)).rows[0];
      const withMerchant = await call('patch', '/api/tenants/current/balance-adjustment-merchant', { merchantUuid: merchant.uuid });
      expectAnswer(withMerchant, 200, tenantDetailSchema, 'balance-adjustment merchant');
      expect(withMerchant.body.balanceAdjustmentMerchant).toEqual({ uuid: merchant.uuid, name: 'Adjustments' });
      expectAnswer(await call('get', '/api/tenants/current/members'), 200, memberListResponseSchema, 'tenant members');
      expectAnswer(await call('get', '/api/tenants/current/users'), 200, tenantUserListResponseSchema, 'tenant users');

      // A member of the organization who isn't in the ledger yet.
      const joiner = await h.addUser('joiner');
      await h.owner.query('INSERT INTO organization_users (organization_id, user_id) VALUES ($1, $2)', [tenant.organizationId, joiner.id]);
      const candidates = await call('get', '/api/tenants/current/member-candidates');
      expectAnswer(candidates, 200, memberCandidateListResponseSchema, 'candidates');
      expect(candidates.body).toHaveLength(1);
      const added = await call('post', '/api/tenants/current/members', { email: joiner.email });
      expectAnswer(added, 201, memberDtoSchema, 'add tenant member');
      const memberUuid = added.body.uuid as string;
      expectAnswer(await call('patch', `/api/tenants/current/members/${memberUuid}`, { isAdmin: true }), 200, membershipChangedResponseSchema, 'tenant admin');
      expectAnswer(await call('patch', `/api/tenants/current/members/${memberUuid}/flags`, { loginDisabled: true }), 200, membershipChangedResponseSchema, 'tenant flags');
      expectAnswer(await call('delete', `/api/tenants/current/members/${memberUuid}`), 200, membershipChangedResponseSchema, 'remove tenant member');

      expectAnswer(await call('get', `/api/organizations/${orgUuid}`), 200, organizationDetailSchema, 'organization');
      expectAnswer(await call('patch', `/api/organizations/${orgUuid}`, { name: `Answers org ${Date.now()}` }), 200, organizationDetailSchema, 'rename organization');
      const orgMembers = await call('get', `/api/organizations/${orgUuid}/members`);
      expectAnswer(orgMembers, 200, memberListResponseSchema, 'organization members');
      const joinerRow = orgMembers.body.find((m: { user: { uuid: string } }) => m.user.uuid === joiner.uuid);
      expectAnswer(await call('patch', `/api/organizations/${orgUuid}/members/${joinerRow.uuid}`, { isAdmin: false }), 200, membershipChangedResponseSchema, 'org admin');
      expectAnswer(await call('patch', `/api/organizations/${orgUuid}/members/${joinerRow.uuid}/flags`, { loginDisabled: false }), 200, membershipChangedResponseSchema, 'org flags');
      expectAnswer(await call('delete', `/api/organizations/${orgUuid}/members/${joinerRow.uuid}`), 200, membershipChangedResponseSchema, 'remove org member');

      expectAnswer(await call('get', `/api/organizations/${orgUuid}/simplefin/connection`), 200, simpleFinConnectionDtoSchema.nullable(), 'no SimpleFin connection');
      const invitee = await h.addUser('invitee');
      const invited = await call('post', `/api/organizations/${orgUuid}/invitations`, { email: invitee.email, isAdmin: false });
      expectAnswer(invited, 201, createdInvitationDtoSchema, 'invite');
      expectAnswer(await call('get', `/api/organizations/${orgUuid}/invitations`), 200, invitationListResponseSchema, 'invitations');
      const inviteeSession = await h.signIn(invitee.id);
      const preview = await call('post', '/api/invitations/inspect', { token: invited.body.token }, inviteeSession);
      expectAnswer(preview, 200, invitationPreviewDtoSchema, 'inspect invitation');
      expectAnswer(await call('post', '/api/invitations/accept', { token: invited.body.token }, inviteeSession), 200, acceptedInvitationDtoSchema, 'accept invitation');
      const second = await call('post', `/api/organizations/${orgUuid}/invitations`, { email: `answers-unused-${Date.now()}@test.local` });
      expectAnswer(await call('delete', `/api/organizations/${orgUuid}/invitations/${second.body.invitation.uuid}`), 200, membershipChangedResponseSchema, 'revoke invitation');
    });
  });
});
