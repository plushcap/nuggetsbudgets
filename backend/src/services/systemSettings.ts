import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { DB } from '../db/schema.generated.js';
import { currentDbOrGlobal } from '../db/withTenant.js';

/**
 * The deployment's own settings, `system_settings` (a control-plane table: no RLS), as the
 * settings routes, the schedulers and the services that keep a setting of their own (the
 * backup key, the Web Push keys, the OneDrive app registration) read and write them. A
 * ledger's own settings are tenant_settings (tenantSettings.ts).
 *
 * Each runs in the caller's transaction when there is one, so a request reads back what it
 * wrote and a test's rollback takes it back, else on the app's pool. A caller that needs
 * another connection passes it as `db`: a scheduler or a job that must not run in a
 * request's transaction passes globalDb, and BackupService its own pool (a restore swaps the
 * database under it).
 *
 * Only for values that aren't secrets in the clear: a secret is encrypted (EncryptionService)
 * before it is written here, and never read back to a page.
 */

/** A setting as a settings page lists it. */
export interface SystemSettingRow {
  setting_key: string;
  setting_value: string | null;
  setting_type: string | null;
  description: string | null;
}

/** The value of `key`: null when it is unset, undefined when there is no such row. */
export async function readSystemSetting(key: string, db: Kysely<DB> = currentDbOrGlobal()): Promise<string | null | undefined> {
  const row = await db
    .selectFrom('system_settings')
    .select('setting_value')
    .where('setting_key', '=', key)
    .executeTakeFirst();
  return row?.setting_value;
}

/** The values of those of `keys` that have a row, by key (a value may be null: unset). */
export async function readSystemSettings<K extends string>(
  keys: readonly K[],
  db: Kysely<DB> = currentDbOrGlobal()
): Promise<Partial<Record<K, string | null>>> {
  if (keys.length === 0) return {};
  const rows = await db
    .selectFrom('system_settings')
    .select(['setting_key', 'setting_value'])
    .where('setting_key', 'in', keys)
    .execute();
  return Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value])) as Partial<Record<K, string | null>>;
}

/** Every setting in `category`, by key; with `keys`, only those of them. */
export async function readSystemSettingsIn(
  category: string,
  options: { keys?: readonly string[] | undefined } = {},
  db: Kysely<DB> = currentDbOrGlobal()
): Promise<SystemSettingRow[]> {
  if (options.keys?.length === 0) return [];
  let query = db
    .selectFrom('system_settings')
    .select(['setting_key', 'setting_value', 'setting_type', 'description'])
    .where('category', '=', category);
  if (options.keys) query = query.where('setting_key', 'in', options.keys);
  return query.orderBy('setting_key').execute();
}

export interface SystemSettingWrite {
  /** The category of a new row. */
  category: string;
  /** The type of a new row, when it has one. */
  settingType?: string | undefined;
  /** Change an existing row only when it is in `category`: a key of another page's is left as it is. */
  onlyInCategory?: boolean | undefined;
}

/**
 * Store `value` as `key`: a new row (in `category`), or the existing row's value, the rest
 * of it (its type, description, category) kept as it is.
 */
export async function writeSystemSetting(
  key: string,
  value: string,
  options: SystemSettingWrite,
  db: Kysely<DB> = currentDbOrGlobal()
): Promise<void> {
  await db
    .insertInto('system_settings')
    .values({
      setting_key: key,
      setting_value: value,
      category: options.category,
      ...(options.settingType !== undefined && { setting_type: options.settingType }),
    })
    .onConflict((oc) => {
      const update = oc.column('setting_key').doUpdateSet((eb) => ({
        setting_value: eb.ref('excluded.setting_value'),
        updated_at: sql<Date>`CURRENT_TIMESTAMP`,
      }));
      return options.onlyInCategory ? update.where('system_settings.category', '=', options.category) : update;
    })
    .execute();
}

/** A setting {@link addSystemSettings} adds. */
export interface NewSystemSetting {
  key: string;
  value: string;
  category: string;
  settingType?: string | undefined;
  description?: string | undefined;
  /** Whether a settings page may change it (false: the server keeps it). */
  userConfigurable?: boolean | undefined;
}

/**
 * Add each of `settings` that has no row yet; one that has keeps its value. Two servers adding
 * the same key at once agree on whichever landed first.
 */
export async function addSystemSettings(settings: readonly NewSystemSetting[], db: Kysely<DB> = currentDbOrGlobal()): Promise<void> {
  if (settings.length === 0) return;
  await db
    .insertInto('system_settings')
    .values(settings.map((s) => ({
      setting_key: s.key,
      setting_value: s.value,
      category: s.category,
      ...(s.settingType !== undefined && { setting_type: s.settingType }),
      ...(s.description !== undefined && { description: s.description }),
      ...(s.userConfigurable !== undefined && { is_user_configurable: s.userConfigurable }),
    })))
    .onConflict((oc) => oc.column('setting_key').doNothing())
    .execute();
}

/** Change the value of `key` when it has a row (a setting that isn't there is left out). */
export async function updateSystemSetting(
  key: string,
  value: string | RawBuilder<string>,
  db: Kysely<DB> = currentDbOrGlobal()
): Promise<void> {
  await db.updateTable('system_settings').set({ setting_value: value }).where('setting_key', '=', key).execute();
}
