import express, { CookieOptions, Request, Response, type Router } from 'express';
import * as path from 'path';
import { unlink, writeFile } from 'fs/promises';
import { randomBytes, timingSafeEqual } from 'crypto';
import {
  oneDriveCallbackQuery,
  oneDriveConfigRequestSchema,
  oneDriveSettingsRequestSchema,
  oneDriveUploadRequestSchema,
  type OneDriveConfigRequest,
} from '@nuggets/shared';
import { baseCookieOptions } from '../utils/session-cookie-config.js';
import logger from '../utils/logger.js';
import { OneDriveService } from '../services/OneDriveService.js';
import { userIsDeploymentAdmin } from '../services/MembershipService.js';
import { backupNotFound, oneDriveNotConfigured } from '../services/backup/errors.js';
import { EncryptionKeyUnavailableError } from '../services/EncryptionService.js';
import { parsedQuery, validateBody, validateQuery } from '../middleware/validate.js';
import { asyncHandler, authHandler, type AuthenticatedRequest } from '../utils/routeHandler.js';
import type { RouteDependencies } from './dependencies.js';

/** JSON safe to embed in a <script>: `</script>` and U+2028/2029 can't end it early. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** What the callback page may say about an error. Microsoft's own text is never shown. */
const CALLBACK_ERRORS = {
  declined: 'You declined access in Microsoft.',
  microsoft: 'Microsoft reported an error. Try connecting again.',
  missing: 'Missing authorization code.',
  expired: 'This sign-in link expired or was already used. Start again from the Backup page.',
  notAdmin: 'Only a deployment admin can connect OneDrive.',
  otherBrowser: 'Finish connecting in the browser you started it in. Start again from the Backup page.',
  failed: 'Failed to connect OneDrive.',
  noKey: "This server has no data encryption key, so OneDrive can't be connected. A deployment admin needs to configure it.",
} as const;

/**
 * The browser that starts a connect gets its OAuth `state` in this cookie, and the
 * callback finishes only in a browser that has it. The state alone
 * (single use, 10 minutes) still let a deployment admin who started a connect send
 * the Microsoft link to someone else, whose OneDrive would then be connected to the admin's
 * account. SameSite=Lax: Microsoft's redirect to the callback is a cross-site navigation,
 * which a Strict cookie doesn't go with. Only the callback's path sees it.
 */
/**
 * The error codes an OAuth callback may carry (RFC 6749 §4.1.2.1, OpenID Connect Core §3.1.2.6,
 * and the token errors of §5.2): the callback logs one of these by name, anything else as 'other'.
 */
const OAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'access_denied', 'invalid_request', 'unauthorized_client', 'unsupported_response_type', 'invalid_scope',
  'server_error', 'temporarily_unavailable', 'interaction_required', 'login_required', 'consent_required',
  'account_selection_required', 'invalid_client', 'invalid_grant',
]);

export const OAUTH_STATE_COOKIE = 'onedrive_oauth_state';
const OAUTH_STATE_PATH = '/api/onedrive/callback';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function oauthStateCookieOptions(): CookieOptions {
  return { ...baseCookieOptions(), sameSite: 'lax', path: OAUTH_STATE_PATH };
}

function sameState(cookie: unknown, state: string): boolean {
  if (typeof cookie !== 'string') return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(state);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Render the OAuth callback result. The connect flow runs in a popup window, so
 * the callback returns a tiny page that notifies the opener (postMessage) and
 * closes itself — rather than loading the whole app inside the popup. If it
 * wasn't opened as a popup (no opener), it falls back to redirecting the tab to
 * the backup settings page with the same query params the frontend already
 * understands.
 */
function sendOAuthCallbackResult(res: Response, clientUrl: string, result: 'success' | 'error', message?: string): void {
  let clientOrigin: string;
  try {
    clientOrigin = new URL(clientUrl).origin;
  } catch {
    clientOrigin = '*';
  }
  const params = new URLSearchParams({ onedrive: result });
  if (message) params.set('message', message);
  const fallbackUrl = `${clientUrl}/settings/backup?${params.toString()}`;
  const payload = scriptJson({ type: 'onedrive-auth', status: result, message: message ?? null });
  const heading = result === 'success' ? 'OneDrive connected' : 'OneDrive connection failed';
  // The app's CSP blocks inline scripts, so this page allows exactly its own, by nonce.
  const nonce = randomBytes(16).toString('base64');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  );
  // The popup arrives here from Microsoft's sign-in, another origin. Under helmet's
  // default (same-origin) the browser cuts it off from the window that opened it, so
  // window.opener would be null and the app would never hear the result.
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');

  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${heading}</title></head>
<body>
<p>${heading}. You can close this window.</p>
<script nonce="${nonce}">
  (function () {
    var payload = ${payload};
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, ${scriptJson(clientOrigin)});
        window.close();
        return;
      }
    } catch (e) { /* fall through to redirect */ }
    window.location.replace(${scriptJson(fallbackUrl)});
  })();
</script>
</body></html>`);
}

/**
 * The OAuth callback Microsoft sends the admin's browser to (/api/onedrive/callback). It
 * is public: the state it was given names the deployment admin who started the connect,
 * and the browser that did holds it in a cookie. Mounted before {@link createOneDriveRoutes}.
 */
export function createOneDriveCallbackRoutes({ oneDriveService, config }: Pick<RouteDependencies, 'oneDriveService' | 'config'>): Router {
  const router = express.Router();
  // Where the popup's result goes: the app's backup page, and the origin it is posted to.
  const clientUrl = config.CLIENT_URL || 'http://localhost:3000';
  const send = (res: Response, result: 'success' | 'error', message?: string) =>
    sendOAuthCallbackResult(res, clientUrl, result, message);

  /**
   * GET /api/onedrive/callback
   * OAuth callback endpoint (called by Microsoft after user authorization)
   */
  router.get('/callback', validateQuery(oneDriveCallbackQuery), asyncHandler(async (req: Request, res: Response) => {
    // Each is text sent once, or undefined (the schema never refuses: this answers a page).
    const { code, state, error, error_description } = parsedQuery(req, oneDriveCallbackQuery);

    // Handle OAuth errors. Neither the error nor Microsoft's description is shown, and only an
    // error code OAuth defines is logged: anyone can send a link to this page with any
    // text in it, and a log line carries no text a caller wrote.
    if (error) {
      logger.error({ oauthError: OAUTH_ERROR_CODES.has(error) ? error : 'other', withDescription: error_description !== undefined }, 'OneDrive OAuth error');
      send(res, 'error', error === 'access_denied' ? CALLBACK_ERRORS.declined : CALLBACK_ERRORS.microsoft);
      return;
    }

    if (!code || !state) {
      logger.error('Missing code or state in OAuth callback');
      send(res, 'error', CALLBACK_ERRORS.missing);
      return;
    }

    try {
      // Only in the browser that started this connect.
      const browserState = (req.cookies as Record<string, unknown> | undefined)?.[OAUTH_STATE_COOKIE];
      res.clearCookie(OAUTH_STATE_COOKIE, oauthStateCookieOptions());
      if (!sameState(browserState, state)) {
        logger.warn('OneDrive OAuth callback in a browser that did not start it');
        send(res, 'error', CALLBACK_ERRORS.otherBrowser);
        return;
      }
      // The state names the user who started this connect, once and briefly.
      const userId = OneDriveService.consumeAuthState(state);
      if (userId == null) {
        logger.warn('OneDrive OAuth callback with an unknown, expired or used state');
        send(res, 'error', CALLBACK_ERRORS.expired);
        return;
      }
      // Backups hold every organization's data: only a deployment admin may receive them.
      if (!(await userIsDeploymentAdmin(userId))) {
        logger.warn({ userId }, 'OneDrive OAuth callback for a user who is not a deployment admin');
        send(res, 'error', CALLBACK_ERRORS.notAdmin);
        return;
      }

      // Exchange authorization code for tokens
      await oneDriveService.exchangeCodeForTokens(code, userId);

      logger.info({ userId }, 'OneDrive connected successfully');

      // Close the popup and notify the opener (falls back to a redirect).
      send(res, 'success');
    } catch (error) {
      logger.error({ err: error }, 'Failed to complete OneDrive OAuth flow');
      send(res, 'error', error instanceof EncryptionKeyUnavailableError ? CALLBACK_ERRORS.noKey : CALLBACK_ERRORS.failed);
    }
  }));

  return router;
}

/**
 * Connecting OneDrive, where backups are copied, and copying them (/api/onedrive).
 * Backups are whole-deployment archives, so this is a deployment admin's to set up: mounted
 * behind authenticateToken and requireDeploymentAdmin. A refusal (not set up, no
 * such backup, no key to keep the tokens with) is a DomainError the route wrapper answers;
 * a failure, OneDrive's included, is its 500.
 */
export function createOneDriveRoutes({
  oneDriveService,
  backupService,
  config,
}: Pick<RouteDependencies, 'oneDriveService' | 'backupService' | 'config'>): Router {
  const router = express.Router();

  /**
   * GET /api/onedrive/config
   * Return the OneDrive app registration (client id + redirect uri, and whether
   * a client secret is set). The secret itself is never returned.
   */
  router.get('/config', authHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json({ success: true, ...(await oneDriveService.getClientConfig()) });
  }));

  /**
   * PUT /api/onedrive/config
   * Save the OneDrive app registration. client id + secret are encrypted at
   * rest in system_settings; the redirect uri is non-secret. Omitting
   * clientSecret leaves the stored secret unchanged.
   */
  router.put('/config', validateBody(oneDriveConfigRequestSchema), authHandler(async (req: AuthenticatedRequest, res: Response) => {
    await oneDriveService.saveClientConfig(req.body as OneDriveConfigRequest);
    logger.info({ userId: req.user.userId }, 'OneDrive app registration updated');
    res.json({ success: true, message: 'OneDrive configuration saved' });
  }));

  /**
   * GET /api/onedrive/status
   * Get OneDrive connection status for current user
   */
  router.get('/status', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!(await oneDriveService.isConfigured())) {
      res.json({
        success: true,
        configured: false,
        message: "OneDrive isn't set up: enter the app's client ID, secret and redirect URI on the Backup page."
      });
      return;
    }
    res.json({ success: true, configured: true, ...(await oneDriveService.getStatus(req.user.userId)) });
  }));

  /**
   * GET /api/onedrive/auth
   * Start OAuth authorization flow: 503 ONEDRIVE_NOT_CONFIGURED before the app is
   * registered, 503 ENCRYPTION_KEY_UNAVAILABLE with nothing to keep the tokens with.
   */
  router.get('/auth', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user.userId;
    if (!(await oneDriveService.isConfigured())) throw oneDriveNotConfigured();
    oneDriveService.assertTokenKeyAvailable();

    const authUrl = await oneDriveService.getAuthorizationUrl(userId);
    const state = new URL(authUrl).searchParams.get('state');
    if (state) res.cookie(OAUTH_STATE_COOKIE, state, { ...oauthStateCookieOptions(), maxAge: OAUTH_STATE_TTL_MS });

    logger.info({ userId }, 'OneDrive OAuth authorization initiated');
    res.json({ success: true, authUrl });
  }));

  /**
   * POST /api/onedrive/settings
   * Update OneDrive settings (e.g., enable/disable auto-sync)  Body: { autoSyncEnabled: boolean }
   */
  router.post('/settings', validateBody(oneDriveSettingsRequestSchema), authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user.userId;
    const { autoSyncEnabled } = req.body as { autoSyncEnabled: boolean };
    await oneDriveService.updateSettings(userId, autoSyncEnabled);
    logger.info({ userId, autoSyncEnabled }, 'OneDrive settings updated');
    res.json({ success: true, message: 'Settings updated successfully' });
  }));

  /**
   * POST /api/onedrive/upload
   * Manually upload a specific backup file to OneDrive  Body: { fileName }
   */
  router.post('/upload', validateBody(oneDriveUploadRequestSchema), authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user.userId;
    const { fileName } = req.body as { fileName: string };

    // Only a backup BackupService lists, by its exact name: nothing else in the folder,
    // and no path in the name.
    const backup = await backupService.findBackup(fileName);
    if (!backup) throw backupNotFound();

    // The stored tokens can't be read without the data encryption key: a 503 that says so.
    await oneDriveService.uploadFile(userId, backup.filePath, backup.fileName);
    logger.info({ userId, fileName }, 'Manual OneDrive upload successful');
    res.json({ success: true, message: 'File uploaded to OneDrive successfully' });
  }));

  /**
   * DELETE /api/onedrive/disconnect
   * Disconnect OneDrive (delete stored tokens)
   */
  router.delete('/disconnect', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user.userId;
    await oneDriveService.disconnect(userId);
    logger.info({ userId }, 'OneDrive disconnected');
    res.json({ success: true, message: 'OneDrive disconnected successfully' });
  }));

  /**
   * POST /api/onedrive/test-upload
   * Test OneDrive connection by uploading a small test file, deleted from here afterwards
   * whether it went or not.
   */
  router.post('/test-upload', authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user.userId;
    const testFileName = `nuggets_test_${Date.now()}.txt`;
    const tempPath = path.join(config.TEMP_PATH, testFileName);
    await writeFile(tempPath, `Nuggets OneDrive Test\nDate: ${new Date().toISOString()}\nUser ID: ${userId}`);
    try {
      await oneDriveService.uploadFile(userId, tempPath, testFileName);
    } finally {
      await unlink(tempPath).catch(() => {});
    }
    logger.info({ userId }, 'OneDrive test upload successful');
    res.json({
      success: true,
      message: 'Test file uploaded successfully. Check /Backups/Nuggets/ folder in OneDrive.'
    });
  }));

  return router;
}
