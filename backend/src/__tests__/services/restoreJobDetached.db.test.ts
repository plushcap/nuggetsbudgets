import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import pool from '../../db.js';
import { getCurrentOrganizationId, inTenantTransaction, withTenant } from '../../db/withTenant.js';
import { getCurrentTenantId, getRequestScope } from '../../context/requestContext.js';
import { restoreJobSettled, startRestoreJob, getRestoreStatus } from '../../services/restoreJob.js';
import type { BackupService } from '../../services/BackupService.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A restore runs in the background, and starts the schedulers again when it is done, which
 * arm timers that keep the context they were created in. startRestoreJob ran it
 * outside the request's context and tenant scope (runOutsideRequestContext), but not
 * outside a transaction getDb() would return, or an organization's: started from code in a
 * ledger's transaction, the restore and the schedulers it started saw that finished
 * transaction as theirs. It runs through runDetached now, which leaves all of them.
 */
describe('a restore started inside a ledger transaction', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('Restore job detached');
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('runs, and starts the schedulers again, outside it', async () => {
    const seen: Record<string, unknown> = {};
    const where = (step: string) => {
      seen[step] = {
        transaction: inTenantTransaction(),
        organization: getCurrentOrganizationId(),
        tenant: getCurrentTenantId(),
        request: getRequestScope() !== undefined,
      };
    };
    const backupService = {
      restoreFromFile: async () => {
        where('restore');
        throw new Error('stopped here by the test');
      },
    } as unknown as BackupService;
    const schedulers = {
      pauseSchedulersForRestore: async () => where('pause'),
      resumeSchedulersAfterRestore: async () => where('resume'),
    };

    await withTenant(tenant.tenantId, async () => {
      expect(inTenantTransaction()).toBe(true);
      expect(getCurrentOrganizationId()).toBeDefined();
      startRestoreJob({ pool, backupService, schedulers }, { filePath: '/nonexistent.enc', fileName: 'x.enc', key: null, fileKey: null, deleteAfter: false, userId: tenant.userId });
    });
    await restoreJobSettled();

    const outside = { transaction: false, organization: undefined, tenant: undefined, request: false };
    expect(seen).toEqual({ pause: outside, restore: outside, resume: outside });
    expect(getRestoreStatus()).toMatchObject({ status: 'failed', databaseChanged: false });
  });
});
