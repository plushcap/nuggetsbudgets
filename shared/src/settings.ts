import { z } from 'zod';
import { QUERY_MAX_PAGE, queryBoolean, queryInt } from './primitives.js';
import { instant } from './responses.js';
import { BACKUP_KEY_KINDS, BACKUP_RUN_OUTCOMES, BACKUP_RUN_TRIGGERS, BACKUP_VERIFY_OUTCOMES } from './vocabulary.js';

/**
 * Deployment-wide settings (`system_settings`) that a settings page may change.
 *
 * Each update route accepts only its own keys, with values as they are stored (strings),
 * and rejects anything else. Before, the routes upserted whatever keys they were sent, so
 * a request to one page could overwrite any other setting, such as the SMTP host.
 */

const flag = z.enum(['true', 'false']);

const wholeNumber = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, 'Must be a whole number')
    .refine((v) => Number(v) >= min && Number(v) <= max, `Must be between ${min} and ${max}`);

/** POST /api/import/settings: a ledger's import settings (its organization's admins, requireOrgAdmin) */
export const importSettingsUpdateSchema = z.object({
  settings: z.strictObject({
    import_enabled: flag.optional(),
    import_manual_sync_enabled: flag.optional(),
    import_sync_frequency: z.enum(['daily', 'weekly']).optional(),
    import_sync_time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Must be a time of day (HH:MM)')
      .optional(),
    // Empty imports all available history.
    import_days_back: z
      .union([z.literal(''), wholeNumber(1, 180)], {
        error: 'import_days_back must be a number between 1 and 180, or empty for all history',
      })
      .optional(),
    // Empty means no import user; otherwise a user id (a Postgres integer).
    import_user_id: z.union([z.literal(''), wholeNumber(1, 2147483647)]).optional(),
  }),
});
export type ImportSettingsUpdate = z.infer<typeof importSettingsUpdateSchema>['settings'];
export const IMPORT_SETTING_KEYS = Object.keys(importSettingsUpdateSchema.shape.settings.shape) as Array<
  keyof ImportSettingsUpdate
>;

/** GET /api/import/sync-log: a page of the ledger's sync log, by offset (as pagination.ts's offsetParams reads it). */
export const importSyncLogQuery = z.object({
  limit: queryInt({ min: 1, max: 500, default: 50 }),
  offset: queryInt({ min: 0, max: QUERY_MAX_PAGE * 500, default: 0 }),
});

/** GET /api/import/simplefin-account-transactions: one SimpleFin account's last `days` (1 to 365, 60 when not given). */
export const simpleFinAccountTransactionsQuery = z.object({
  account_id: z.string({ error: 'account_id is required' }).min(1, 'account_id is required').max(200),
  days: queryInt({ min: 1, max: 365, default: 60 }),
});

/** POST /api/admin/notifications/settings (deployment admins) */
export const notificationSettingsUpdateSchema = z.object({
  settings: z.strictObject({
    notification_system_enabled: flag.optional(),
    // A host name (Docker service names may have underscores) or an IP address.
    notification_smtp_host: z
      .string()
      .trim()
      .max(253)
      .regex(/^([A-Za-z0-9._-]*|\[?[0-9A-Fa-f:.]+\]?)$/, 'Must be a host name or IP address')
      .optional(),
    notification_smtp_port: wholeNumber(1, 65535).optional(),
    notification_smtp_username: z.string().max(320).optional(),
    // Write-only: stored encrypted, never returned. Empty leaves the stored one.
    notification_smtp_password: z.string().max(1024).optional(),
    // Lenient on the domain (nuggets@localhost is fine), strict on what could break the
    // From header: no spaces, control characters (\p{Cc}: U+0000-001F, U+007F-009F),
    // quotes, angle brackets or separators.
    notification_email_from_address: z
      .string()
      .max(320)
      .regex(/^([^\s\p{Cc}@<>"(),;:\\]+@[^\s\p{Cc}@<>"(),;:\\]+)?$/u, 'Must be an email address')
      .optional(),
    // Shown as the sender's name. No line breaks or control characters, which could add
    // headers; EmailDeliveryService quotes the rest. The C0 controls and DEL are refused:
    // anything but \p{Cc}, or a C1 control (U+0080-009F).
    notification_email_from_name: z
      .string()
      .max(200)
      .regex(/^(?:[^\p{Cc}]|[\u0080-\u009f])*$/u, 'Must be plain text on one line')
      .optional(),
    notification_logo_url: z
      .union([z.literal(''), z.url({ protocol: /^https?$/ })])
      .optional(),
    notification_max_per_user_per_day: wholeNumber(0, 1000).optional(),
    notification_rules_check_interval: wholeNumber(1, 1440).optional(),
    notification_queue_process_interval: wholeNumber(1, 1440).optional(),
  }),
});
export type NotificationSettingsUpdate = z.infer<typeof notificationSettingsUpdateSchema>['settings'];
export const NOTIFICATION_SETTING_KEYS = Object.keys(
  notificationSettingsUpdateSchema.shape.settings.shape
) as Array<keyof NotificationSettingsUpdate>;

/**
 * The backup settings a deployment admin may change (POST /api/backup/settings validates
 * their values). The other `backup` rows, such as the encrypted backup key, are managed
 * by BackupService and never sent to or accepted from the page.
 */
export const BACKUP_SETTING_KEYS = [
  'backup_enabled',
  'backup_time',
  'backup_frequency_days',
  'backup_retention_days',
] as const;

/** Allowed backup_frequency_days and backup_retention_days (BackupScheduler reads them in this range too). */
export const BACKUP_DAYS_RANGE = { min: 1, max: 365 } as const;

/**
 * A whole number of days in BACKUP_DAYS_RANGE, stored as its string. The scheduler can
 * wait any number of days, but a frequency of 0 or less would back up continuously.
 */
const backupDays = (key: string) => {
  const error = `${key} must be a whole number of days from ${BACKUP_DAYS_RANGE.min} to ${BACKUP_DAYS_RANGE.max}`;
  return z.coerce
    .number({ error })
    .int({ error })
    .min(BACKUP_DAYS_RANGE.min, { error })
    .max(BACKUP_DAYS_RANGE.max, { error })
    .transform(String)
    .optional();
};

/**
 * POST /api/backup/settings (deployment admins): the backup settings a deployment admin
 * may change, BACKUP_SETTING_KEYS; any other key is refused, so the route can't write
 * another setting.
 */
export const backupSettingsUpdateSchema = z.object({
  settings: z.strictObject(
    {
      backup_enabled: z.enum(['true', 'false'], { error: 'backup_enabled must be "true" or "false"' }).optional(),
      backup_time: z
        .string({ error: 'backup_time must be HH:MM' })
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'backup_time must be HH:MM' })
        .optional(),
      backup_frequency_days: backupDays('backup_frequency_days'),
      backup_retention_days: backupDays('backup_retention_days'),
    },
    { error: (issue) => (issue.code === 'invalid_type' ? 'Settings object is required' : undefined) }
  ),
});
export type BackupSettingsUpdate = z.infer<typeof backupSettingsUpdateSchema>['settings'];

const encryptionKeyText = 'encryptionKey must be text';
const fileKeyText = 'fileKey must be the 16-byte file key, in base64';

/** Text that holds an age private key (`AGE-SECRET-KEY-1…`, `AGE-SECRET-KEY-PQ-1…`). */
export function isAgePrivateKeyText(text: string): boolean {
  return /AGE-SECRET-KEY-(PQ-)?1/i.test(text);
}

/** Why an age private key isn't taken where the old backup key goes. */
export const AGE_KEY_IN_OLD_KEY_FIELD =
  'That is an age private key, which stays in your browser: this field takes the old backup key of an older .enc backup.';

/** An age file key (16 bytes) in base64: what the browser sends once it has opened a backup's header. */
export const BACKUP_FILE_KEY_PATTERN = /^[A-Za-z0-9+/]{21}[AQgw]==$/;

/**
 * POST /api/backup/restore and /api/backup/verify (a form, with the backup file), and their
 * /:fileName forms (a backup on the server):
 * - `fileKey`, for an age backup (.tar.age): the file key the browser got by opening the
 *   backup's header with the owner's private key, which never leaves the browser;
 * - `encryptionKey`, for an older .enc backup: the old backup key, if typed. Without one, the
 *   server's own old key.
 */
export const backupRestoreRequestSchema = z
  .object(
    {
      encryptionKey: z
        .string({ error: encryptionKeyText })
        .max(1024, { error: encryptionKeyText })
        .refine((key) => !isAgePrivateKeyText(key), { error: AGE_KEY_IN_OLD_KEY_FIELD })
        .optional(),
      fileKey: z.string({ error: fileKeyText }).regex(BACKUP_FILE_KEY_PATTERN, { error: fileKeyText }).optional(),
    },
    { error: encryptionKeyText }
  )
  .default({});
export type BackupRestoreRequest = z.infer<typeof backupRestoreRequestSchema>;

/** At most this many backup keys: a backup is encrypted to each. */
export const MAX_BACKUP_RECIPIENTS = 5;

/** The longest text taken as a backup key (a post-quantum public key is 1,959 characters). */
export const MAX_BACKUP_RECIPIENT_LENGTH = 4000;


/** The length of an age public key of each built-in form. */
const RECIPIENT_LENGTHS: Array<[prefix: string, length: number]> = [
  ['age1pq1', 1959],
  ['age1', 62],
];

/**
 * What is wrong with a pasted age public key, by its prefix and length only, or null. The
 * server also checks its checksum; neither answer repeats the key.
 */
export function backupRecipientProblem(recipient: string): string | null {
  const key = recipient.trim();
  if (!key) return 'Paste the public key: it starts with age1.';
  if (/^AGE-SECRET-KEY-/i.test(key)) {
    return 'That is a private key. Paste the public key (age1…) instead, and keep the private key to yourself.';
  }
  if (!key.startsWith('age1')) return "That isn't an age public key: one starts with age1 (age1pq1 for a post-quantum key).";
  if (/\s/.test(key)) return 'A public key has no spaces or line breaks in it.';
  if (key.length > MAX_BACKUP_RECIPIENT_LENGTH) return 'That is longer than an age public key.';
  // A hardware key's tag forms (age1tag1…, age1tagpq1…) vary with the plugin.
  if (key.startsWith('age1tag1') || key.startsWith('age1tagpq1')) return null;
  const expected = RECIPIENT_LENGTHS.find(([prefix]) => key.startsWith(prefix))?.[1];
  if (expected !== undefined && key.length !== expected) {
    return key.length < expected
      ? 'That public key is cut short: copy all of it.'
      : "That isn't the length of an age public key: it may be a plugin's own form (a hardware key needs age 1.3's age1tag1 or age1tagpq1 form).";
  }
  return null;
}

const recipientText = 'recipient must be an age public key';

/**
 * POST /api/backup/recipients (deployment admins, with step-up): a backup key. `checked`
 * when the browser made the key pair, or was shown the private key file and it matched.
 */
export const backupRecipientCreateSchema = z.strictObject({
  recipient: z
    .string({ error: recipientText })
    .max(MAX_BACKUP_RECIPIENT_LENGTH, { error: 'That is longer than an age public key.' })
    .superRefine((value, ctx) => {
      const problem = backupRecipientProblem(value);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
  label: z
    .string({ error: 'label must be text' })
    .trim()
    .min(1, { error: 'Give the key a name, such as where you keep it' })
    .max(100, { error: 'A key name is at most 100 characters' }),
  checked: z.boolean({ error: 'checked must be true or false' }).optional(),
});
export type BackupRecipientCreate = z.infer<typeof backupRecipientCreateSchema>;

/** POST /api/backup/check-onedrive-status: whether each of these backups is in OneDrive. */
export const backupOneDriveStatusRequestSchema = z.object({
  fileNames: z
    .array(z.string({ error: 'fileNames must be an array of file names' }).max(255), { error: 'fileNames must be an array' })
    .max(1000),
});

/** GET /api/backup/list: `checkOneDrive=true` also says which are in OneDrive (slower). */
export const backupListQuery = z.object({ checkOneDrive: queryBoolean({ default: false }) });

/**
 * PUT /api/onedrive/config: the OneDrive app registration. The client id and secret are
 * stored encrypted; without a clientSecret the stored one is kept, so an edit of the id or
 * the redirect needn't send it again. Microsoft sends the authorization code to the
 * redirect, so it must be this app's callback.
 */
export const oneDriveConfigRequestSchema = z.object({
  clientId: z.string({ error: 'Client ID is required' }).trim().min(1, 'Client ID is required').max(200),
  redirectUri: z
    .string({ error: 'Redirect URI must be a valid URL' })
    .trim()
    // abort: the check below parses it, and a URL that isn't one would throw there (a 500).
    .url({ error: 'Redirect URI must be a valid URL', abort: true })
    .refine((value) => {
      const url = new URL(value);
      const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      return (url.protocol === 'https:' || (local && url.protocol === 'http:')) && url.pathname === '/api/onedrive/callback';
    }, 'Redirect URI must be https://<your domain>/api/onedrive/callback'),
  clientSecret: z.string().trim().min(1).max(1024).optional(),
});
export type OneDriveConfigRequest = z.infer<typeof oneDriveConfigRequestSchema>;

/**
 * A text value in a query, sent once, of 1 to `max` characters; anything else (absent, empty,
 * sent twice, too long) is undefined. Never refuses, for a page that answers in HTML.
 */
const queryTextOrNothing = (max: number) =>
  z.preprocess((value) => (typeof value === 'string' && value !== '' && value.length <= max ? value : undefined), z.string().optional());

/**
 * GET /api/onedrive/callback: where Microsoft sends the admin's browser back, with the
 * authorization `code` and the `state` it was given, or an `error` code and its
 * description. It never refuses: the route answers the popup's page, and a value missing
 * or not text (sent twice, too long) is missing there.
 */
export const oneDriveCallbackQuery = z.object({
  code: queryTextOrNothing(4096),
  state: queryTextOrNothing(512),
  error: queryTextOrNothing(200),
  error_description: queryTextOrNothing(1000),
});
export type OneDriveCallbackQuery = z.infer<typeof oneDriveCallbackQuery>;

/** POST /api/onedrive/settings: whether each new backup is copied to OneDrive. */
export const oneDriveSettingsRequestSchema = z.object({
  autoSyncEnabled: z.boolean({ error: 'autoSyncEnabled must be a boolean' }),
});

/** POST /api/onedrive/upload: copy one listed backup to OneDrive. */
export const oneDriveUploadRequestSchema = z.object({
  fileName: z.string({ error: 'fileName is required' }).min(1, 'fileName is required').max(255),
});

// ---- Answers the settings pages share ---------------------------------------

/**
 * A write whose answer says only that it worked and what to tell the person: the settings
 * pages' saves, the schedulers' start and stop, OneDrive's and the backups' actions.
 */
export const settingsActionResponseSchema = z.object({ success: z.literal(true), message: z.string() });
export type SettingsActionResponse = z.infer<typeof settingsActionResponseSchema>;

/**
 * A stored setting as a settings page shows it (`system_settings`, or a ledger's own): its
 * value (null when none is stored), its type and its description. The keys are the page's.
 */
export const storedSettingResponseSchema = z.object({
  value: z.string().nullable(),
  type: z.string().nullable(),
  description: z.string().nullable(),
});
export type StoredSetting = z.infer<typeof storedSettingResponseSchema>;
export const storedSettingsResponseSchema = z.record(z.string(), storedSettingResponseSchema);

// ---- General settings and the deployment's --------------------------------------------

/**
 * One of the ledger's general settings (GET /api/settings/general): its key, type and
 * description, and its value, the ledger's own or else the deployment's (null when neither
 * is set). The keys are the route's list, so a setting added to it (a currency, say) is one
 * more row here.
 */
export const generalSettingResponseSchema = z.object({
  setting_key: z.string(),
  setting_type: z.string(),
  description: z.string(),
  setting_value: z.string().nullable(),
  is_user_configurable: z.boolean(),
});
export type SystemSetting = z.infer<typeof generalSettingResponseSchema>;
export const generalSettingsResponseSchema = z.array(generalSettingResponseSchema);

/** One of the time zones GET /api/settings/timezones offers. */
export const timeZoneOptionResponseSchema = z.object({ value: z.string(), label: z.string(), offset: z.string() });
export type TimezoneOption = z.infer<typeof timeZoneOptionResponseSchema>;
export const timeZoneOptionsResponseSchema = z.array(timeZoneOptionResponseSchema);

/** The deployment's own settings (GET /api/admin/deployment-settings): its time zone, UTC when none is stored. */
export const deploymentSettingsResponseSchema = z.object({
  settings: z.object({ application_timezone: z.string() }),
});
export type DeploymentSettings = z.infer<typeof deploymentSettingsResponseSchema>['settings'];

/**
 * PUT /api/admin/deployment-settings: the settings as saved. A new zone moves each ledger's
 * goal history that follows it to the new today; `notice` (with `tenants_not_clamped`, how
 * many, when that is known) says some couldn't be, and saving the zone again retries them.
 */
export const deploymentSettingsSavedResponseSchema = z.object({
  success: z.literal(true),
  settings: deploymentSettingsResponseSchema.shape.settings,
  tenants_not_clamped: z.number().int().optional(),
  notice: z.string().optional(),
});
export type DeploymentSettingsSaved = z.infer<typeof deploymentSettingsSavedResponseSchema>;

// ---- Backup answers --------------------------------------------------------

/** One backup key, as GET /api/backup/recipients lists it. */
export const backupRecipientResponseSchema = z.object({
  uuid: z.string(),
  /** The age public key itself: public, and the page matches a private key against it. */
  recipient: z.string(),
  label: z.string(),
  kind: z.enum(BACKUP_KEY_KINDS),
  /** A hardware key's tag form: the browser can't check one. */
  hardware: z.boolean(),
  fingerprint: z.string(),
  /** When its private key file was shown to match it; null for a pasted key not checked yet. */
  checkedAt: instant.nullable(),
  createdAt: instant,
  /** Who added it, by name; null once they are gone. */
  createdBy: z.string().nullable(),
});
export type BackupRecipient = z.infer<typeof backupRecipientResponseSchema>;

/**
 * GET /api/backup/recipients: the backup keys, this server's signer, how backups are
 * encrypted now (`legacy`: with the old key, until a backup key is set up), and the old key.
 */
export const backupKeysResponseSchema = z.object({
  recipients: z.array(backupRecipientResponseSchema),
  /** The public key this server signs its backups with (`ed25519:…`); null without a data encryption key. */
  signer: z.string().nullable(),
  mode: z.enum(['age', 'legacy', 'none']),
  maxRecipients: z.number().int(),
  legacyKey: z.object({ exists: z.boolean(), downloaded: z.boolean() }),
});
export type BackupKeys = z.infer<typeof backupKeysResponseSchema>;

/** POST /api/backup/recipients and /api/backup/recipients/:uuid/checked: the key as now stored. */
export const backupRecipientSavedResponseSchema = z.object({ success: z.literal(true), recipient: backupRecipientResponseSchema });

/** GET /api/backup/key/status: whether a backup key exists, and whether it has been downloaded. */
export const backupKeyStatusResponseSchema = z.object({ exists: z.boolean(), downloaded: z.boolean() });
export type BackupKeyStatus = z.infer<typeof backupKeyStatusResponseSchema>;

/** GET /api/backup/create-status: the latest manual backup (POST /api/backup/create), for polling. */
export const backupCreateStatusResponseSchema = z.object({
  status: z.enum(['idle', 'running', 'completed', 'failed']),
  fileName: z.string().optional(),
  fileSize: z.number().int().optional(),
  /** A failure people can read, never the internal error. */
  error: z.string().optional(),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  finishedAt: z.iso.datetime({ offset: true }).optional(),
});
export type BackupCreateStatus = z.infer<typeof backupCreateStatusResponseSchema>;

/** GET /api/backup/status: whether automatic backups are set up and on, and their scheduler. */
export const backupStatusResponseSchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  scheduler: z.object({
    enabled: z.boolean(),
    /** A backup is armed, not merely a scheduler constructed. */
    running: z.boolean(),
    hasRunningBackup: z.boolean(),
    nextBackupTime: z.iso.datetime({ offset: true }).optional(),
    lastRunStartedAt: z.iso.datetime({ offset: true }).nullable(),
    lastRunFinishedAt: z.iso.datetime({ offset: true }).nullable(),
    lastRunOutcome: z.enum(['success', 'failed']).nullable(),
    /** Backups are on but none can run until a backup key is set up. */
    waitingForBackupKey: z.boolean(),
    /** Backups are made with the old backup key until a backup key is set up (an upgraded install). */
    usingOldBackupKey: z.boolean(),
  }),
});
export type BackupStatus = z.infer<typeof backupStatusResponseSchema>;

/** GET /api/backup/settings: the backup settings the page edits (never the key or its download flag). */
export const backupSettingsResponseSchema = z.object({ settings: storedSettingsResponseSchema });

/** One backup file GET /api/backup/list lists, newest first. */
export const backupFileResponseSchema = z.object({
  fileName: z.string(),
  size: z.number().int(),
  created: instant,
  sizeFormatted: z.string(),
  /** Whether OneDrive has it: false unless the list was asked to check (`checkOneDrive=true`). */
  onedriveUploaded: z.boolean(),
  /** From its first bytes: `age` opens with a backup key's private key, `legacy` (.enc) with the old key. */
  format: z.enum(['age', 'legacy', 'tar', 'unknown']),
});
export type BackupFile = z.infer<typeof backupFileResponseSchema>;
export const backupListResponseSchema = z.object({ success: z.literal(true), backups: z.array(backupFileResponseSchema) });

/** POST /api/backup/create and the restores (202): it runs in the background; poll its status. */
export const backupStartedResponseSchema = z.object({ success: z.literal(true), started: z.literal(true), message: z.string() });
export type BackupStarted = z.infer<typeof backupStartedResponseSchema>;

/** POST /api/backup/check-onedrive-status: whether OneDrive has each file asked about (none while OneDrive isn't set up). */
export const backupOneDriveStatusResponseSchema = z.object({
  success: z.literal(true),
  status: z.record(z.string(), z.boolean()),
});

/** What a restore is doing, for its status. */
export const RESTORE_PHASES = ['decrypting', 'checking', 'restoring', 'migrating', 'verifying', 'swapping', 'restoring-uploads'] as const;
export type RestorePhase = (typeof RESTORE_PHASES)[number];

/**
 * What a restore did to signing in and the deployment's settings before it swapped the data
 * in (BackupService's carry-over): ended, taken from the running server, kept, and the
 * memberships it removed since, which the restored data still has (for an admin to remove).
 */
export const restoreCarryOverSchema = z.object({
  /** False with the restore command's --ignore-current-database: only the ending ran. */
  tookFromRunningServer: z.boolean(),
  /** The restored data is this deployment's: sign-in state was taken from the running server. */
  sameDeployment: z.boolean(),
  ended: z.object({
    sessions: z.number().int(),
    challenges: z.number().int(),
    tokens: z.number().int(),
    invitations: z.number().int(),
    notifications: z.number().int(),
  }),
  taken: z.object({
    locks: z.number().int(),
    passwords: z.number().int(),
    passkeysRemoved: z.number().int(),
    passkeyCounters: z.number().int(),
    deploymentRoles: z.number().int(),
    loginThrottles: z.number().int(),
    deliveries: z.number().int(),
  }),
  /** People in the backup the running server has deleted since: locked. */
  lockedDeletedSince: z.number().int(),
  kept: z.object({
    backupKeys: z.boolean(),
    oneDriveRegistration: z.boolean(),
    oneDriveConnections: z.number().int(),
    backupRuns: z.boolean(),
    automaticBackupsKeptOn: z.boolean(),
  }),
  removedSince: z.array(
    z.object({
      /** The person's email. */
      person: z.string(),
      kind: z.enum(['organization', 'tenant']),
      /** The organization's or tenant's name. */
      name: z.string(),
      /** Removed as a member, or only as an admin. */
      change: z.enum(['member', 'admin']),
    })
  ),
});
export type RestoreCarryOver = z.infer<typeof restoreCarryOverSchema>;

/** GET /api/backup/restore-status: the restore running, or the last one, and how it ended. */
export const restoreStatusResponseSchema = z.object({
  status: z.enum(['idle', 'running', 'completed', 'failed']),
  phase: z.enum(RESTORE_PHASES).optional(),
  /** The backup's file name. */
  fileName: z.string().optional(),
  startedAt: instant.optional(),
  finishedAt: instant.optional(),
  /** Why it failed, when that is something the person restoring can act on. */
  error: z.string().optional(),
  /** Whether the data was replaced: false for every failure the restore could undo. */
  databaseChanged: z.boolean().optional(),
  /** Where the replaced data was kept. */
  previousDatabase: z.string().nullable().optional(),
  /** How many rows each table had once restored. */
  rowCounts: z.record(z.string(), z.number().int()).optional(),
  /** The backup's own id and time, from its signed manifest (an age backup's). */
  backupId: z.string().nullable().optional(),
  backupCreatedAt: instant.nullable().optional(),
  /** What the restore ended, took from this server and kept (a completed restore's). */
  carryOver: restoreCarryOverSchema.nullable().optional(),
});
export type RestoreStatus = z.infer<typeof restoreStatusResponseSchema>;

/** One backup run, as GET /api/backup/runs lists it (newest first). */
export const backupRunSchema = z.object({
  uuid: z.uuid(),
  startedAt: instant,
  finishedAt: instant,
  trigger: z.enum(BACKUP_RUN_TRIGGERS),
  outcome: z.enum(BACKUP_RUN_OUTCOMES),
  /** Why it failed, written for people; null when it succeeded. */
  message: z.string().nullable(),
  fileName: z.string().nullable(),
  fileSize: z.number().int().nullable(),
  sha256: z.string().nullable(),
  /** The fingerprints of the backup keys it was encrypted to. */
  recipients: z.array(z.string()),
  /** Who started it (by name), when someone did. */
  startedBy: z.string().nullable(),
  /** When it was last verified, by whom (null: the restore command, or no one), and how that went. */
  verifiedAt: instant.nullable(),
  verifiedBy: z.string().nullable(),
  verifyOutcome: z.enum(BACKUP_VERIFY_OUTCOMES).nullable(),
  verifyMessage: z.string().nullable(),
  /** When it last passed a verify (a later failed one leaves this). */
  passedVerifyAt: instant.nullable(),
});
export type BackupRun = z.infer<typeof backupRunSchema>;

/**
 * GET /api/backup/runs: the newest backup runs, when a backup last passed a verify, and
 * whether none has for 90 days (said only once backups have been made for that long).
 */
export const backupRunsResponseSchema = z.object({
  runs: z.array(backupRunSchema),
  lastVerifiedAt: instant.nullable(),
  verifyOverdue: z.boolean(),
});
export type BackupRuns = z.infer<typeof backupRunsResponseSchema>;

/**
 * GET /api/backup/verify-status: the verify running, or the last one. A verify restores the
 * backup into a scratch database, checks it and drops it: the data stays as it is.
 */
export const verifyStatusResponseSchema = z.object({
  status: z.enum(['idle', 'running', 'completed', 'failed']),
  phase: z.enum(RESTORE_PHASES).optional(),
  fileName: z.string().optional(),
  startedAt: instant.optional(),
  finishedAt: instant.optional(),
  error: z.string().optional(),
  backupId: z.string().nullable().optional(),
  backupCreatedAt: instant.nullable().optional(),
  schemaVersion: z.string().nullable().optional(),
  appVersion: z.string().nullable().optional(),
  rowCounts: z.record(z.string(), z.number().int()).optional(),
});
export type VerifyStatus = z.infer<typeof verifyStatusResponseSchema>;

// ---- OneDrive answers -------------------------------------------------------------

/** GET /api/onedrive/config: the app registration, never its secret (only whether one is set). */
export const oneDriveConfigResponseSchema = z.object({
  success: z.literal(true),
  clientId: z.string(),
  redirectUri: z.string(),
  clientSecretSet: z.boolean(),
});
export type OneDriveConfig = z.infer<typeof oneDriveConfigResponseSchema>;

/**
 * GET /api/onedrive/status: whether OneDrive is set up for the deployment (with `message`
 * when it isn't), and whether the signed-in admin connected theirs, with its settings and
 * the account's address when Microsoft gives it.
 */
export const oneDriveStatusResponseSchema = z.union([
  z.object({ success: z.literal(true), configured: z.literal(false), message: z.string() }),
  z.object({
    success: z.literal(true),
    configured: z.literal(true),
    connected: z.boolean(),
    autoSyncEnabled: z.boolean().optional(),
    folderPath: z.string().optional(),
    expiresAt: instant.optional(),
    email: z.string().optional(),
  }),
]);
export type OneDriveStatus = z.infer<typeof oneDriveStatusResponseSchema>;

/** GET /api/onedrive/auth: the Microsoft sign-in page to open. */
export const oneDriveAuthResponseSchema = z.object({ success: z.literal(true), authUrl: z.string() });

// ---- Settings bodies (checked before the handler runs) ----------------------

const SETTINGS_REQUIRED = 'Settings object is required';

/**
 * POST /api/settings/general body: `{ settings: { key: value, … } }`. Which keys a ledger
 * may set and what each takes is checked against the stored settings by the route
 * (generalSettingsError), so this checks only the shape.
 */
export const generalSettingsUpdateSchema = z.object({
  settings: z.record(z.string(), z.unknown(), { error: SETTINGS_REQUIRED }),
});
export type GeneralSettingsUpdateInput = z.infer<typeof generalSettingsUpdateSchema>;

export const DEPLOYMENT_TIME_ZONE_ERROR = 'application_timezone must be an IANA time zone such as America/New_York';

/**
 * PUT /api/admin/deployment-settings body: `{ settings: { application_timezone } }`, the
 * deployment's own settings; any other key is refused, naming it. Whether the zone
 * is one the database knows is checked by the route.
 */
export const deploymentSettingsUpdateSchema = z.object({
  settings: z.strictObject(
    {
      application_timezone: z
        .string({ error: DEPLOYMENT_TIME_ZONE_ERROR })
        .max(100, { error: DEPLOYMENT_TIME_ZONE_ERROR })
        .optional(),
    },
    {
      error: (issue) =>
        issue.code === 'unrecognized_keys' ? `Setting '${issue.keys[0]}' is not a deployment setting` : SETTINGS_REQUIRED,
    }
  ),
});
export type DeploymentSettingsUpdateInput = z.infer<typeof deploymentSettingsUpdateSchema>;
