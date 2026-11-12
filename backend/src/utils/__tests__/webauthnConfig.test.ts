import { describe, it, expect } from 'vitest';
import { resolveWebAuthnConfig, WebAuthnConfigError } from '../webauthnConfig.js';

/**
 * Passkeys bind to the host Nuggets is served at. The shipped compose files used
 * to default it to the author's own domain, so a deployment that didn't override it got
 * passkeys that could never be enrolled.
 */
describe('resolveWebAuthnConfig', () => {
  it('takes the RP ID and origin from DOMAIN_URL', () => {
    expect(resolveWebAuthnConfig({ NODE_ENV: 'production', DOMAIN_URL: 'https://app.example.com/' })).toEqual({
      rpName: 'Nuggets',
      rpID: 'app.example.com',
      origin: 'https://app.example.com',
      userVerification: 'required',
    });
  });

  // A passkey stands in for the password, so by default it must verify the user.
  it('requires user verification unless WEBAUTHN_USER_VERIFICATION=preferred', () => {
    const env = { NODE_ENV: 'production', DOMAIN_URL: 'https://app.example.com' };
    expect(resolveWebAuthnConfig(env).userVerification).toBe('required');
    expect(resolveWebAuthnConfig({ ...env, WEBAUTHN_USER_VERIFICATION: 'Preferred' }).userVerification).toBe('preferred');
    expect(() => resolveWebAuthnConfig({ ...env, WEBAUTHN_USER_VERIFICATION: 'discouraged' })).toThrow(WebAuthnConfigError);
  });

  it('prefers WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN, and treats empty ones as unset', () => {
    const env = { NODE_ENV: 'production', DOMAIN_URL: 'https://app.example.com', WEBAUTHN_RP_ID: 'example.com', WEBAUTHN_ORIGIN: 'https://example.com/' };
    expect(resolveWebAuthnConfig(env)).toMatchObject({ rpID: 'example.com', origin: 'https://example.com' });
    expect(resolveWebAuthnConfig({ ...env, WEBAUTHN_RP_ID: '', WEBAUTHN_ORIGIN: '' })).toMatchObject({
      rpID: 'app.example.com',
      origin: 'https://app.example.com',
    });
  });

  it('refuses to guess in production', () => {
    expect(() => resolveWebAuthnConfig({ NODE_ENV: 'production' })).toThrow(WebAuthnConfigError);
    expect(() => resolveWebAuthnConfig({ NODE_ENV: 'production', DOMAIN_URL: 'not a url' })).toThrow(WebAuthnConfigError);
  });

  it('falls back to the dev server outside production', () => {
    expect(resolveWebAuthnConfig({ NODE_ENV: 'development' })).toMatchObject({ rpID: 'localhost', origin: 'http://localhost:3000' });
  });
});
