import { DomainError } from '../domainErrors.js';

/**
 * Refusals of a person's own account routes: signing in, their sessions,
 * re-authenticating and their MCP tokens (/api/auth), and their passkeys (/api/passkeys).
 * Thrown by the route or the service (SessionService, personalAccessTokens, PasskeyService)
 * and answered by the route wrapper as `{ ...details, error, code, message, requestId }`.
 * The account's own refusals (a weak password, a wrong current one) are UserError
 * (UserService); a ledger the person may not use is a ControlPlaneError (MembershipService).
 */

/** "5 seconds", "3 minutes": how long a throttled sign-in has to wait. */
function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export class AuthError extends DomainError {
  /**
   * A password sign-in refused: a wrong password, an address with no account, and (for a
   * wrong password) a locked or sign-in-disabled account alike.
   */
  static invalidCredentials(): AuthError {
    return new AuthError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  /** The right password, or a passkey of its own that verified, for a locked account. */
  static accountLocked(): AuthError {
    return new AuthError(401, 'ACCOUNT_LOCKED', 'Account is locked. Please contact an administrator.');
  }

  /** The right password for a service account, which signs in only with its tokens. */
  static loginDisabled(): AuthError {
    return new AuthError(403, 'LOGIN_DISABLED', 'This account cannot sign in — it is set up for automation only.');
  }

  /** Too many failed sign-ins for this account (LoginThrottleService): wait `retryAfter` seconds. */
  static loginThrottled(retryAfterSeconds: number): AuthError {
    return new AuthError(
      429,
      'LOGIN_THROTTLED',
      `Too many failed sign-in attempts for this account. Try again in ${formatWait(retryAfterSeconds)}, or sign in with a passkey.`,
      { retryAfter: retryAfterSeconds }
    );
  }

  /**
   * The session (or token) the request came with ended while it ran: a lock, a password
   * change or a sign-out committed meanwhile. 401, so the app signs the person out.
   */
  static sessionEnded(): AuthError {
    return new AuthError(401, 'INVALID_SESSION', 'Session invalid or expired');
  }

  /** Something only a browser session can do (it has an active ledger to switch). */
  static browserSessionRequired(): AuthError {
    return new AuthError(400, 'SESSION_REQUIRED', 'Switching tenants requires a browser session');
  }

  /** A guard that needs a browser session let a request through without one. */
  static interactiveSessionRequired(): AuthError {
    return new AuthError(403, 'INTERACTIVE_SESSION_REQUIRED', 'This needs a signed-in browser session, not a personal access token');
  }

  /** No session of the caller's has this uuid (or it has ended already). */
  static sessionNotFound(): AuthError {
    return new AuthError(404, 'SESSION_NOT_FOUND', 'Session not found');
  }

  /** No token of the caller's that still works has this uuid. */
  static tokenNotFound(): AuthError {
    return new AuthError(404, 'TOKEN_NOT_FOUND', 'Token not found');
  }

  /** Re-authentication with a password that isn't the account's. 403: the session still stands. */
  static wrongPassword(): AuthError {
    return new AuthError(403, 'REAUTH_FAILED', 'That password is not correct');
  }

  /** The session ended between the re-authentication's check and recording it. */
  static reauthenticationLost(): AuthError {
    return new AuthError(403, 'REAUTH_REQUIRED', 'Your session changed; please try again');
  }

  /** A request body the route refuses, with the code its clients have always had for it. */
  static badRequest(code: string, message: string): AuthError {
    return new AuthError(400, code, message);
  }
}

/** Refusals of the passkey routes (/api/passkeys): its ceremonies and a person's own passkeys. */
export class PasskeyError extends DomainError {
  /**
   * A passkey sign-in refused: an unknown, removed or wrong passkey, and a
   * sign-in-disabled account, answer alike. A locked account's own passkey that verified is
   * AuthError.accountLocked instead.
   */
  static signInRefused(): PasskeyError {
    return new PasskeyError(401, 'VERIFICATION_FAILED', 'Authentication verification failed');
  }

  /**
   * A passkey that proved only that someone was there, not who (no PIN, fingerprint or
   * face), which WEBAUTHN_USER_VERIFICATION=required refuses: at sign-in (401) or
   * re-authentication (403).
   */
  static noUserVerification(status: 401 | 403, code: 'USER_VERIFICATION_REQUIRED' | 'REAUTH_FAILED'): PasskeyError {
    return new PasskeyError(
      status,
      code,
      "This passkey didn't confirm it's you with a PIN, fingerprint or face. Use a passkey that does, or sign in with your password."
    );
  }

  /** Enrolling a passkey that can't verify its user. */
  static cannotVerifyUser(): PasskeyError {
    return new PasskeyError(
      400,
      'USER_VERIFICATION_REQUIRED',
      "This passkey can't confirm it's you with a PIN, fingerprint or face, so it can't be added. Set a PIN on it, or use another."
    );
  }

  /** This browser's challenge for the ceremony is gone: used, expired, or never started here. */
  static challengeExpired(): PasskeyError {
    return new PasskeyError(400, 'INVALID_CHALLENGE', 'Challenge not found or expired');
  }

  /** A registration whose response didn't verify. */
  static registrationFailed(): PasskeyError {
    return new PasskeyError(400, 'VERIFICATION_FAILED', 'Registration verification failed');
  }

  /** Re-authenticating with a passkey that isn't the signed-in person's. */
  static notYours(): PasskeyError {
    return new PasskeyError(403, 'REAUTH_FAILED', 'That passkey is not one of yours');
  }

  /** Re-authenticating with one's own passkey, whose assertion didn't verify. */
  static reauthenticationFailed(): PasskeyError {
    return new PasskeyError(403, 'REAUTH_FAILED', 'The passkey check failed');
  }

  /** Re-authenticating with a passkey, for a person who has none. */
  static noPasskey(): PasskeyError {
    return new PasskeyError(400, 'NO_PASSKEY', 'You have no passkey to confirm with');
  }

  /** No passkey of this person's has this credential id (or one that can't be stored, a NUL byte). */
  static notFound(): PasskeyError {
    return new PasskeyError(404, 'PASSKEY_NOT_FOUND', 'Passkey not found');
  }
}
