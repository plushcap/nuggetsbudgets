/**
 * API Reauth Module — step-up re-authentication.
 *
 * Creating an MCP token and adding a passkey need the user to have confirmed their
 * password or a passkey in the last few minutes (signing in counts). Without that the
 * server answers 403 with code REAUTH_REQUIRED; `useReauth` catches it, asks, and retries.
 */
import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { reauthenticatedResponseSchema, webAuthnOptionsResponseSchema, type ReauthResult } from '@nuggets/shared';
import { apiPost } from './base';
import { parseAnswer } from './parseAnswer';

export const REAUTH_REQUIRED = 'REAUTH_REQUIRED';

/** The machine-readable `code` of an API error, if it has one. */
export const apiErrorCode = (error: unknown): string | undefined => {
  const code = (error as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
  return typeof code === 'string' ? code : undefined;
};

/** True when a request was refused because the session needs a fresh re-authentication. */
export const isReauthRequiredError = (error: unknown): boolean => apiErrorCode(error) === REAUTH_REQUIRED;

/** Confirmed, and for how long (`validForSeconds`). */
export type { ReauthResult };

/** Confirm the signed-in user's password. */
export const reauthenticateWithPassword = async (password: string): Promise<ReauthResult> =>
  parseAnswer(reauthenticatedResponseSchema, await apiPost<unknown>('/auth/reauthenticate', { password }), 're-authentication');

/** Confirm with one of the signed-in user's passkeys. */
export const reauthenticateWithPasskey = async (): Promise<ReauthResult> => {
  const options = parseAnswer(webAuthnOptionsResponseSchema, await apiPost<unknown>('/passkeys/reauthenticate/options'), 'passkey options');
  const response = await startAuthentication({ optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON });
  return parseAnswer(reauthenticatedResponseSchema, await apiPost<unknown>('/passkeys/reauthenticate/verify', { response }), 'passkey re-authentication');
};
