import { describe, it, expect } from 'vitest';
import { apiErrorBodySchema } from '@nuggets/shared';
import type { Response } from 'express';
import { RECORD_BUSY_MESSAGE, answerError, completeErrorBody, defaultErrorCode, publicErrorMessage } from '../apiError.js';
import { ControlPlaneError } from '../../services/controlPlaneErrors.js';
import { DomainError, refusalFromBody } from '../../services/domainErrors.js';
import { TransactionRefusal, badRequest, invalidReference, notFound } from '../../services/transactions/refusal.js';
import { AccountError } from '../../services/accounts/AccountError.js';
import { UserError } from '../../services/UserService.js';
import { BillError } from '../../services/bills/BillService.js';
import { BudgetItemNotFoundError } from '../../services/budgetItems/BudgetItemEditor.js';
import { requestIdFor } from '../../middleware/logger.js';
import { logContext } from '../logger.js';
import {
  noteRequestUser,
  runInRequestScope,
  runInTenantScope,
  runOutsideRequestContext,
  runWithRequestContext,
} from '../../context/requestContext.js';

/** The pieces of the one error shape and the request id, without the app. */
describe('API error shape', () => {
  it('completes an error body with a code from its status and the request id', () => {
    expect(completeErrorBody({ error: 'Goal not found' }, 404, 'req-1')).toEqual({ error: 'Goal not found', code: 'NOT_FOUND', requestId: 'req-1' });
    expect(completeErrorBody({ success: false, message: 'Bad input' }, 400, 'req-2')).toEqual({
      success: false,
      message: 'Bad input',
      error: 'Bad input',
      code: 'BAD_REQUEST',
      requestId: 'req-2',
    });
    expect(completeErrorBody({}, 503, 'req-3')).toEqual({ error: 'Service Unavailable', code: 'SERVICE_UNAVAILABLE', requestId: 'req-3' });
    // What a route set stays.
    expect(completeErrorBody({ error: 'x', code: 'MINE', requestId: 'kept' }, 409, 'req-4')).toEqual({ error: 'x', code: 'MINE', requestId: 'kept' });
    expect(apiErrorBodySchema.safeParse(completeErrorBody({ error: 'Goal not found' }, 404, 'req-1')).success).toBe(true);
  });

  it('leaves alone what is not a JSON error object, and JSON-RPC answers', () => {
    expect(completeErrorBody('text', 400, 'r')).toBe('text');
    expect(completeErrorBody([1], 400, 'r')).toEqual([1]);
    const rpc = { jsonrpc: '2.0', error: { code: -32001, message: 'Missing Authorization header' }, id: null };
    expect(completeErrorBody(rpc, 401, 'r')).toEqual(rpc);
  });

  it('has a code for every status', () => {
    expect(defaultErrorCode(413)).toBe('PAYLOAD_TOO_LARGE');
    expect(defaultErrorCode(418)).toBe('REQUEST_FAILED');
    expect(defaultErrorCode(599)).toBe('INTERNAL_ERROR');
  });

  it("shows a refusal's message and nothing else's", () => {
    expect(publicErrorMessage(new ControlPlaneError(409, 'X', 'Written for people'), 'fallback')).toBe('Written for people');
    expect(publicErrorMessage(notFound('Transaction not found'), 'fallback')).toBe('Transaction not found');
    expect(publicErrorMessage(new Error('relation "secret" does not exist'), 'fallback')).toBe('fallback');
    expect(publicErrorMessage('a string', 'fallback')).toBe('fallback');
  });
});

describe('refusals (DomainError)', () => {
  /** What answerError sends for `err`: its status and body (outside a request, so no requestId). */
  const answered = (err: unknown) => {
    let status = 0;
    let body: unknown;
    const res = {
      headersSent: false,
      status(code: number) { status = code; return this; },
      json(value: unknown) { body = value; return this; },
    } as unknown as Response;
    answerError(err, res);
    return { status, body };
  };

  it('every refusal class is one, and keeps its name', () => {
    const refusals = [
      new ControlPlaneError(404, 'X', 'x'),
      notFound('x'),
      new AccountError(404, { error: 'x' }),
      new UserError(400, 'X', 'x'),
      new BillError('x', 404),
      new BudgetItemNotFoundError(),
    ];
    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(DomainError);
      expect(refusal).toBeInstanceOf(Error);
      expect(refusal.name).toBe(refusal.constructor.name);
    }
    expect(notFound('x')).toBeInstanceOf(TransactionRefusal);
  });

  // A deadlock or a lock timeout that no service mapped to its own refusal was a 500.
  it('answers a lock conflict no service answered with 409 RECORD_BUSY, and the refusals as they are', () => {
    for (const code of ['40P01', '55P03']) {
      const err = Object.assign(new Error(`relation "internal_secret" lock (${code})`), { code });
      expect(answered(err)).toEqual({ status: 409, body: { error: RECORD_BUSY_MESSAGE, code: 'RECORD_BUSY' } });
    }
    expect(answered(new ControlPlaneError(409, 'TRANSACTION_BUSY', 'These transactions were busy')).body).toMatchObject({ code: 'TRANSACTION_BUSY' });
    expect(answered(Object.assign(new Error('duplicate key'), { code: '23505' })).status).toBe(500);
  });

  it('answers { ...details, error, code, message } with its status', () => {
    expect(answered(new UserError(409, 'LAST_ADMIN', 'Make someone else an admin first', { organizations: ['Home'] }))).toEqual({
      status: 409,
      body: { organizations: ['Home'], error: 'Make someone else an admin first', code: 'LAST_ADMIN', message: 'Make someone else an admin first' },
    });
    // Details can't replace the answer's own fields.
    expect(answered(new DomainError(400, 'X', 'the message', { error: 'other', code: 'OTHER', message: 'other' })).body).toEqual({
      error: 'the message', code: 'X', message: 'the message',
    });
  });

  it('a refusal written as its answer body keeps that body, with message added', () => {
    expect(answered(badRequest('Cannot transfer to the same account'))).toEqual({
      status: 400,
      body: { error: 'Cannot transfer to the same account', code: 'BAD_REQUEST', message: 'Cannot transfer to the same account' },
    });
    expect(answered(invalidReference('merchant_id')).body).toEqual({
      error: 'merchant_id does not name a merchant in this tenant',
      code: 'INVALID_REFERENCE',
      field: 'merchant_id',
      message: 'merchant_id does not name a merchant in this tenant',
    });
    // One with a message of its own keeps both texts.
    expect(answered(new AccountError(409, { error: 'The account is busy', code: 'RECORD_BUSY', message: 'Try again in a moment.' })).body).toEqual({
      error: 'The account is busy', code: 'RECORD_BUSY', message: 'Try again in a moment.',
    });
  });

  it('refusalFromBody: the code from the status when the body names none', () => {
    expect(refusalFromBody(404, { error: 'Gone' })).toEqual([404, 'NOT_FOUND', 'Gone', {}, { heading: 'Gone' }]);
    expect(refusalFromBody(400, { error: 'E', code: 'C', message: 'M', field: 'f' })).toEqual([400, 'C', 'M', { field: 'f' }, { heading: 'E' }]);
  });

  it('anything else is a 500 without its text', () => {
    expect(answered(new Error('relation "secret" does not exist'))).toEqual({
      status: 500,
      body: { error: 'Internal server error', code: 'INTERNAL_ERROR' },
    });
  });
});

describe('request ids', () => {
  it('keeps an inbound X-Request-Id only when it is short and plain', () => {
    expect(requestIdFor('mcp-3f2a_7.b:1')).toBe('mcp-3f2a_7.b:1');
    expect(requestIdFor(['first', 'second'])).toBe('first');
    for (const bad of [undefined, '', 'x'.repeat(65), 'has space', 'line\nbreak', '-dash', 'é']) {
      expect(requestIdFor(bad)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('puts the request id, the user and the tenant on log lines, and none of it on a detached job', async () => {
    expect(logContext()).toEqual({});
    await runInRequestScope({ requestId: 'req-ctx' }, async () => {
      expect(logContext()).toEqual({ requestId: 'req-ctx' });
      noteRequestUser(7);
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(logContext()).toEqual({ requestId: 'req-ctx', userId: 7 });
      await runWithRequestContext({ userId: 7, tenantId: 3, isDeploymentAdmin: false }, async () => {
        expect(logContext()).toEqual({ requestId: 'req-ctx', userId: 7, tenantId: 3 });
        // A timer a request arms runs as no request (db/withTenant.ts runDetached).
        runOutsideRequestContext(() => expect(logContext()).toEqual({}));
      });
    });
    // A background job's per-tenant work carries its tenant.
    runInTenantScope(5, () => expect(logContext()).toEqual({ tenantId: 5 }));
  });
});
