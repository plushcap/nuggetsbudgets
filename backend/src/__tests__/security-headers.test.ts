import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';

/**
 * The backend never serves the app: the SPA document comes from the frontend container,
 * with its own policy (frontend/public/serve.json). What the backend sends (JSON,
 * uploaded images, attachments) loads and runs nothing, so it gets a deny-all
 * Content-Security-Policy, and only the app's own origin may embed it. It used to
 * send an app-style policy, with style-src 'unsafe-inline' and img-src https:, and
 * Cross-Origin-Resource-Policy: cross-origin. Style attributes are allowed for the browser's
 * own image viewer, and nothing else (app.ts).
 */
const DENY_ALL =
  "default-src 'none';style-src-attr 'unsafe-inline';base-uri 'none';form-action 'none';frame-ancestors 'none'";

describe('backend security headers', () => {
  const app = createApp();
  // createApp mounts no routes; a JSON route like the API's. (Express's own 404 page sets
  // its own default-src 'none', so a 404 would not show the app's policy.)
  app.get('/api/probe', (_req, res) => {
    res.json({ ok: true });
  });

  const expectLockedDown = (headers: Record<string, string>) => {
    expect(headers['content-security-policy']).toBe(DENY_ALL);
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
  };

  it('an API response may load, run, frame or post nothing, and only its own origin may embed it', async () => {
    const res = await request(app).get('/api/probe').expect(200);
    expectLockedDown(res.headers);
    // No <style> elements or stylesheets (style-src / style-src-elem fall back to
    // default-src 'none'), no scripts, and no host it may load from.
    const directives = res.headers['content-security-policy'].split(';').map((d: string) => d.split(' ')[0]);
    expect(directives).not.toContain('style-src');
    expect(directives).not.toContain('style-src-elem');
    expect(directives).not.toContain('script-src');
    expect(res.headers['content-security-policy']).not.toMatch(/https?:/);
  });

  it('so may an /uploads response', async () => {
    // Refused without a session, but the headers are set before the check.
    const res = await request(app).get('/uploads/user-profiles/someone.png');
    expect(res.status).toBe(401);
    expectLockedDown(res.headers);
  });

  it('lets a cross-origin write send its CSRF token', async () => {
    // A cookie-authenticated write carries X-CSRF-Token; a preflight that doesn't allow
    // it stops the browser sending the write at all.
    const res = await request(app)
      .options('/api/probe')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token');
    expect(res.status).toBe(204);
    const allowed = String(res.headers['access-control-allow-headers']).toLowerCase().split(/\s*,\s*/);
    expect(allowed).toEqual(expect.arrayContaining(['content-type', 'x-csrf-token']));
  });
});
