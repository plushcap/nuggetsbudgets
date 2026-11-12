import type { PoolClient } from 'pg';
import { AAD, DOMAIN, deriveKey, envelopeKeyId, keyIdOf, open, seal } from '../utils/crypto-envelope.js';

/**
 * Re-encrypt every stored secret from one `data_encryption_key` to another:
 * the step that lets the key be rotated. Without it, a new key file left
 * every value below unreadable, with nothing to say why.
 *
 * Run by scripts/rewrap-secrets.ts, as the schema owner, the database superuser, in one
 * transaction. RLS doesn't apply to it, so it reaches every organization's SimpleFin
 * URL (organization_simplefin_connections has the organization policy; the other tables
 * here have no RLS).
 *
 * Each value is opened with the new key first (already rewrapped: left alone, so a second
 * run changes nothing), then with the old one (sealed again under the new key, as v3 with
 * its key id). A value neither opens is counted and left as it is.
 *
 * Not here, and not changed by a rotation: backup files (encrypted with the backup key K,
 * which is itself one of the values below and keeps its value; a backup made before
 * backup keys existed was encrypted with the data key itself, and needs the old key to
 * restore), and notification unsubscribe links, signed with a key derived from the data
 * key: links in emails sent before the rotation stop working.
 */

type Domain = typeof DOMAIN.credential | typeof DOMAIN.onedrive;

interface Target {
  /** How the report names it. */
  label: string;
  table: string;
  column: string;
  domain: Domain;
  /** Extra condition on the rows (system_settings holds plain settings too). */
  where?: string;
}

/** system_settings rows whose value is a credential envelope (EncryptionService.encryptString). */
export const ENCRYPTED_SETTINGS = [
  'notification_smtp_password',
  'onedrive_client_id',
  'onedrive_client_secret',
  'push_vapid_private_key',
  'backup_data_key',
] as const;

/** Every column that holds a data-key envelope. */
export const REWRAP_TARGETS: readonly Target[] = [
  {
    label: 'system_settings (SMTP password, OneDrive app, Web Push key, backup key)',
    table: 'system_settings',
    column: 'setting_value',
    domain: DOMAIN.credential,
    where: `setting_key IN (${ENCRYPTED_SETTINGS.map((k) => `'${k}'`).join(', ')})`,
  },
  { label: 'SimpleFin access URLs', table: 'organization_simplefin_connections', column: 'access_url', domain: DOMAIN.credential },
  { label: 'Web Push subscription keys', table: 'push_subscriptions', column: 'keys_encrypted', domain: DOMAIN.credential },
  { label: 'OneDrive access tokens', table: 'onedrive_tokens', column: 'access_token', domain: DOMAIN.onedrive },
  { label: 'OneDrive refresh tokens', table: 'onedrive_tokens', column: 'refresh_token', domain: DOMAIN.onedrive },
];

const AAD_FOR: Record<Domain, Buffer> = { [DOMAIN.credential]: AAD.credential, [DOMAIN.onedrive]: AAD.onedrive };

export interface RewrapCounts {
  label: string;
  /** Sealed under the old key, now under the new one (or would be, on a dry run). */
  rewrapped: number;
  /** Already under the new key. */
  current: number;
  /** Opened by neither key: left as they are. Ids only, never a value. */
  unreadable: number[];
}

function tryOpen(key: Buffer, envelope: Buffer, aad: Buffer): Buffer | null {
  try {
    return open(key, envelope, aad);
  } catch {
    return null;
  }
}

/**
 * Rewrap every target on `client`, which the caller has in a transaction (and commits,
 * or rolls back for a dry run). Returns what it found per target.
 */
export async function rewrapSecrets(client: PoolClient, oldSecret: string, newSecret: string): Promise<RewrapCounts[]> {
  if (oldSecret === newSecret) throw new Error('The old and the new key are the same.');
  const newKeyId = keyIdOf(newSecret);
  const results: RewrapCounts[] = [];
  for (const target of REWRAP_TARGETS) {
    const oldKey = deriveKey(oldSecret, target.domain);
    const newKey = deriveKey(newSecret, target.domain);
    const aad = AAD_FOR[target.domain];
    const counts: RewrapCounts = { label: target.label, rewrapped: 0, current: 0, unreadable: [] };
    // Identifiers are this module's constants, never input.
    const { rows } = await client.query<{ id: number; value: string }>(
      `SELECT id, ${target.column} AS value FROM ${target.table}
        WHERE ${target.column} IS NOT NULL AND ${target.column} <> ''${target.where ? ` AND ${target.where}` : ''}
        ORDER BY id FOR UPDATE`
    );
    for (const row of rows) {
      const envelope = Buffer.from(row.value, 'base64');
      // A v3 value says which key sealed it; a v2 value (sealed before v1.0.0) is tried with both.
      if (envelopeKeyId(envelope) === newKeyId && tryOpen(newKey, envelope, aad)) {
        counts.current += 1;
        continue;
      }
      const plaintext = tryOpen(oldKey, envelope, aad);
      if (plaintext === null) {
        if (tryOpen(newKey, envelope, aad)) counts.current += 1;
        else counts.unreadable.push(row.id);
        continue;
      }
      const rewrapped = seal(newKey, plaintext, aad, newKeyId).toString('base64');
      await client.query(`UPDATE ${target.table} SET ${target.column} = $1 WHERE id = $2`, [rewrapped, row.id]);
      counts.rewrapped += 1;
    }
    results.push(counts);
  }
  return results;
}
