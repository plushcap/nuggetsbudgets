import type { ClientBase, Pool, PoolClient } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { RestoreCarryOver } from '@nuggets/shared';
import type { DB } from '../../db/schema.generated.js';
import { ControlPlaneError } from '../controlPlaneErrors.js';
import { readSystemSettings, writeSystemSetting } from '../systemSettings.js';

/**
 * What a restore takes from the running server, and ends, before the restored data is
 * swapped in: run in the scratch database as the owner, after the migrations and the checks,
 * in one transaction (a verify skips it). Signing in after a restore is never wider than
 * before it, and the restore can't leave the deployment without an admin who can sign in.
 *
 * - **Ended, on every restore:** every session and WebAuthn challenge, every personal access
 *   token (revoked: `restore`), every invitation not accepted yet; and the queued
 *   notifications are marked failed, so nothing the backup had queued goes out late.
 * - **Taken from the running server, when the restored data is this deployment's**
 *   (`deployment.uuid` equal; people, tenants and passkeys matched by uuid, and only those on
 *   both sides touched): a lock or disabled sign-in (only ever set, never cleared), a password
 *   changed since, the passkeys it no longer has (and the counters of those it has), the
 *   deployment roles it no longer gives, the sign-in throttles, and the notification
 *   deliveries made since the backup (what stops an alert going twice). People the running
 *   server has deleted since are locked. A restore onto another server (disaster recovery)
 *   skips these: by uuid alone, "deleted since" can't be told from "never on this server".
 *   This is the one place `is_locked` and `login_disabled` change outside
 *   applyUserAccountFlags, in data not yet served.
 * - **Kept from the running server, on any server:** its backup keys (when it has any), its
 *   OneDrive app registration (when set) and connections (by person), and its record of
 *   backups (when it has any); automatic backups stay on when they are on here.
 * - **Reported, not changed:** organization and tenant memberships, and admin flags, the
 *   running server removed since: the organization's own data, for an admin to remove again.
 * - **Then refused** when no one could manage the deployment afterwards: a web restore unless
 *   the person restoring is, in the restored data, a deployment admin who can sign in; the
 *   restore command when the restored data has no such admin at all.
 *
 * The restore command's --ignore-current-database takes nothing from the running database
 * (someone with write access to it could have locked every admin): only the ending runs.
 */

/** A restore refused by what the restored data would let people do: nothing is changed. */
export class RestoreCarryOverRefusal extends ControlPlaneError {
  constructor(code: string, message: string) {
    super(422, code, message);
    this.name = 'RestoreCarryOverRefusal';
  }
}

export interface CarryOverOptions {
  /** The web restore's person, by their id in the running data; null for the restore command. */
  restorerId: number | null;
  /** When the backup was made (its manifest): the deliveries made since are copied in. */
  backupCreatedAt: string | null;
}

/** What a restore did to sign-in and the deployment's settings (RestoreCarryOver in @nuggets/shared). */
export type CarryOverReport = RestoreCarryOver;

/** The OneDrive app registration: taken from the running server, all three, when it has a client id. */
const ONEDRIVE_REGISTRATION = ['onedrive_client_id', 'onedrive_client_secret', 'onedrive_redirect_uri'] as const;
/** What a queued notification the restore stopped says. */
const NOT_SENT = 'Not sent: the data was restored from a backup';

/** The running server's state a restore takes, read in one snapshot. */
export interface RunningState {
  deploymentUuid: string | null;
  /** The person restoring through the web app: their email in the running data. */
  restorerEmail: string | null;
  users: Array<{
    uuid: string;
    is_locked: boolean;
    login_disabled: boolean;
    password_hash: string;
    password_changed_at: string | null;
    must_change_password: boolean;
  }>;
  passkeys: Array<{ uuid: string; counter: string }>;
  deploymentRoles: Array<{ user_uuid: string; role: string }>;
  loginThrottles: Array<Record<string, unknown>>;
  deliveries: Array<Record<string, unknown>>;
  organizations: string[];
  tenants: string[];
  organizationMembers: Array<{ user_uuid: string; organization_uuid: string; is_admin: boolean }>;
  tenantMembers: Array<{ user_uuid: string; tenant_uuid: string; is_admin: boolean }>;
  backupRecipients: Array<Record<string, unknown>>;
  oneDriveRegistration: Record<string, string | null> | null;
  oneDriveTokens: Array<Record<string, unknown>>;
  backupRuns: Array<Record<string, unknown>>;
  automaticBackupsOn: boolean;
}

/**
 * The settings helpers (services/systemSettings.ts, the one place that names the table) on
 * `client`'s own connection, so they run in its transaction. Never destroyed: that would end
 * the caller's connection.
 */
function onClient(client: ClientBase): Kysely<DB> {
  // What Kysely's driver uses of a pooled client: query, and release (here, nothing to give back).
  const borrowed = { query: client.query.bind(client), release: () => {} } as unknown as PoolClient;
  const pool = { connect: async () => borrowed, end: async () => {} } as unknown as Pool;
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

/** Timestamps as ISO text, so they survive the trip through JSON into the scratch database. */
const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : (value as string | null));

/**
 * Read what a restore takes from the running database (`client`, the owner's connection to
 * it), in one read-only snapshot with row security off.
 */
export async function readRunningState(client: ClientBase, options: Pick<CarryOverOptions, 'restorerId' | 'backupCreatedAt'>): Promise<RunningState> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query('SET LOCAL row_security = off');
    const rows = async <T>(text: string, values: unknown[] = []): Promise<T[]> => (await client.query(text, values)).rows as T[];
    const deployment = await rows<{ uuid: string }>('SELECT uuid FROM deployment ORDER BY id LIMIT 1');
    const restorer = options.restorerId === null ? [] : await rows<{ email: string }>('SELECT email FROM users WHERE id = $1', [options.restorerId]);
    const users = (
      await rows<RunningState['users'][number] & { password_changed_at: unknown }>(
        'SELECT uuid, is_locked, login_disabled, password_hash, password_changed_at, must_change_password FROM users'
      )
    ).map((u) => ({ ...u, password_changed_at: iso(u.password_changed_at) }));
    const settings: Partial<Record<string, string | null>> = await readSystemSettings([...ONEDRIVE_REGISTRATION, 'backup_enabled'], onClient(client));
    const setting = (key: string) => settings[key] ?? null;
    const registration = setting('onedrive_client_id')?.trim()
      ? Object.fromEntries(ONEDRIVE_REGISTRATION.map((key) => [key, setting(key)]))
      : null;
    const state: RunningState = {
      deploymentUuid: deployment[0]?.uuid ?? null,
      restorerEmail: restorer[0]?.email ?? null,
      users,
      passkeys: await rows('SELECT uuid, counter FROM passkey_credentials'),
      deploymentRoles: await rows('SELECT u.uuid AS user_uuid, d.role FROM deployment_users d JOIN users u ON u.id = d.user_id'),
      loginThrottles: await rows(
        'SELECT uuid, throttle_key, attempts, locked_until, last_attempt_at, created_at FROM login_throttles'
      ),
      // Made since the backup (all of them for a backup that doesn't say when it was made).
      deliveries: await rows(
        `SELECT d.uuid, t.uuid AS tenant_uuid, u.uuid AS user_uuid, d.rule_key, d.subject_key, d.created_at
           FROM notification_deliveries d JOIN tenants t ON t.id = d.tenant_id JOIN users u ON u.id = d.user_id
          WHERE $1::timestamptz IS NULL OR d.created_at >= $1::timestamptz`,
        [options.backupCreatedAt]
      ),
      organizations: (await rows<{ uuid: string }>('SELECT uuid FROM organizations')).map((o) => o.uuid),
      tenants: (await rows<{ uuid: string }>('SELECT uuid FROM tenants')).map((t) => t.uuid),
      organizationMembers: await rows(
        `SELECT u.uuid AS user_uuid, o.uuid AS organization_uuid, m.is_admin
           FROM organization_users m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id`
      ),
      tenantMembers: await rows(
        `SELECT u.uuid AS user_uuid, t.uuid AS tenant_uuid, m.is_admin
           FROM tenant_users m JOIN users u ON u.id = m.user_id JOIN tenants t ON t.id = m.tenant_id`
      ),
      backupRecipients: await rows(
        `SELECT r.uuid, r.recipient, r.label, r.kind, r.checked_at, r.created_at, u.uuid AS created_by_uuid
           FROM backup_recipients r LEFT JOIN users u ON u.id = r.created_by`
      ),
      oneDriveRegistration: registration,
      oneDriveTokens: await rows(
        `SELECT t.uuid, u.uuid AS user_uuid, t.access_token, t.refresh_token, t.expires_at, t.folder_path,
                t.auto_sync_enabled, t.created_at, t.updated_at
           FROM onedrive_tokens t JOIN users u ON u.id = t.user_id`
      ),
      backupRuns: await rows(
        `SELECT r.uuid, r.started_at, r.finished_at, r.trigger, r.outcome, r.message, r.file_name, r.file_size, r.sha256,
                r.recipients, s.uuid AS started_by_uuid, r.verified_at, v.uuid AS verified_by_uuid, r.verify_outcome, r.verify_message
           FROM backup_runs r LEFT JOIN users s ON s.id = r.started_by LEFT JOIN users v ON v.id = r.verified_by`
      ),
      automaticBackupsOn: setting('backup_enabled') === 'true',
    };
    await client.query('COMMIT');
    return state;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

/**
 * Apply the carry-over to the scratch database (`client`, the owner's connection to it) in
 * one transaction, then check that someone can manage the deployment. `running` is null
 * with --ignore-current-database: only the ending runs. Throws RestoreCarryOverRefusal.
 */
export async function applyCarryOver(client: ClientBase, running: RunningState | null, options: CarryOverOptions): Promise<CarryOverReport> {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL row_security = off');
    const report = await carryOver(client, running);
    await assertSomeoneCanManage(client, running, options);
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function carryOver(client: ClientBase, running: RunningState | null): Promise<CarryOverReport> {
  const count = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rowCount ?? 0;
  const json = (value: unknown) => JSON.stringify(value);

  const report: CarryOverReport = {
    tookFromRunningServer: running !== null,
    sameDeployment: false,
    ended: {
      sessions: await count('DELETE FROM sessions'),
      challenges: await count('DELETE FROM webauthn_challenges'),
      tokens: await count("UPDATE personal_access_tokens SET revoked_at = now(), revoked_reason = 'restore' WHERE revoked_at IS NULL"),
      invitations: await count('UPDATE organization_invitations SET revoked_at = now() WHERE accepted_at IS NULL AND revoked_at IS NULL'),
      notifications: await count(
        "UPDATE notifications SET status = 'failed', error_message = $1, updated_at = now() WHERE status IN ('pending', 'processing')",
        [NOT_SENT]
      ),
    },
    taken: { locks: 0, passwords: 0, passkeysRemoved: 0, passkeyCounters: 0, deploymentRoles: 0, loginThrottles: 0, deliveries: 0 },
    lockedDeletedSince: 0,
    kept: { backupKeys: false, oneDriveRegistration: false, oneDriveConnections: 0, backupRuns: false, automaticBackupsKeptOn: false },
    removedSince: [],
  };
  if (!running) return report;

  const restoredDeployment = (await client.query<{ uuid: string }>('SELECT uuid FROM deployment ORDER BY id LIMIT 1')).rows[0]?.uuid ?? null;
  report.sameDeployment = restoredDeployment !== null && restoredDeployment === running.deploymentUuid;

  if (report.sameDeployment) {
    const users = json(running.users);
    const liveUsers = `jsonb_to_recordset($1::jsonb) AS l(uuid uuid, is_locked boolean, login_disabled boolean, password_hash text,
                         password_changed_at timestamptz, must_change_password boolean)`;
    // A lock or a disabled sign-in: only ever set.
    report.taken.locks =
      (await count(`UPDATE users u SET is_locked = true FROM ${liveUsers} WHERE l.uuid = u.uuid AND l.is_locked AND NOT u.is_locked`, [users])) +
      (await count(`UPDATE users u SET login_disabled = true FROM ${liveUsers} WHERE l.uuid = u.uuid AND l.login_disabled AND NOT u.login_disabled`, [users]));
    // A password changed since the backup: the current one works, the old one doesn't.
    report.taken.passwords = await count(
      `UPDATE users u SET password_hash = l.password_hash, password_changed_at = l.password_changed_at, must_change_password = l.must_change_password
         FROM ${liveUsers}
        WHERE l.uuid = u.uuid AND l.password_changed_at IS NOT NULL
          AND (u.password_changed_at IS NULL OR l.password_changed_at > u.password_changed_at)`,
      [users]
    );
    const liveUserUuids = running.users.map((u) => u.uuid);
    // People the running server deleted since.
    report.lockedDeletedSince = await count('UPDATE users SET is_locked = true WHERE NOT is_locked AND NOT (uuid = ANY($1::uuid[]))', [liveUserUuids]);
    // Passkeys: those it no longer has go; the counters of the rest are its, so a clone is still caught.
    report.taken.passkeysRemoved = await count(
      `DELETE FROM passkey_credentials p USING users u
        WHERE p.user_id = u.id AND u.uuid = ANY($1::uuid[]) AND NOT (p.uuid = ANY($2::uuid[]))`,
      [liveUserUuids, running.passkeys.map((p) => p.uuid)]
    );
    report.taken.passkeyCounters = await count(
      `UPDATE passkey_credentials p SET counter = l.counter
         FROM jsonb_to_recordset($1::jsonb) AS l(uuid uuid, counter bigint)
        WHERE p.uuid = l.uuid AND l.counter > p.counter`,
      [json(running.passkeys)]
    );
    // Deployment roles: those it no longer gives go; an admin it made support is support.
    const roles = json(running.deploymentRoles);
    report.taken.deploymentRoles =
      (await count(
        `DELETE FROM deployment_users d USING users u
          WHERE d.user_id = u.id AND u.uuid = ANY($1::uuid[])
            AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS l(user_uuid uuid, role text) WHERE l.user_uuid = u.uuid)`,
        [liveUserUuids, roles]
      )) +
      (await count(
        `UPDATE deployment_users d SET role = l.role
           FROM users u, jsonb_to_recordset($1::jsonb) AS l(user_uuid uuid, role text)
          WHERE d.user_id = u.id AND l.user_uuid = u.uuid AND d.role = 'admin' AND l.role <> 'admin'`,
        [roles]
      ));
    // The sign-in throttles: a restore doesn't reset the count of failed sign-ins.
    await client.query('DELETE FROM login_throttles');
    report.taken.loginThrottles = await count(
      `INSERT INTO login_throttles (uuid, throttle_key, attempts, locked_until, last_attempt_at, created_at)
       SELECT uuid, throttle_key, attempts, locked_until, last_attempt_at, created_at
         FROM jsonb_to_recordset($1::jsonb) AS l(uuid uuid, throttle_key text, attempts integer, locked_until timestamptz,
                                                 last_attempt_at timestamptz, created_at timestamptz)`,
      [json(running.loginThrottles)]
    );
    // The deliveries made since: what stops an alert going twice. tenant_id given (its default
    // is current_tenant_id()); a tenant or person not in the restored data is left out.
    report.taken.deliveries = await count(
      `INSERT INTO notification_deliveries (uuid, tenant_id, user_id, rule_key, subject_key, created_at)
       SELECT l.uuid, t.id, u.id, l.rule_key, l.subject_key, l.created_at
         FROM jsonb_to_recordset($1::jsonb) AS l(uuid uuid, tenant_uuid uuid, user_uuid uuid, rule_key text, subject_key text, created_at timestamptz)
         JOIN tenants t ON t.uuid = l.tenant_uuid
         JOIN users u ON u.uuid = l.user_uuid
       ON CONFLICT DO NOTHING`,
      [json(running.deliveries)]
    );
    report.removedSince = await removedSince(client, running, liveUserUuids);
  }

  // Kept from the running server, on any server.
  if (running.backupRecipients.length > 0) {
    await client.query('DELETE FROM backup_recipients');
    await client.query(
      `INSERT INTO backup_recipients (uuid, recipient, label, kind, checked_at, created_at, created_by)
       SELECT l.uuid, l.recipient, l.label, l.kind, l.checked_at, l.created_at, u.id
         FROM jsonb_to_recordset($1::jsonb) AS l(uuid uuid, recipient text, label text, kind text, checked_at timestamptz,
                                                 created_at timestamptz, created_by_uuid uuid)
         LEFT JOIN users u ON u.uuid = l.created_by_uuid`,
      [json(running.backupRecipients)]
    );
    report.kept.backupKeys = true;
  }
  const settings = onClient(client);
  if (running.oneDriveRegistration) {
    // An unset one as empty, which the OneDrive service reads as unset too.
    for (const [key, value] of Object.entries(running.oneDriveRegistration)) {
      await writeSystemSetting(key, value ?? '', { category: 'backup' }, settings);
    }
    report.kept.oneDriveRegistration = true;
  }
  // Its OneDrive connections, by person; a connection whose person isn't in the restored data
  // is dropped (they connect again). Sealed with this server's key, which the backup's aren't.
  await client.query('DELETE FROM onedrive_tokens');
  report.kept.oneDriveConnections = await count(
    `INSERT INTO onedrive_tokens (uuid, user_id, access_token, refresh_token, expires_at, folder_path, auto_sync_enabled, created_at, updated_at)
     SELECT l.uuid, u.id, l.access_token, l.refresh_token, l.expires_at, l.folder_path, l.auto_sync_enabled, l.created_at, l.updated_at
       FROM jsonb_to_recordset($1::jsonb) AS l(uuid uuid, user_uuid uuid, access_token text, refresh_token text, expires_at timestamptz,
                                               folder_path text, auto_sync_enabled boolean, created_at timestamptz, updated_at timestamptz)
       JOIN users u ON u.uuid = l.user_uuid`,
    [json(running.oneDriveTokens)]
  );
  if (running.backupRuns.length > 0) {
    await client.query('DELETE FROM backup_runs');
    await client.query(
      `INSERT INTO backup_runs (uuid, started_at, finished_at, trigger, outcome, message, file_name, file_size, sha256, recipients,
                                started_by, verified_at, verified_by, verify_outcome, verify_message)
       SELECT l.uuid, l.started_at, l.finished_at, l.trigger, l.outcome, l.message, l.file_name, l.file_size, l.sha256, l.recipients,
              s.id, l.verified_at, v.id, l.verify_outcome, l.verify_message
         FROM jsonb_to_recordset($1::jsonb) AS l(uuid uuid, started_at timestamptz, finished_at timestamptz, trigger text, outcome text,
                                                 message text, file_name text, file_size bigint, sha256 text, recipients text[],
                                                 started_by_uuid uuid, verified_at timestamptz, verified_by_uuid uuid,
                                                 verify_outcome text, verify_message text)
         LEFT JOIN users s ON s.uuid = l.started_by_uuid
         LEFT JOIN users v ON v.uuid = l.verified_by_uuid`,
      [json(running.backupRuns)]
    );
    report.kept.backupRuns = true;
  }
  // The schedule and retention are the backup's (they are data), but a restore never turns
  // automatic backups off while they are on here: every server has the setting, so "set here"
  // can't tell a choice from the default.
  if (running.automaticBackupsOn && (await readSystemSettings(['backup_enabled'], settings)).backup_enabled !== 'true') {
    await writeSystemSetting('backup_enabled', 'true', { category: 'backup' }, settings);
    report.kept.automaticBackupsKeptOn = true;
  }
  return report;
}

/**
 * The memberships and admin flags the running server removed since, which the restored data
 * still has (people, organizations and tenants on both sides): reported, not changed.
 */
async function removedSince(client: ClientBase, running: RunningState, liveUserUuids: string[]): Promise<CarryOverReport['removedSince']> {
  const { rows } = await client.query<{ email: string; kind: 'organization' | 'tenant'; name: string; admin_only: boolean }>(
    `WITH live_org AS (SELECT * FROM jsonb_to_recordset($4::jsonb) AS l(user_uuid uuid, organization_uuid uuid, is_admin boolean)),
          live_tenant AS (SELECT * FROM jsonb_to_recordset($5::jsonb) AS l(user_uuid uuid, tenant_uuid uuid, is_admin boolean))
     SELECT u.email, 'organization' AS kind, o.name, (l.user_uuid IS NOT NULL) AS admin_only
       FROM organization_users m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id
       LEFT JOIN live_org l ON l.user_uuid = u.uuid AND l.organization_uuid = o.uuid
      WHERE u.uuid = ANY($1::uuid[]) AND o.uuid = ANY($2::uuid[])
        AND (l.user_uuid IS NULL OR (m.is_admin AND NOT l.is_admin))
     UNION ALL
     SELECT u.email, 'tenant', t.name, (l.user_uuid IS NOT NULL)
       FROM tenant_users m JOIN users u ON u.id = m.user_id JOIN tenants t ON t.id = m.tenant_id
       LEFT JOIN live_tenant l ON l.user_uuid = u.uuid AND l.tenant_uuid = t.uuid
      WHERE u.uuid = ANY($1::uuid[]) AND t.uuid = ANY($3::uuid[])
        AND (l.user_uuid IS NULL OR (m.is_admin AND NOT l.is_admin))
     ORDER BY 1, 2, 3`,
    [liveUserUuids, running.organizations, running.tenants, JSON.stringify(running.organizationMembers), JSON.stringify(running.tenantMembers)]
  );
  return rows.map((r) => ({ person: r.email, kind: r.kind, name: r.name, change: r.admin_only ? 'admin' : 'member' }));
}

/** An email as the restore compares it: the column is unique, but case-sensitive. */
const SAME_EMAIL = 'lower(btrim(u.email)) = lower(btrim($1))';
const CAN_MANAGE = `EXISTS (SELECT 1 FROM deployment_users d WHERE d.user_id = u.id AND d.role = 'admin') AND NOT u.is_locked AND NOT u.login_disabled`;

/**
 * Refuses a restore after which no one could manage the deployment: the web restore unless
 * the person restoring is, in the restored data, a deployment admin who can sign in (the same
 * email); the restore command when there is no such admin at all. Nothing on the host makes
 * one: setup-token works only while there are no users, and no command resets a password.
 */
async function assertSomeoneCanManage(client: ClientBase, running: RunningState | null, options: CarryOverOptions): Promise<void> {
  if (options.restorerId !== null) {
    const email = running?.restorerEmail ?? null;
    const found = email === null ? 0 : (await client.query(`SELECT 1 FROM users u WHERE ${SAME_EMAIL} AND ${CAN_MANAGE}`, [email])).rowCount;
    if (!found) {
      throw new RestoreCarryOverRefusal(
        'RESTORE_WOULD_LOCK_OUT',
        `In this backup's data, ${email ?? 'you'} ${email ? 'is' : 'are'} not a deployment admin who can sign in (an admin, ` +
          'not locked, sign-in not disabled), so the restore would leave you unable to manage this server. Nothing was changed. ' +
          'Restore it as a deployment admin the backup has, or with the restore command on the server.'
      );
    }
    return;
  }
  const admins = (await client.query(`SELECT 1 FROM users u WHERE ${CAN_MANAGE}`)).rowCount;
  if (!admins) {
    throw new RestoreCarryOverRefusal(
      'RESTORE_WOULD_LOCK_OUT',
      "The backup's data has no deployment admin who can sign in (one not locked, with sign-in not disabled): after this restore no one " +
        'could manage the server, and nothing on the server can make one. Nothing was changed.'
    );
  }
}
