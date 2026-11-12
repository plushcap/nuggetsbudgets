/**
 * Passkey API Service
 *
 * Handles WebAuthn/passkey operations:
 * - Registration (creating new passkeys)
 * - Authentication (logging in with passkeys)
 * - Management (listing, updating, deleting passkeys)
 */

import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthnAutofill,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import {
  passkeyChangedResponseSchema,
  passkeyDeletedResponseSchema,
  passkeyListResponseSchema,
  passkeyRegisteredResponseSchema,
  passkeySignInResponseSchema,
  webAuthnOptionsResponseSchema,
  type PasskeyRegistered,
  type PasskeySignInResponse,
  type PasskeySummary,
} from '@nuggets/shared';
import { API_BASE_URL, apiDelete, apiErrorFrom, apiGet, getAuthHeaders, handleResponse } from './base';
import { parseAnswer } from './parseAnswer';
import { logger } from '../../utils/logger';

const getErrorInfo = (error: unknown): { name?: string | undefined; message?: string | undefined; stack?: string | undefined; code?: unknown } => {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }

  if (typeof error === 'object' && error !== null) {
    const maybeError = error as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown };
    return {
      name: typeof maybeError.name === 'string' ? maybeError.name : undefined,
      message: typeof maybeError.message === 'string' ? maybeError.message : undefined,
      stack: typeof maybeError.stack === 'string' ? maybeError.stack : undefined,
      code: maybeError.code,
    };
  }

  return { message: String(error) };
};

/**
 * A passkey as its owner's (or a deployment admin's) list shows it: passkeySummaryResponseSchema.
 * `discoverable`: whether it can sign in without an email; false, or null (not known), for
 * some passkeys added before sign-in stopped asking for one.
 */
export type PasskeyCredential = PasskeySummary;

/** A passkey registered. */
export type PasskeyRegistrationResult = PasskeyRegistered;

/** Signed in with a passkey. */
export type PasskeyAuthenticationResult = PasskeySignInResponse;

/**
 * Register a new passkey for the current user. Needs a fresh re-authentication: rejects
 * with code REAUTH_REQUIRED (on `response.data`) otherwise, before any browser prompt.
 */
export const registerPasskey = async (
  deviceName?: string
): Promise<PasskeyRegistrationResult> => {
  try {
    // Step 1: Get registration options from server
    const optionsResponse = await fetch(
      `${API_BASE_URL}/passkeys/register/options`,
      {
        method: 'POST',
        headers: getAuthHeaders(),
        credentials: 'include', // Include session cookie
      }
    );

    // WebAuthn's own options, handed to the browser as they came (the challenge checked).
    const options = parseAnswer(
      webAuthnOptionsResponseSchema,
      await handleResponse<unknown>(optionsResponse),
      'passkey registration options'
    ) as unknown as PublicKeyCredentialCreationOptionsJSON;

    logger.debug('Received passkey registration options');

    // Step 2: Start WebAuthn registration ceremony
    const registrationResponse = await startRegistration({
      optionsJSON: options,
    });

    logger.debug('Completed passkey registration ceremony');

    // Step 3: Send credential to server for verification
    // Registration runs while logged in (session cookie present), so this
    // state-changing POST must carry the X-CSRF-Token header — getAuthHeaders()
    // supplies it alongside Content-Type. (The login/authenticate flow below is
    // CSRF-exempt server-side because no session cookie exists yet.)
    const verifyResponse = await fetch(
      `${API_BASE_URL}/passkeys/register/verify`,
      {
        method: 'POST',
        headers: getAuthHeaders(),
        credentials: 'include', // Include session cookie
        body: JSON.stringify({
          response: registrationResponse,
          deviceName,
        }),
      }
    );

    if (!verifyResponse.ok) {
      const errorData = (await verifyResponse.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      logger.error({
        status: verifyResponse.status,
        statusText: verifyResponse.statusText,
        errorData
      }, 'Passkey verification failed');
      // Keep the status and the server's error code (e.g. REAUTH_REQUIRED) on the error.
      throw apiErrorFrom(verifyResponse, errorData);
    }

    const result = parseAnswer(passkeyRegisteredResponseSchema, await verifyResponse.json(), 'passkey registration');

    logger.info({ credentialId: result.credentialId }, 'Passkey registered successfully');

    return result;
  } catch (error) {
    const errorInfo = getErrorInfo(error);
    logger.error({ err: error, ...errorInfo }, 'Failed to register passkey');

    // Check for user cancellation
    if (errorInfo.name === 'NotAllowedError') {
      throw new Error('Passkey registration was cancelled', { cause: error });
    }

    // Registration asks for a passkey that signs in without an email, which some
    // older security keys can't store.
    if (
      (error as { code?: unknown } | null)?.code === 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT' ||
      errorInfo.name === 'ConstraintError'
    ) {
      throw new Error(
        "This security key can't store a passkey that signs in without your email. Use another key, your phone, or this device.",
        { cause: error }
      );
    }

    throw error;
  }
};

export interface PasskeySignInOptions {
  /**
   * Offer the passkeys in the email box's autofill (a conditional request), which waits until
   * one is chosen there, rather than ask now.
   */
  autofill?: boolean;
  /** Ends an autofill request: before its ceremony starts, or while it waits. */
  signal?: AbortSignal;
  /** Called when an autofill request has its options and asks the browser to wait for a passkey. */
  onWaiting?: () => void;
}

/** The error a cancelled passkey request rejects with (the name WebAuthn gives one). */
const abortError = () => Object.assign(new Error('Passkey sign-in was cancelled'), { name: 'AbortError' });

/** Whether a passkey sign-in ended only because it was cancelled (by the page, or a newer request). */
export const isPasskeyRequestAborted = (error: unknown): boolean =>
  (error as { name?: unknown } | null)?.name === 'AbortError';

/** Whether the person turned down the browser's passkey prompt (or it found none to use). */
export const isPasskeyRequestDeclined = (error: unknown): boolean =>
  ((error as { cause?: { name?: unknown } } | null)?.cause?.name ?? (error as { name?: unknown } | null)?.name) ===
  'NotAllowedError';

/**
 * Sign in with a passkey. No email: the browser offers the passkeys it has for this
 * site, and the one chosen says whose account it is. With `autofill`, the request waits for
 * a passkey chosen in the email box's autofill; otherwise it asks now (the button), ending a
 * waiting autofill request first.
 */
export const authenticateWithPasskey = async (
  { autofill = false, signal, onWaiting }: PasskeySignInOptions = {}
): Promise<PasskeyAuthenticationResult> => {
  const startTime = Date.now();
  const stepTimings: Record<string, number> = {};
  // An autofill request runs unasked, on every visit to the sign-in page: where the browser
  // can't serve it after all (no authenticator that can, NotSupportedError), that is no error.
  // The page shows what the person should see.
  const logFailure = autofill ? logger.warn.bind(logger) : logger.error.bind(logger);

  try {
    // Comprehensive device and environment logging
    const deviceInfo = {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      vendor: navigator.vendor,
      language: navigator.language,
      cookieEnabled: navigator.cookieEnabled,
      onLine: navigator.onLine,
      windowInnerWidth: window.innerWidth,
      windowInnerHeight: window.innerHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
      touchSupport: 'ontouchstart' in window,
      origin: window.location.origin,
      href: window.location.href,
      apiBaseUrl: API_BASE_URL,
      autofill,
    };

    logger.debug(deviceInfo, 'Starting passkey authentication - device info');

    // Check WebAuthn support
    const isSupported = isPasskeySupported();
    logger.debug({ isSupported }, 'WebAuthn support check');

    if (!isSupported) {
      throw new Error('WebAuthn is not supported on this device');
    }

    // Asked now: a request waiting in the autofill holds the browser's one WebAuthn
    // request, so end it first.
    if (!autofill) WebAuthnAbortService.cancelCeremony();
    if (signal?.aborted) throw abortError();

    // Step 1: Get authentication options from server
    logger.debug('Step 1: Requesting authentication options from server');
    const step1Start = Date.now();

    const optionsResponse = await fetch(
      `${API_BASE_URL}/passkeys/auth/options`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        // The server answers with this browser's ceremony cookie, which the verify step
        // below must send back.
        credentials: 'include',
        // No email: the options are the same for everyone.
        body: JSON.stringify({}),
        signal: signal ?? null,
      }
    );

    stepTimings.optionsFetch = Date.now() - step1Start;
    logger.debug({
      status: optionsResponse.status,
      statusText: optionsResponse.statusText,
      duration: stepTimings.optionsFetch
    }, 'Options response received');

    if (!optionsResponse.ok) {
      const errorData = (await optionsResponse.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      logFailure({
        status: optionsResponse.status,
        statusText: optionsResponse.statusText,
        errorBody: errorData
      }, 'Failed to fetch authentication options');
      throw apiErrorFrom(optionsResponse, errorData);
    }

    const options = parseAnswer(
      webAuthnOptionsResponseSchema,
      await handleResponse<unknown>(optionsResponse),
      'passkey sign-in options'
    ) as unknown as PublicKeyCredentialRequestOptionsJSON;

    const optionsInfo = {
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: options.userVerification,
      allowCredentialsCount: options.allowCredentials?.length || 0,
      challengeLength: options.challenge?.length || 0
    };
    logger.debug(optionsInfo, 'Step 1 complete: Received passkey authentication options');

    // Step 2: Start WebAuthn authentication ceremony
    const step2Info = {
      useBrowserAutofill: autofill,
      optionsJSON: {
        rpId: options.rpId,
        challenge: options.challenge?.substring(0, 20) + '...',
        timeout: options.timeout
      }
    };
    logger.debug(step2Info, 'Step 2: Calling startAuthentication from @simplewebauthn/browser');

    const step2Start = Date.now();

    // Cancelled while the options were on their way: start no ceremony, which would end
    // whichever one replaced this request.
    if (signal?.aborted) throw abortError();
    // While this autofill request waits, cancelling it ends its ceremony.
    const cancel = () => WebAuthnAbortService.cancelCeremony();
    if (autofill) {
      signal?.addEventListener('abort', cancel, { once: true });
      onWaiting?.();
    }

    // Only the browser's ceremony is in this try: a failure of the verify request after it is
    // the outer catch's, not "WebAuthn ceremony failed".
    let authenticationResponse: Awaited<ReturnType<typeof startAuthentication>>;
    try {
      authenticationResponse = await startAuthentication({
        optionsJSON: options,
        useBrowserAutofill: autofill,
      }).finally(() => signal?.removeEventListener('abort', cancel));
    } catch (webauthnError) {
      stepTimings.webauthnCeremony = Date.now() - step2Start;
      if (isPasskeyRequestAborted(webauthnError)) throw webauthnError;
      const webauthnErrorInfo = getErrorInfo(webauthnError);
      logFailure({
        err: webauthnError,
        ...webauthnErrorInfo,
        duration: stepTimings.webauthnCeremony
      }, 'WebAuthn ceremony failed');
      throw webauthnError;
    }

    stepTimings.webauthnCeremony = Date.now() - step2Start;
    const step2Complete = {
      duration: stepTimings.webauthnCeremony,
      responseId: authenticationResponse.id?.substring(0, 20) + '...',
      responseType: authenticationResponse.type,
      clientDataJSONLength: authenticationResponse.response?.clientDataJSON?.length || 0
    };
    logger.debug(step2Complete, 'Step 2 complete: WebAuthn ceremony completed');

    // Step 3: Send credential to server for verification
    logger.debug('Step 3: Sending credential to server for verification');
    const step3Start = Date.now();

    const verifyResponse = await fetch(
      `${API_BASE_URL}/passkeys/auth/verify`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include', // Session cookie will be set by server on success
        body: JSON.stringify({
          response: authenticationResponse,
        }),
      }
    );

    stepTimings.verifyFetch = Date.now() - step3Start;
    logger.debug({
      status: verifyResponse.status,
      statusText: verifyResponse.statusText,
      duration: stepTimings.verifyFetch
    }, 'Verify response received');

    if (!verifyResponse.ok) {
      const errorData = (await verifyResponse.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      logFailure({
        status: verifyResponse.status,
        statusText: verifyResponse.statusText,
        errorBody: errorData
      }, 'Verification failed on server');
      // Show the server's reason (e.g. a passkey that didn't check a PIN or biometric).
      // Not handleResponse: a 401 here is a failed sign-in, not an expired session.
      throw apiErrorFrom(verifyResponse, errorData);
    }

    const result = parseAnswer(passkeySignInResponseSchema, await handleResponse<unknown>(verifyResponse), 'passkey sign-in');

    stepTimings.total = Date.now() - startTime;
    // Debug only, and no email: production's console logs at info.
    const successInfo = {
      timings: stepTimings,
      userId: result.user?.id
    };
    logger.debug(successInfo, 'Step 3 complete: Authentication successful');

    return result;
  } catch (error) {
    stepTimings.total = Date.now() - startTime;

    // Cancelled by the page (the button, or leaving it) or by a newer request: no failure.
    if (isPasskeyRequestAborted(error)) {
      logger.debug({ autofill }, 'Passkey sign-in request cancelled');
      throw error;
    }

    const errorInfo = getErrorInfo(error);

    logFailure({
      err: error,
      ...errorInfo,
      timings: stepTimings
    }, 'Passkey authentication failed');

    // Check for user cancellation
    if (errorInfo.name === 'NotAllowedError') {
      throw new Error('Passkey authentication was cancelled', { cause: error });
    }

    // Check for timeout
    if (errorInfo.name === 'TimeoutError') {
      throw new Error('Passkey authentication timed out. Please try again.', { cause: error });
    }

    // Check for invalid state (common on mobile)
    if (errorInfo.name === 'InvalidStateError') {
      throw new Error('Unable to use passkey. Your device may not support this feature or no passkey is available.', { cause: error });
    }

    // Check for not supported (some mobile browsers)
    if (errorInfo.name === 'NotSupportedError') {
      throw new Error('Passkeys are not supported on this device or browser.', { cause: error });
    }

    // Check for security error (common with HTTPS/origin issues on mobile)
    if (errorInfo.name === 'SecurityError') {
      throw new Error('Security error. This may be due to HTTPS requirements or origin mismatch.', { cause: error });
    }

    // Check for network error
    if (errorInfo.name === 'NetworkError' || errorInfo.message?.includes('fetch')) {
      throw new Error('Network error. Please check your connection and try again.', { cause: error });
    }

    throw error;
  }
};

/**
 * Get all passkeys for the current user
 */
export const getUserPasskeys = async (): Promise<PasskeyCredential[]> => {
  try {
    const response = await fetch(`${API_BASE_URL}/passkeys`, {
      method: 'GET',
      headers: getAuthHeaders(),
      credentials: 'include', // Include session cookie
    });

    const passkeys = parseAnswer(passkeyListResponseSchema, await handleResponse<unknown>(response), 'passkeys');

    logger.info({ count: passkeys.length }, 'Fetched user passkeys');

    return passkeys;
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch passkeys');
    throw error;
  }
};

/** WebAuthn's Signal API (Level 3), which TypeScript's DOM types don't have yet; most browsers don't either. */
interface PasskeySignals {
  signalUnknownCredential?: (options: { rpId: string; credentialId: string }) => Promise<void>;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Tell the browser a passkey was deleted (`PublicKeyCredential.signalUnknownCredential`),
 * so it stops offering it in autofill. It names that passkey alone, by the id the server listed
 * and has just deleted: a list of the ones that remain could miss one being added in another tab
 * at the same moment, and the browser would drop that one too. Where the browser has no Signal
 * API (most, so far) it does nothing, and a call that throws or rejects is logged, never the
 * caller's failure.
 */
export const signalDeletedPasskey = (rpId: unknown, credentialId: string): void => {
  const refused = (err: unknown) => logger.warn({ err }, 'The browser refused the deleted passkey');
  try {
    if (typeof rpId !== 'string' || rpId === '' || !BASE64URL.test(credentialId)) return;
    const credentialApi = (globalThis as { PublicKeyCredential?: PasskeySignals }).PublicKeyCredential;
    const signal = credentialApi?.signalUnknownCredential;
    if (typeof signal !== 'function') return;
    Promise.resolve(signal.call(credentialApi, { rpId, credentialId })).catch(refused);
  } catch (err) {
    refused(err);
  }
};

/**
 * Delete one of the signed-in user's passkeys, then tell the browser it is gone
 * ({@link signalDeletedPasskey}).
 */
export const deletePasskey = async (credentialId: string): Promise<void> => {
  try {
    const response = await fetch(
      `${API_BASE_URL}/passkeys/${credentialId}`,
      {
        method: 'DELETE',
        headers: getAuthHeaders(),
        credentials: 'include', // Include session cookie
      }
    );

    const answer = parseAnswer(passkeyDeletedResponseSchema, await handleResponse<unknown>(response), 'passkey deletion');

    logger.info({ credentialId }, 'Deleted passkey');
    // A production build reads a mismatched answer as it came (parseAnswer), which may not be an
    // object: the passkey is deleted all the same, so the browser is told nothing then.
    signalDeletedPasskey((answer as { rpId?: unknown } | null | undefined)?.rpId, credentialId);
  } catch (error) {
    logger.error({ err: error }, 'Failed to delete passkey');
    throw error;
  }
};

/**
 * Check if WebAuthn is supported in the current browser
 */
export const isPasskeySupported = (): boolean => {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined'
  );
};

/**
 * Whether the browser can offer passkeys in a field's autofill (conditional mediation:
 * `PublicKeyCredential.isConditionalMediationAvailable()`).
 */
export const isConditionalUISupported = async (): Promise<boolean> => {
  if (!isPasskeySupported()) {
    return false;
  }

  try {
    return await browserSupportsWebAuthnAutofill();
  } catch {
    return false;
  }
};

/**
 * Admin: a user's passkeys (the deployment admin's user page). Deployment admins only:
 * GET /api/admin/users/:uuid/passkeys (it used to be under /api/passkeys/admin).
 */
export const getAdminUserPasskeys = async (userUuid: string): Promise<PasskeyCredential[]> =>
  parseAnswer(passkeyListResponseSchema, await apiGet<unknown>(`/admin/users/${encodeURIComponent(userUuid)}/passkeys`), "an account's passkeys");

/** Admin: remove one of a user's passkeys (a lost device). */
export const deleteAdminUserPasskey = async (userUuid: string, credentialId: string): Promise<void> => {
  parseAnswer(
    passkeyChangedResponseSchema,
    await apiDelete<unknown>(`/admin/users/${encodeURIComponent(userUuid)}/passkeys/${encodeURIComponent(credentialId)}`),
    'passkey removed'
  );
};
