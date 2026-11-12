import { answerProblem, transactionRangeDeleteResponseSchema } from '@nuggets/shared';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// Refused requests log warnings; keep them out of the test output unless asked for.
vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { BackupService } from '../../services/BackupService.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';

/**
 * "Back up first" on Delete Transactions runs BackupService.createBackup(): a pg_dump of
 * every ledger on the server, added to the deployment's backup list. Only a deployment
 * admin may make one, as on the Backup page. A ledger or organization admin who
 * asks for one is refused before anything runs; without it they still delete. Through the
 * real app, with each role's own session; the backup itself is observed, not run.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

describeDb('delete-transactions: who may back up first', () => {
  let h: RouteHarness;
  let a: TestTenant;
  let accountId: number;
  let tenantAdmin: string;
  let orgAdmin: string;
  let deploymentAdmin: string;
  let month = 0;

  beforeAll(async () => {
    h = await startRouteHarness('Delete backup access');
    a = await createTestTenant('Delete backup access');
    await h.owner.query('UPDATE tenant_users SET is_admin = true WHERE tenant_id = $1 AND user_id = $2', [a.tenantId, a.userId]);
    tenantAdmin = await h.signIn(a.userId, a.tenantId);
    const org = await h.addUser('org-admin');
    await h.owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, true)', [a.organizationId, org.id]);
    orgAdmin = await h.signIn(org.id, a.tenantId);
    const deployment = await h.addUser('deployment-admin');
    await h.makeDeploymentAdmin(deployment.id);
    deploymentAdmin = await h.signIn(deployment.id, a.tenantId);
    accountId = (
      await a.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Backup access', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0].id;
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    // The harness's people first: their memberships reference A's organization.
    const closed = await Promise.allSettled([h?.close()]);
    await a?.cleanup();
    if (closed[0].status === 'rejected') throw closed[0].reason;
  }, 60_000);

  /** A transaction in a month of its own, so each test's range holds only it. */
  const fixture = async () => {
    month += 1;
    const day = `2025-${String(month).padStart(2, '0')}`;
    const id = (
      await a.pool.query<{ id: number }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, -9.99, $2, 'expense', 'Backup access') RETURNING id`,
        [accountId, `${day}-15`]
      )
    ).rows[0].id;
    return { id, range: { dateFrom: `${day}-01`, dateTo: `${day}-28`, excludeBudgetPeriod: false } };
  };
  const exists = async (id: number) => (await a.pool.query('SELECT 1 FROM transactions WHERE id = $1', [id])).rowCount === 1;

  /** Delete what a preview by `session` found, with or without a backup first. */
  const remove = async (session: string, range: object, createBackup: boolean) => {
    const preview = await h.call(session, 'post', '/api/data-management/preview-delete-transactions', range);
    expect(preview.status, preview.text).toBe(200);
    return h.call(session, 'post', '/api/data-management/delete-transactions', { ...range, createBackup, selectionKey: preview.body.selectionKey });
  };

  it.each([
    ['ledger', () => tenantAdmin],
    ['organization', () => orgAdmin],
  ])('refuses a backup to a %s admin, and deletes nothing', async (_role, session) => {
    const backup = vi.spyOn(BackupService.prototype, 'createBackup');
    const { id, range } = await fixture();

    const res = await remove(session(), range, true);
    expect(res.status, res.text).toBe(403);
    expect(res.body.code).toBe('BACKUP_REQUIRES_DEPLOYMENT_ADMIN');
    expect(res.body.error).toMatch(/deployment admin/);
    expect(backup).not.toHaveBeenCalled();
    expect(await exists(id)).toBe(true);

    // Refused before the body is checked: a request without a preview gets the same answer.
    const unchecked = await h.call(session(), 'post', '/api/data-management/delete-transactions', { createBackup: true });
    expect(unchecked.status, unchecked.text).toBe(403);
    expect(unchecked.body.code).toBe('BACKUP_REQUIRES_DEPLOYMENT_ADMIN');
  });

  it('lets a ledger admin delete without a backup', async () => {
    const backup = vi.spyOn(BackupService.prototype, 'createBackup');
    const { id, range } = await fixture();

    const res = await remove(tenantAdmin, range, false);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ count: 1, backupCreated: false });
    expect(backup).not.toHaveBeenCalled();
    expect(await exists(id)).toBe(false);
  });

  it('backs up first for a deployment admin, then deletes', async () => {
    const backup = vi
      .spyOn(BackupService.prototype, 'createBackup')
      .mockResolvedValue({ fileName: 'nuggets_backup_20251115_030000_000.enc', filePath: '/unused', fileSize: 1 });
    const { id, range } = await fixture();

    const res = await remove(deploymentAdmin, range, true);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ count: 1, backupCreated: true, backupFileName: 'nuggets_backup_20251115_030000_000.enc' });
    expect(answerProblem(transactionRangeDeleteResponseSchema, res.body)).toBeNull();
    expect(backup).toHaveBeenCalledTimes(1);
    expect(await exists(id)).toBe(false);
  });
});
