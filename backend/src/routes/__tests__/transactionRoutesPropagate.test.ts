import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
  process.env.ENCRYPTION_KEY ??= 'transaction-routes-propagate-key-0123456789';
});

import request from 'supertest';
import express from 'express';
import { createApp } from '../../app.js';
import { mountRoutes } from '../../routes.js';
import { rejectMalformedIds as ids } from '../../middleware/routeParams.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { ControlPlaneError } from '../../services/controlPlaneErrors.js';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';

vi.mock('../../services/transactions/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/transactions/index.js')>();
  return { ...actual, updateTransaction: vi.fn(actual.updateTransaction), createTransaction: vi.fn(actual.createTransaction) };
});
const transactions = await import('../../services/transactions/index.js');
const { createTransactionsRoutes } = await import('../transactions.js');

/**
 * The transaction routes let an error propagate to the route wrapper: a
 * refusal the service throws keeps its status, whatever its class, and anything else is
 * a 500 without its text. PUT /:uuid and POST / caught everything but a
 * TransactionRefusal and answered 500 "Failed to update transaction", so a 409
 * TRANSACTION_BUSY from a lock the single edit takes would have reached the
 * client as a 500.
 */

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

const MISSING = '00000000-0000-7000-8000-000000000000';
const busy = () => new ControlPlaneError(409, 'TRANSACTION_BUSY', 'Another change to this transaction was being saved. Try again.');

describe('Transaction routes: errors reach the route wrapper', () => {
  let tenant: TestTenant;
  let app: express.Application;

  beforeAll(async () => {
    tenant = await createTestTenant('Transaction routes propagate');
    app = createApp();
    app.use('/api/probe/transactions', tenant.context(), ids(createTransactionsRoutes()));
    mountRoutes(app, { lifecycleService: lifecycleStub });
  });

  afterEach(() => {
    vi.mocked(transactions.updateTransaction).mockReset();
    vi.mocked(transactions.createTransaction).mockReset();
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('PUT /:uuid answers a busy edit 409 TRANSACTION_BUSY, not 500', async () => {
    vi.mocked(transactions.updateTransaction).mockRejectedValueOnce(busy());
    const res = await request(app).put(`/api/probe/transactions/${MISSING}`).send({ description: 'x' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: busy().message,
      code: 'TRANSACTION_BUSY',
      message: busy().message,
      requestId: res.headers['x-request-id'],
    });
  });

  it('POST / answers a busy create 409 TRANSACTION_BUSY, not 500', async () => {
    vi.mocked(transactions.createTransaction).mockRejectedValueOnce(busy());
    const res = await request(app)
      .post('/api/probe/transactions')
      .send({ account_uuid: MISSING, transaction_date: '2026-03-01', description: 'x', amount: -5, type: 'expense' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TRANSACTION_BUSY');
  });

  it('answers any other error 500 without its text', async () => {
    vi.mocked(transactions.updateTransaction).mockRejectedValueOnce(new Error('relation "secret_table" does not exist'));
    const res = await request(app).put(`/api/probe/transactions/${MISSING}`).send({ description: 'x' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error', code: 'INTERNAL_ERROR', requestId: res.headers['x-request-id'] });
  });
});
