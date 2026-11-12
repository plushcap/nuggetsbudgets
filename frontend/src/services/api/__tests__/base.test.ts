import { describe, it, expect, vi } from 'vitest';
import { toLedgerWording, handleResponse, assertOk, isSessionExpiredError, SessionExpiredError, getCsrfToken } from '../base';

/**
 * The backend speaks "tenant" (the internal name for a Ledger). Users must never
 * see that word — base.ts translates it on every surfaced error message. This
 * guards that invariant (see CLAUDE.md: "the isolation unit is a `tenant` (the UI
 * says Ledger)").
 */
describe('toLedgerWording', () => {
  it('translates the internal "tenant" wording to the UI term "Ledger"', () => {
    expect(toLedgerWording('No active tenant selected')).toBe('No active ledger selected');
    expect(toLedgerWording('No access to this tenant')).toBe('No access to this ledger');
    expect(toLedgerWording('Tenant admin required')).toBe('Ledger admin required');
    expect(toLedgerWording('That person is already a member of this tenant.')).toBe(
      'That person is already a member of this ledger.',
    );
    expect(toLedgerWording('This tenant must keep at least one admin.')).toBe(
      'This ledger must keep at least one admin.',
    );
  });

  it('handles plurals and preserves the leading letter case', () => {
    expect(toLedgerWording('Failed to list tenants')).toBe('Failed to list ledgers');
    expect(toLedgerWording('Tenants')).toBe('Ledgers');
  });

  it('never leaves the word "tenant" in surfaced copy', () => {
    expect(toLedgerWording('Switching tenants requires a browser session')).not.toMatch(/tenant/i);
  });

  it('leaves unrelated text untouched (incl. the budgeting feature)', () => {
    expect(toLedgerWording('Budget item not found')).toBe('Budget item not found');
    expect(toLedgerWording('HTTP 500: Internal Server Error')).toBe('HTTP 500: Internal Server Error');
  });
});

/**
 * A 401 must REJECT (with a recognizable error) rather than return the old
 * never-resolving promise — a hung promise left every in-flight query stuck in
 * `isLoading` forever with no error and no retry. AuthContext owns the logout via the
 * `session-expired` event.
 */
describe('handleResponse 401 handling', () => {
  it('rejects with SessionExpiredError and dispatches session-expired', async () => {
    const dispatched = vi.spyOn(window, 'dispatchEvent');
    const response = new Response('{"error":"unauthorized"}', { status: 401 });

    await expect(handleResponse(response)).rejects.toMatchObject({
      name: 'SessionExpiredError',
      status: 401,
    });

    const events = dispatched.mock.calls.map(([e]) => (e as Event).type);
    expect(events).toContain('session-expired');
    dispatched.mockRestore();
  });

  it('settles (does not hang): resolution races a short timer and wins', async () => {
    const response = new Response('{}', { status: 401 });
    const outcome = await Promise.race([
      handleResponse(response).then(() => 'resolved', () => 'rejected'),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 250)),
    ]);
    expect(outcome).toBe('rejected');
  });

  it('isSessionExpiredError recognizes only the session-expiry rejection', () => {
    expect(isSessionExpiredError(new SessionExpiredError())).toBe(true);
    expect(isSessionExpiredError(new Error('HTTP 500'))).toBe(false);
    expect(isSessionExpiredError(undefined)).toBe(false);
  });
});

/**
 * A 2xx whose body isn't JSON (an empty body, an HTML SPA/proxy fallback served
 * with a 200, or truncated JSON) must reject with a message that names the status
 * and content-type — the bare "Failed to parse response JSON" was undiagnosable
 * in production because the server logs only show the 200.
 */
describe('handleResponse 2xx body-parse diagnostics', () => {
  it('names status + content-type when a 200 returns an HTML page', async () => {
    const response = new Response('<!doctype html><title>App</title>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    await expect(handleResponse(response)).rejects.toThrow(
      /Failed to parse response JSON \[200 text\/html.*<!doctype html/,
    );
  });

  it('flags an empty 200 body distinctly', async () => {
    const response = new Response('', { status: 200 });
    await expect(handleResponse(response)).rejects.toThrow(
      /Failed to parse response JSON \[200 .*\] \(empty body\)/,
    );
  });

  it('still parses a valid JSON 2xx body', async () => {
    const response = new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    await expect(handleResponse<{ ok: boolean }>(response)).resolves.toEqual({ ok: true });
  });
});

/**
 * Most routes answer an error as `{ error }`, validation as `{ message }`. Reading only
 * `message` showed "HTTP 400: Bad Request" for the rest, e.g. a rejected backup setting.
 */
describe('handleResponse error reasons', () => {
  const failing = (body: unknown, status = 400, statusText = 'Bad Request') =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, statusText });

  it("shows the server's reason, whichever field it is in", async () => {
    await expect(handleResponse(failing({ success: false, error: 'backup_frequency_days must be 1 to 365' }))).rejects.toMatchObject({
      message: 'backup_frequency_days must be 1 to 365',
      status: 400,
      response: { data: { success: false, error: 'backup_frequency_days must be 1 to 365' } },
    });
    await expect(handleResponse(failing({ message: 'Validation failed', error: 'x' }))).rejects.toThrow('Validation failed');
  });

  it('keeps the response data when the reason is reworded for the UI', async () => {
    await expect(handleResponse(failing({ error: 'No active tenant', code: 'NO_ACTIVE_TENANT' }))).rejects.toMatchObject({
      message: 'No active ledger',
      response: { data: { code: 'NO_ACTIVE_TENANT' } },
    });
  });

  it('falls back to the status line without a JSON reason', async () => {
    await expect(handleResponse(failing('<html>oops</html>', 502, 'Bad Gateway'))).rejects.toThrow('HTTP 502: Bad Gateway');
    await expect(handleResponse(failing({ code: 'X' }, 500, 'Internal Server Error'))).rejects.toThrow('HTTP 500: Internal Server Error');
  });
});

/**
 * The API's one error shape is `{ error, code, requestId }`. The helpers keep the
 * code and the request id on the error, and a server error's message names the id, so the
 * toast someone reports quotes it and the operator can find that request's log lines.
 */
describe('handleResponse error shape', () => {
  const answer = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('keeps the code and the request id from the body', async () => {
    await expect(handleResponse(answer({ error: 'Goal not found', code: 'NOT_FOUND', requestId: 'req-404' }, 404))).rejects.toMatchObject({
      message: 'Goal not found',
      status: 404,
      code: 'NOT_FOUND',
      requestId: 'req-404',
    });
  });

  it('names the request id in a server error, from the body or the X-Request-Id header', async () => {
    await expect(
      handleResponse(answer({ error: 'Internal server error', code: 'INTERNAL_ERROR', requestId: 'req-500' }, 500))
    ).rejects.toMatchObject({ message: 'Internal server error (reference req-500)', code: 'INTERNAL_ERROR', requestId: 'req-500' });
    await expect(
      handleResponse(new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway', headers: { 'X-Request-Id': 'req-502' } }))
    ).rejects.toMatchObject({ message: 'HTTP 502: Bad Gateway (reference req-502)', requestId: 'req-502' });
    // A client error is the caller's to fix: its reason alone.
    await expect(handleResponse(answer({ error: 'Already there', code: 'CONFLICT', requestId: 'req-409' }, 409))).rejects.toThrow(/^Already there$/);
  });

  it("shows a 403's fuller reason, in Ledger wording", async () => {
    await expect(
      handleResponse(answer({ error: 'Forbidden', message: 'Tenant admin required', code: 'TENANT_ADMIN_REQUIRED' }, 403))
    ).rejects.toMatchObject({ message: 'Ledger admin required', status: 403, code: 'TENANT_ADMIN_REQUIRED' });
  });

  it('assertOk rejects as handleResponse does, and passes an ok answer', async () => {
    await expect(assertOk(answer({ error: 'Account not found', code: 'ACCOUNT_NOT_FOUND' }, 404))).rejects.toMatchObject({
      message: 'Account not found',
      code: 'ACCOUNT_NOT_FOUND',
    });
    await expect(assertOk(new Response('a,b\n1,2', { status: 200 }))).resolves.toBeUndefined();
  });
});

/**
 * The CSRF header is the CSRF cookie's value. Production names the cookie
 * __Host-csrf_token; right after the upgrade a browser can still hold the old
 * csrf_token, whose value is no longer its session's, so the prefixed one wins.
 */
describe('getCsrfToken', () => {
  const clear = () => {
    for (const name of ['csrf_token', '__Host-csrf_token']) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  };

  it('reads the production cookie before the old name, whichever comes first', () => {
    // jsdom, like a browser, takes a __Host- cookie only over HTTPS: stub what it holds.
    const cookie = vi.spyOn(document, 'cookie', 'get').mockReturnValue('csrf_token=old-value; __Host-csrf_token=bound-value');
    try {
      expect(getCsrfToken()).toBe('bound-value');
    } finally {
      cookie.mockRestore();
    }
  });

  it('reads the development cookie', () => {
    clear();
    document.cookie = 'csrf_token=dev-value; path=/';
    expect(getCsrfToken()).toBe('dev-value');
    clear();
    expect(getCsrfToken()).toBeUndefined();
  });
});
