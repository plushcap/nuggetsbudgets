import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';
import type { TenantRequest } from '../../middleware/tenant.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Handlers that failed answered with the error's own message (`message`, `details`, an
 * `error` taken from it): a database error's text names tables, columns and
 * constraints, a mailer's or pg_dump's names hosts and roles. Each now answers a
 * generic message, or one written for people, and logs the rest (CLAUDE.md:
 * don't leak internals in error responses).
 *
 * Each case makes the handler fail with an error whose text carries SECRET, and checks
 * the answer doesn't.
 */

const SECRET = vi.hoisted(() => {
  return 'internal_secret_xyz';
});
const dbFailure = vi.hoisted(
  () => () => Object.assign(new Error(`relation "${'internal_secret_xyz'}" does not exist`), { code: '42P01', severity: 'ERROR' })
);

// From call `failFrom.at` on, getDb() throws a database error.
const failFrom = vi.hoisted(() => ({ at: Infinity, calls: 0 }));
vi.mock('../../db/withTenant.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/withTenant.js')>();
  return {
    ...actual,
    getDb: () => {
      if (failFrom.calls++ >= failFrom.at) throw dbFailure();
      return actual.getDb();
    },
  };
});

const { default: pool } = await import('../../db.js');
const { createSettingsRoutes } = await import('../settings.js');
const { createBudgetRoutes } = await import('../budgets.js');
const { createDataManagementRoutes } = await import('../data-management.js');
const { createNotificationAdminRoutes, createNotificationRoutes } = await import('../notifications.js');
const { config } = await import('../../config.js');
const { createBackupRoutes } = await import('../backup.js');
const { routeDependencies } = await import('../dependencies.js');
const { createGoalRoutes } = await import('../goals.js');
const { createInvestmentsRoutes } = await import('../investments.js');
const { BackupService, BackupKeyMissingError } = await import('../../services/BackupService.js');
const { EmailDeliveryService } = await import('../../services/EmailDeliveryService.js');
const { EmailTemplateService } = await import('../../services/EmailTemplateService.js');
const { NotificationRuleService } = await import('../../services/notifications/NotificationRuleService.js');

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const failingLifecycle = new Proxy(
  {},
  {
    get: (_t, prop) =>
      prop === 'then' ? undefined : async () => { throw dbFailure(); },
  }
) as unknown as ApplicationLifecycleService;

describe('a failing handler answers without the error text', () => {
  let app: Express;
  let tenant: TestTenant;

  /** getDb() fails from its `at`-th call (0: the first) for the next request. */
  const failDbFrom = (at: number) => {
    failFrom.calls = 0;
    failFrom.at = at;
  };

  const expectNoSecret = (res: request.Response) => {
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify(res.body)).not.toMatch(/relation "|pg_dump|password authentication/);
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Internal error text');
    app = express();
    app.use(express.json());
    app.use(tenant.context({ deploymentAdmin: true }));
    app.use((req, _res, next) => {
      const tr = req as TenantRequest & { isDeploymentAdmin?: boolean };
      tr.tenant = { id: tenant.tenantId, isAdmin: true };
      tr.org = { id: tenant.organizationId, isAdmin: true };
      tr.isDeploymentAdmin = true;
      next();
    });
    app.use('/api/settings', createSettingsRoutes());
    app.use('/api/budgets', createBudgetRoutes());
    app.use('/api/data-management', createDataManagementRoutes({ backupService: new BackupService(pool) }));
    app.use('/api/admin/notifications', createNotificationAdminRoutes({ lifecycleService: failingLifecycle, config: config() }));
    app.use('/api/notifications', createNotificationRoutes({ notificationRuleService: new NotificationRuleService() }));
    app.use('/api/backup', createBackupRoutes(routeDependencies({ lifecycleService: failingLifecycle, backupService: new BackupService(pool) })));
    app.use('/api/goals', createGoalRoutes());
    app.use('/api/investments', createInvestmentsRoutes());
  });

  afterEach(() => {
    failFrom.at = Infinity;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('GET /api/settings/general', async () => {
    failDbFrom(0);
    const res = await request(app).get('/api/settings/general');
    expect(res.status).toBe(500);
    expectNoSecret(res);
    expect(res.body.error).toBe('Internal server error');
  });

  it.each(['items', 'envelope-transfers'])('GET /api/budgets/periods/:uuid/%s', async (what) => {
    failDbFrom(0);
    const res = await request(app).get(`/api/budgets/periods/${NIL_UUID}/${what}`);
    expect(res.status).toBe(500);
    expectNoSecret(res);
    expect(res.body.error).toBe('Internal server error');
  });

  /** The deletion of what a preview of January 2020 found. */
  const previewedJanuary = async () => {
    const range = { dateFrom: '2020-01-01', dateTo: '2020-01-31' };
    const res = await request(app).post('/api/data-management/preview-delete-transactions').send(range);
    expect(res.status).toBe(200);
    return { ...range, selectionKey: res.body.selectionKey };
  };

  it('POST /api/data-management/delete-transactions, when the database fails', async () => {
    const deletion = await previewedJanuary();
    failDbFrom(0);
    const res = await request(app)
      .post('/api/data-management/delete-transactions')
      .send({ ...deletion, createBackup: false });
    expect(res.status).toBe(500);
    expectNoSecret(res);
    expect(res.body).not.toHaveProperty('details');
  });

  it('POST /api/data-management/delete-transactions, when the backup before it fails', async () => {
    vi.spyOn(BackupService.prototype, 'createBackup').mockRejectedValueOnce(
      new Error('Backup creation failed: pg_dump: error: connection to server at "db.internal" failed: FATAL: password authentication failed for user "internal_secret_xyz"')
    );
    const res = await request(app)
      .post('/api/data-management/delete-transactions')
      .send({ ...(await previewedJanuary()), createBackup: true });
    expect(res.status).toBe(500);
    expectNoSecret(res);
    expect(res.body.error).toBe('Backup creation failed. Deletion has been blocked for safety.');

    // A refusal written for people still says what to do.
    vi.spyOn(BackupService.prototype, 'createBackup').mockRejectedValueOnce(new BackupKeyMissingError());
    const noKey = await request(app)
      .post('/api/data-management/delete-transactions')
      .send({ ...(await previewedJanuary()), createBackup: true });
    expect(noKey.status).toBe(500);
    expect(noKey.body.message).toMatch(/No backup encryption key has been generated/);
  });

  it.each(['start', 'stop', 'restart'])('POST /api/admin/notifications/scheduler/%s', async (action) => {
    const res = await request(app).post(`/api/admin/notifications/scheduler/${action}`);
    expect(res.status).toBe(500);
    expectNoSecret(res);
    expect(res.body).not.toHaveProperty('details');
  });

  it('DELETE /api/notifications/history', async () => {
    failDbFrom(0);
    const res = await request(app).delete('/api/notifications/history');
    expect(res.status).toBe(500);
    expectNoSecret(res);
  });

  it('GET /api/admin/notifications/preview/:templateType', async () => {
    vi.spyOn(EmailTemplateService.prototype, 'renderTemplate').mockRejectedValueOnce(dbFailure());
    const res = await request(app).get('/api/admin/notifications/preview/transaction-review');
    expect(res.status).toBe(500);
    expectNoSecret(res);
  });

  it('POST /api/admin/notifications/test says what to check, not what the mail server said', async () => {
    vi.spyOn(EmailDeliveryService.prototype, 'sendEmailWithRetry').mockRejectedValueOnce(
      Object.assign(new Error(`Invalid login: 535 Authentication Credentials Invalid for internal_secret_xyz@smtp.internal`), { code: 'EAUTH' })
    );
    const res = await request(app)
      .post('/api/admin/notifications/test')
      .send({ recipient: 'someone@example.com', templateType: 'transaction-review' });
    // The mail server's failure, a 502 (it was a 500 before the route moved to /api/admin).
    expect(res.status).toBe(502);
    expectNoSecret(res);
    expect(res.body).toMatchObject({
      error: 'Failed to send test email',
      message: 'The mail server refused the sign-in: check the SMTP username and password',
    });
  });

  it('GET /api/backup/create-status after a failed manual backup', async () => {
    vi.spyOn(BackupService.prototype, 'createBackup').mockRejectedValueOnce(
      new Error('Backup creation failed: pg_dump: error: connection to server at "db.internal" failed: FATAL: password authentication failed for user "internal_secret_xyz"')
    );
    expect((await request(app).post('/api/backup/create')).status).toBe(202);
    await vi.waitFor(async () => expect((await request(app).get('/api/backup/create-status')).body.status).toBe('failed'));
    const status = await request(app).get('/api/backup/create-status');
    expectNoSecret(status);
    expect(status.body.error).toBe('Backup failed; the server log has the details');

    // No key yet: the status says what to do.
    vi.spyOn(BackupService.prototype, 'createBackup').mockRejectedValueOnce(new BackupKeyMissingError());
    expect((await request(app).post('/api/backup/create')).status).toBe(202);
    await vi.waitFor(async () => {
      const again = await request(app).get('/api/backup/create-status');
      expect(again.body.error).toMatch(/No backup encryption key has been generated/);
    });
  });

  describe('goal associations', () => {
    let goalUuid: string;
    let plainItemId: number;

    beforeAll(async () => {
      goalUuid = (
        await tenant.pool.query(
          `INSERT INTO budget_items (name, expense_type, type, status) VALUES ('Paused goal', 'Savings', 'Goal', 'paused') RETURNING uuid`
        )
      ).rows[0].uuid;
      plainItemId = (
        await tenant.pool.query(
          `INSERT INTO budget_items (name, expense_type, rollover, status) VALUES ('Paused groceries', 'Expense', false, 'paused') RETURNING id`
        )
      ).rows[0].id;
    });

    // An account that doesn't exist was the foreign key's 500, with its text.
    it('POST /api/goals/:uuid/accounts with an account that does not exist: 400 INVALID_REFERENCE', async () => {
      const res = await request(app).post(`/api/goals/${goalUuid}/accounts`).send({ account_id: 2147480000 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_REFERENCE', field: 'account_id' });
      expect(JSON.stringify(res.body)).not.toMatch(/foreign key|budget_item_accounts/);
    });

    // The foreign key, which RLS doesn't apply to, took another ledger's account.
    it("POST /api/goals/:uuid/accounts with another ledger's account: 400 INVALID_REFERENCE, and nothing linked", async () => {
      const other = await createTestTenant('Internal error text, other ledger');
      try {
        const theirs = (
          await other.pool.query(
            `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Their checking', 'checking', 'cash', 'Asset') RETURNING id`
          )
        ).rows[0].id;
        const res = await request(app).post(`/api/goals/${goalUuid}/accounts`).send({ account_id: theirs });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'INVALID_REFERENCE', field: 'account_id' });
        expect((await tenant.pool.query('SELECT 1 FROM budget_item_accounts WHERE account_id = $1', [theirs])).rowCount).toBe(0);
      } finally {
        await other.cleanup();
      }
    });

    // A non-numeric id reached the database: "invalid input syntax for type integer".
    it.each([
      ['accounts', { account_id: 'abc' }],
      ['budget-items', { budget_item_id: 'abc' }],
    ])('POST /api/goals/:uuid/%s with an id that is not one: 400', async (what, body) => {
      const res = await request(app).post(`/api/goals/${goalUuid}/${what}`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.body)).not.toMatch(/invalid input syntax/);
    });

    it('POST /api/goals/:uuid/budget-items: a budget item that is not one, or not rollover', async () => {
      const missing = await request(app).post(`/api/goals/${goalUuid}/budget-items`).send({ budget_item_id: 2147480000 });
      expect(missing.status).toBe(400);
      expect(missing.body).toMatchObject({ code: 'INVALID_REFERENCE', field: 'budget_item_id' });
      const plain = await request(app).post(`/api/goals/${goalUuid}/budget-items`).send({ budget_item_id: plainItemId });
      expect(plain.status).toBe(400);
      expect(plain.body).toMatchObject({ code: 'BUDGET_ITEM_NOT_ROLLOVER', error: 'Only rollover (envelope) budget items can be associated with goals' });
    });

    it('POST /api/goals/:uuid/accounts when the database fails', async () => {
      failDbFrom(1); // the goal lookup works; the association fails
      const res = await request(app).post(`/api/goals/${goalUuid}/accounts`).send({ account_id: 1 });
      expect(res.status).toBe(500);
      expectNoSecret(res);
      expect(res.body.error).toBe('Internal server error');
    });
  });

  it('POST /api/investments/prices/bulk: a row the database refused says only that it failed', async () => {
    const { uuid } = (await tenant.pool.query<{ uuid: string }>(`INSERT INTO securities (ticker, name) VALUES ('IETXYZ', 'Internal error text') RETURNING uuid`)).rows[0]!;
    // From the record's own statement: the first is the up-front lock of the securities.
    failDbFrom(1);
    const res = await request(app)
      .post('/api/investments/prices/bulk')
      .send({ prices: [{ security_uuid: uuid, price_date: '2026-01-02', close: 10 }] });
    expect(res.status).toBe(200);
    expectNoSecret(res);
    expect(res.body.results).toEqual([{ index: 0, ok: false, error: 'This price could not be saved' }]);

    // An unknown security is the caller's to fix, and says so.
    failFrom.at = Infinity;
    const unknown = await request(app)
      .post('/api/investments/prices/bulk')
      .send({ prices: [{ security_uuid: NIL_UUID, price_date: '2026-01-02', close: 10 }] });
    expect(unknown.body.results).toEqual([{ index: 0, ok: false, error: 'Security not found' }]);
  });
});
