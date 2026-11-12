import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';
import { isAppTimeZone } from '../../utils/appDate.js';

/**
 * A ledger's categories and institutions, and the settings pages' zone list, through the
 * real app under RLS. Ledger B has a category and an institution of the
 * same names as A's: A's names must not clash with them, and A can't change or delete them.
 *
 * Elsewhere: saving the general settings (generalSettings.test.ts) and the deployment-wide
 * ones (deploymentSettings.test.ts).
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

type Ref = { id: number; uuid: string };

describeDb('Categories, institutions and settings lists', () => {
  let h: RouteHarness;
  let a: TestTenant;
  let b: TestTenant;
  let session: string;
  let categoryB: Ref;
  let institutionB: Ref;

  const one = async <T>(t: TestTenant, text: string, params: unknown[] = []) => (await t.pool.query(text, params)).rows[0] as T;

  beforeAll(async () => {
    h = await startRouteHarness('Reference data');
    a = await createTestTenant('Reference data A');
    b = await createTestTenant('Reference data B');
    session = await h.signIn(a.userId, a.tenantId);
    categoryB = await one<Ref>(b, `INSERT INTO categories (name, icon) VALUES ('Housing', 'Home') RETURNING id, uuid`);
    institutionB = await one<Ref>(b, `INSERT INTO account_institutions (name) VALUES ('First Bank') RETURNING id, uuid`);
  }, 60_000);

  afterAll(async () => {
    const settled = await Promise.allSettled([h?.close(), a?.cleanup(), b?.cleanup()]);
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }, 60_000);

  describe('categories', () => {
    let housing: Ref;

    it('creates a category with a name another ledger also uses, but not one this ledger has in any case', async () => {
      const created = await h.call(session, 'post', '/api/categories', { name: '  Housing ', icon: 'Home', priority: 'Need' });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ name: 'Housing', icon: 'Home', priority: 'Need' });
      housing = created.body;

      const dup = await h.call(session, 'post', '/api/categories', { name: 'HOUSING', icon: 'Home' });
      expect(dup.status).toBe(409);
      expect((await h.call(session, 'post', '/api/categories', { name: 'No icon' })).status).toBe(400);

      const list = await h.call(session, 'get', '/api/categories');
      expect(list.status).toBe(200);
      expect(list.body.map((c: { uuid: string }) => c.uuid)).toEqual([housing.uuid]);
    });

    it('renames a category, refusing the name of another of its own', async () => {
      const food = await h.call(session, 'post', '/api/categories', { name: 'Food', icon: 'Utensils' });
      expect(food.status).toBe(201);
      const clash = await h.call(session, 'put', `/api/categories/${food.body.uuid}`, { name: 'housing', icon: 'Utensils' });
      expect(clash.status).toBe(409);
      // Changing only its case is no clash with itself.
      const recased = await h.call(session, 'put', `/api/categories/${food.body.uuid}`, { name: 'FOOD', icon: 'Utensils', notes: ' groceries ' });
      expect(recased.status, recased.text).toBe(200);
      expect(recased.body).toMatchObject({ name: 'FOOD', notes: 'groceries', priority: 'Undefined' });
    });

    it('deletes a category no budget item uses, and keeps one in use', async () => {
      await a.pool.query(`INSERT INTO budget_items (name, category_id) VALUES ('Rent', $1)`, [housing.id]);
      const inUse = await h.call(session, 'delete', `/api/categories/${housing.uuid}`);
      expect(inUse.status).toBe(409);
      expect((await a.pool.query('SELECT 1 FROM categories WHERE id = $1', [housing.id])).rowCount).toBe(1);

      const spare = await h.call(session, 'post', '/api/categories', { name: 'Spare', icon: 'Box' });
      expect((await h.call(session, 'delete', `/api/categories/${spare.body.uuid}`)).status).toBe(204);
      expect((await a.pool.query('SELECT 1 FROM categories WHERE uuid = $1', [spare.body.uuid])).rowCount).toBe(0);
    });

    it("can't change or delete another ledger's category", async () => {
      expect((await h.call(session, 'put', `/api/categories/${categoryB.uuid}`, { name: 'Taken', icon: 'X' })).status).toBe(404);
      expect((await h.call(session, 'delete', `/api/categories/${categoryB.uuid}`)).status).toBe(404);
      expect(await one(b, 'SELECT name, icon FROM categories WHERE id = $1', [categoryB.id])).toEqual({ name: 'Housing', icon: 'Home' });
    });
  });

  describe('institutions', () => {
    it('creates, reads and renames an institution, counting the accounts at it', async () => {
      const created = await h.call(session, 'post', '/api/institutions', { name: ' First Bank ', notes: 'branch on Main' });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ name: 'First Bank', notes: 'branch on Main' });
      await a.pool.query(
        `INSERT INTO accounts (name, account_type, account_group, type, institution_id) VALUES
           ('Checking', 'checking', 'cash', 'Asset', $1), ('Savings', 'savings', 'cash', 'Asset', $1)`,
        [created.body.id]
      );

      const list = await h.call(session, 'get', '/api/institutions');
      expect(list.status).toBe(200);
      expect(list.body).toEqual([expect.objectContaining({ uuid: created.body.uuid, account_count: '2' })]);
      expect((await h.call(session, 'get', `/api/institutions/${created.body.uuid}`)).body.name).toBe('First Bank');

      const renamed = await h.call(session, 'put', `/api/institutions/${created.body.uuid}`, { name: 'First National' });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ name: 'First National', notes: null });
      expect((await h.call(session, 'put', `/api/institutions/${created.body.uuid}`, { name: '  ' })).status).toBe(400);

      // In use by two accounts: kept.
      const inUse = await h.call(session, 'delete', `/api/institutions/${created.body.uuid}`);
      expect(inUse.status).toBe(400);
      expect((await a.pool.query('SELECT 1 FROM account_institutions WHERE uuid = $1', [created.body.uuid])).rowCount).toBe(1);

      await a.pool.query('UPDATE accounts SET institution_id = NULL');
      const deleted = await h.call(session, 'delete', `/api/institutions/${created.body.uuid}`);
      expect(deleted.status).toBe(200);
      expect((await a.pool.query('SELECT 1 FROM account_institutions WHERE uuid = $1', [created.body.uuid])).rowCount).toBe(0);
    });

    it("can't read, change or delete another ledger's institution", async () => {
      expect((await h.call(session, 'get', `/api/institutions/${institutionB.uuid}`)).status).toBe(404);
      expect((await h.call(session, 'put', `/api/institutions/${institutionB.uuid}`, { name: 'Mine' })).status).toBe(404);
      expect((await h.call(session, 'delete', `/api/institutions/${institutionB.uuid}`)).status).toBe(404);
      expect(await one(b, 'SELECT name FROM account_institutions WHERE id = $1', [institutionB.id])).toEqual({ name: 'First Bank' });
    });
  });

  describe('settings', () => {
    it('offers only time zones the settings page can save', async () => {
      const res = await h.call(session, 'get', '/api/settings/timezones');
      expect(res.status).toBe(200);
      const zones = res.body as Array<{ value: string; label: string }>;
      expect(zones.length).toBeGreaterThan(0);
      expect(zones.map((z) => z.value)).toContain('UTC');
      for (const zone of zones) expect(await isAppTimeZone(zone.value), zone.value).toBe(true);
      expect(new Set(zones.map((z) => z.value)).size).toBe(zones.length);
    });

    it('shows a member the user-configurable general settings, including the zone', async () => {
      const res = await h.call(session, 'get', '/api/settings/general');
      expect(res.status, res.text).toBe(200);
      const keys = (res.body as Array<{ setting_key: string; is_user_configurable: boolean }>).map((s) => s.setting_key);
      expect(keys).toContain('application_timezone');
      for (const s of res.body) expect(s.is_user_configurable).toBe(true);
    });
  });
});
