import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express from 'express';
import { createDataManagementRoutes } from '../routes/data-management.js';
import { answerError } from '../utils/apiError.js';
import type { BackupService } from '../services/BackupService.js';

/**
 * "Back up first" checks the caller is a deployment admin before the deletion's body is read.
 * When that check itself failed, the route answered a 500 of its own,
 * AUTH_CHECK_ERROR; it now passes the error on, to the global error handler, which logs
 * it and answers 500 INTERNAL_ERROR as for any other failure.
 */
describe('delete-transactions: a deployment-admin check that fails', () => {
  it('goes to the error handler, not an answer of its own', async () => {
    const failure = new Error('the deployment_users lookup failed');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { user: unknown }).user = { userId: 1, email: 'admin@test.local' };
      Object.defineProperty(req, 'isDeploymentAdmin', { get: () => { throw failure; } });
      next();
    });
    app.use('/api/data-management', createDataManagementRoutes({ backupService: {} as BackupService }));
    const handled: unknown[] = [];
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      handled.push(err);
      answerError(err, res, { during: 'test' });
    });

    const res = await request(app).post('/api/data-management/delete-transactions').send({ createBackup: true });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(handled).toEqual([failure]);
  });
});
