import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// Refused requests log warnings; keep them out of the test output unless asked for.
vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

// Everything the passkey code logs, to check what reaches the log (pino methods are called
// even when silent).
const logged = vi.hoisted(() => [] as unknown[][]);
vi.mock('../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger.js')>();
  const methods = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  const record = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        if (typeof prop === 'string' && methods.has(prop) && typeof value === 'function') {
          return (...args: unknown[]) => {
            logged.push(args);
            return value.apply(obj, args);
          };
        }
        if (prop === 'child' && typeof value === 'function') {
          return (...args: unknown[]) => record(value.apply(obj, args));
        }
        return typeof value === 'function' ? value.bind(obj) : value;
      },
    });
  // The passkey route's and service's loggers (the HTTP logger's raw request objects hold
  // the body, which pino's serializers leave out).
  const passkeyLoggers = new Set(['PasskeyRoute', 'PasskeyService']);
  return {
    ...actual,
    createLogger: (context: Record<string, unknown>) =>
      passkeyLoggers.has(String(context.service)) ? record(actual.createLogger(context)) : actual.createLogger(context),
  };
});

// The library's assertion check, passed through, so a test can count the work a refusal does.
vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>();
  return { ...actual, verifyAuthenticationResponse: vi.fn(actual.verifyAuthenticationResponse) };
});

import http from 'http';
import { inspect } from 'util';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import { sessionService } from '../middleware/auth.js';
import { passkeyService } from '../services/PasskeyService.js';
import { listUserPasskeys } from '../services/UserService.js';
import { CEREMONY_COOKIE_NAME } from '../services/WebAuthnChallengeStore.js';
import { SESSION_COOKIE_NAME } from '../utils/session-cookie-config.js';
// The CSRF token is bound to the session.
import { csrfTokenFor } from '../utils/csrfToken.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import {
  answerProblem,
  passkeyRegisteredResponseSchema,
  passkeySignInResponseSchema,
  reauthenticatedResponseSchema,
  webAuthnOptionsResponseSchema,
} from '@nuggets/shared';

/**
 * Passkey ceremonies: each ceremony's challenge is stored server-side,
 * for the browser that started it (a cookie names it), and used once; and a passkey must
 * verify its user (PIN or biometrics), not only be present. Through the real app, with a
 * software authenticator that signs like a real one (ES256, none attestation).
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

// Where passkeys are bound outside production with no DOMAIN_URL (utils/webauthnConfig.ts).
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const CSRF_TOKEN = 'passkey-ceremonies-csrf-token';

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();
const b64url = (data: Buffer) => data.toString('base64url');

/** An ES256 passkey: signs assertions and attestations the way an authenticator does. */
class SoftPasskey {
  readonly rawId = randomBytes(16);
  readonly id = b64url(this.rawId);
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private counter = 0;
  /**
   * The WebAuthn user handle it was made with (the options' user.id at registration), which
   * it names when it signs in, as a discoverable passkey does.
   */
  userHandle = b64url(randomBytes(32));

  /** The public key as COSE (kty EC2, alg ES256, crv P-256). */
  coseKey(): Buffer {
    const jwk = (this.keys.publicKey as KeyObject).export({ format: 'jwk' }) as { x: string; y: string };
    return Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
      Buffer.from(jwk.x, 'base64url'),
      Buffer.from([0x22, 0x58, 0x20]),
      Buffer.from(jwk.y, 'base64url'),
    ]);
  }

  private flags(uv: boolean, attested = false) {
    return Buffer.from([0x01 | (uv ? 0x04 : 0) | (attested ? 0x40 : 0)]);
  }

  private nextCounter() {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.counter);
    return counter;
  }

  /** `userHandle: null` names none, as a passkey that isn't discoverable may not. */
  /** `counter` signs that counter, as a passkey that keeps none (0) or a clone would. */
  assertion(
    challenge: string,
    { uv = true, userHandle = this.userHandle as string | null, counter = undefined as number | undefined } = {}
  ) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }));
    const fixed = Buffer.alloc(4);
    if (counter !== undefined) fixed.writeUInt32BE(counter);
    const authenticatorData = Buffer.concat([sha256(RP_ID), this.flags(uv), counter === undefined ? this.nextCounter() : fixed]);
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        ...(userHandle !== null && { userHandle }),
      },
      clientExtensionResults: {},
    };
  }

  /** A signature by another key, for this passkey's id: a wrong passkey. */
  forgedAssertion(challenge: string) {
    const real = this.assertion(challenge);
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const clientDataJSON = Buffer.from(real.response.clientDataJSON, 'base64url');
    const authenticatorData = Buffer.from(real.response.authenticatorData, 'base64url');
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), other.privateKey);
    return { ...real, response: { ...real.response, signature: b64url(signature) } };
  }

  attestation(
    challenge: string,
    { uv = true, transports = ['internal'] as unknown, clientExtensionResults = {} as Record<string, unknown> } = {}
  ) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false }));
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.rawId.length);
    const authData = Buffer.concat([
      sha256(RP_ID),
      this.flags(uv, true),
      Buffer.alloc(4), // counter 0
      Buffer.alloc(16), // AAGUID
      idLength,
      this.rawId,
      this.coseKey(),
    ]);
    // CBOR { "fmt": "none", "attStmt": {}, "authData": <bytes> }
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3, 0x63]), Buffer.from('fmt'), Buffer.from([0x64]), Buffer.from('none'),
      Buffer.from([0x67]), Buffer.from('attStmt'), Buffer.from([0xa0]),
      Buffer.from([0x68]), Buffer.from('authData'), Buffer.from([0x58, authData.length]), authData,
    ]);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports },
      clientExtensionResults,
    };
  }
}

/** A browser: keeps the cookies the server sets, and sends them back. */
class Browser {
  readonly cookies = new Map<string, string>();
  constructor(private readonly server: http.Server) {}

  async post(path: string, body: unknown = {}, extraCookies: Record<string, string> = {}) {
    const all = { ...Object.fromEntries(this.cookies), ...extraCookies };
    // As the SPA does: the header is the CSRF cookie's value.
    const req = request(this.server).post(path).set('X-CSRF-Token', all.csrf_token ?? CSRF_TOKEN);
    const header = Object.entries(all).map(([k, v]) => `${k}=${v}`).join('; ');
    if (header) req.set('Cookie', header);
    const res = await req.send(body as object);
    for (const cookie of ([] as string[]).concat(res.headers['set-cookie'] ?? [])) {
      const [pair] = cookie.split(';');
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      if (!value || /expires=Thu, 01 Jan 1970/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
}

interface User {
  id: number;
  email: string;
  passkey: SoftPasskey;
}

describeDb('Passkey ceremonies', () => {
  let owner: Pool;
  let server: http.Server;
  const userIds: number[] = [];
  let alice: User;
  let bob: User;

  const resetPasskeyConfig = () => {
    (passkeyService as unknown as { resolvedConfig?: unknown }).resolvedConfig = undefined;
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= 'passkey-ceremonies-test-encryption-key-0123456789';
    delete process.env.WEBAUTHN_USER_VERIFICATION;
    resetPasskeyConfig();
    const app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    owner = new Pool({ connectionString, max: 4 });
    alice = await addUser('alice');
    bob = await addUser('bob');
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (!owner) return;
    try {
      // Their passkeys, sessions and challenges go with them (ON DELETE CASCADE).
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    } finally {
      await owner.end();
    }
  });

  afterEach(() => {
    delete process.env.WEBAUTHN_USER_VERIFICATION;
    resetPasskeyConfig();
  });

  /** A user with a password and one enrolled passkey. */
  async function addUser(label: string, enrol = true): Promise<User> {
    const email = `passkey-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
    const id = (
      await owner.query<{ id: number }>(
        `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, $2, 'Test', $3) RETURNING id`,
        [email, bcrypt.hashSync('Passkey user Rb6!', 4), label]
      )
    ).rows[0].id;
    userIds.push(id);
    const passkey = new SoftPasskey();
    if (enrol) {
      await owner.query(
        `INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, transports, user_handle, discoverable)
         VALUES ($1, $2, $3, 0, $4, $5, true)`,
        [id, passkey.id, b64url(passkey.coseKey()), ['internal'], passkey.userHandle]
      );
    }
    return { id, email, passkey };
  }

  /** A browser signed in as `user`, recently enough to enrol a passkey. */
  async function signedIn(user: User): Promise<Browser> {
    const { token } = await sessionService.createSession({ userId: user.id });
    const browser = new Browser(server);
    browser.cookies.set(SESSION_COOKIE_NAME, token);
    browser.cookies.set('csrf_token', csrfTokenFor(token));
    return browser;
  }

  async function startSignIn(browser: Browser, body: Record<string, unknown> = {}) {
    const res = await browser.post('/api/passkeys/auth/options', body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(answerProblem(webAuthnOptionsResponseSchema, res.body)).toBeNull();
    return res.body.challenge as string;
  }

  describe('a challenge belongs to one ceremony in one browser', () => {
    it('lets two people sign in with a passkey at the same time', async () => {
      const aliceBrowser = new Browser(server);
      const bobBrowser = new Browser(server);
      const aliceChallenge = await startSignIn(aliceBrowser);
      const bobChallenge = await startSignIn(bobBrowser); // used to overwrite Alice's

      const aliceIn = await aliceBrowser.post('/api/passkeys/auth/verify', { response: alice.passkey.assertion(aliceChallenge) });
      expect(aliceIn.status, JSON.stringify(aliceIn.body)).toBe(200);
      expect(aliceIn.body.user.id).toBe(alice.id);
      const bobIn = await bobBrowser.post('/api/passkeys/auth/verify', { response: bob.passkey.assertion(bobChallenge) });
      expect(bobIn.status, JSON.stringify(bobIn.body)).toBe(200);
      expect(bobIn.body.user.id).toBe(bob.id);
      // A passkey sign-in leaves the password sign-in's trusted-device cookie alone.
      expect(([] as string[]).concat(bobIn.headers['set-cookie'] ?? []).some((c) => c.startsWith('nuggets_login_device='))).toBe(
        false
      );
    });

    it('lets one browser have two ceremonies open, and finish them in either order', async () => {
      // A double click, or React running an effect twice: the second start mustn't strand the first.
      const browser = new Browser(server);
      const first = await startSignIn(browser);
      const second = await startSignIn(browser);
      const secondIn = await browser.post('/api/passkeys/auth/verify', { response: bob.passkey.assertion(second) });
      expect(secondIn.status, JSON.stringify(secondIn.body)).toBe(200);
      const firstIn = await browser.post('/api/passkeys/auth/verify', { response: alice.passkey.assertion(first) });
      expect(firstIn.status, JSON.stringify(firstIn.body)).toBe(200);
    });

    it("isn't disturbed by anyone else starting ceremonies, with or without the same email", async () => {
      const browser = new Browser(server);
      const challenge = await startSignIn(browser, { email: alice.email });
      for (const body of [{}, { email: alice.email }, {}]) await startSignIn(new Browser(server), body);

      const signedInRes = await browser.post('/api/passkeys/auth/verify', { response: alice.passkey.assertion(challenge) });
      expect(signedInRes.status, JSON.stringify(signedInRes.body)).toBe(200);
    });

    it('works once, only from the browser that asked for it, and not after it expires', async () => {
      // Another browser, without this one's ceremony cookie, can't finish it.
      const browser = new Browser(server);
      const challenge = await startSignIn(browser);
      const stranger = await new Browser(server).post('/api/passkeys/auth/verify', { response: alice.passkey.assertion(challenge) });
      expect(stranger.status).toBe(400);
      expect(stranger.body.code).toBe('INVALID_CHALLENGE');

      // Stored for the hash of the cookie's browser id, not the id itself.
      const ceremonyId = browser.cookies.get(CEREMONY_COOKIE_NAME)!;
      expect(ceremonyId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const stored = await owner.query(
        'SELECT purpose, user_id, challenge FROM webauthn_challenges WHERE browser_hash = $1',
        [createHash('sha256').update(ceremonyId).digest('hex')]
      );
      expect(stored.rows).toEqual([{ purpose: 'authentication', user_id: null, challenge }]);
      const plain = await owner.query('SELECT 1 FROM webauthn_challenges WHERE browser_hash = $1', [ceremonyId]);
      expect(plain.rowCount).toBe(0);

      // Used once: a replay with the same cookie is refused.
      const first = await browser.post('/api/passkeys/auth/verify', { response: alice.passkey.assertion(challenge) });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const replay = await browser.post(
        '/api/passkeys/auth/verify',
        { response: alice.passkey.assertion(challenge) },
        { [CEREMONY_COOKIE_NAME]: ceremonyId }
      );
      expect(replay.status).toBe(400);
      expect(replay.body.code).toBe('INVALID_CHALLENGE');

      // Expired.
      const late = new Browser(server);
      const lateChallenge = await startSignIn(late);
      const lateId = late.cookies.get(CEREMONY_COOKIE_NAME)!;
      await owner.query(
        `UPDATE webauthn_challenges SET expires_at = now() - interval '1 second' WHERE browser_hash = $1 AND challenge = $2`,
        [createHash('sha256').update(lateId).digest('hex'), lateChallenge]
      );
      const expired = await late.post('/api/passkeys/auth/verify', { response: alice.passkey.assertion(lateChallenge) });
      expect(expired.status).toBe(400);
      expect(expired.body.code).toBe('INVALID_CHALLENGE');
    });

    it("re-authentication's challenge is the signed-in user's own", async () => {
      const aliceBrowser = await signedIn(alice);
      const options = await aliceBrowser.post('/api/passkeys/reauthenticate/options');
      expect(options.status, JSON.stringify(options.body)).toBe(200);
      expect(answerProblem(webAuthnOptionsResponseSchema, options.body)).toBeNull();
      const ok = await aliceBrowser.post('/api/passkeys/reauthenticate/verify', {
        response: alice.passkey.assertion(options.body.challenge),
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(answerProblem(reauthenticatedResponseSchema, ok.body)).toBeNull();

      // Bob's session can't finish a ceremony Alice's browser started.
      const again = await aliceBrowser.post('/api/passkeys/reauthenticate/options');
      const aliceCeremony = aliceBrowser.cookies.get(CEREMONY_COOKIE_NAME)!;
      const bobBrowser = await signedIn(bob);
      const crossed = await bobBrowser.post(
        '/api/passkeys/reauthenticate/verify',
        { response: bob.passkey.assertion(again.body.challenge) },
        { [CEREMONY_COOKIE_NAME]: aliceCeremony }
      );
      expect(crossed.status).toBe(400);
      expect(crossed.body.code).toBe('INVALID_CHALLENGE');
    });
  });

  describe('user verification', () => {
    it('is required to sign in, unless WEBAUTHN_USER_VERIFICATION=preferred', async () => {
      const browser = new Browser(server);
      const options = await browser.post('/api/passkeys/auth/options', {});
      expect(options.body.userVerification).toBe('required');
      const presenceOnly = await browser.post('/api/passkeys/auth/verify', {
        response: alice.passkey.assertion(options.body.challenge, { uv: false }),
      });
      expect(presenceOnly.status).toBe(401);
      expect(presenceOnly.body.code).toBe('USER_VERIFICATION_REQUIRED');

      process.env.WEBAUTHN_USER_VERIFICATION = 'preferred';
      resetPasskeyConfig();
      const legacy = new Browser(server);
      const legacyOptions = await legacy.post('/api/passkeys/auth/options', {});
      expect(legacyOptions.body.userVerification).toBe('preferred');
      const accepted = await legacy.post('/api/passkeys/auth/verify', {
        response: alice.passkey.assertion(legacyOptions.body.challenge, { uv: false }),
      });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    });

    it('is required to enrol a passkey', async () => {
      const carol = await addUser('carol', false);
      const browser = await signedIn(carol);
      const options = await browser.post('/api/passkeys/register/options');
      expect(options.status, JSON.stringify(options.body)).toBe(200);
      expect(options.body.authenticatorSelection.userVerification).toBe('required');
      const presenceOnly = await browser.post('/api/passkeys/register/verify', {
        response: carol.passkey.attestation(options.body.challenge, { uv: false }),
      });
      expect(presenceOnly.status).toBe(400);
      expect(presenceOnly.body.code).toBe('USER_VERIFICATION_REQUIRED');

      // The account's owner hears of a new passkey: here no SMTP, so by push.
      const { EmailDeliveryService } = await import('../services/EmailDeliveryService.js');
      const { PushNotificationService } = await import('../services/PushNotificationService.js');
      vi.spyOn(EmailDeliveryService.prototype, 'isConfigured').mockResolvedValue(false);
      const pushed = vi.spyOn(PushNotificationService.prototype, 'sendToUser').mockResolvedValue({ sent: 1, failed: 0, removed: 0 });

      const again = await browser.post('/api/passkeys/register/options');
      const enrolled = await browser.post('/api/passkeys/register/verify', {
        response: carol.passkey.attestation(again.body.challenge),
        deviceName: 'Carol’s phone',
      });
      expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(200);
      const saved = await owner.query('SELECT credential_id FROM passkey_credentials WHERE user_id = $1', [carol.id]);
      expect(saved.rows).toEqual([{ credential_id: carol.passkey.id }]);
      const toCarol = () => pushed.mock.calls.filter(([userId]) => userId === carol.id);
      await vi.waitFor(() => expect(toCarol()).toHaveLength(1));
      expect(toCarol()[0][1]).toMatchObject({
        title: 'A passkey was added to your Nuggets account',
        body: expect.stringContaining('named “Carol’s phone”'),
        url: '/profile',
      });
      vi.restoreAllMocks();
    });
  });

  // A passkey is a credential. One whose registration passed its
  // checks while a password reset or a sign-out ended its session isn't saved after it,
  // or it would outlive the reset meant to remove it.
  it('saves a passkey only while the session it was registered from still stands', async () => {
    const dave = await addUser('dave', false);
    const { sessionId } = await sessionService.createSession({ userId: dave.id });
    await owner.query(
      "UPDATE sessions SET is_revoked = true, revoked_at = NOW(), revocation_reason = 'admin_password_reset' WHERE id = $1",
      [sessionId]
    );
    const refused = await passkeyService.verifyRegistrationResponse(
      dave.id, dave.passkey.attestation('challenge-ended') as never, 'challenge-ended', 'Old phone', sessionId
    );
    expect(refused).toEqual({ verified: false, reason: 'credential_ended' });
    expect((await owner.query('SELECT 1 FROM passkey_credentials WHERE user_id = $1', [dave.id])).rows).toEqual([]);

    const live = await sessionService.createSession({ userId: dave.id });
    const saved = await passkeyService.verifyRegistrationResponse(
      dave.id, dave.passkey.attestation('challenge-live') as never, 'challenge-live', 'New phone', live.sessionId
    );
    expect(saved).toMatchObject({ verified: true, credentialId: dave.passkey.id });
  });

  // A registration's transports aren't signed, so a browser (or anyone posting
  // to register/verify) can send any strings. Only the known ones are kept, and only the
  // known ones are read back from a row that holds others.
  describe('transports', () => {
    async function register(user: User, passkey: SoftPasskey, transports: unknown) {
      const browser = await signedIn(user);
      const options = await browser.post('/api/passkeys/register/options');
      expect(options.status, JSON.stringify(options.body)).toBe(200);
      return browser.post('/api/passkeys/register/verify', {
        response: passkey.attestation(options.body.challenge, { transports }),
      });
    }
    const storedTransports = async (passkey: SoftPasskey) =>
      (await owner.query('SELECT transports FROM passkey_credentials WHERE credential_id = $1', [passkey.id])).rows;

    it('are stored as the known ones a registration lists, once each', async () => {
      const erin = await addUser('erin', false);
      const enrolled = await register(erin, erin.passkey, [
        'hybrid', 'internal', 'cable2', 'hybrid', 7, null, 'USB', 'x'.repeat(5000),
      ]);
      expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(200);
      expect(await storedTransports(erin.passkey)).toEqual([{ transports: ['hybrid', 'internal'] }]);

      // Only unknown ones: an empty list, as an authenticator that names none.
      const second = new SoftPasskey();
      expect((await register(erin, second, ['warp-drive'])).status).toBe(200);
      expect(await storedTransports(second)).toEqual([{ transports: [] }]);
    });

    it('that are not a list are stored as none, not a server error', async () => {
      const gwen = await addUser('gwen', false);
      const enrolled = await register(gwen, gwen.passkey, 'usb');
      expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(200);
      expect(await storedTransports(gwen.passkey)).toEqual([{ transports: null }]);
    });

    it('are read back as the known ones a stored passkey lists', async () => {
      const finn = await addUser('finn', false);
      await owner.query(
        `INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, transports) VALUES ($1, $2, $3, 0, $4)`,
        [finn.id, finn.passkey.id, b64url(finn.passkey.coseKey()), ['usb', 'warp-drive', 'nfc', '<script>']]
      );
      // Re-authentication lists the user's own passkeys (sign-in lists none).
      const reauth = await (await signedIn(finn)).post('/api/passkeys/reauthenticate/options');
      expect(reauth.status, JSON.stringify(reauth.body)).toBe(200);
      expect(reauth.body.allowCredentials).toEqual([{ id: finn.passkey.id, type: 'public-key', transports: ['usb', 'nfc'] }]);

      // A registration lists it to exclude once it is known to be discoverable.
      await owner.query('UPDATE passkey_credentials SET discoverable = true WHERE credential_id = $1', [finn.passkey.id]);
      const enrol = await (await signedIn(finn)).post('/api/passkeys/register/options');
      expect(enrol.status, JSON.stringify(enrol.body)).toBe(200);
      expect(enrol.body.excludeCredentials).toEqual([{ id: finn.passkey.id, type: 'public-key', transports: ['usb', 'nfc'] }]);

      // The passkey still signs in (one stored before email-free passkey sign-in, which names its handle now).
      const browser = new Browser(server);
      const challenge = await startSignIn(browser);
      const signedInRes = await browser.post('/api/passkeys/auth/verify', { response: finn.passkey.assertion(challenge) });
      expect(signedInRes.status, JSON.stringify(signedInRes.body)).toBe(200);
      expect(signedInRes.body.user.id).toBe(finn.id);
    });
  });

  // Passkey sign-in asks for no email. The options are the same for everyone, the
  // passkey that answers says whose it is (its user handle), and every refusal answers alike.
  describe('sign-in without an email', () => {
    /**
     * What every refused sign-in answers, whatever the reason. A refusal (a DomainError)
     * carries `message` beside `error` since the routes moved onto the route wrapper.
     */
    const SIGN_IN_REFUSED = {
      error: 'Authentication verification failed',
      code: 'VERIFICATION_FAILED',
      message: 'Authentication verification failed',
    };
    /** What a refusal answers, without the request's own id. */
    const answer = (res: request.Response) => {
      const { requestId: _requestId, ...body } = res.body as Record<string, unknown>;
      return { status: res.status, body };
    };
    const storedPasskey = async (passkey: SoftPasskey) =>
      (
        await owner.query(
          'SELECT user_handle, discoverable, counter::int AS counter, last_used_at FROM passkey_credentials WHERE credential_id = $1',
          [passkey.id]
        )
      ).rows[0];
    const insertPasskey = (userId: number, passkey: SoftPasskey, { userHandle = null as string | null, transports = ['internal'] as string[] | null } = {}) =>
      owner.query(
        `INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, transports, user_handle)
         VALUES ($1, $2, $3, 0, $4, $5)`,
        [userId, passkey.id, b64url(passkey.coseKey()), transports, userHandle]
      );
    async function signInWith(assertion: (challenge: string) => unknown) {
      const browser = new Browser(server);
      const challenge = await startSignIn(browser);
      return browser.post('/api/passkeys/auth/verify', { response: assertion(challenge) });
    }

    it('answers sign-in options the same for no email, an unknown one, and accounts with none, one or several passkeys', async () => {
      const several = await addUser('several');
      await insertPasskey(several.id, new SoftPasskey(), { userHandle: several.passkey.userHandle });
      const none = await addUser('none', false);
      const asked = [
        {},
        { email: `nobody-unknown-${Date.now()}@test.local` },
        { email: none.email },
        { email: alice.email },
        { email: several.email.toUpperCase() },
        { email: 42 },
      ];
      const answers: request.Response[] = [];
      for (const body of asked) {
        const res = await new Browser(server).post('/api/passkeys/auth/options', body);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        answers.push(res);
      }

      // Byte for byte, apart from the challenge: no allowCredentials, nothing else that varies.
      const shapes = answers.map((res) => res.text.replace(res.body.challenge as string, '<challenge>'));
      expect(new Set(shapes).size).toBe(1);
      expect(JSON.parse(shapes[0])).toEqual({ rpId: RP_ID, challenge: '<challenge>', timeout: 300_000, userVerification: 'required' });
      // Each its own challenge, and the same headers (the ceremony cookie, apart from its id).
      expect(new Set(answers.map((res) => res.body.challenge)).size).toBe(asked.length);
      const headerShape = (res: request.Response) => ({
        names: Object.keys(res.headers).filter((name) => !['date', 'etag', 'x-request-id'].includes(name)).sort(),
        // The id, and the Expires date (wall-clock time: two answers can fall either side of a
        // second); Max-Age says how long each lasts.
        cookies: ([] as string[])
          .concat(res.headers['set-cookie'] ?? [])
          .map((c) => c.replace(/=[^;]*/, '=<id>').replace(/; Expires=[^;]*/, '; Expires=<date>')),
        length: res.headers['content-length'],
      });
      for (const res of answers) expect(headerShape(res)).toEqual(headerShape(answers[0]));
    });

    it('registers a discoverable passkey under the account’s own user handle, and records whether the browser says it is', async () => {
      const gina = await addUser('gina', false);
      const browser = await signedIn(gina);
      const options = await browser.post('/api/passkeys/register/options');
      expect(options.status, JSON.stringify(options.body)).toBe(200);
      expect(answerProblem(webAuthnOptionsResponseSchema, options.body)).toBeNull();
      expect(options.body.authenticatorSelection).toMatchObject({ residentKey: 'required', requireResidentKey: true });
      expect(options.body.extensions).toEqual({ credProps: true });
      const handle = (await owner.query('SELECT webauthn_user_id FROM users WHERE id = $1', [gina.id])).rows[0].webauthn_user_id;
      expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(options.body.user.id).toBe(handle);
      // Not the email or the numeric id.
      expect(Buffer.from(handle, 'base64url').toString('utf8')).not.toContain(gina.email);
      expect(handle).not.toBe(b64url(Buffer.from(String(gina.id))));

      const kinds = [
        { said: { credProps: { rk: true } }, stored: true },
        { said: { credProps: { rk: false } }, stored: false },
        // No answer: the options required a discoverable passkey, which an authenticator makes or refuses.
        { said: {}, stored: true },
        // Unsigned and anything at all: only a boolean counts.
        { said: { credProps: { rk: 'yes' } }, stored: true },
      ];
      for (const { said, stored } of kinds) {
        const passkey = new SoftPasskey();
        passkey.userHandle = options.body.user.id;
        const again = await browser.post('/api/passkeys/register/options');
        // The same handle every time.
        expect(again.body.user.id).toBe(handle);
        const enrolled = await browser.post('/api/passkeys/register/verify', {
          response: passkey.attestation(again.body.challenge, { clientExtensionResults: said }),
        });
        expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(200);
        expect(answerProblem(passkeyRegisteredResponseSchema, enrolled.body)).toBeNull();
        expect(await storedPasskey(passkey)).toMatchObject({ user_handle: handle, discoverable: stored });

        // It signs in with no email, naming the handle it was made with.
        const signIn = await signInWith((challenge) => passkey.assertion(challenge));
        expect(signIn.status, JSON.stringify(signIn.body)).toBe(200);
        expect(answerProblem(passkeySignInResponseSchema, signIn.body)).toBeNull();
        expect(signIn.body.user).toEqual({ id: gina.id, email: gina.email });
        // Signing in that way shows it is discoverable.
        expect((await storedPasskey(passkey)).discoverable).toBe(true);
      }

      // (Four sign-ins ended the browser's own session: an account keeps four.)
      const own = await request(server)
        .get('/api/passkeys')
        .set('Cookie', `${SESSION_COOKIE_NAME}=${(await signedIn(gina)).cookies.get(SESSION_COOKIE_NAME)}`);
      expect(own.status).toBe(200);
      expect((own.body as Array<{ discoverable: unknown }>).map((p) => p.discoverable)).toEqual([true, true, true, true]);
    });

    it('refuses a wrong, unknown or removed passkey, a wrong or missing user handle, and a sign-in-disabled account alike, after the same work', async () => {
      const dana = await addUser('dana');
      const locked = await addUser('locked');
      const disabled = await addUser('disabled');
      const removed = await addUser('removed');
      await owner.query('UPDATE users SET is_locked = true WHERE id = $1', [locked.id]);
      await owner.query('UPDATE users SET login_disabled = true WHERE id = $1', [disabled.id]);
      await owner.query('DELETE FROM passkey_credentials WHERE user_id = $1', [removed.id]);
      // A passkey whose signature counter didn't grow: the stored one is ahead (a clone).
      const rewound = await addUser('rewound');
      await owner.query('UPDATE passkey_credentials SET counter = 1000 WHERE user_id = $1', [rewound.id]);

      const find = vi.spyOn(passkeyService as unknown as { findCredentialForAssertion: () => Promise<unknown> }, 'findCredentialForAssertion');
      const record = vi.spyOn(passkeyService as unknown as { recordUse: () => Promise<boolean> }, 'recordUse');
      const check = vi.mocked(verifyAuthenticationResponse);
      try {
        const refusals: Record<string, (challenge: string) => unknown> = {
          'a wrong passkey (another key signed)': (c) => dana.passkey.forgedAssertion(c),
          'an unknown passkey': (c) => new SoftPasskey().assertion(c),
          'a removed passkey': (c) => removed.passkey.assertion(c),
          'another user handle': (c) => dana.passkey.assertion(c, { userHandle: alice.passkey.userHandle }),
          'no user handle': (c) => dana.passkey.assertion(c, { userHandle: null }),
          'a malformed user handle': (c) => dana.passkey.assertion(c, { userHandle: 'not a handle!' }),
          // A locked account's passkey, when anything about it is wrong (only a
          // correct one is told the account is locked, the next test).
          'a locked account’s passkey, signed by another key': (c) => locked.passkey.forgedAssertion(c),
          'a locked account’s passkey, naming another user handle': (c) => locked.passkey.assertion(c, { userHandle: alice.passkey.userHandle }),
          'a locked account’s passkey, naming no user handle': (c) => locked.passkey.assertion(c, { userHandle: null }),
          'an account set up for automation only': (c) => disabled.passkey.assertion(c),
          'a counter that didn’t grow': (c) => rewound.passkey.assertion(c),
        };
        const answers: Record<string, unknown> = {};
        for (const [name, assertion] of Object.entries(refusals)) {
          find.mockClear();
          record.mockClear();
          check.mockClear();
          const before = { locked: await storedPasskey(locked.passkey), dana: await storedPasskey(dana.passkey) };
          const res = await signInWith(assertion);
          answers[name] = answer(res);
          expect(([] as string[]).concat(res.headers['set-cookie'] ?? []).some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`)), name).toBe(false);
          // One read of the passkey and its account, one signature check, nothing written.
          expect(find, name).toHaveBeenCalledTimes(1);
          expect(check, name).toHaveBeenCalledTimes(1);
          expect(record, name).not.toHaveBeenCalled();
          // The signature check ran to the end (the library refuses some things before it,
          // a counter that didn't grow among them, which would be a quicker refusal).
          const libraryRuns = await Promise.allSettled(check.mock.results.map((result) => result.value));
          expect(libraryRuns.map((run) => run.status), name).toEqual(['fulfilled']);
          expect(await storedPasskey(locked.passkey), name).toEqual(before.locked);
          expect(await storedPasskey(dana.passkey), name).toEqual(before.dana);
        }
        for (const name of Object.keys(refusals)) {
          expect(answers[name], name).toEqual({
            status: 401,
            body: SIGN_IN_REFUSED,
          });
        }

        // Sign-in disabled, or the password changed, after the passkey was read: refused by the
        // session the same way (a lock then is the next test's).
        const { SessionRefusedError } = await import('../services/SessionService.js');
        for (const code of ['LOGIN_DISABLED', 'PASSWORD_CHANGED', 'USER_NOT_FOUND'] as const) {
          vi.spyOn(sessionService, 'createSession').mockRejectedValueOnce(new SessionRefusedError(code));
          expect(answer(await signInWith((c) => dana.passkey.assertion(c))), code).toEqual(answers['a wrong passkey (another key signed)']);
        }

        // And the passkey itself, with its handle, signs Dana in.
        record.mockClear();
        const ok = await signInWith((c) => dana.passkey.assertion(c));
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(ok.body.user.id).toBe(dana.id);
        expect(record).toHaveBeenCalledTimes(1);
      } finally {
        find.mockRestore();
        record.mockRestore();
        vi.restoreAllMocks();
      }
    });

    // By design, a locked account's correct passkey is
    // told the account is locked, as a correct password is, once the assertion verifies. Every
    // other refusal still answers alike (the test above), a sign-in-disabled account's included.
    it('tells a locked account’s correct passkey the account is locked, only once the assertion verifies, after the same work as a refusal', async () => {
      const lee = await addUser('lee');
      const both = await addUser('locked-and-disabled');
      const disabled = await addUser('disabled-only');
      const active = await addUser('active');
      // The stored counter is ahead of what the passkey signs next: a clone.
      const rewoundLocked = await addUser('rewound-locked');
      await owner.query('UPDATE users SET is_locked = true WHERE id = ANY($1)', [[lee.id, both.id, rewoundLocked.id]]);
      await owner.query('UPDATE users SET login_disabled = true WHERE id = ANY($1)', [[both.id, disabled.id]]);
      await owner.query('UPDATE passkey_credentials SET counter = 1000 WHERE user_id = $1', [rewoundLocked.id]);
      const ACCOUNT_LOCKED = {
        error: 'Account is locked. Please contact an administrator.',
        code: 'ACCOUNT_LOCKED',
        message: 'Account is locked. Please contact an administrator.',
      };

      const find = vi.spyOn(passkeyService as unknown as { findCredentialForAssertion: () => Promise<unknown> }, 'findCredentialForAssertion');
      const record = vi.spyOn(passkeyService as unknown as { recordUse: () => Promise<boolean> }, 'recordUse');
      const check = vi.mocked(verifyAuthenticationResponse);
      try {
        const cases: Array<[string, (challenge: string) => unknown, { status: number; body: unknown }]> = [
          ['a locked account’s correct passkey', (c) => lee.passkey.assertion(c), { status: 401, body: ACCOUNT_LOCKED }],
          // Locked first, as a correct password is answered.
          ['a correct passkey of an account both locked and set up for automation', (c) => both.passkey.assertion(c), { status: 401, body: ACCOUNT_LOCKED }],
          ['a sign-in-disabled account’s correct passkey', (c) => disabled.passkey.assertion(c), { status: 401, body: SIGN_IN_REFUSED }],
          ['a locked account’s passkey, wrongly signed', (c) => lee.passkey.forgedAssertion(c), { status: 401, body: SIGN_IN_REFUSED }],
          ['a locked account’s passkey, naming another account’s handle', (c) => lee.passkey.assertion(c, { userHandle: active.passkey.userHandle }), { status: 401, body: SIGN_IN_REFUSED }],
          ['a locked account’s passkey whose counter didn’t grow', (c) => rewoundLocked.passkey.assertion(c), { status: 401, body: SIGN_IN_REFUSED }],
          ['an unknown passkey', (c) => new SoftPasskey().assertion(c), { status: 401, body: SIGN_IN_REFUSED }],
        ];
        const headerNames = new Map<string, string[]>();
        for (const [name, assertion, expected] of cases) {
          find.mockClear();
          record.mockClear();
          check.mockClear();
          const before = await storedPasskey(lee.passkey);
          const res = await signInWith(assertion);
          expect(answer(res), name).toEqual(expected);
          expect(([] as string[]).concat(res.headers['set-cookie'] ?? []).some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`)), name).toBe(false);
          // The same work as every refusal: one read, the signature check run to its end, nothing written.
          expect(find, name).toHaveBeenCalledTimes(1);
          expect(check, name).toHaveBeenCalledTimes(1);
          expect((await Promise.allSettled(check.mock.results.map((result) => result.value))).map((run) => run.status), name).toEqual(['fulfilled']);
          expect(record, name).not.toHaveBeenCalled();
          expect(await storedPasskey(lee.passkey), name).toEqual(before);
          headerNames.set(name, Object.keys(res.headers).filter((h) => !['date', 'etag', 'x-request-id', 'content-length'].includes(h)).sort());
        }
        // The same headers as a wrong passkey's: only the body says the account is locked.
        for (const [name, names] of headerNames) expect(names, name).toEqual(headerNames.get('an unknown passkey'));

        // Without user verification, the passkey is refused for that before anything else, as
        // an unknown one is: the assertion didn't verify.
        const uvOff = answer(await signInWith((c) => lee.passkey.assertion(c, { uv: false })));
        expect(uvOff).toEqual(answer(await signInWith((c) => new SoftPasskey().assertion(c, { uv: false }))));
        expect(uvOff.body).toMatchObject({ code: 'USER_VERIFICATION_REQUIRED' });

        // Locked after the passkey was read and its use recorded: the session is refused, and
        // says why, as a password sign-in does.
        const { SessionRefusedError } = await import('../services/SessionService.js');
        vi.spyOn(sessionService, 'createSession').mockRejectedValueOnce(new SessionRefusedError('ACCOUNT_LOCKED'));
        const lockedMeanwhile = await signInWith((c) => active.passkey.assertion(c));
        expect(answer(lockedMeanwhile)).toEqual({ status: 401, body: ACCOUNT_LOCKED });
        expect(([] as string[]).concat(lockedMeanwhile.headers['set-cookie'] ?? []).some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(false);

        // An active account's correct passkey signs in.
        const ok = await signInWith((c) => active.passkey.assertion(c));
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(ok.body.user).toEqual({ id: active.id, email: active.email });

        // Unlocked, the same passkey signs in (nothing was written while it was locked).
        await owner.query('UPDATE users SET is_locked = false WHERE id = $1', [lee.id]);
        const unlocked = await signInWith((c) => lee.passkey.assertion(c));
        expect(unlocked.status, JSON.stringify(unlocked.body)).toBe(200);
        expect(unlocked.body.user.id).toBe(lee.id);
      } finally {
        find.mockRestore();
        record.mockRestore();
        vi.restoreAllMocks();
      }
    });

    it('refuses a credential id that is not base64url like any unknown passkey, without asking the database', async () => {
      const find = vi.spyOn(passkeyService as unknown as { findCredentialForAssertion: () => Promise<unknown> }, 'findCredentialForAssertion');
      try {
        // The last: a run of `=` that a trailing-padding regex took seconds to trim.
        for (const id of ['not base64url!', 'A'.repeat(1365), `${'='.repeat(200_000)}x`]) {
          const res = await signInWith((c) => ({ ...alice.passkey.assertion(c), id, rawId: id }));
          expect(answer(res), JSON.stringify(id).slice(0, 30)).toEqual({
            status: 401,
            body: SIGN_IN_REFUSED,
          });
        }
        // A NUL is refused with the body, before any route runs: the same 400 for any id.
        for (const id of [`${alice.passkey.id}\u0000`, '\u0000']) {
          const res = await signInWith((c) => ({ ...alice.passkey.assertion(c), id, rawId: id }));
          expect([res.status, res.body.code], JSON.stringify(id).slice(0, 30)).toEqual([400, 'VALIDATION_ERROR']);
        }
        expect(find).not.toHaveBeenCalled();
        // A base64 spelling of a stored id still finds it.
        const base64 = Buffer.from(alice.passkey.id, 'base64url').toString('base64');
        const ok = await signInWith((c) => ({ ...alice.passkey.assertion(c), id: base64, rawId: base64 }));
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      } finally {
        find.mockRestore();
      }
    });

    it('signs in while the counter grows, and with one that stays 0 (a passkey that keeps none)', async () => {
      const kim = await addUser('kim');
      for (let i = 0; i < 2; i++) {
        const res = await signInWith((c) => kim.passkey.assertion(c));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
      expect((await storedPasskey(kim.passkey)).counter).toBe(2);

      // Synced passkeys keep no counter: 0 every time, accepted while the stored one is 0.
      const synced = await addUser('synced');
      for (let i = 0; i < 2; i++) {
        const res = await signInWith((c) => synced.passkey.assertion(c, { counter: 0 }));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
      expect((await storedPasskey(synced.passkey)).counter).toBe(0);
      // Once it has counted, 0 is a counter that didn't grow.
      expect((await signInWith((c) => synced.passkey.assertion(c, { counter: 5 }))).status).toBe(200);
      expect(answer(await signInWith((c) => synced.passkey.assertion(c, { counter: 0 })))).toEqual({
        status: 401,
        body: SIGN_IN_REFUSED,
      });
    });

    // Two sign-ins of one passkey that both read the stored counter before either writes:
    // the one counting 6 writes first, so the one counting 5, which read 0 and passed
    // counterMayFollow, must not take the counter back to 5.
    it('keeps the higher counter when two sign-ins of one passkey cross, refusing the lower one', async () => {
      const max = await addUser('max');
      const hold = await owner.connect();
      try {
        // Holds the passkey's row: both sign-ins read it, then wait to update it, in turn.
        await hold.query('BEGIN');
        await hold.query('SELECT 1 FROM passkey_credentials WHERE credential_id = $1 FOR UPDATE', [max.passkey.id]);
        const holdPid = (await hold.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        /** The pid of a session, other than `except`, waiting behind any of `blockers`. */
        const waitingBehind = async (blockers: number[], except: number[] = []): Promise<number> => {
          for (let i = 0; i < 200; i++) {
            const { rows } = await owner.query<{ pid: number }>(
              'SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) && $1::int[] AND NOT pid = ANY($2::int[])',
              [blockers, except]
            );
            if (rows[0]) return rows[0].pid;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error('no sign-in is waiting on the passkey row');
        };

        const six = signInWith((c) => max.passkey.assertion(c, { counter: 6 }));
        const sixPid = await waitingBehind([holdPid]);
        const five = signInWith((c) => max.passkey.assertion(c, { counter: 5 }));
        await waitingBehind([holdPid, sixPid], [sixPid]);
        await hold.query('COMMIT');

        const [first, second] = await Promise.all([six, five]);
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        expect(answer(second)).toEqual({
          status: 401,
          body: SIGN_IN_REFUSED,
        });
        expect((await storedPasskey(max.passkey)).counter).toBe(6);
      } finally {
        await hold.query('ROLLBACK').catch(() => undefined);
        hold.release();
      }
    });

    it('leaves passkeys not known to be discoverable out of a registration’s excludeCredentials, so a new one can be added beside them', async () => {
      const lou = await addUser('lou'); // one discoverable passkey
      const unknown = new SoftPasskey();
      const notDiscoverable = new SoftPasskey();
      await insertPasskey(lou.id, unknown);
      await insertPasskey(lou.id, notDiscoverable);
      await owner.query('UPDATE passkey_credentials SET discoverable = false WHERE credential_id = $1', [notDiscoverable.id]);
      const options = await (await signedIn(lou)).post('/api/passkeys/register/options');
      expect(options.status, JSON.stringify(options.body)).toBe(200);
      expect(options.body.excludeCredentials).toEqual([{ id: lou.passkey.id, type: 'public-key', transports: ['internal'] }]);
    });

    // A passkey registered since email-free passkey sign-in is discoverable (residentKey 'required') whatever
    // the browser said of it (rk). One the browser misreported was left out, so the
    // authenticator holding it made another for the account in its place; and (review) the
    // lists answered it false, so the profile page said to add a new one on that device, which
    // excluding it then refused. One rule now for both: what is stored stays as it was.
    it("treats a passkey registered under the account's user handle as discoverable whatever its rk said, in excludeCredentials and the lists", async () => {
      const mia = await addUser('mia'); // one discoverable passkey
      const handle = randomBytes(32).toString('base64url');
      await owner.query('UPDATE users SET webauthn_user_id = $1 WHERE id = $2', [handle, mia.id]);
      const misreported = new SoftPasskey();
      const unknown = new SoftPasskey();
      const notDiscoverable = new SoftPasskey();
      await insertPasskey(mia.id, misreported, { userHandle: handle });
      await insertPasskey(mia.id, unknown); // from before email-free sign-in: no handle, not known to be discoverable
      // From before email-free sign-in too, with a handle of its own (random, as those were), and marked not discoverable.
      await insertPasskey(mia.id, notDiscoverable, { userHandle: notDiscoverable.userHandle });
      await owner.query('UPDATE passkey_credentials SET discoverable = false WHERE credential_id = ANY($1)', [[misreported.id, notDiscoverable.id]]);
      const browser = await signedIn(mia);

      const options = await browser.post('/api/passkeys/register/options');
      expect(options.status, JSON.stringify(options.body)).toBe(200);
      expect(Buffer.from(options.body.user.id, 'base64url').toString('base64url')).toBe(handle);
      const excluded = (options.body.excludeCredentials as Array<{ id: string }>).map((c) => c.id).sort();
      expect(excluded).toEqual([mia.passkey.id, misreported.id].sort());

      const answered = (list: Array<{ id: string; discoverable: unknown }>) => Object.fromEntries(list.map((p) => [p.id, p.discoverable]));
      const expected = { [mia.passkey.id]: true, [misreported.id]: true, [unknown.id]: null, [notDiscoverable.id]: false };
      const own = await request(server).get('/api/passkeys').set('Cookie', `${SESSION_COOKIE_NAME}=${browser.cookies.get(SESSION_COOKIE_NAME)}`);
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      expect(answered(own.body)).toEqual(expected);
      // The deployment admin's view of the user lists them the same way.
      expect(answered(await listUserPasskeys((await owner.query<{ uuid: string }>('SELECT uuid FROM users WHERE id = $1', [mia.id])).rows[0].uuid))).toEqual(expected);
      // Stored as the browser said it.
      expect(await storedPasskey(misreported)).toMatchObject({ discoverable: false });
    });

    it('refuses a passkey without user verification the same way whether or not it is stored', async () => {
      const uvOff = (passkey: SoftPasskey) => (c: string) => passkey.assertion(c, { uv: false });
      const stored = answer(await signInWith(uvOff(alice.passkey)));
      const unknown = answer(await signInWith(uvOff(new SoftPasskey())));
      expect(stored).toEqual({ status: 401, body: expect.objectContaining({ code: 'USER_VERIFICATION_REQUIRED' }) });
      expect(unknown).toEqual(stored);
    });

    it('keeps the user handle an older passkey (from before email-free sign-in) names at its first sign-in, and refuses another after', async () => {
      const hal = await addUser('hal', false);
      const legacy = new SoftPasskey();
      await insertPasskey(hal.id, legacy); // no user_handle, discoverable unknown
      const listed = await request(server)
        .get('/api/passkeys')
        .set('Cookie', `${SESSION_COOKIE_NAME}=${(await signedIn(hal)).cookies.get(SESSION_COOKIE_NAME)}`);
      expect((listed.body as Array<{ discoverable: unknown }>).map((p) => p.discoverable)).toEqual([null]);

      const first = await signInWith((c) => legacy.assertion(c));
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.user.id).toBe(hal.id);
      expect(await storedPasskey(legacy)).toMatchObject({ user_handle: legacy.userHandle, discoverable: true });

      const other = await signInWith((c) => legacy.assertion(c, { userHandle: b64url(randomBytes(32)) }));
      expect(answer(other)).toEqual({ status: 401, body: SIGN_IN_REFUSED });
      expect((await storedPasskey(legacy)).user_handle).toBe(legacy.userHandle);

      const again = await signInWith((c) => legacy.assertion(c));
      expect(again.status, JSON.stringify(again.body)).toBe(200);
    });

    it('lets only one of two first sign-ins of an older passkey, naming different handles, keep its handle', async () => {
      const jo = await addUser('jo', false);
      const legacy = new SoftPasskey();
      await insertPasskey(jo.id, legacy);
      const [a, b] = [b64url(randomBytes(32)), b64url(randomBytes(32))];
      const answers = await Promise.all([
        signInWith((c) => legacy.assertion(c, { userHandle: a })),
        signInWith((c) => legacy.assertion(c, { userHandle: b })),
      ]);
      expect(answers.map((res) => res.status).sort()).toEqual([200, 401]);
      const winner = answers[0].status === 200 ? a : b;
      expect((await storedPasskey(legacy)).user_handle).toBe(winner);
    });

    it("re-authentication still lists only the signed-in user's own passkeys, with the transports each is known by", async () => {
      const ivy = await addUser('ivy');
      const noTransports = new SoftPasskey();
      await insertPasskey(ivy.id, noTransports, { transports: null });
      const browser = await signedIn(ivy);
      const options = await browser.post('/api/passkeys/reauthenticate/options');
      expect(options.status, JSON.stringify(options.body)).toBe(200);
      // No made-up 'internal' for the one whose transports aren't known; Alice's isn't listed.
      expect(new Set(options.body.allowCredentials)).toEqual(
        new Set([
          { id: ivy.passkey.id, type: 'public-key', transports: ['internal'] },
          { id: noTransports.id, type: 'public-key' },
        ])
      );

      // A passkey that isn't discoverable names no handle, which re-authentication accepts.
      const ok = await browser.post('/api/passkeys/reauthenticate/verify', {
        response: noTransports.assertion(options.body.challenge, { userHandle: null }),
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);

      // One that names another handle than its own is refused.
      const next = await browser.post('/api/passkeys/reauthenticate/options');
      const wrong = await browser.post('/api/passkeys/reauthenticate/verify', {
        response: ivy.passkey.assertion(next.body.challenge, { userHandle: alice.passkey.userHandle }),
      });
      expect(wrong.status).toBe(403);
      expect(wrong.body.code).toBe('REAUTH_FAILED');
      // As is someone else's passkey.
      const third = await browser.post('/api/passkeys/reauthenticate/options');
      const theirs = await browser.post('/api/passkeys/reauthenticate/verify', { response: alice.passkey.assertion(third.body.challenge) });
      expect(theirs.status).toBe(403);
    });
  });

  it("doesn't write anyone's email address to the log", async () => {
    logged.length = 0;
    // Bob starts a sign-in for his address; a stranger's sign-in finds no challenge.
    await startSignIn(new Browser(server), { email: bob.email });
    const stranger = await new Browser(server).post('/api/passkeys/auth/verify', { response: alice.passkey.assertion('x') });
    expect(stranger.status).toBe(400);
    const text = inspect(logged, { depth: 6, maxArrayLength: null, maxStringLength: null });
    expect(text).toContain('Received authentication verification request'); // the verify step's log was captured
    expect(text).not.toContain(bob.email);
  });
});
