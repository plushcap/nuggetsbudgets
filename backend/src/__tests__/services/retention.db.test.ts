import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import {
  purgeEndedSessions,
  purgeOldBackupRuns,
  purgeTenant,
  purgeOldPriceSyncRuns,
  retentionPolicy,
  runRetention,
  type RetentionPolicy,
} from '../../services/maintenance/retention.js';

/**
 * The daily retention job deletes exactly what has outlived its use:
 * ended sessions, old sent notifications and deliveries, old sync history (keeping the
 * newest), and images nothing points at. Fixtures are backdated rows in two ledgers of
 * their own; the code under test runs on the app's pool, as the scheduler does.
 *
 * Other files run in parallel on the same database, so nothing here reaches their rows:
 * the ledger jobs run for these two ledgers only, and the deployment-wide ones (sessions,
 * price-sync runs) with a ten-year period, on fixtures older than that.
 */
describe('Retention', () => {
  let a: TestTenant;
  let b: TestTenant;
  let owner: Pool;
  const policy: RetentionPolicy = { sessionDays: 30, notificationDays: 90, notificationDeliveryDays: 365, syncLogDays: 180 };
  // The deployment-wide jobs only reach this far back.
  const farBack: RetentionPolicy = { ...policy, sessionDays: 3650, syncLogDays: 3650 };

  const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

  beforeAll(async () => {
    a = await createTestTenant('Retention A');
    b = await createTestTenant('Retention B');
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 2 });
  });

  afterAll(async () => {
    await owner?.end();
    await a?.cleanup();
    await b?.cleanup();
  });

  const idsIn = async (table: string, ids: number[]) =>
    (await owner.query<{ id: number }>(`SELECT id FROM ${table} WHERE id = ANY($1) ORDER BY id`, [ids])).rows.map((r) => r.id);

  it('reads its settings, refusing values that would delete what is still needed', () => {
    expect(retentionPolicy({})).toEqual(policy);
    expect(retentionPolicy({ RETENTION_SESSION_DAYS: '7', RETENTION_SYNC_LOG_DAYS: '365' })).toMatchObject({ sessionDays: 7, syncLogDays: 365 });
    // A delivery is what stops an alert going twice; its subject can come round for ~90 days.
    expect(() => retentionPolicy({ RETENTION_NOTIFICATION_DELIVERY_DAYS: '30' })).toThrow(/from 120 to/);
    expect(() => retentionPolicy({ RETENTION_NOTIFICATION_DAYS: 'forever' })).toThrow(/RETENTION_NOTIFICATION_DAYS/);
  });

  it('deletes the sessions that ended more than RETENTION_SESSION_DAYS ago, and no others', async () => {
    const session = async (cols: Record<string, unknown>) => {
      const values = { session_token_hash: randomBytes(32).toString('hex'), user_id: a.userId, ...cols };
      const keys = Object.keys(values);
      const { rows } = await a.pool.query<{ id: number }>(
        `INSERT INTO sessions (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        Object.values(values)
      );
      return rows[0].id;
    };
    const expiredLongAgo = await session({ expires_at: ago(3660), created_at: ago(3700), last_activity_at: ago(3661) });
    const revokedLongAgo = await session({ expires_at: ago(-10), is_revoked: true, revoked_at: ago(3651), revocation_reason: 'logout' });
    const revokedUndated = await session({ expires_at: ago(-10), is_revoked: true, created_at: ago(4000), last_activity_at: ago(4000) });
    const expiredRecently = await session({ expires_at: ago(3640) });
    const revokedRecently = await session({ expires_at: ago(-10), is_revoked: true, revoked_at: ago(3649), revocation_reason: 'logout' });
    const rotatedJustNow = await session({ expires_at: ago(-10), is_revoked: true, revoked_at: new Date(), revocation_reason: 'rotated' });
    const live = await session({ expires_at: ago(-3), rotated_from_session_id: revokedLongAgo, created_at: ago(200) });
    const all = [expiredLongAgo, revokedLongAgo, revokedUndated, expiredRecently, revokedRecently, rotatedJustNow, live];

    expect(await purgeEndedSessions(farBack)).toBeGreaterThanOrEqual(3);
    expect(await idsIn('sessions', all)).toEqual([expiredRecently, revokedRecently, rotatedJustNow, live]);
    // The live session it was rotated from is gone; the foreign key let it go.
    const { rows } = await owner.query('SELECT rotated_from_session_id FROM sessions WHERE id = $1', [live]);
    expect(rows[0].rotated_from_session_id).toBeNull();
  });

  it('deletes the record of a backup a year after its file went, and keeps one whose file is there', async () => {
    const tag = randomBytes(4).toString('hex');
    const name = (what: string) => `nuggets_backup_${what}_${tag}.tar.age`;
    const backupRun = async (days: number, fileName: string | null, goneDays: number | null = null) =>
      (
        await owner.query<{ id: number }>(
          `INSERT INTO backup_runs (started_at, finished_at, trigger, outcome, message, file_name, file_gone_at)
           VALUES (now() - make_interval(days => $1), now() - make_interval(days => $1), 'scheduled', $2, $3, $4,
                   CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(days => $5::int) END) RETURNING id`,
          [days, fileName ? 'succeeded' : 'failed', fileName ? null : 'no key', fileName, goneDays]
        )
      ).rows[0].id;
    const goneJustNow = await backupRun(800, name('gone-now'));
    const goneAYearAgo = await backupRun(800, name('gone-long'), 400);
    const goneRecently = await backupRun(800, name('gone-recently'), 30);
    const backAgain = await backupRun(800, name('back'), 400);
    const stillThere = await backupRun(4000, name('kept'));
    const failedLongAgo = await backupRun(400, null);
    const failedRecently = await backupRun(30, null);
    const all = [goneJustNow, goneAYearAgo, goneRecently, backAgain, stillThere, failedLongAgo, failedRecently];
    const goneAt = async (id: number) => (await owner.query('SELECT file_gone_at FROM backup_runs WHERE id = $1', [id])).rows[0].file_gone_at;

    expect(await purgeOldBackupRuns([name('kept'), name('back'), 'nuggets_backup_other.tar.age'])).toBeGreaterThanOrEqual(2);
    // A file gone today is noted, not deleted; one gone a year ago goes; one back is kept and cleared.
    expect(await idsIn('backup_runs', all)).toEqual([goneJustNow, goneRecently, backAgain, stillThere, failedRecently]);
    expect(await goneAt(goneJustNow)).not.toBeNull();
    expect(await goneAt(backAgain)).toBeNull();
    expect(await goneAt(stillThere)).toBeNull();

    // A backup directory that can't be read notes nothing and deletes nothing: the job fails, and says so.
    const unreadable = await backupRun(800, name('unread'), 400);
    await expect(
      runRetention(policy, {
        tenantIds: [],
        organizationIds: [],
        backupFileNames: async () => {
          throw new Error('EACCES');
        },
      })
    ).rejects.toThrow(/backup_runs/);
    expect(await idsIn('backup_runs', [unreadable, goneJustNow])).toEqual([goneJustNow, unreadable]);
    await owner.query('DELETE FROM backup_runs WHERE id = ANY($1)', [[goneJustNow, goneRecently, backAgain, stillThere, failedRecently, unreadable]]);
  });

  it("deletes price-sync runs older than RETENTION_SYNC_LOG_DAYS, keeping each organization's newest", async () => {
    const run = async (orgId: number, startedDaysAgo: number, status = 'success') =>
      (
        await owner.query<{ id: number }>(
          `INSERT INTO organization_price_sync_runs (organization_id, run_status, started_at) VALUES ($1, $2, $3) RETURNING id`,
          [orgId, status, ago(startedDaysAgo)]
        )
      ).rows[0].id;
    const oldA = await run(a.organizationId, 4000);
    const oldFailedA = await run(a.organizationId, 3700, 'error');
    const recentA = await run(a.organizationId, 10);
    const onlyB = await run(b.organizationId, 5000); // B's newest, however old

    expect(await purgeOldPriceSyncRuns(farBack)).toBeGreaterThanOrEqual(2);
    expect(await idsIn('organization_price_sync_runs', [oldA, oldFailedA, recentA, onlyB])).toEqual([recentA, onlyB]);
  });

  describe("a ledger's rows", () => {
    // Inserted through the ledger's own connection, so tenant_id comes from its default.
    const insert = async (t: TestTenant, table: string, cols: Record<string, unknown>) => {
      const keys = Object.keys(cols);
      const { rows } = await t.pool.query<{ id: number; uuid: string }>(
        `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, uuid`,
        Object.values(cols)
      );
      return rows[0];
    };
    const notification = (t: TestTenant, status: string | null, createdDaysAgo: number) =>
      insert(t, 'notifications', {
        user_id: t.userId,
        recipient_email: t.userEmail,
        notification_type: 'budget_item',
        subject: 'Retention test',
        template_data: JSON.stringify({ rule: 'r' }),
        status,
        created_at: ago(createdDaysAgo),
      }).then((r) => r.id);
    const delivery = (t: TestTenant, createdDaysAgo: number) =>
      insert(t, 'notification_deliveries', {
        rule_key: 'retention-test',
        user_id: t.userId,
        subject_key: `subject-${randomBytes(6).toString('hex')}`,
        created_at: ago(createdDaysAgo),
      }).then((r) => r.id);
    const syncLog = (t: TestTenant, startedDaysAgo: number) =>
      insert(t, 'import_sync_log', {
        sync_type: 'full',
        sync_status: 'completed',
        sync_trigger: 'scheduled',
        sync_start_time: ago(startedDaysAgo),
        created_at: ago(startedDaysAgo),
      }).then((r) => r.id);
    const image = (t: TestTenant, createdHoursAgo: number) =>
      insert(t, 'stored_images', {
        mime_type: 'image/png',
        byte_size: 3,
        data: Buffer.from([1, 2, 3]),
        created_at: new Date(Date.now() - createdHoursAgo * 3_600_000),
      });
    const url = (img: { uuid: string }) => `/api/images/${img.uuid}`;

    const fixtures: Record<string, number> = {};
    const tenantBImages: number[] = [];

    beforeAll(async () => {
      // Notifications: sent or failed and old go; pending, processing, unknown and recent stay.
      fixtures.sentOld = await notification(a, 'sent', 100);
      fixtures.failedOld = await notification(a, 'failed', 91);
      fixtures.pendingOld = await notification(a, 'pending', 100);
      fixtures.processingOld = await notification(a, 'processing', 100);
      fixtures.noStatusOld = await notification(a, null, 100);
      fixtures.sentRecent = await notification(a, 'sent', 89);
      fixtures.sentOldB = await notification(b, 'sent', 100);
      // Deliveries: older than 365 days go.
      fixtures.deliveryOld = await delivery(a, 400);
      fixtures.deliveryRecent = await delivery(a, 300);
      fixtures.deliveryOldB = await delivery(b, 400);
      // Sync log: older than 180 days goes, except the ledger's newest.
      fixtures.syncOld = await syncLog(a, 300);
      fixtures.syncOlder = await syncLog(a, 181);
      fixtures.syncRecent = await syncLog(a, 5);
      fixtures.syncOnlyB = await syncLog(b, 500);
      // Images: what nothing points at, a day after it was stored.
      const orphanOld = await image(a, 25);
      const orphanNew = await image(a, 2);
      const ofAccount = await image(a, 48);
      const ofGoal = await image(a, 48);
      const ofMerchant = await image(a, 48);
      // Named only by another ledger's row: that ledger can't show it (RLS), so it goes.
      const namedByOtherTenant = await image(a, 48);
      const orphanB = await image(b, 48);
      tenantBImages.push(orphanB.id);
      await insert(a, 'accounts', { name: `Retention acct ${Date.now()}`, account_type: 'checking', account_group: 'cash', account_image: url(ofAccount) });
      // Matched whatever the case and form of the URL.
      await insert(a, 'budget_items', { name: `Retention goal ${Date.now()}`, image_path: `https://nuggets.example.com${url(ofGoal).toUpperCase()}` });
      await insert(a, 'merchants', { name: `Retention merchant ${Date.now()}`, merchant_image: url(ofMerchant) });
      await insert(b, 'merchants', { name: `Retention merchant B ${Date.now()}`, merchant_image: url(namedByOtherTenant) });
      Object.assign(fixtures, {
        orphanOld: orphanOld.id, orphanNew: orphanNew.id, ofAccount: ofAccount.id, ofGoal: ofGoal.id,
        ofMerchant: ofMerchant.id, namedByOtherTenant: namedByOtherTenant.id, orphanB: orphanB.id,
      });
    });

    it("deletes only that ledger's disposable rows, in batches", async () => {
      // Bounded to one batch of one row per job: one of each this run, the rest next run.
      const first = await purgeTenant(a.tenantId, policy, { limits: { batchSize: 1, maxBatches: 1 } });
      expect(first).toEqual({ notifications: 1, notification_deliveries: 1, import_sync_log: 1, stored_images: 1 });
      const second = await purgeTenant(a.tenantId, policy);
      expect(second).toEqual({ notifications: 1, notification_deliveries: 0, import_sync_log: 1, stored_images: 1 });
      expect(await purgeTenant(a.tenantId, policy)).toEqual({ notifications: 0, notification_deliveries: 0, import_sync_log: 0, stored_images: 0 });

      const f = fixtures;
      expect(await idsIn('notifications', [f.sentOld, f.failedOld, f.pendingOld, f.processingOld, f.noStatusOld, f.sentRecent, f.sentOldB]))
        .toEqual([f.pendingOld, f.processingOld, f.noStatusOld, f.sentRecent, f.sentOldB]);
      expect(await idsIn('notification_deliveries', [f.deliveryOld, f.deliveryRecent, f.deliveryOldB])).toEqual([f.deliveryRecent, f.deliveryOldB]);
      expect(await idsIn('import_sync_log', [f.syncOld, f.syncOlder, f.syncRecent, f.syncOnlyB])).toEqual([f.syncRecent, f.syncOnlyB]);
      expect(await idsIn('stored_images', [f.orphanOld, f.orphanNew, f.ofAccount, f.ofGoal, f.ofMerchant, f.namedByOtherTenant, f.orphanB]))
        .toEqual([f.orphanNew, f.ofAccount, f.ofGoal, f.ofMerchant, f.orphanB]);
    });

    it('stops between batches when asked to', async () => {
      const old = await notification(b, 'sent', 120);
      expect(await purgeTenant(b.tenantId, policy, { shouldStop: () => true })).toEqual({
        notifications: 0, notification_deliveries: 0, import_sync_log: 0, stored_images: 0,
      });
      expect(await idsIn('notifications', [old])).toEqual([old]);
    });

    it('runs every job, for the ledgers it is given', async () => {
      const counts = await runRetention(farBack, { tenantIds: [a.tenantId, b.tenantId] });
      expect(Object.keys(counts).sort()).toEqual(
        ['import_sync_log', 'notification_deliveries', 'notifications', 'organization_price_sync_runs', 'sessions', 'stored_images']
      );
      const f = fixtures;
      // B's turn came: its old rows went, its only (newest) sync log stayed.
      expect(await idsIn('notifications', [f.sentOldB])).toEqual([]);
      expect(await idsIn('notification_deliveries', [f.deliveryOldB])).toEqual([]);
      expect(await idsIn('import_sync_log', [f.syncOnlyB])).toEqual([f.syncOnlyB]);
      expect(await idsIn('stored_images', tenantBImages)).toEqual([]);
      // What A kept, it keeps.
      expect(await idsIn('notifications', [f.pendingOld, f.processingOld, f.noStatusOld, f.sentRecent])).toHaveLength(4);
      expect(await idsIn('stored_images', [f.orphanNew, f.ofAccount, f.ofGoal, f.ofMerchant])).toHaveLength(4);
    });
  });
});
