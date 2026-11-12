import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
  // The backup and OneDrive routers build their services when mounted (see apiContract.test.ts).
  process.env.ENCRYPTION_KEY ??= 'refusal-answers-test-encryption-key-0123456789';
});

import request from 'supertest';
import { budgetExpenseType } from '@nuggets/shared';
import express from 'express';
import { createApp } from '../../app.js';
import { mountRoutes } from '../../routes.js';
import { rejectMalformedIds as ids } from '../../middleware/routeParams.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { createTransactionsRoutes } from '../transactions.js';
import { createTransferRoutes } from '../transfer.js';
import { createAccountsRoutes } from '../accounts.js';
import { createAdminRoutes } from '../admin.js';
import { createBillRoutes } from '../bills.js';
import { createBudgetRoutes } from '../budgets.js';
import { createBudgetPeriodRoutes } from '../budget-periods.js';
import { createNotificationLinkRoutes } from '../notificationLinks.js';
import { createOrganizationRoutes } from '../organizations.js';
import { createInvitationRoutes } from '../invitations.js';
import { NotificationRuleService } from '../../services/notifications/NotificationRuleService.js';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';

/**
 * What each kind of refusal answers, through the real middleware stack and error handlers
 * (createApp + mountRoutes), so the request scope's `code` and `requestId` are in the body
 * as a client gets it. One case per refusal class the routes answer: a transaction
 * refusal, an account error (one whose `message` differs from its `error`), a user error,
 * a bill error, the budget-item errors, a notification-link error, a control-plane error
 * from a param handler and from a handler, and the budget-period route's own 404.
 *
 * Every refusal is a DomainError (services/domainErrors.ts), answered by the route
 * wrapper as `{ ...details, error, code, message, requestId }`: the bodies the routes
 * answered before the classes were one hierarchy, each with `message` (the error's text,
 * or the refusal's own message where it had one), and nothing else changed.
 */

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MISSING = '00000000-0000-7000-8000-000000000000';

describe('Refusal answers', () => {
  let tenant: TestTenant;
  let app: express.Application;

  beforeAll(async () => {
    tenant = await createTestTenant('Refusal answers');
    app = createApp();
    const member = tenant.context();
    const admin = tenant.context({ deploymentAdmin: true });
    app.use('/api/probe/transactions', member, ids(createTransactionsRoutes()));
    app.use('/api/probe/transfer', member, ids(createTransferRoutes()));
    app.use('/api/probe/accounts', member, ids(createAccountsRoutes()));
    app.use('/api/probe/admin', admin, createAdminRoutes());
    app.use('/api/probe/bills', member, ids(createBillRoutes()));
    app.use('/api/probe/budgets', member, ids(createBudgetRoutes()));
    app.use('/api/probe/budget-periods', member, ids(createBudgetPeriodRoutes()));
    app.use('/api/probe/notification-links', createNotificationLinkRoutes({ notificationRuleService: new NotificationRuleService() }));
    app.use('/api/probe/organizations', member, ids(createOrganizationRoutes()));
    app.use('/api/probe/invitations', member, ids(createInvitationRoutes()));
    mountRoutes(app, { lifecycleService: lifecycleStub });
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  /** The answer's status and body, its requestId checked and left out. */
  const answer = (res: request.Response) => {
    expect(res.body.requestId, JSON.stringify(res.body)).toMatch(UUID);
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    const { requestId: _requestId, ...body } = res.body as Record<string, unknown>;
    return { status: res.status, body };
  };

  let accountCount = 0;
  const createAccount = async () => {
    const res = await request(app)
      .post('/api/probe/accounts')
      .send({ name: `Refusal account ${++accountCount}`, account_type: 'checking', account_group: 'cash', type: 'Asset', initial_balance: 10 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: number; uuid: string; name: string };
  };

  const createBudgetItem = async (name: string) => {
    const res = await request(app).post('/api/probe/budgets/items').send({ name, type: 'expense' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: number; uuid: string };
  };

  describe('a transaction refusal', () => {
    it('a transaction that is not there: 404', async () => {
      const res = await request(app).put(`/api/probe/transactions/${MISSING}`).send({ description: 'x' });
      expect(answer(res)).toEqual({ status: 404, body: { error: 'Transaction not found', code: 'NOT_FOUND', message: 'Transaction not found' } });
    });

    it('a tag on a transaction that is not there: 404', async () => {
      const res = await request(app).post(`/api/probe/transactions/${MISSING}/tags/${MISSING}`);
      expect(answer(res)).toEqual({ status: 404, body: { error: 'Transaction not found', code: 'NOT_FOUND', message: 'Transaction not found' } });
    });

    it('an id that names no row of this ledger: 400 INVALID_REFERENCE with its field', async () => {
      const account = await createAccount();
      const res = await request(app)
        .post('/api/probe/transactions')
        .send({ account_uuid: account.uuid, transaction_date: '2026-03-01', description: 'x', amount: -5, type: 'expense', merchant_id: 2147483000 });
      expect(answer(res)).toEqual({
        status: 400,
        body: {
          error: 'merchant_id does not name a merchant in this tenant',
          code: 'INVALID_REFERENCE',
          field: 'merchant_id',
          message: 'merchant_id does not name a merchant in this tenant',
        },
      });
    });

    it('a transfer to the account it is from: 400', async () => {
      const account = await createAccount();
      const res = await request(app)
        .post('/api/probe/transfer')
        .send({ source_account_uuid: account.uuid, destination_account_uuid: account.uuid, amount: 5, transaction_date: '2026-03-01', type: 'transfer' });
      expect(answer(res)).toEqual({ status: 400, body: { error: 'Cannot transfer to the same account', code: 'BAD_REQUEST', message: 'Cannot transfer to the same account' } });
    });
  });

  describe('an account error', () => {
    it('an account that is not there: 404', async () => {
      const res = await request(app).put(`/api/probe/accounts/${MISSING}/instructions`).send({ instructions: 'x' });
      expect(answer(res)).toEqual({ status: 404, body: { error: 'Account not found', code: 'NOT_FOUND', message: 'Account not found' } });
    });

    it('an account with transactions: 400 with its own message and details', async () => {
      const account = await createAccount();
      await request(app)
        .post('/api/probe/transactions')
        .send({ account_uuid: account.uuid, transaction_date: '2026-03-01', description: 'x', amount: -5, type: 'expense' })
        .expect(201);
      const res = await request(app).delete(`/api/probe/accounts/${account.uuid}`);
      expect(answer(res)).toEqual({
        status: 400,
        body: {
          error: 'Cannot delete account with dependent records',
          code: 'BAD_REQUEST',
          message: expect.stringContaining(`Account "${account.name}" cannot be deleted because it has 1 transaction.`),
          details: {
            accountName: account.name,
            transactionCount: 1,
            recommendation: 'Use the "Hide Account" option to remove from view without losing data',
          },
        },
      });
    });
  });

  describe('a user error', () => {
    it('a user that is not there: 404 USER_NOT_FOUND', async () => {
      const res = await request(app).delete(`/api/probe/admin/users/${MISSING}`);
      expect(answer(res)).toEqual({ status: 404, body: { error: 'User not found', code: 'USER_NOT_FOUND', message: 'User not found' } });
    });

    it('a new user without the fields it needs: 400 MISSING_FIELDS', async () => {
      const res = await request(app).post('/api/probe/admin/users').send({});
      expect(answer(res)).toEqual({ status: 400, body: { error: 'Email, password, and first name are required', code: 'MISSING_FIELDS', message: 'Email, password, and first name are required' } });
    });
  });

  it('a bill error: 404', async () => {
    const res = await request(app).get(`/api/probe/bills/occurrences/${MISSING}/candidates`);
    expect(answer(res)).toEqual({ status: 404, body: { error: 'That bill payment wasn’t found.', code: 'NOT_FOUND', message: 'That bill payment wasn’t found.' } });
  });

  describe('the budget-item errors', () => {
    it('an item that is not there, edited: 404', async () => {
      const res = await request(app).put(`/api/probe/budgets/items/${MISSING}`).send({ name: 'x' });
      expect(answer(res)).toEqual({ status: 404, body: { error: 'Budget item not found', code: 'NOT_FOUND', message: 'Budget item not found' } });
    });

    it('an edit that names no field: 400', async () => {
      const item = await createBudgetItem('Refusal no fields');
      const res = await request(app).put(`/api/probe/budgets/items/${item.uuid}`).send({ bogus: 1 });
      expect(answer(res)).toEqual({ status: 400, body: { error: 'No valid fields to update', code: 'BAD_REQUEST', message: 'No valid fields to update' } });
    });

    // The editor's own refusal: an expense type outside the vocabulary (the body's schema takes
    // any text there on update, since an older item may send back a legacy one).
    it('a value the item cannot hold: 400', async () => {
      const item = await createBudgetItem('Refusal bad value');
      const res = await request(app).put(`/api/probe/budgets/items/${item.uuid}`).send({ expense_type: 'Bogus' });
      const said = `expense_type must be one of: ${budgetExpenseType.options.join(', ')}`;
      expect(answer(res)).toEqual({ status: 400, body: { error: said, code: 'BAD_REQUEST', message: said } });
    });

    it('the usage of an item that is not there: 404', async () => {
      const res = await request(app).get(`/api/probe/budgets/items/${MISSING}/usage`);
      expect(answer(res)).toEqual({ status: 404, body: { error: 'Budget item not found', code: 'NOT_FOUND', message: 'Budget item not found' } });
    });

    it('an item merged into itself: 400', async () => {
      const item = await createBudgetItem('Refusal merge');
      const res = await request(app).post(`/api/probe/budgets/items/${item.uuid}/merge`).send({ into_uuid: item.uuid });
      expect(answer(res)).toEqual({ status: 400, body: { error: 'Choose a different budget item to merge into.', code: 'BAD_REQUEST', message: 'Choose a different budget item to merge into.' } });
    });
  });

  it('a notification link that does not work: 404', async () => {
    const res = await request(app).post('/api/probe/notification-links/inspect').send({ token: 'not-a-signed-token' });
    expect(answer(res)).toEqual({
      status: 404,
      body: { error: 'This link has expired or doesn’t work. Choose what you get in My Profile.', code: 'NOT_FOUND', message: 'This link has expired or doesn’t work. Choose what you get in My Profile.' },
    });
  });

  describe('a control-plane error', () => {
    it('from the organization routes’ uuid check: 403 ORG_ADMIN_REQUIRED', async () => {
      const { rows } = await tenant.pool.query<{ uuid: string }>('SELECT uuid FROM organizations WHERE id = $1', [tenant.organizationId]);
      const res = await request(app).get(`/api/probe/organizations/${rows[0]!.uuid}`);
      expect(answer(res)).toEqual({
        status: 403,
        body: { error: 'Organization admin required.', code: 'ORG_ADMIN_REQUIRED', message: 'Organization admin required.' },
      });
    });

    it('from a handler: an invitation that is not there', async () => {
      const res = await request(app).post('/api/probe/invitations/inspect').send({ token: 'x'.repeat(43) });
      const { status, body } = answer(res);
      expect(status).toBe(404);
      expect(body).toEqual({ error: body.message, code: body.code, message: body.message });
      expect(typeof body.message).toBe('string');
    });
  });

  it('the budget-period route’s own refusal: a period that is not there, 404', async () => {
    const res = await request(app).delete(`/api/probe/budget-periods/${MISSING}`);
    expect(answer(res)).toEqual({ status: 404, body: { error: 'Budget period not found', code: 'NOT_FOUND', message: 'Budget period not found' } });
  });
});
