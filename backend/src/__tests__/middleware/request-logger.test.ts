import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { httpLoggerOptions, requestIdFor, serializeRequest, serializeResponse } from '../../middleware/logger.js';

/**
 * The request log line (middleware/logger.ts): what it keeps of a request and a response
 * however pino-http hands them over, its level and message by status, and the probes it
 * leaves out. logHygiene.test.ts checks what a logged line never carries.
 */

/** An option the logger must set (the tests fail, rather than skip, without it). */
function defined<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`httpLoggerOptions.${name} is not set`);
  return value;
}
const options = {
  genReqId: defined(httpLoggerOptions.genReqId, 'genReqId'),
  customLogLevel: defined(httpLoggerOptions.customLogLevel, 'customLogLevel'),
  customSuccessMessage: defined(httpLoggerOptions.customSuccessMessage, 'customSuccessMessage'),
  customErrorMessage: defined(httpLoggerOptions.customErrorMessage, 'customErrorMessage'),
  autoLogging: { ignore: defined((httpLoggerOptions.autoLogging as { ignore?: (req: IncomingMessage) => boolean }).ignore, 'autoLogging.ignore') },
};
const raw = (fields: Record<string, unknown>) => fields as unknown as IncomingMessage & { originalUrl?: string; ip?: string };
const response = (statusCode: number) => ({ statusCode }) as ServerResponse;

describe('requestIdFor', () => {
  it('keeps an inbound id it accepts, the first of several, and makes one for anything else', () => {
    expect(requestIdFor('mcp-call:42.a_b')).toBe('mcp-call:42.a_b');
    expect(requestIdFor(['first-id', 'second-id'])).toBe('first-id');
    for (const header of [undefined, '', 'has space', 'x'.repeat(65), '-leading-dash', 'line\nbreak']) {
      expect(requestIdFor(header)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

describe('serializeRequest', () => {
  it('reads the method, path, headers and address from the raw request when the serialized one lacks them', () => {
    const line = serializeRequest({
      id: 'req-1',
      raw: raw({
        method: 'POST',
        originalUrl: '/api/import/callback?code=secret-oauth-code',
        url: '/callback',
        headers: { host: 'nuggets.example.com', cookie: 'nuggets_session=secret', authorization: 'Bearer secret', 'content-type': 'application/json' },
        ip: '203.0.113.7',
      }),
    });
    expect(line).toEqual({
      id: 'req-1',
      method: 'POST',
      url: '/api/import/callback',
      headers: { host: 'nuggets.example.com', 'content-type': 'application/json' },
      remoteAddress: '203.0.113.7',
    });
  });

  it("takes the serialized request's own fields first, and keeps no headers that aren't an object", () => {
    expect(serializeRequest({ method: 'GET', url: '/api/tags?search=private', headers: 'not headers', remoteAddress: '198.51.100.2' })).toEqual({
      id: undefined,
      method: 'GET',
      url: '/api/tags',
      headers: {},
      remoteAddress: '198.51.100.2',
    });
  });
});

describe('serializeResponse', () => {
  it("keeps the status and the type and length, from the raw response's headers when it has to, never Set-Cookie", () => {
    const rawResponse = {
      statusCode: 201,
      getHeaders: () => ({ 'content-type': 'application/json', 'content-length': '12', 'set-cookie': ['nuggets_session=secret'] }),
    } as unknown as ServerResponse;
    expect(serializeResponse({ raw: rawResponse })).toEqual({ statusCode: 201, headers: { 'content-type': 'application/json', 'content-length': '12' } });
    expect(serializeResponse({ statusCode: 204, headers: null })).toEqual({ statusCode: 204, headers: {} });
  });
});

describe('the line for a request', () => {
  const req = raw({ method: 'GET', originalUrl: '/api/accounts?hidden=true', url: '/accounts', headers: {} });

  it('is an error for a 5xx or an error, a warning for a 4xx, else info', () => {
    expect(options.customLogLevel(req, response(503), undefined)).toBe('error');
    expect(options.customLogLevel(req, response(200), new Error('stream failed'))).toBe('error');
    expect(options.customLogLevel(req, response(404), undefined)).toBe('warn');
    expect(options.customLogLevel(req, response(302), undefined)).toBe('info');
  });

  it('says the method, the path without its query, and the status', () => {
    expect(options.customSuccessMessage(req, response(200), 3)).toBe('GET /api/accounts - 200');
    expect(options.customSuccessMessage(req, response(404), 3)).toBe('GET /api/accounts - Not Found');
    expect(options.customErrorMessage(raw({ method: 'PUT', url: '/api/tags/1?x=1', headers: {} }), response(500), new Error('x'))).toBe(
      'PUT /api/tags/1 - 500'
    );
  });

  it('leaves out the liveness probes, and logs the rest', () => {
    expect(options.autoLogging.ignore(raw({ originalUrl: '/api/health?probe=1', url: '/health' }))).toBe(true);
    expect(options.autoLogging.ignore(raw({ url: '/health' }))).toBe(true);
    expect(options.autoLogging.ignore(raw({ url: '/api/ready' }))).toBe(false);
    expect(options.autoLogging.ignore(raw({ url: '/api/health/detailed' }))).toBe(false);
  });

  it('is given the id requestIdFor chooses', () => {
    expect(options.genReqId(raw({ headers: { 'x-request-id': 'kept-id' } }), response(200))).toBe('kept-id');
  });
});
