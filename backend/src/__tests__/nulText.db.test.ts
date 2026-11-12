import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import fs from 'fs';
import http from 'http';
import multer from 'multer';
import request from 'supertest';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import { sessionService } from '../middleware/auth.js';
import { nulTextPath } from '../middleware/nulText.js';
import { SESSION_COOKIE_NAME } from '../utils/session-cookie-config.js';
import { csrfTokenFor } from '../utils/csrfToken.js';
import { png } from '../test/imageFixtures.js';
import { UPLOAD_DIR } from '../services/attachments/AttachmentService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';

/**
 * A NUL character in a body's text. JSON carries one as "\u0000", which Postgres can't
 * store in text or jsonb, so a passkey rename, an MCP token's label and the profile's first
 * name answered 500. A JSON or form body is now refused before any route runs, and a
 * multipart one's text fields right after its route's multer (the profile page sends
 * FormData), 400 VALIDATION_ERROR naming the field. A file's bytes (which hold NULs) aren't
 * read, and a refused upload's file on disk is removed.
 */

const CSRF_TOKEN = 'nul-text-csrf-token';
const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

describe('nulTextPath', () => {
  it('names the field holding a NUL, in a string or a key, however deep', () => {
    expect(nulTextPath({ name: 'Groceries', tags: ['a', 'b'] })).toBeNull();
    expect(nulTextPath({ first_name: 'A\u0000' })).toBe('first_name');
    expect(nulTextPath({ splits: [{ description: 'ok' }, { description: 'x\u0000y' }] })).toBe('splits.1.description');
    expect(nulTextPath({ meta: { 'k\u0000': 1 } })).toBe('meta.k\\u0000');
    expect(nulTextPath('\u0000')).toBe('(root)');
    expect(nulTextPath(undefined)).toBeNull();
    expect(nulTextPath({ amount: 5, flag: true, none: null })).toBeNull();
    // As deep as a 1 MB body nests, without running out of stack.
    let deep: unknown = 'bottom\u0000';
    for (let i = 0; i < 200_000; i += 1) deep = [deep];
    expect(nulTextPath(deep)?.split('.')).toHaveLength(200_000);
  });
});

describe('A NUL character in a request body', () => {
  let tenant: TestTenant;
  let server: http.Server;
  let session: string;
  let tenantUuid: string;
  const credentialId = `nul-text-${Date.now()}`;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= 'nul-text-test-encryption-key-0123456789abcdef';
    tenant = await createTestTenant('NUL text');
    const app = createApp();
    // An upload, as a route's multer takes one after the body parsers.
    app.post('/api/probe/upload', multer({ storage: multer.memoryStorage() }).single('file'), (req, res) => {
      res.json({ size: req.file?.size ?? 0, note: (req.body as { note?: string }).note ?? null });
    });
    mountRoutes(app, { lifecycleService: lifecycleStub });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const { token, sessionId } = await sessionService.createSession({ userId: tenant.userId });
    session = token;
    await tenant.pool.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [tenant.tenantId, sessionId]);
    tenantUuid = (await tenant.pool.query<{ uuid: string }>('SELECT uuid FROM tenants WHERE id = $1', [tenant.tenantId])).rows[0].uuid;
    await tenant.pool.query(
      `INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, transports, device_name)
       VALUES ($1, $2, 'cHVibGljLWtleQ', 0, ARRAY['internal'], 'Laptop')`,
      [tenant.userId, credentialId]
    );
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await tenant?.pool.query('DELETE FROM passkey_credentials WHERE user_id = $1', [tenant.userId]);
    await tenant?.pool.query('DELETE FROM personal_access_tokens WHERE user_id = $1', [tenant.userId]);
    await tenant?.pool.query('DELETE FROM sessions WHERE user_id = $1', [tenant.userId]);
    await tenant?.cleanup();
  });

  const signedIn = (req: request.Test) =>
    req.set('Cookie', `${SESSION_COOKIE_NAME}=${session}; csrf_token=${CSRF_TOKEN}`).set('X-CSRF-Token', csrfTokenFor(session));

  const refusal = (res: request.Response) => ({ status: res.status, code: res.body.code, details: res.body.details });
  const refused = (field: string) => ({
    status: 400,
    code: 'VALIDATION_ERROR',
    details: [{ field, message: `${field} can't contain a NUL character (\\u0000)` }],
  });

  it("refuses a passkey's new name with a NUL, and renames it without one", async () => {
    const bad = await signedIn(request(server).put(`/api/passkeys/${credentialId}`)).send({ deviceName: 'Phone\u0000' });
    expect(refusal(bad)).toEqual(refused('deviceName'));
    const good = await signedIn(request(server).put(`/api/passkeys/${credentialId}`)).send({ deviceName: 'Phone' });
    expect(good.status, JSON.stringify(good.body)).toBe(200);
    const { rows } = await tenant.pool.query('SELECT device_name FROM passkey_credentials WHERE credential_id = $1', [credentialId]);
    expect(rows[0].device_name).toBe('Phone');
  });

  it("refuses an MCP token's label with a NUL, and mints one without", async () => {
    const body = { tenantUuid, scope: 'read', expiresIn: '30d' };
    const bad = await signedIn(request(server).post('/api/auth/mcp-token')).send({ ...body, label: 'cli\u0000' });
    expect(refusal(bad)).toEqual(refused('label'));
    const good = await signedIn(request(server).post('/api/auth/mcp-token')).send({ ...body, label: 'cli' });
    expect(good.status, JSON.stringify(good.body)).toBe(201);
  });

  it("refuses the profile's first name with a NUL, and saves it without", async () => {
    const bad = await signedIn(request(server).put('/api/auth/profile')).send({ first_name: 'Ann\u0000' });
    expect(refusal(bad)).toEqual(refused('first_name'));
    const good = await signedIn(request(server).put('/api/auth/profile')).send({ first_name: 'Ann' });
    expect(good.status, JSON.stringify(good.body)).toBe(200);
    const { rows } = await tenant.pool.query('SELECT first_name FROM users WHERE id = $1', [tenant.userId]);
    expect(rows[0].first_name).toBe('Ann');
  });

  it("refuses the profile's first name with a NUL sent as FormData, as the page sends it", async () => {
    const bad = await signedIn(request(server).put('/api/auth/profile')).field('first_name', 'Bea\u0000').field('last_name', 'Lee');
    expect(refusal(bad)).toEqual(refused('first_name'));
    const good = await signedIn(request(server).put('/api/auth/profile')).field('first_name', 'Bea').field('last_name', 'Lee');
    expect(good.status, JSON.stringify(good.body)).toBe(200);
    const { rows } = await tenant.pool.query('SELECT first_name, last_name FROM users WHERE id = $1', [tenant.userId]);
    expect(rows[0]).toEqual({ first_name: 'Bea', last_name: 'Lee' });
  });

  it("refuses an attachment's notes with a NUL, and removes the file multer wrote", async () => {
    const name = `nul-text-${Date.now()}.pdf`;
    const leftovers = () => fs.readdirSync(UPLOAD_DIR).filter((file) => file.endsWith(name));
    const res = await signedIn(request(server).post('/api/attachments/upload'))
      .attach('attachments', Buffer.from('%PDF-1.4\n%\u0000\n'), name)
      .field('transaction_id', '1')
      .field('notes', 'See\u0000page 2');
    expect(refusal(res)).toEqual(refused('notes'));
    expect(leftovers()).toEqual([]);
  });

  // busboy refuses a part header holding a NUL ("Malformed part header") before
  // the fields reach refuseNulFields, and multer passed that on as a 500.
  it("refuses a NUL in a part's field name or file name, and removes the file multer wrote", async () => {
    const merchant = await tenant.pool.query<{ uuid: string }>(`INSERT INTO merchants (name) VALUES ('NUL text merchant') RETURNING uuid`);
    const stamp = Date.now();
    const leftovers = () => fs.readdirSync(UPLOAD_DIR).filter((file) => file.includes(`nul-part-${stamp}`));
    const malformed = { status: 400, code: 'VALIDATION_ERROR' };
    const answers = [
      // The file is written before the bad part's header is read.
      await signedIn(request(server).post('/api/attachments/upload'))
        .attach('attachments', Buffer.from('%PDF-1.4 fake'), `nul-part-${stamp}-a.pdf`)
        .field('no\u0000tes', 'x'),
      await signedIn(request(server).post('/api/attachments/upload'))
        .field('transaction_id', '1')
        .attach('attachments', Buffer.from('%PDF-1.4 fake'), `nul-part-${stamp}-b\u0000.pdf`),
      await signedIn(request(server).post(`/api/merchants/${merchant.rows[0].uuid}/upload-image`))
        .attach('merchant_image', png(), 'logo.png')
        .field('na\u0000me', 'x'),
    ];
    expect(answers.map((res) => ({ status: res.status, code: res.body.code }))).toEqual([malformed, malformed, malformed]);
    expect(answers[0].body.message).toMatch(/NUL/);
    expect(leftovers()).toEqual([]);
    await tenant.pool.query('DELETE FROM merchants WHERE uuid = $1', [merchant.rows[0].uuid]);
  });

  // busboy refuses a multipart content type with no boundary as multer
  // starts, before any file, so the error has no storageErrors mark, and it was a 500.
  it('refuses a multipart body with no boundary', async () => {
    const res = await signedIn(request(server).put('/api/auth/profile'))
      .set('Content-Type', 'multipart/form-data')
      .send('first_name=x');
    expect([res.status, res.body.code], JSON.stringify(res.body)).toEqual([400, 'VALIDATION_ERROR']);
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  // Postgres couldn't read the search, a 500.
  it('refuses a NUL in a query string, naming the parameter', async () => {
    const bad = await signedIn(request(server).get('/api/transactions?search=%00'));
    expect(refusal(bad)).toEqual(refused('search'));
    const good = await signedIn(request(server).get('/api/transactions?search=coffee'));
    expect(good.status, JSON.stringify(good.body)).toBe(200);
  });

  it('names a field nested 200,000 deep in a few hundred bytes', async () => {
    let deep = '"x\\u0000"';
    for (let i = 0; i < 200_000; i += 1) deep = `[${deep}]`;
    const res = await signedIn(request(server).put('/api/auth/profile')).set('Content-Type', 'application/json').send(`{"first_name":${deep}}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details[0].field).toHaveLength(200);
    expect(res.body.details[0].field).toMatch(/^first_name\.0\.0.*….*0\.0$/);
    expect(res.text.length).toBeLessThan(1_000);
  });

  it('leaves the MCP endpoint to answer, however its path is spelled', async () => {
    for (const path of ['/api/mcp', '/API/MCP', '/Api/Mcp/']) {
      const res = await request(server).post(path).send({ jsonrpc: '2.0', id: 1, method: 'x\u0000' });
      // No token: the MCP endpoint's own 401, not the body check's 400.
      expect([res.status, res.body.code], path).toEqual([401, expect.not.stringMatching(/^VALIDATION_ERROR$/)]);
    }
  });

  it('refuses a form body with a NUL, and leaves a multipart upload to its route', async () => {
    const form = await signedIn(request(server).put('/api/auth/profile'))
      .type('form').send('first_name=Ann%00');
    expect(refusal(form)).toEqual(refused('first_name'));

    const image = png();
    expect(image.includes(0)).toBe(true);
    const upload = await request(server).post('/api/probe/upload').attach('file', image, 'a.png').field('note', 'hello');
    expect(upload.status, JSON.stringify(upload.body)).toBe(200);
    expect(upload.body).toEqual({ size: image.length, note: 'hello' });
  });
});
