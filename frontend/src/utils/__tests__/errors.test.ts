import { describe, it, expect } from 'vitest';
import {
  errorMessage,
  errorStatus,
  errorResponseData,
  errorResponseMessage,
  errorDetailsText,
  errorCode,
  errorRequestId,
  apiErrorMessage,
} from '../errors';

const apiError = () =>
  Object.assign(new Error('Ledger not found'), {
    status: 404,
    details: 'no such ledger',
    response: { data: { error: 'Tenant not found', message: 'raw message' } },
  });

describe('errorMessage', () => {
  it("reads an Error's message", () => {
    expect(errorMessage(new Error('boom'), 'fallback')).toBe('boom');
  });

  it('falls back for an empty message, a non-object or a missing message', () => {
    expect(errorMessage(new Error(''), 'fallback')).toBe('fallback');
    expect(errorMessage('a string', 'fallback')).toBe('fallback');
    expect(errorMessage(undefined, 'fallback')).toBe('fallback');
    expect(errorMessage(null, 'fallback')).toBe('fallback');
    expect(errorMessage({ message: 42 }, 'fallback')).toBe('fallback');
  });

  it('reads a plain object with a message, as `error.message` did', () => {
    expect(errorMessage({ message: 'thrown object' }, 'fallback')).toBe('thrown object');
  });
});

describe('API error fields', () => {
  it('reads what base.ts attaches', () => {
    const error = apiError();
    expect(errorStatus(error)).toBe(404);
    expect(errorDetailsText(error)).toBe('no such ledger');
    expect(errorResponseData(error)).toEqual({ error: 'Tenant not found', message: 'raw message' });
    expect(errorResponseMessage(error)).toBe('raw message');
  });

  it('answers undefined when a field is missing or has another type', () => {
    expect(errorStatus(new Error('x'))).toBeUndefined();
    expect(errorStatus({ status: '404' })).toBeUndefined();
    expect(errorDetailsText({ details: { nested: true } })).toBeUndefined();
    expect(errorResponseData(new Error('x'))).toBeUndefined();
    expect(errorResponseData({ response: { data: 'text' } })).toBeUndefined();
    expect(errorResponseMessage({ response: { data: { message: '' } } })).toBeUndefined();
    expect(errorStatus(undefined)).toBeUndefined();
  });
});

describe('the API error shape', () => {
  it("reads an API error's code and request id", () => {
    const error = Object.assign(new Error('Goal not found'), { status: 404, code: 'NOT_FOUND', requestId: 'req-1' });
    expect(errorCode(error)).toBe('NOT_FOUND');
    expect(errorRequestId(error)).toBe('req-1');
    expect(errorCode(new Error('x'))).toBeUndefined();
    expect(errorRequestId({ requestId: 42 })).toBeUndefined();
  });

  it("shows an API error's reason, and the fallback for anything else", () => {
    expect(apiErrorMessage(apiError(), 'Failed to save')).toBe('Ledger not found');
    // A network failure or a bug isn't the server's reason.
    expect(apiErrorMessage(new TypeError('Failed to fetch'), 'Failed to save')).toBe('Failed to save');
    expect(apiErrorMessage(Object.assign(new Error(''), { status: 500 }), 'Failed to save')).toBe('Failed to save');
  });
});
