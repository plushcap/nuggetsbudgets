/**
 * The ways a passkey says it can be reached: WebAuthn Level 3's
 * AuthenticatorTransport values, and `cable`, the name Chrome reported for `hybrid` before
 * it was standardized (simplewebauthn's own list carried it until v13). @simplewebauthn/server
 * 14 types a stored credential's transports as any string, and its `AuthenticatorTransport`
 * is TypeScript's DOM list, which lacks `smart-card` and `cable`; so this list is the app's.
 *
 * A registration response's transports aren't signed: a browser, or anyone posting to
 * /passkeys/register/verify, can send any strings. Only these are stored, and only these
 * are read back (a row saved before, or written another way, may hold others), so the
 * options a sign-in sends list nothing else. A transport is only a hint: a browser given
 * none tries every way it has, so one dropped here costs at most a less direct prompt.
 */
export const KNOWN_TRANSPORTS = ['usb', 'nfc', 'ble', 'smart-card', 'hybrid', 'internal', 'cable'] as const;
export type KnownTransport = (typeof KNOWN_TRANSPORTS)[number];

const KNOWN: ReadonlySet<unknown> = new Set(KNOWN_TRANSPORTS);

export function isKnownTransport(value: unknown): value is KnownTransport {
  return KNOWN.has(value);
}

/** The known transports in `values`, each once, in the order they came. */
export function knownTransports(values: readonly unknown[]): KnownTransport[] {
  const known: KnownTransport[] = [];
  for (const value of values) {
    if (isKnownTransport(value) && !known.includes(value)) known.push(value);
  }
  return known;
}
