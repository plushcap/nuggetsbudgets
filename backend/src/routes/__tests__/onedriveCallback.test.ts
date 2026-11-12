import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import type { Pool } from 'pg';

const { isAdmin, exchange } = vi.hoisted(() => ({
  isAdmin: vi.fn(async (_userId: number) => true),
  exchange: vi.fn(async (_code: string, _userId: number) => undefined),
}));

vi.mock('../../services/MembershipService.js', () => ({ userIsDeploymentAdmin: isAdmin }));
// GET /auth as deployment admin 7, without a session (its guards are tested elsewhere).
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { userId: 7, email: 'admin@test.local' };
    next();
  },
}));
vi.mock('../../middleware/tenant.js', () => ({ requireDeploymentAdmin: (_req: unknown, _res: unknown, next: () => void) => next() }));
import cookieParser from 'cookie-parser';
import { createOneDriveCallbackRoutes, createOneDriveRoutes, OAUTH_STATE_COOKIE } from '../onedrive.js';
import { OneDriveService } from '../../services/OneDriveService.js';
import { config } from '../../config.js';
import { BackupService } from '../../services/BackupService.js';
import { authenticateToken } from '../../middleware/auth.js';
import logger from '../../utils/logger.js';

/**
 * The OneDrive OAuth callback is public: Microsoft redirects the browser to it. It must
 * only finish a connect a deployment admin started, once, and never put the request's
 * text into the page. Before, the state was the encrypted user id (replayable,
 * never expiring, any user), and error_description was written into an inline script.
 */
describe('GET /api/onedrive/callback', () => {
  const app = express();
  // The app's own helmet defaults, which the callback has to override.
  app.use(helmet());
  app.use(cookieParser());
  // As routes.ts mounts them: the public callback, then the rest behind the (mocked) sign-in.
  const deps = { oneDriveService: new OneDriveService(), backupService: new BackupService({} as Pool), config: config() };
  app.use('/api/onedrive', createOneDriveCallbackRoutes(deps));
  app.use('/api/onedrive', authenticateToken, createOneDriveRoutes(deps));
  const service = new OneDriveService();
  const stateFor = async (userId: number) =>
    new URL(await service.getAuthorizationUrl(userId)).searchParams.get('state') as string;
  /** The callback, from the browser that started the connect: it has the state cookie. */
  const callback = (query: Record<string, string>) =>
    request(app).get('/api/onedrive/callback').set('Cookie', `${OAUTH_STATE_COOKIE}=${query.state ?? ''}`).query(query);

  beforeEach(() => {
    // The real state handling; the network, the token key and token storage are stubbed.
    vi.spyOn(OneDriveService.prototype, 'assertTokenKeyAvailable').mockImplementation(() => undefined);
    vi.spyOn(OneDriveService.prototype as unknown as { resolveClientConfig: () => Promise<unknown> }, 'resolveClientConfig').mockResolvedValue({
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://nuggets.example/api/onedrive/callback',
    });
    vi.spyOn(OneDriveService.prototype, 'exchangeCodeForTokens').mockImplementation(exchange);
    isAdmin.mockClear();
    isAdmin.mockResolvedValue(true);
    exchange.mockClear();
  });

  it('connects the deployment admin who started it, once', async () => {
    const state = await stateFor(7);
    const ok = await callback({ code: 'abc', state }).expect(200);
    expect(ok.text).toContain('OneDrive connected');
    expect(exchange).toHaveBeenCalledWith('abc', 7);

    const again = await callback({ code: 'abc', state }).expect(200);
    expect(again.text).toContain('expired or was already used');
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('gives the browser that starts a connect its state, for the callback only', async () => {
    const res = await request(app).get('/api/onedrive/auth').expect(200);
    const state = new URL(res.body.authUrl).searchParams.get('state');
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`))!;
    expect(cookie).toContain(`${OAUTH_STATE_COOKIE}=${state};`);
    expect(cookie).toMatch(/Path=\/api\/onedrive\/callback/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=600/);

    const done = await callback({ code: 'abc', state: state! }).expect(200);
    expect(done.text).toContain('OneDrive connected');
    expect(done.headers['set-cookie']?.[0]).toMatch(new RegExp(`^${OAUTH_STATE_COOKIE}=;`));
  });

  it("refuses to finish a connect in a browser that didn't start it", async () => {
    const state = await stateFor(7);
    // Someone else's browser, sent the admin's Microsoft link: no cookie, or another state.
    const none = await request(app).get('/api/onedrive/callback').query({ code: 'victim', state }).expect(200);
    expect(none.text).toContain('Finish connecting in the browser you started it in');
    const other = await request(app)
      .get('/api/onedrive/callback')
      .set('Cookie', `${OAUTH_STATE_COOKIE}=${await stateFor(7)}`)
      .query({ code: 'victim', state })
      .expect(200);
    expect(other.text).toContain('Finish connecting in the browser you started it in');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('refuses a state it never issued, including the old encrypted user id', async () => {
    const res = await callback({ code: 'abc', state: 'djI6Zm9vYmFy' }).expect(200);
    expect(res.text).toContain('expired or was already used');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('refuses a state after ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const state = await stateFor(7);
      vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
      const res = await callback({ code: 'abc', state }).expect(200);
      expect(res.text).toContain('expired or was already used');
      expect(exchange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a user who is not a deployment admin', async () => {
    isAdmin.mockResolvedValue(false);
    const res = await callback({ code: 'abc', state: await stateFor(8) }).expect(200);
    expect(res.text).toContain('Only a deployment admin');
    expect(exchange).not.toHaveBeenCalled();
  });

  it("never puts Microsoft's error text, or any request text, into the page", async () => {
    const res = await request(app)
      .get('/api/onedrive/callback')
      .query({ error: 'x', error_description: `</script><meta http-equiv=refresh content='0;url=https://attacker.example'>` })
      .expect(200);
    expect(res.text).not.toContain('attacker.example');
    expect(res.text).not.toMatch(/<\/script><meta/i);
    expect(res.text).toContain('Microsoft reported an error');
  });

  it("logs an OAuth error by its code, never Microsoft's description or other request text", async () => {
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      await request(app).get('/api/onedrive/callback').query({ error: 'access_denied', error_description: 'AADSTS65004 DESCRIPTION-TEXT' }).expect(200);
      await request(app).get('/api/onedrive/callback').query({ error: 'ERROR-TEXT', error_description: 'MORE-TEXT' }).expect(200);
      const lines = JSON.stringify(logged.mock.calls);
      expect(lines).not.toMatch(/DESCRIPTION-TEXT|ERROR-TEXT|MORE-TEXT|AADSTS/);
      expect(logged.mock.calls.map(([fields]) => (fields as { oauthError?: string }).oauthError)).toEqual(['access_denied', 'other']);
    } finally {
      logged.mockRestore();
    }
  });

  it('allows only its own inline script, by nonce', async () => {
    const res = await request(app).get('/api/onedrive/callback').query({ error: 'access_denied' }).expect(200);
    const csp = res.headers['content-security-policy'];
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(res.text).toContain(`<script nonce="${nonce}">`);
    expect(res.text).toContain('You declined access in Microsoft.');
  });

  it("keeps the popup's link to the app, which a same-origin opener policy would cut", async () => {
    const res = await request(app).get('/api/onedrive/callback').query({ error: 'access_denied' }).expect(200);
    expect(res.headers['cross-origin-opener-policy']).toBe('unsafe-none');
  });
});
