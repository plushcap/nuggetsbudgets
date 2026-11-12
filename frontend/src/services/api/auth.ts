/**
 * API Auth Module — session lifecycle + pre-authentication setup flow.
 *
 * Some of these endpoints are reached before a session exists (initial admin
 * setup, the login page's setup-status probe, the startup session probe), so
 * they live in their own module.
 */
import {
  authMeResponseSchema,
  createdUserResponseSchema,
  loginResponseSchema,
  passwordPolicySchema,
  setupStatusResponseSchema,
  type CreatedUserResponse,
  type OwnAccount,
  type PasswordPolicy,
  type SetupStatus,
} from '@nuggets/shared';
import { apiErrorFrom, apiGet, apiPost, API_BASE_URL, getAuthHeaders } from './base';
import { parseAnswer } from './parseAnswer';
import { logger } from '../../utils/logger';

/**
 * The signed-in person's own account, as GET /auth/me (and signing in) answers it:
 * ownAccountResponseSchema. `must_change_password`: an admin set the password, which must be
 * replaced before anything else (the server enforces it).
 */
export type AuthUser = OwnAccount;

export interface LoginResult {
  ok: boolean;
  user?: AuthUser;
  error?: string;
}

/**
 * Resolve the current session's user, or `null` when there is no session (401).
 *
 * Any other failure rejects (an `ApiError`, or the network's error): a server that is
 * restarting or unreachable is not "signed out", and treating it so sent a signed-in
 * family to the sign-in page, then to first-run setup. ProtectedRoute shows a
 * retry screen for it instead.
 *
 * Intentionally bypasses the shared `apiGet`/`handleResponse` pipeline: a
 * logged-out visitor gets a 401 here, and the shared 401 handler dispatches the
 * `session-expired` logout flow and rejects with `SessionExpiredError`. For the
 * startup probe we want a plain `null` instead.
 */
export const getCurrentUser = async (): Promise<AuthUser | null> => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/auth/me`, {
      credentials: 'include',
    });
  } catch (error) {
    logger.error({ err: error }, 'Session verification failed');
    throw error;
  }
  if (response.status === 401) return null;
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    const error = apiErrorFrom(response, body);
    logger.error({ err: error }, 'Session verification failed');
    throw error;
  }
  return parseAnswer(authMeResponseSchema, await response.json(), 'signed-in account').user;
};

/**
 * Attempt a password login. Returns a result object (rather than throwing) so a
 * 401 for bad credentials doesn't trip the shared session-expired handler.
 */
export const loginRequest = async (email: string, password: string): Promise<LoginResult> => {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (response.ok) return { ok: true, user: parseAnswer(loginResponseSchema, data, 'sign-in').user };
  const error = (data as { error?: unknown } | null)?.error;
  return { ok: false, ...(typeof error === 'string' && { error }) };
};

/**
 * Revoke the server session. Best-effort: client-side logout proceeds even if
 * this call fails.
 *
 * It carries the CSRF header like every other write: without it the server
 * answered 403 and kept the session, so a reload signed the last person back in.
 */
export const logoutRequest = async (): Promise<void> => {
  try {
    const response = await fetch(`${API_BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    if (!response.ok) {
      logger.error({ status: response.status }, 'The server did not end the session on logout');
    }
  } catch (error) {
    logger.error({ err: error }, 'Logout API call failed');
  }
};

export type { SetupStatus };

export interface SetupAdminPayload {
  /** The one-time token from the server log (first-run setup needs it). */
  setup_token: string;
  email: string;
  password: string;
  first_name: string;
  last_name: string;
}

/**
 * The rules a new password must meet, as the server enforces them (public: the first-run
 * setup page needs them before anyone has signed in).
 */
export const getPasswordPolicy = async (): Promise<PasswordPolicy> =>
  passwordPolicySchema.parse(await apiGet<unknown>('/auth/password-policy'));

/**
 * Whether the initial admin account has been created.
 */
export const getSetupStatus = async (): Promise<SetupStatus> =>
  parseAnswer(setupStatusResponseSchema, await apiGet<unknown>('/auth/setup-status'), 'setup status');

/**
 * Create the first admin account. On success the server sets the session cookie.
 */
export const setupAdmin = async (payload: SetupAdminPayload): Promise<CreatedUserResponse> =>
  parseAnswer(createdUserResponseSchema, await apiPost<unknown>('/auth/setup-admin', payload), 'first account');
