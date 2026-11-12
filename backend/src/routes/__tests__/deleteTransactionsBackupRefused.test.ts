import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import pool from '../../db.js';
import { createDataManagementRoutes } from '../data-management.js';
import { BackupInProgressError, BackupService } from '../../services/BackupService.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import type { TenantRequest } from '../../middleware/tenant.js';

/**
 * Delete Transactions with "back up first": when no backup can start, the deletion is
 * blocked, and the answer says why as the backup routes do: 503 SHUTTING_DOWN once a
 * shutdown has begun, 409 BACKUP_IN_PROGRESS while another backup or restore runs. A
 * shutdown answered 500 "Backup creation failed".
 */
describe('delete-transactions when its backup cannot start', () => {
  let app: Express;
  let tenant: TestTenant;
  let accountId: number;
  const body = { dateFrom: '2020-03-01', dateTo: '2020-03-31', createBackup: true };

  beforeAll(async () => {
    tenant = await createTestTenant('Delete transactions backup refused');
    app = express();
    app.use(express.json());
    app.use(tenant.context({ deploymentAdmin: true }));
    // What resolveTenant sets for a deployment admin: only one may back up first.
    app.use((req, _res, next) => {
      (req as TenantRequest).isDeploymentAdmin = true;
      next();
    });
    app.use('/api/data-management', createDataManagementRoutes({ backupService: new BackupService(pool) }));
    accountId = (
      await tenant.pool.query(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Refused backup', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0].id;
    await tenant.pool.query(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, status)
       VALUES ($1, -12.50, '2020-03-15', 'expense', 'Kept', 'cleared')`,
      [accountId]
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  /** The deletion of what a preview of the range found: its backup is what is refused here. */
  const previewed = async () => {
    const res = await request(app).post('/api/data-management/preview-delete-transactions').send(body);
    expect(res.status).toBe(200);
    return { ...body, selectionKey: res.body.selectionKey };
  };

  const remaining = async () =>
    Number((await tenant.pool.query('SELECT count(*)::int AS n FROM transactions WHERE account_id = $1', [accountId])).rows[0].n);

  it('409 BACKUP_IN_PROGRESS while another backup runs, and nothing is deleted', async () => {
    vi.spyOn(BackupService.prototype, 'createBackup').mockRejectedValueOnce(new BackupInProgressError());
    const res = await request(app).post('/api/data-management/delete-transactions').send(await previewed());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'BACKUP_IN_PROGRESS', error: 'A backup is already in progress. Deletion has been blocked for safety.' });
    expect(await remaining()).toBe(1);
  });

  // Last: a shutdown refuses backups for good in this process.
  it('503 SHUTTING_DOWN once a shutdown has begun, and nothing is deleted', async () => {
    const deletion = await previewed();
    BackupService.refuseNewOperations();
    const res = await request(app).post('/api/data-management/delete-transactions').send(deletion);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SHUTTING_DOWN');
    expect(res.body.error).toMatch(/^The server is shutting down, so no backup or restore can start now\. .*Deletion has been blocked for safety\.$/);
    expect(await remaining()).toBe(1);
  });
});
