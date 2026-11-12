// Passkey (WebAuthn) authentication routes
//
// The routes parse the request and answer; the work is in PasskeyService and SessionService.
// A refusal is a PasskeyError or AuthError the route wrapper answers as itself;
// anything else it logs and answers 500 INTERNAL_ERROR without its text. A deployment
// admin's view of another person's passkeys is in routes/admin.ts.
import express, { type Request, type Response, type Router } from 'express';
import { passkeyService } from '../services/PasskeyService.js';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { requireInteractiveSession, requireRecentReauth, sessionService } from '../middleware/auth.js';
import { asyncHandler, authHandler } from '../utils/routeHandler.js';
import { SessionRefusedError, REAUTH_WINDOW_MS } from '../services/SessionService.js';
import { passkeyLoginRateLimiter, passkeyOptionsRateLimiter, reauthRateLimiter } from '../middleware/security.js';
import { getSessionFromCookies, setSessionCookie } from '../utils/session-cookie-config.js';
import { startCeremony, takeCeremonyChallenge } from '../services/WebAuthnChallengeStore.js';
import { createLogger } from '../utils/logger.js';
import { requireJsonBody } from '../middleware/security-enhanced.js';
import { noticeCredentialAdded } from '../services/credentialNotices.js';
import { validateBody } from '../middleware/validate.js';
import {
  passkeyAssertionSchema,
  passkeyRegistrationSchema,
  passkeyRenameSchema,
  type PasskeyAssertionInput,
  type PasskeyRegistrationInput,
  type PasskeyRenameInput,
  type PasskeyDeletedResponse,
} from '@nuggets/shared';
import { AuthError, PasskeyError } from '../services/auth/authErrors.js';
import { browserSessionId } from './auth.js';

const logger = createLogger({ service: 'PasskeyRoute' });

// Each ceremony's challenge is stored server-side, for the browser that started it, and
// used once (services/WebAuthnChallengeStore.ts). A passkey must verify its user
// (WEBAUTHN_USER_VERIFICATION=required): PasskeyError says what to tell someone whose
// passkey only showed the device was there.

/**
 * Signing in with a passkey (/api/passkeys/auth/…), before there is a session: public, so
 * this router is mounted before {@link createPasskeyRoutes} and its guard. The options
 * are the same whoever asks, and every refused sign-in answers alike.
 */
export function createPasskeySignInRoutes(): Router {
  const router = express.Router();

  /**
   * Generate authentication options
   * POST /api/passkeys/auth/options
   * Public endpoint (no auth required)
   */
  router.post('/auth/options', requireJsonBody, passkeyOptionsRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    // No email: the options are the same whoever asks, and list no passkeys. The
    // browser offers the ones it has for this site; the one that answers says whose it is.
    // An email in the body, from an older page, is ignored.
    // Log the request origin for debugging mobile issues.
    const origin = req.get('origin') || req.get('referer');
    const userAgent = req.get('user-agent');

    logger.info({
      origin,
      userAgent: userAgent?.substring(0, 100), // Truncate for readability
      host: req.get('host')
    }, 'Generating authentication options');

    const options = await passkeyService.generateSignInOptions();

    // The challenge is this browser's alone, kept server-side until it verifies or
    // expires: another sign-in, here or anywhere, can't replace it.
    await startCeremony(req, res, { purpose: 'authentication', userId: null, challenge: options.challenge });

    logger.info({
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: options.userVerification,
    }, 'Authentication options generated successfully');

    res.json(options);
  }));

  /**
   * Verify authentication response and login
   * POST /api/passkeys/auth/verify
   * Public endpoint (no auth required)
   */
  router.post(
    '/auth/verify',
    requireJsonBody,
    passkeyLoginRateLimiter,
    validateBody(passkeyAssertionSchema),
    asyncHandler(async (req: Request, res: Response) => {
      // Every log line here carries the request's id (utils/logger.ts), not one of our own.
      const response = (req.body as PasskeyAssertionInput).response as unknown as AuthenticationResponseJSON;

      logger.info({
        hasResponse: true,
        responseId: response.id.substring(0, 20) + '...',
        userAgent: req.headers['user-agent'],
        origin: req.headers['origin'],
        ip: req.ip || req.socket.remoteAddress
      }, 'Received authentication verification request');

      // This browser's sign-in challenge (its ceremony cookie), consumed now so it can't be
      // replayed, even if verification below fails.
      const expectedChallenge = await takeCeremonyChallenge(req, { purpose: 'authentication', response });
      if (!expectedChallenge) {
        logger.warn('Passkey challenge not found or expired');
        throw PasskeyError.challengeExpired();
      }

      // The passkey says whose it is. Every refusal answers as a wrong passkey does: an
      // unknown or removed passkey, a wrong signature, counter or user handle, and a
      // sign-in-disabled account (PasskeyService.verifySignIn). A locked account's own passkey
      // that verified is told the account is locked, as its correct password is.
      logger.info('Starting authentication verification');
      const verifyStart = Date.now();
      const verification = await passkeyService.verifySignIn(response, expectedChallenge);
      const verifyDuration = Date.now() - verifyStart;

      logger.info({
        verified: verification.verified,
        ...(verification.verified && { userId: verification.account.id }),
        verifyDuration
      }, 'Authentication verification completed');

      if (!verification.verified) {
        logger.warn({ reason: verification.reason }, 'Authentication verification failed');
        if (verification.reason === 'user_verification') {
          throw PasskeyError.noUserVerification(401, 'USER_VERIFICATION_REQUIRED');
        }
        if (verification.reason === 'account_locked') throw AuthError.accountLocked();
        throw PasskeyError.signInRefused();
      }
      const user = verification.account;

      // The browser may still carry an earlier session (e.g. another family member's
      // on a shared computer): end it, rather than leave it valid on the server.
      const presentedToken = getSessionFromCookies(req);
      if (presentedToken) {
        await sessionService
          .revokeSessionByToken(presentedToken, 'replaced_by_login')
          .catch((err) => logger.warn({ err }, 'Failed to revoke the session the browser carried at login'));
      }

      // Create session (enforces max 4 sessions per user). It is refused if the account
      // was locked, had sign-in disabled or had its password changed since the passkey's
      // account was read (passwordChangedAt is from it): locked, as the verified passkey of a
      // locked account is; otherwise as a wrong passkey is.
      let sessionToken: string;
      try {
        ({ token: sessionToken } = await sessionService.createSession({
          userId: user.id,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          deviceInfo: {
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            authMethod: 'passkey',
          },
          passwordChangedAt: user.passwordChangedAt,
        }));
      } catch (refusal) {
        if (!(refusal instanceof SessionRefusedError)) throw refusal;
        logger.warn({ userId: user.id, code: refusal.code }, 'Passkey sign-in refused: the account changed');
        if (refusal.code === 'ACCOUNT_LOCKED') throw AuthError.accountLocked();
        throw PasskeyError.signInRefused();
      }

      setSessionCookie(res, sessionToken);

      logger.info({ userId: user.id }, 'Successfully authenticated with passkey');

      res.json({
        user: {
          id: user.id,
          email: user.email,
        },
      });
    })
  );

  return router;
}

/**
 * The signed-in person's passkeys (/api/passkeys): enrolling one, confirming it's them
 * with one (re-authentication), listing, renaming and removing them. Mounted behind
 * authenticateToken; a route adds the guards it needs (a recent re-authentication, a
 * browser session), and validates its body after them.
 */
export function createPasskeyRoutes(): Router {
  const router = express.Router();

  /**
   * Generate registration options for a new passkey
   * POST /api/passkeys/register/options
   * Requires a browser session that re-authenticated in the last few minutes:
   * a new passkey is a lasting way in, so a stolen session or a token can't
   * add one.
   */
  router.post('/register/options', requireRecentReauth, authHandler(async (req, res) => {
    const { userId, email } = req.user;

    const options = await passkeyService.generateRegistrationOptions(userId, email);
    await startCeremony(req, res, { purpose: 'registration', userId, challenge: options.challenge });

    logger.info({ userId }, 'Generated passkey registration options');

    res.json(options);
  }));

  /**
   * Verify registration response and save passkey
   * POST /api/passkeys/register/verify
   * Requires a browser session that re-authenticated in the last few minutes, like the
   * options step.
   */
  router.post('/register/verify', requireRecentReauth, validateBody(passkeyRegistrationSchema), authHandler(async (req, res) => {
    const userId = req.user.userId;
    const { deviceName } = req.body as PasskeyRegistrationInput;
    const response = (req.body as PasskeyRegistrationInput).response as unknown as RegistrationResponseJSON;

    // This browser's registration challenge, for this user, used up by reading it.
    const expectedChallenge = await takeCeremonyChallenge(req, { purpose: 'registration', userId, response });
    if (!expectedChallenge) throw PasskeyError.challengeExpired();

    const verification = await passkeyService.verifyRegistrationResponse(
      userId,
      response,
      expectedChallenge,
      deviceName ?? undefined,
      req.session?.id
    );

    if (!verification.verified) {
      if (verification.reason === 'credential_ended') throw AuthError.sessionEnded();
      if (verification.reason === 'user_verification') throw PasskeyError.cannotVerifyUser();
      throw PasskeyError.registrationFailed();
    }

    logger.info(
      { userId, credentialId: verification.credentialId },
      'Successfully registered passkey'
    );
    // Tell the account's owner, by email or push, in the background.
    void noticeCredentialAdded(userId, { kind: 'passkey', name: deviceName ?? null });

    res.json({
      verified: true,
      credentialId: verification.credentialId,
      message: 'Passkey registered successfully',
    });
  }));

  /**
   * Step-up with a passkey instead of the password (see POST /api/auth/reauthenticate).
   * POST /api/passkeys/reauthenticate/options
   * Requires a browser session; offers only the signed-in user's own passkeys.
   */
  router.post('/reauthenticate/options', requireInteractiveSession, authHandler(async (req, res) => {
    const userId = req.user.userId;
    // The signed-in user's own passkeys, and only theirs.
    const options = await passkeyService.generateReauthenticationOptions(userId);
    if (!options) throw PasskeyError.noPasskey();
    await startCeremony(req, res, { purpose: 'reauthentication', userId, challenge: options.challenge });

    res.json(options);
  }));

  /**
   * POST /api/passkeys/reauthenticate/verify
   * Verifies a passkey assertion for the challenge above and, when the passkey belongs to
   * the signed-in user, records the re-authentication on the session. Rate-limited per
   * user together with the password variant. A failed check is 403, not 401.
   */
  router.post(
    '/reauthenticate/verify',
    requireInteractiveSession,
    reauthRateLimiter,
    validateBody(passkeyAssertionSchema),
    authHandler(async (req, res) => {
      const userId = req.user.userId;
      const sessionId = browserSessionId(req);
      const response = (req.body as PasskeyAssertionInput).response as unknown as AuthenticationResponseJSON;

      // Single-use: consume the challenge before verifying, even if verification fails.
      const expectedChallenge = await takeCeremonyChallenge(req, { purpose: 'reauthentication', userId, response });
      if (!expectedChallenge) throw PasskeyError.challengeExpired();

      // Only the signed-in user's own passkeys count: check before verifying anything.
      const own = await passkeyService.getUserCredentials(userId);
      if (!own.some((cred) => cred.credential_id === response.id)) {
        logger.warn({ userId }, 'Passkey re-authentication refused: not one of the user’s passkeys');
        throw PasskeyError.notYours();
      }

      // A bad assertion (wrong challenge, origin, signature, counter, user handle, no user
      // verification) is { verified: false }; anything thrown is the server's, and a 500.
      const verification = await passkeyService.verifyReauthentication(userId, response, expectedChallenge);
      if (!verification.verified) {
        logger.warn({ userId }, 'Passkey re-authentication failed');
        if (verification.reason === 'user_verification') throw PasskeyError.noUserVerification(403, 'REAUTH_FAILED');
        throw PasskeyError.reauthenticationFailed();
      }

      await sessionService.recordReauthentication(sessionId);
      logger.info({ userId, method: 'passkey' }, 'User re-authenticated');
      res.json({ reauthenticated: true, validForSeconds: REAUTH_WINDOW_MS / 1000 });
    })
  );

  /**
   * Get all passkeys for current user
   * GET /api/passkeys
   * Requires authentication
   */
  router.get('/', authHandler(async (req, res) => {
    res.json(await passkeyService.listPasskeys(req.user.userId));
  }));

  /**
   * Update passkey device name
   * PUT /api/passkeys/:credentialId
   * Requires authentication. A credential id that isn't one of the caller's, or can't be
   * any passkey's (a NUL byte), is 404 PASSKEY_NOT_FOUND.
   */
  router.put('/:credentialId', validateBody(passkeyRenameSchema), authHandler(async (req, res) => {
    const userId = req.user.userId;
    const credentialId = String(req.params.credentialId);
    const { deviceName } = req.body as PasskeyRenameInput;

    await passkeyService.renamePasskey(userId, credentialId, deviceName);
    logger.info({ userId, credentialId }, 'Updated passkey device name');

    res.json({ success: true, message: 'Device name updated' });
  }));

  /**
   * Delete a passkey
   * DELETE /api/passkeys/:credentialId
   * Requires authentication; 404 PASSKEY_NOT_FOUND as for a rename. Answers with the relying
   * party (`rpId`), which the page hands the browser with the deleted passkey's id so it stops
   * offering that one (passkeyDeletedResponseSchema).
   */
  router.delete('/:credentialId', authHandler(async (req, res) => {
    const userId = req.user.userId;
    const credentialId = String(req.params.credentialId);

    await passkeyService.removePasskey(userId, credentialId);
    logger.info({ userId, credentialId }, 'Deleted passkey');

    const answer: PasskeyDeletedResponse = { success: true, message: 'Passkey deleted', rpId: passkeyService.relyingPartyId };
    res.json(answer);
  }));

  return router;
}
