/**
 * Where passkeys are bound (WebAuthn's relying party), and how strict they are.
 *
 * A passkey works only on the host it was enrolled on (the RP ID), and the browser
 * reports the origin it was used from, which has to match. Both come from
 * WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN, or else from DOMAIN_URL, the address the app is
 * served at, so a deployment that sets only DOMAIN_URL gets passkeys for its own host.
 *
 * Production refuses to start when neither is set, rather than binding passkeys to
 * localhost (where enrolling one fails with a confusing browser error). Development
 * falls back to the Vite dev server, http://localhost:3000.
 *
 * Changing the RP ID later strands every passkey enrolled under the old one.
 *
 * User verification: a passkey replaces the password here, so by
 * default it must prove the user too (a fingerprint, face, device PIN or security-key
 * PIN), not only that someone holds the device: WEBAUTHN_USER_VERIFICATION=required. A
 * deployment with security keys that have no PIN can set `preferred`, which accepts them
 * without it, as before.
 */

import { config, configProblems, loadConfig } from '../config.js';

export type UserVerification = 'required' | 'preferred';

export interface WebAuthnConfig {
  rpName: string;
  rpID: string;
  origin: string;
  userVerification: UserVerification;
}

export class WebAuthnConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebAuthnConfigError';
  }
}

export function resolveWebAuthnConfig(env: NodeJS.ProcessEnv = process.env): WebAuthnConfig {
  // The settings are parsed in config.ts; an unusable user verification is refused here
  // too, so a passkey is never enrolled under a value nobody chose.
  const { config: settings, problems } =
    env === process.env ? { config: config(), problems: configProblems() } : loadConfig(env);
  const badVerification = problems.find((p) => p.startsWith('WEBAUTHN_USER_VERIFICATION '));
  if (badVerification) throw new WebAuthnConfigError(badVerification);
  const rpName = settings.WEBAUTHN_RP_NAME;
  const userVerification: UserVerification = settings.WEBAUTHN_USER_VERIFICATION;
  let domain: URL | undefined;
  if (settings.DOMAIN_URL?.trim()) {
    try {
      domain = new URL(settings.DOMAIN_URL.trim());
    } catch {
      throw new WebAuthnConfigError(`DOMAIN_URL is not a URL: ${settings.DOMAIN_URL}`);
    }
  }

  const rpID = settings.WEBAUTHN_RP_ID || domain?.hostname;
  const origin = settings.WEBAUTHN_ORIGIN || domain?.origin;
  if (rpID && origin) return { rpName, rpID, origin, userVerification };

  if (settings.NODE_ENV === 'production') {
    throw new WebAuthnConfigError(
      'Set DOMAIN_URL (or WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN) to the address Nuggets is served at; passkeys are bound to it'
    );
  }
  return { rpName, rpID: rpID || 'localhost', origin: origin || 'http://localhost:3000', userVerification };
}
