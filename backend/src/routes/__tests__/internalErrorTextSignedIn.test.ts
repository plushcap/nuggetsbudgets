import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { Express, type NextFunction, type Request, type Response } from 'express';

/**
 * internalErrorText.test.ts's check, for the routers that authenticate per route
 * (OneDrive, passkeys): a failure answers without the error's own text. The OneDrive test
 * upload answered it as `error`; the passkey routes put it in `details` whenever NODE_ENV
 * was development, which a deployment can run with by mistake. Signing in is stubbed: it
 * isn't what's tested.
 */

const SECRET = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY ??= 'internal-error-text-signed-in-test-key-0123456789';
  return 'internal_secret_xyz';
});

vi.mock('../../middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth.js')>();
  const signedIn = (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: unknown; isDeploymentAdmin: boolean }).user = { userId: 1, email: 'admin@example.com' };
    (req as Request & { isDeploymentAdmin: boolean }).isDeploymentAdmin = true;
    next();
  };
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  return { ...actual, authenticateToken: signedIn, authenticateSession: signedIn, requireRecentReauth: pass, requireInteractiveSession: pass };
});

// The passkey sign-in's challenge lookup fails, inside the route's try.
vi.mock('../../services/WebAuthnChallengeStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/WebAuthnChallengeStore.js')>();
  return {
    ...actual,
    takeCeremonyChallenge: vi.fn(async () => {
      throw new Error('relation "internal_secret_xyz" does not exist');
    }),
  };
});

const { default: pool } = await import('../../db.js');
const { createOneDriveRoutes } = await import('../onedrive.js');
const { config } = await import('../../config.js');
const { createPasskeyRoutes, createPasskeySignInRoutes } = await import('../passkeys.js');
const { authenticateToken } = await import('../../middleware/auth.js');
const { BackupService } = await import('../../services/BackupService.js');
const { OneDriveService } = await import('../../services/OneDriveService.js');
const { passkeyService } = await import('../../services/PasskeyService.js');

describe('a failing signed-in route answers without the error text', () => {
  let app: Express;
  const env = process.env.NODE_ENV;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    // As routes.ts mounts them, behind the (mocked) sign-in; the passkey sign-in is public.
    app.use('/api/onedrive', authenticateToken, createOneDriveRoutes({ oneDriveService: new OneDriveService(), backupService: new BackupService(pool), config: config() }));
    app.use('/api/passkeys', createPasskeySignInRoutes());
    app.use('/api/passkeys', authenticateToken, createPasskeyRoutes());
  });

  afterEach(() => {
    process.env.NODE_ENV = env;
    vi.restoreAllMocks();
  });

  afterAll(() => {
    process.env.NODE_ENV = env;
  });

  it('POST /api/onedrive/test-upload', async () => {
    vi.spyOn(OneDriveService.prototype, 'uploadFile').mockRejectedValueOnce(
      new Error(`Graph API 401 for drive internal_secret_xyz: InvalidAuthenticationToken`)
    );
    const res = await request(app).post('/api/onedrive/test-upload');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(res.body).toMatchObject({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });

  it('POST /api/passkeys/register/options, in development', async () => {
    process.env.NODE_ENV = 'development';
    vi.spyOn(passkeyService, 'generateRegistrationOptions').mockRejectedValueOnce(
      new Error('relation "internal_secret_xyz" does not exist')
    );
    const res = await request(app).post('/api/passkeys/register/options');
    expect(res.status).toBe(500);
    // The route wrapper's answer (was REGISTRATION_OPTIONS_ERROR).
    expect(res.body).toMatchObject({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('POST /api/passkeys/auth/verify, in development', async () => {
    process.env.NODE_ENV = 'development';
    const res = await request(app).post('/api/passkeys/auth/verify').send({ response: { id: 'credential-id' } });
    expect(res.status).toBe(500);
    // The route wrapper's answer (was AUTH_VERIFY_ERROR).
    expect(res.body).toMatchObject({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });
});
