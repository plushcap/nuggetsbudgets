import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { withTenant, getDb, globalDb } from '../../db/withTenant.js';
import {
  addSystemSettings, readSystemSetting, readSystemSettings, readSystemSettingsIn, updateSystemSetting, writeSystemSetting,
} from '../../services/systemSettings.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The one reader and writer of system_settings for the settings routes. The table is
 * shared by every test file, so each case runs in a transaction that is rolled back (the
 * helpers use the caller's), and its keys are its own.
 */

class Rollback extends Error {}

describe('system_settings helpers', () => {
  let tenant: TestTenant;
  const key = (name: string) => `test_${name}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  /** `fn` in a transaction that is rolled back, so nothing it writes stays. */
  const rolledBack = async (fn: () => Promise<void>) => {
    await withTenant(tenant.tenantId, async () => {
      await fn();
      throw new Rollback();
    }).catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
  };
  const row = (settingKey: string) =>
    getDb().selectFrom('system_settings').select(['setting_value', 'setting_type', 'category', 'description']).where('setting_key', '=', settingKey).executeTakeFirst();

  beforeAll(async () => {
    tenant = await createTestTenant('System settings helpers');
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('adds a row in its category, with its type, and changes only the value of one that exists', async () => {
    await rolledBack(async () => {
      const k = key('added');
      expect(await readSystemSetting(k)).toBeUndefined();
      await writeSystemSetting(k, 'one', { category: 'test-cat', settingType: 'string' });
      expect(await row(k)).toEqual({ setting_value: 'one', setting_type: 'string', category: 'test-cat', description: null });

      await getDb().updateTable('system_settings').set({ description: 'kept' }).where('setting_key', '=', k).execute();
      await writeSystemSetting(k, 'two', { category: 'another-cat', settingType: 'integer' });
      expect(await row(k)).toEqual({ setting_value: 'two', setting_type: 'string', category: 'test-cat', description: 'kept' });
      expect(await readSystemSetting(k)).toBe('two');
    });
  });

  it('leaves a row of another category as it is when asked to write only its own', async () => {
    await rolledBack(async () => {
      const k = key('guarded');
      await writeSystemSetting(k, 'theirs', { category: 'backup' });
      await writeSystemSetting(k, 'mine', { category: 'notifications', onlyInCategory: true });
      expect(await row(k)).toMatchObject({ setting_value: 'theirs', category: 'backup' });
      await writeSystemSetting(k, 'mine', { category: 'backup', onlyInCategory: true });
      expect(await readSystemSetting(k)).toBe('mine');
    });
  });

  it("lists a category's settings by key, and reads an unset one as null", async () => {
    await rolledBack(async () => {
      const category = key('category');
      await writeSystemSetting('zz_' + category, 'last', { category, settingType: 'integer' });
      await writeSystemSetting('aa_' + category, 'first', { category, settingType: 'string' });
      await getDb().updateTable('system_settings').set({ setting_value: null }).where('setting_key', '=', 'zz_' + category).execute();
      expect(await readSystemSettingsIn(category)).toEqual([
        { setting_key: 'aa_' + category, setting_value: 'first', setting_type: 'string', description: null },
        { setting_key: 'zz_' + category, setting_value: null, setting_type: 'integer', description: null },
      ]);
      expect(await readSystemSetting('zz_' + category)).toBeNull();
      // Only the keys asked for, in that category.
      await writeSystemSetting('mm_' + category, 'other', { category: 'elsewhere' });
      expect((await readSystemSettingsIn(category, { keys: ['zz_' + category, 'mm_' + category] })).map((r) => r.setting_key))
        .toEqual(['zz_' + category]);
      expect(await readSystemSettingsIn(category, { keys: [] })).toEqual([]);
    });
  });

  it('adds only the settings that have no row, and changes only one that has', async () => {
    await rolledBack(async () => {
      const k = key('added_once');
      await addSystemSettings([{ key: k, value: 'first', category: 'push', settingType: 'string', description: 'Kept', userConfigurable: false }]);
      await addSystemSettings([{ key: k, value: 'second', category: 'push' }]);
      expect(await row(k)).toEqual({ setting_value: 'first', setting_type: 'string', category: 'push', description: 'Kept' });
      await updateSystemSetting(k, sql<string>`'third'`);
      expect(await readSystemSettings([k, `${k}_missing`])).toEqual({ [k]: 'third' });
      await updateSystemSetting(`${k}_missing`, 'nothing');
      expect(await readSystemSetting(`${k}_missing`)).toBeUndefined();
    });
  });

  it("runs on the connection it is given, not the caller's transaction", async () => {
    await rolledBack(async () => {
      const k = key('connection');
      await writeSystemSetting(k, 'uncommitted', { category: 'test-cat' });
      expect(await readSystemSetting(k)).toBe('uncommitted');
      // The pool doesn't see what the transaction hasn't committed.
      expect(await readSystemSetting(k, globalDb)).toBeUndefined();
      expect(await readSystemSettings([k], globalDb)).toEqual({});
    });
  });
});
