import { describe, it, expect } from 'vitest';
import { deriveKey, seal, open, envelopeKeyId, keyIdOf, AAD, DOMAIN } from '../../utils/crypto-envelope.js';

/**
 * Unit tests for the shared v2 authenticated-encryption envelope:
 * HKDF per-domain key derivation, versioned GCM format, AAD domain separation,
 * and the deliberate lack of a backward-compatibility path for pre-v2 data.
 */

const SECRET = 'abcdefghijklmnopqrstuvwxyz012345'; // 32 chars, as on disk

describe('crypto-envelope', () => {
  const key = deriveKey(SECRET, DOMAIN.credential);
  const plaintext = Buffer.from('https://user:s3cr3t-token@bridge.simplefin.org/simplefin', 'utf8'); // gitleaks:allow (made-up)

  it('derives a stable 32-byte AES key from the same secret + domain', () => {
    const a = deriveKey(SECRET, DOMAIN.credential);
    const b = deriveKey(SECRET, DOMAIN.credential);
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(true);
  });

  it('derives a distinct key per domain from the same secret', () => {
    const backup = deriveKey(SECRET, DOMAIN.backup);
    const credential = deriveKey(SECRET, DOMAIN.credential);
    const onedrive = deriveKey(SECRET, DOMAIN.onedrive);
    expect(backup.equals(credential)).toBe(false);
    expect(backup.equals(onedrive)).toBe(false);
    expect(credential.equals(onedrive)).toBe(false);
  });

  it('cannot open a backup-domain envelope with the credential-domain key', () => {
    const env = seal(deriveKey(SECRET, DOMAIN.backup), plaintext, AAD.backup);
    expect(() => open(deriveKey(SECRET, DOMAIN.credential), env, AAD.backup)).toThrow();
  });

  it('does not use the raw secret bytes as the key (HKDF is applied)', () => {
    // The old scheme used the 32 ASCII bytes directly; the new key must differ.
    expect(key.equals(Buffer.from(SECRET, 'utf8'))).toBe(false);
  });

  it('round-trips plaintext through seal/open', () => {
    const env = seal(key, plaintext, AAD.credential);
    expect(open(key, env, AAD.credential).equals(plaintext)).toBe(true);
  });

  it('emits the v2 version byte and a 12-byte nonce + 16-byte tag header', () => {
    const env = seal(key, plaintext, AAD.credential);
    expect(env[0]).toBe(0x02);
    // header (29) + at least one ciphertext byte
    expect(env.length).toBeGreaterThan(29);
  });

  it('produces a distinct envelope per call (random nonce)', () => {
    const a = seal(key, plaintext, AAD.credential);
    const b = seal(key, plaintext, AAD.credential);
    expect(a.equals(b)).toBe(false);
  });

  it('rejects a tampered ciphertext (GCM auth)', () => {
    const env = seal(key, plaintext, AAD.credential);
    env[env.length - 1] ^= 0xff;
    expect(() => open(key, env, AAD.credential)).toThrow();
  });

  it('rejects opening under a different AAD domain', () => {
    const env = seal(key, plaintext, AAD.backup);
    expect(() => open(key, env, AAD.credential)).toThrow();
  });

  it('rejects opening with a key derived from a different secret', () => {
    const env = seal(key, plaintext, AAD.credential);
    const otherKey = deriveKey('ZYXWVUTSRQPONMLKJIHGFEDCBA987654', DOMAIN.credential);
    expect(() => open(otherKey, env, AAD.credential)).toThrow();
  });

  it('rejects pre-v2 data with an unsupported-version error', () => {
    // Simulate an old envelope: 16-byte IV + 16-byte tag + ciphertext, no
    // version byte. Its first byte is whatever the random IV happened to be;
    // force a non-0x02 value to exercise the version guard deterministically.
    const legacy = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(40, 7)]);
    expect(() => open(key, legacy, AAD.credential)).toThrow(/[Uu]nsupported/);
  });

  it('rejects a truncated envelope', () => {
    expect(() => open(key, Buffer.from([0x02, 0x00, 0x00]), AAD.credential)).toThrow();
  });

  describe('v3: the key id', () => {
    const keyId = keyIdOf(SECRET);

    it('carries the key id after the version byte, and opens', () => {
      const env = seal(key, plaintext, AAD.credential, keyId);
      expect(env[0]).toBe(0x03);
      expect(env[1]).toBe(keyId);
      expect(env.length).toBe(2 + 12 + 16 + plaintext.length);
      expect(envelopeKeyId(env)).toBe(keyId);
      expect(open(key, env, AAD.credential).equals(plaintext)).toBe(true);
    });

    it('authenticates the key id: a changed one does not open', () => {
      const env = seal(key, plaintext, AAD.credential, keyId);
      env[1] ^= 0xff;
      expect(() => open(key, env, AAD.credential)).toThrow();
    });

    it('still opens a v2 value, which has no key id', () => {
      const v2 = seal(key, plaintext, AAD.credential);
      expect(v2[0]).toBe(0x02);
      expect(envelopeKeyId(v2)).toBeNull();
      expect(open(key, v2, AAD.credential).equals(plaintext)).toBe(true);
    });

    it('gives each secret a stable one-byte id', () => {
      expect(keyIdOf(SECRET)).toBe(keyId);
      expect(keyId).toBeGreaterThanOrEqual(0);
      expect(keyId).toBeLessThan(256);
      const ids = new Set(Array.from({ length: 64 }, (_, i) => keyIdOf(`${SECRET}-${i}`)));
      expect(ids.size).toBeGreaterThan(40);
    });
  });
});
