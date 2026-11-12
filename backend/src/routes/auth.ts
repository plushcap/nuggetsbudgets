/**
 * Authentication Routes
 *
 * Session-based authentication endpoints:
 * - Login/logout with server-side sessions
 * - Session management (list, revoke)
 * - Password change with session invalidation
 * - Profile management
 *
 * Security features:
 * - Sessions stored in httpOnly cookies
 * - Sliding idle timeout and absolute lifetime (utils/session-lifetime.ts)
 * - Max 4 concurrent sessions per user
 * - All sessions and personal access tokens revoked on password change
 *
 * The routes parse the request and answer; the work is in the services (UserService,
 * SessionService, MembershipService, personalAccessTokens). A refusal is a
 * DomainError (AuthError, UserError, ControlPlaneError) the route wrapper answers as
 * itself; anything else it logs and answers 500 INTERNAL_ERROR without its text.
 */

import express, { Request, Response, type Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import {
  requireInteractiveSession,
  requireRecentReauth,
  sessionService,
} from '../middleware/auth.js';
import { SessionRefusedError, REAUTH_WINDOW_MS } from '../services/SessionService.js';
import {
  listActivePersonalAccessTokens,
  mintPersonalAccessToken,
  revokeOwnPersonalAccessToken,
} from '../services/personalAccessTokens.js';
import { resolveTenant, type TenantRequest } from '../middleware/tenant.js';
import { accessibleTenantByUuid, getMembershipSummary, switchActiveTenant } from '../services/MembershipService.js';
import {
  changeOwnPassword,
  createFirstAdmin,
  deploymentHasAccounts,
  findAccountForSignIn,
  getOwnAccount,
  passwordIsCorrect,
  rehashCheckedPassword,
  updateOwnProfile,
} from '../services/UserService.js';
import { AuthError } from '../services/auth/authErrors.js';
import { DomainError } from '../services/domainErrors.js';
import { loginRateLimiter, markNotAFailedSignIn, reauthRateLimiter, setupRateLimiter } from '../middleware/security.js';
import { getPasswordPolicy } from '../utils/validation.js';
import { compareWithoutAccount, hashNeedsRehash } from '../utils/passwords.js';
import {
  accountThrottleKey,
  chargeLoginAttempt,
  clearLoginAttempts,
  refundLoginAttempt,
  deviceThrottleKey,
} from '../services/LoginThrottleService.js';
import { trustedDeviceId, trustThisDevice } from '../utils/loginDevice.js';
import { logAuthenticationEvent, requireJsonBody } from '../middleware/security-enhanced.js';
import { validateBody } from '../middleware/validate.js';
import {
  changePasswordSchema,
  loginSchema,
  mcpTokenCreateSchema,
  ownProfileUpdateSchema,
  reauthenticateSchema,
  setActiveTenantSchema,
  type ChangePasswordInput,
  type LoginInput,
  type McpTokenCreateInput,
  type OwnProfileUpdateInput,
  type ReauthenticateInput,
  type SetActiveTenantInput,
} from '@nuggets/shared';
import { createLogger } from '../utils/logger.js';
import {
  setSessionCookie,
  clearSessionCookie,
  getSessionFromCookies,
} from '../utils/session-cookie-config.js';
import { imageFileFilter, IMAGE_UPLOAD_LIMITS } from '../utils/imageUpload.js';
import { requireWellFormedIds } from '../middleware/routeParams.js';
import { noticeCredentialAdded } from '../services/credentialNotices.js';
import { asyncHandler, authHandler, type AuthenticatedRequest } from '../utils/routeHandler.js';
import { refuseNulFields } from '../middleware/nulText.js';

const logger = createLogger({ service: 'AuthRoute' });

// Multer configuration for user profile image uploads. Profile images are stored
// in the DB (user_profile_images, one per user) so they ride the backup/restore —
// buffer in memory, don't write to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: IMAGE_UPLOAD_LIMITS,
  // Validate BOTH extension and MIME so a spoofed image/* MIME on an .html/.svg
  // file cannot be stored and later served as executable content (stored XSS).
  fileFilter: imageFileFilter
});

/**
 * The browser session a request behind requireInteractiveSession came with. The guard
 * refuses a request without one, so this never throws; it keeps the handlers from
 * reading the session as set.
 */
export function browserSessionId(req: AuthenticatedRequest): number {
  const sessionId = req.session?.id;
  if (sessionId === undefined) throw AuthError.interactiveSessionRequired();
  return sessionId;
}

/** The ledger resolveTenant chose for this request (null when there is none). */
const activeTenantOf = (req: AuthenticatedRequest): number | null => (req as TenantRequest).activeTenantId ?? null;

/** The browser's address and user agent, as a new session records them. */
const sessionOrigin = (req: Request) => ({
  ipAddress: req.ip,
  userAgent: req.headers['user-agent'],
  deviceInfo: {
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  },
});

/**
 * Sign in with a password (POST /auth/login): the throttle, the check, the session. Each
 * refusal is an AuthError, logged as an authentication event first.
 */
async function signInWithPassword(req: Request, res: Response): Promise<void> {
  // loginSchema trimmed and lower-cased the email.
  const { email, password } = req.body as LoginInput;

  // Throttle per account before anything else: charged now, refunded by a
  // correct password. A browser that signed in to this account before is throttled on
  // its own, so guesses from elsewhere don't keep it out.
  const deviceId = trustedDeviceId(req, email);
  const throttleKey = deviceId ? deviceThrottleKey(email, deviceId) : accountThrottleKey(email);
  const charge = await chargeLoginAttempt(throttleKey);
  if (!charge.allowed) {
    logAuthenticationEvent(req, 'blocked', 'Sign-in throttled for this account');
    // Not a failed sign-in of this address's: the per-IP limiter doesn't count it, so
    // one family member waiting out a throttled account doesn't use up the others' budget.
    markNotAFailedSignIn(res);
    res.setHeader('Retry-After', String(charge.retryAfterSeconds));
    throw AuthError.loginThrottled(charge.retryAfterSeconds);
  }

  const user = await findAccountForSignIn(email);

  // Verify the password before saying anything about the account, and spend the time a
  // comparison at the current cost takes when there is no account, so neither the answer
  // nor its timing tells whether the address has one, or whether it is locked.
  // (A hash at an older cost takes its own time until its user next signs in, below.)
  const isValidPassword = user
    ? await bcrypt.compare(password, user.password_hash)
    : await compareWithoutAccount(password);
  if (!user || !isValidPassword) {
    logAuthenticationEvent(req, 'failure', user ? 'Invalid password' : 'User not found');
    throw AuthError.invalidCredentials();
  }
  // A trusted device's failures were its own: forget them. On the address's shared key,
  // refund only this attempt, not the count someone else's guesses built.
  if (deviceId) await clearLoginAttempts(throttleKey);
  else await refundLoginAttempt(throttleKey);

  if (user.is_locked) {
    logAuthenticationEvent(req, 'failure', 'Account is locked');
    throw AuthError.accountLocked();
  }

  // Service accounts (automation-only) may not sign in interactively.
  if (user.login_disabled) {
    logAuthenticationEvent(req, 'failure', 'Interactive login disabled');
    throw AuthError.loginDisabled();
  }

  // The browser may still carry an earlier session (e.g. another family member's
  // on a shared computer): end it, rather than leave it valid on the server.
  const presentedToken = getSessionFromCookies(req);
  if (presentedToken) {
    await sessionService
      .revokeSessionByToken(presentedToken, 'replaced_by_login')
      .catch((err) => logger.warn({ err }, 'Failed to revoke the session the browser carried at login'));
  }

  // Create session (enforces max 4 sessions per user). It is refused if, while the
  // password was being checked, the account was locked or had sign-in disabled, or
  // the password checked here was changed (passwordChangedAt is from that same row).
  let sessionToken: string;
  try {
    ({ token: sessionToken } = await sessionService.createSession({
      userId: user.id,
      ...sessionOrigin(req),
      passwordChangedAt: user.password_changed_at ?? null,
    }));
  } catch (error) {
    if (!(error instanceof SessionRefusedError)) throw error;
    logAuthenticationEvent(req, 'failure', `Account changed during sign-in: ${error.code}`);
    if (error.code === 'ACCOUNT_LOCKED') throw AuthError.accountLocked();
    if (error.code === 'LOGIN_DISABLED') throw AuthError.loginDisabled();
    throw AuthError.invalidCredentials();
  }

  // A hash made at another bcrypt cost than BCRYPT_ROUNDS is made again from the password
  // just checked; a failure here doesn't fail the sign-in.
  if (hashNeedsRehash(user.password_hash)) {
    await rehashCheckedPassword(user.id, user.password_hash, password);
  }

  setSessionCookie(res, sessionToken);
  // This browser now signs in to the account on its own throttle key.
  trustThisDevice(req, res, user.email);

  logAuthenticationEvent(req, 'success', 'Signed in with a password', user.id);

  // The account as GET /api/auth/me answers it: the page keeps it as the
  // signed-in person, so it must carry what /me's does (the uuid, colour, icon and picture).
  res.json({
    message: 'Login successful',
    user: {
      id: user.id,
      uuid: user.uuid,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      default_color: user.default_color,
      icon: user.icon,
      profile_image: user.profile_image,
      created_at: user.created_at,
      // Set by an admin creating the account or resetting its password: the session
      // reaches little but PUT /api/auth/change-password until it's changed.
      must_change_password: user.must_change_password,
    },
  });
}

/**
 * The sign-in routes nobody is signed in for yet (/api/auth): first-run setup, signing in
 * with a password, and the password policy those pages show. Public; mounted before
 * {@link createAuthRoutes}.
 */
export function createAuthPublicRoutes(): Router {
  const router = express.Router();

  /**
   * GET /auth/setup-status
   * Check if initial admin setup is needed
   */
  router.get('/setup-status', asyncHandler(async (_req: Request, res: Response) => {
    const hasUsers = await deploymentHasAccounts();
    res.json({
      setupComplete: hasUsers,
      requiresSetup: !hasUsers
    });
  }));

  /**
   * POST /auth/setup-admin
   * Initial admin user creation: only while no users exist, and only with the one-time setup
   * token the server logs at startup (SetupTokenService). Public, so it authorizes with that
   * token before reading the rest of the body (UserService.createFirstAdmin). Then signs the
   * new admin in, in the ledger setup made (no NO_ACTIVE_TENANT).
   */
  router.post('/setup-admin', requireJsonBody, setupRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const user = await createFirstAdmin(req.body ?? {}, { ip: req.ip });

    const { token: sessionToken } = await sessionService.createSession({ userId: user.id, ...sessionOrigin(req) });
    setSessionCookie(res, sessionToken);

    res.status(201).json({
      message: 'Admin user created successfully',
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        created_at: user.created_at
      }
    });
  }));

  /**
   * POST /auth/login
   * User login with email and password
   * Creates a session and sets httpOnly cookie
   */
  router.post('/login', requireJsonBody, loginRateLimiter, validateBody(loginSchema), asyncHandler(async (req: Request, res: Response) => {
    try {
      await signInWithPassword(req, res);
    } catch (error) {
      // A failure inside (not a refusal) is the route wrapper's to log and answer 500. Its
      // security event, which /api/health/security shows, doesn't carry the error's text.
      if (!(error instanceof DomainError)) {
        logAuthenticationEvent(req, 'failure', 'Login error (internal; see the server log)');
      }
      throw error;
    }
  }));

  /**
   * GET /auth/password-policy
   * The rules a new password must meet (minimum length, byte limit, whether composition
   * rules are on), so the pages that set one check and describe them as the server does.
   * Public: the first-run setup page needs it before anyone can sign in, and the policy is
   * no secret.
   */
  router.get('/password-policy', (_req: Request, res: Response) => {
    res.json(getPasswordPolicy());
  });

  return router;
}

/**
 * The signed-in person's own account (/api/auth): who they are and their ledgers, the
 * active ledger, their profile and password, their sessions, re-authentication, and their
 * MCP tokens. Mounted behind authenticateToken; a route adds the guards it needs.
 */
export function createAuthRoutes(): Router {
  const router = express.Router();

  /**
   * GET /auth/me
   * Get current user information
   */
  router.get('/me', resolveTenant, authHandler(async (req, res) => {
    const user = await getOwnAccount(req.user.userId);
    // Multi-tenancy: the budgets/orgs the caller can see + active-budget role
    // context. Drives the tenant switcher and role-gated settings pages.
    const membership = await getMembershipSummary(req.user.userId, activeTenantOf(req));
    res.json({ user, membership });
  }));

  /**
   * GET /auth/tenants
   * The caller's budgets (grouped client-side by org) + active budget + roles.
   * Reads only global control-plane tables, so it works with no active budget.
   */
  router.get('/tenants', resolveTenant, authHandler(async (req, res) => {
    res.json(await getMembershipSummary(req.user.userId, activeTenantOf(req)));
  }));

  /**
   * POST /auth/active-tenant
   * Switch the browser session's active budget. Validates membership via the same
   * access rule as the per-request gate. Rejected for Bearer/PAT auth (no session).
   */
  router.post('/active-tenant', validateBody(setActiveTenantSchema), authHandler(async (req, res) => {
    if (!req.session?.id) throw AuthError.browserSessionRequired();
    const { tenantUuid } = req.body as SetActiveTenantInput;
    const activeTenant = await switchActiveTenant(req.user.userId, req.session.id, tenantUuid);
    logger.info({ userId: req.user.userId, tenantUuid }, 'Active tenant switched');
    res.json({ activeTenant });
  }));

  /**
   * PUT /auth/profile
   * Update current user's profile
   */
  router.put('/profile', upload.single('profile_image'), refuseNulFields, validateBody(ownProfileUpdateSchema), authHandler(async (req, res) => {
    const image = req.file ? { mimeType: req.file.mimetype, data: req.file.buffer } : undefined;
    const updated = await updateOwnProfile(req.user.userId, req.body as OwnProfileUpdateInput, image);
    logger.info({ userId: req.user.userId, profileUpdated: true }, 'User profile updated');
    res.json(updated);
  }));

  /**
   * PUT /auth/change-password
   * Change current user's password
   * Revokes ALL sessions for security (forces re-login on all devices)
   */
  // Rate-limited like re-authentication: it checks the current password, so without a
  // limit a stolen session could guess it here once /reauthenticate refuses.
  // The refusals keep the codes they had before the schema.
  const changePasswordCodes = { currentPassword: 'BAD_REQUEST', newPassword: 'BAD_REQUEST', removePasskeys: 'INVALID_REMOVE_PASSKEYS' };
  router.put('/change-password', reauthRateLimiter, validateBody(changePasswordSchema, { codes: changePasswordCodes }), authHandler(async (req, res) => {
    const userId = req.user.userId;
    const { currentPassword, newPassword, removePasskeys } = req.body as ChangePasswordInput;

    const { sessionsRevoked, tokensRevoked, passkeysRemoved } = await changeOwnPassword(
      { userId, email: req.user.email, sessionId: req.session?.id },
      { currentPassword, newPassword, removePasskeys }
    );

    // The session this request came with ended with the rest.
    clearSessionCookie(res);

    logger.info({ userId, sessionsRevoked, tokensRevoked, passkeysRemoved }, 'User password changed, all sessions and tokens revoked');

    res.json({
      success: true,
      message: 'Password changed successfully. Please log in again.',
      sessionsRevoked,
      tokensRevoked,
      passkeysRemoved,
    });
  }));

  /**
   * POST /auth/logout
   * Logout current session
   */
  router.post('/logout', authHandler(async (req, res) => {
    const sessionToken = getSessionFromCookies(req);
    try {
      if (sessionToken) {
        await sessionService.revokeSessionByToken(sessionToken, 'logout');
      }
    } finally {
      // Cleared even when ending the session failed (the wrapper answers that 500): the
      // browser stops sending it either way.
      clearSessionCookie(res);
    }

    logger.info({ userId: req.user.userId }, 'User logged out successfully');

    res.json({
      message: 'Logged out successfully'
    });
  }));

  /**
   * GET /auth/sessions
   * List active sessions for current user
   */
  router.get('/sessions', authHandler(async (req, res) => {
    res.json({ sessions: await sessionService.listOwnSessions(req.user.userId, req.session?.id) });
  }));

  /**
   * DELETE /auth/sessions/:uuid
   * Revoke a specific session by UUID
   */
  router.delete('/sessions/:uuid', requireWellFormedIds, authHandler(async (req, res) => {
    const userId = req.user.userId;
    const uuid = String(req.params.uuid);

    await sessionService.revokeOwnSession(uuid, userId);
    logger.info({ userId, sessionUuid: uuid }, 'User revoked a session');

    res.json({
      message: 'Session revoked successfully'
    });
  }));

  /**
   * POST /auth/reauthenticate
   * Step-up: the signed-in user confirms their password, which lets this session mint a
   * personal access token or enroll a passkey for the next few minutes. Needs a
   * browser session (never a token) and is rate-limited per user. A wrong password is 403,
   * not 401: the session itself is still good. The passkey variant is
   * POST /api/passkeys/reauthenticate/{options,verify}.
   */
  router.post(
    '/reauthenticate',
    requireInteractiveSession,
    reauthRateLimiter,
    validateBody(reauthenticateSchema, { codes: { password: 'PASSWORD_REQUIRED' } }),
    authHandler(async (req, res) => {
      const userId = req.user.userId;
      const sessionId = browserSessionId(req);
      const { password } = req.body as ReauthenticateInput;

      if (!(await passwordIsCorrect(userId, password))) {
        logAuthenticationEvent(req, 'failure', 'Re-authentication with password failed');
        throw AuthError.wrongPassword();
      }

      await sessionService.recordReauthentication(sessionId);
      logger.info({ userId, method: 'password' }, 'User re-authenticated');
      res.json({ reauthenticated: true, validForSeconds: REAUTH_WINDOW_MS / 1000 });
    })
  );

  /**
   * POST /auth/mcp-token
   * Mint a personal access token for the MCP server, pinned to one ledger the caller may
   * use, with a scope (`read` or `read_write`, default `read`) and a lifetime of 30, 90 or
   * 365 days (`expiresIn`: '30d' | '90d' | '365d', default 365). Needs a browser session
   * that re-authenticated in the last few minutes: a token can never mint another.
   * Inserts a row in personal_access_tokens so the token can be listed and revoked.
   */
  const mcpTokenCodes = { expiresIn: 'INVALID_EXPIRES_IN', scope: 'INVALID_SCOPE', tenantUuid: 'TENANT_REQUIRED' };
  router.post('/mcp-token', requireRecentReauth, validateBody(mcpTokenCreateSchema, { codes: mcpTokenCodes }), authHandler(async (req, res) => {
    const { userId, email } = req.user;
    // The token is scoped to one ledger (tenant): the client sends the chosen ledger's uuid
    // (defaulting to the active one); its access is checked first.
    const { label, expiresIn, scope, tenantUuid } = req.body as McpTokenCreateInput;
    const tenant = await accessibleTenantByUuid(userId, tenantUuid, 'You do not have access to that tenant');

    // Inserted only if the session or token this request came with still stands.
    const minted = await mintPersonalAccessToken(
      { userId, email, sessionId: req.session?.id, patId: req.patId },
      { tenantId: tenant.id, label, scope, expiresIn }
    );

    logger.info({ userId, label, jti: minted.jti, expiresIn, scope }, 'Minted MCP personal-access token');
    // Tell the account's owner, by email or push, in the background.
    void noticeCredentialAdded(userId, { kind: 'mcp_token', name: label });

    res.status(201).json({
      token: minted.token,
      uuid: minted.uuid,
      jti: minted.jti,
      label,
      audience: 'mcp',
      scope,
      tenantUuid,
      createdAt: minted.createdAt,
      expiresAt: minted.expiresAt,
    });
  }));

  /**
   * GET /auth/mcp-tokens
   * List the caller’s non-revoked, non-expired personal access tokens (metadata only).
   */
  router.get('/mcp-tokens', authHandler(async (req, res) => {
    res.json(await listActivePersonalAccessTokens(req.user.userId));
  }));

  /**
   * DELETE /auth/mcp-tokens/:uuid
   * Soft-revoke one of the caller’s personal access tokens.
   */
  router.delete('/mcp-tokens/:uuid', requireWellFormedIds, authHandler(async (req, res) => {
    const userId = req.user.userId;
    const uuid = String(req.params.uuid);

    const revoked = await revokeOwnPersonalAccessToken(userId, uuid);

    logger.info({ userId, tokenUuid: uuid, label: revoked.label }, 'Revoked MCP token');
    res.json({ message: 'Token revoked', uuid });
  }));

  return router;
}
