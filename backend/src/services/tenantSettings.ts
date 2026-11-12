import { sql } from 'kysely';
import { getDb, inTenantTransaction, withTenant } from '../db/withTenant.js';
import { getCurrentTenantId } from '../context/requestContext.js';

/**
 * A ledger's own settings (`tenant_settings`): its time zone, its currency and locale
 * (tenantMoneyFormat.ts), and its bank import schedule. Deployment-wide settings (SMTP, backups, OneDrive, the notification limits)
 * stay in `system_settings`. The table is under the standard tenant policy, so these read
 * and write the current ledger's rows through getDb().
 */

/** The keys tenant_settings takes; its check constraint lists the same ones. */
export const TENANT_SETTING_KEYS = [
  'application_timezone',
  'application_currency',
  'application_locale',
  'import_enabled',
  'import_manual_sync_enabled',
  'import_sync_frequency',
  'import_sync_time',
  'import_days_back',
  'import_user_id',
  'import_last_auto_sync',
  'import_last_attempt',
] as const;
export type TenantSettingKey = (typeof TENANT_SETTING_KEYS)[number];

/** Values to write; an undefined one (a field a validated body left out) is skipped. */
export type TenantSettings = { [K in TenantSettingKey]?: string | null | undefined };

/**
 * The current ledger's values for `keys` (a key with no row is absent). In the current
 * tenant transaction when there is one; otherwise, for work that runs between
 * transactions (a bank sync, the scheduler), in a short one of the ledger's own.
 */
export async function readTenantSettings<K extends TenantSettingKey>(
  keys: readonly K[],
  tenantId: number | null = null
): Promise<Partial<Record<K, string | null>>> {
  const read = async () => {
    const rows = await getDb()
      .selectFrom('tenant_settings')
      .select(['setting_key', 'setting_value'])
      .where('setting_key', 'in', [...keys])
      .execute();
    const out: Partial<Record<K, string | null>> = {};
    for (const row of rows) out[row.setting_key as K] = row.setting_value;
    return out;
  };
  return inTenantScope(tenantId, read);
}

/** The current ledger's value of one key, or null when it has none. */
export async function readTenantSetting(key: TenantSettingKey, tenantId: number | null = null): Promise<string | null> {
  return (await readTenantSettings([key], tenantId))[key] ?? null;
}

/**
 * Set the current ledger's values (insert or update each key). `userId` is recorded as
 * who changed them; null for the scheduler. A value that is already stored is left as it
 * is, so its updated_at says when it last changed (the scheduler counts a ledger's first
 * run from when import_enabled turned on).
 */
export async function writeTenantSettings(
  values: TenantSettings,
  userId: number | null,
  tenantId: number | null = null
): Promise<void> {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined) as Array<[TenantSettingKey, string | null]>;
  if (entries.length === 0) return;
  await inTenantScope(tenantId, async () => {
    await getDb()
      .insertInto('tenant_settings')
      .values(entries.map(([setting_key, setting_value]) => ({ setting_key, setting_value, updated_by_user_id: userId })))
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'setting_key']).doUpdateSet((eb) => ({
          setting_value: eb.ref('excluded.setting_value'),
          updated_by_user_id: eb.ref('excluded.updated_by_user_id'),
          updated_at: sql<Date>`CURRENT_TIMESTAMP`,
        })).where(sql<boolean>`tenant_settings.setting_value IS DISTINCT FROM excluded.setting_value`)
      )
      .execute();
  });
}

/**
 * Run `fn` where getDb() is ledger `tenantId`'s transaction: the open one when it is that
 * ledger's, else a short one of its own. `tenantId` defaults to the current ledger.
 */
export async function inTenantScope<T>(tenantId: number | null, fn: () => Promise<T>): Promise<T> {
  const current = getCurrentTenantId() ?? null;
  const target = tenantId ?? current;
  if (target == null) throw new Error('No tenant to read its settings: run inside a tenant scope or pass its id');
  if (inTenantTransaction() && current === target) return fn();
  if (inTenantTransaction()) {
    throw new Error(`Tenant ${target}'s settings asked for inside tenant ${current}'s transaction`);
  }
  return withTenant(target, fn);
}
