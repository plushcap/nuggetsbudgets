import * as crypto from 'crypto';

/**
 * Versioned authenticated-encryption envelope.
 *
 * One implementation shared by every at-rest consumer (backup files, the
 * SimpleFin access URL, OneDrive tokens) so key handling and the wire format
 * live in exactly one place.
 *
 * Format (v2), bytes:
 *   [0]            version = 0x02
 *   [1 .. 13)      12-byte GCM nonce (standard length)
 *   [13 .. 29)     16-byte GCM auth tag
 *   [29 ..]        ciphertext
 *
 * Key handling: the on-disk secret is a 32-character string. Rather than use
 * those ASCII bytes directly as the AES-256 key (≤192 bits of real entropy),
 * we derive a full 32-byte key with HKDF-SHA256 — and derive a *distinct* key
 * per purpose by feeding the domain into HKDF's `info` (`backup`, `credential`,
 * `onedrive`). The three consumers therefore share no key material: a flaw in
 * one domain's handling can't expose another's key. The matching AAD is also
 * bound at seal/open time as belt-and-suspenders so a ciphertext from one
 * domain can't be opened as another even by mistake.
 *
 * There is intentionally NO backward-compatibility path: values written by the
 * previous scheme (raw-key AES-256-GCM with a 16-byte IV, or the legacy
 * OneDrive AES-256-CBC) do not carry the version byte and fail to open with a
 * clear "unsupported version" error. Re-establish those values (take a fresh
 * backup, re-enter the SimpleFin access URL, reconnect OneDrive).
 */

const VERSION = 0x02;
/**
 * v3 is v2 with a key-id byte after the version:
 *   [0] 0x03   [1] key id   [2 .. 14) nonce   [14 .. 30) tag   [30 ..] ciphertext
 * The key id says which `data_encryption_key` sealed the value ({@link keyIdOf}), so
 * a value sealed under another key is told apart from a damaged one, and the
 * rewrap-secrets script (scripts/rewrap-secrets.ts) knows which values still need the
 * old key. The two header bytes are authenticated with the AAD. Stored credentials are
 * written as v3; backup files stay v2 (their key is the backup key K, not this one), and
 * v2 values still open.
 */
const VERSION_WITH_KEY_ID = 0x03;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 1 + NONCE_LEN + TAG_LEN;
const HEADER_LEN_V3 = 2 + NONCE_LEN + TAG_LEN;
const ALGORITHM = 'aes-256-gcm';

// Fixed, app-specific HKDF parameters. The secret is already high-entropy, so
// a constant salt is fine here — this is key expansion / domain separation,
// not password stretching. The per-purpose domain is appended to the info.
const HKDF_SALT = Buffer.from('nuggets-encryption-hkdf-salt-v2');
const HKDF_INFO_PREFIX = 'nuggets-encryption-v2:';

/**
 * Per-purpose key-derivation domains. Each yields a distinct key: AES keys for
 * the envelopes, `unsubscribe` the HMAC key that signs notification unsubscribe
 * links, and `backupSignature` the HMAC key a server signs its own backups with
 * (derived from the data encryption secret, never from a backup key).
 */
export const DOMAIN = {
  backup: 'backup',
  credential: 'credential',
  onedrive: 'onedrive',
  unsubscribe: 'unsubscribe',
  backupSignature: 'backup-signature',
} as const;

export type Domain = (typeof DOMAIN)[keyof typeof DOMAIN];

/**
 * Derive a purpose-specific 32-byte AES-256 key from the secret material via
 * HKDF-SHA256, binding the `domain` into the HKDF info so each purpose gets an
 * independent key. Accepts the 32-character secret string (or raw bytes);
 * length validation is left to callers, which already enforce their own rules.
 */
export function deriveKey(secret: string | Buffer, domain: Domain): Buffer {
  const ikm = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
  const info = Buffer.from(HKDF_INFO_PREFIX + domain);
  return Buffer.from(crypto.hkdfSync('sha256', ikm, HKDF_SALT, info, 32));
}

/**
 * The one-byte id of a data-encryption secret: the first byte of an HKDF output of its
 * own, so it says nothing about the keys. Two secrets share an id one time in 256, so
 * it's a hint about which key sealed a value; the GCM tag is what decides.
 */
export function keyIdOf(secret: string | Buffer): number {
  const ikm = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
  return Buffer.from(crypto.hkdfSync('sha256', ikm, HKDF_SALT, Buffer.from(`${HKDF_INFO_PREFIX}key-id`), 1)).readUInt8(0);
}

/**
 * Encrypt `plaintext` into a versioned envelope, authenticating `aad`. With a `keyId`
 * (see {@link keyIdOf}) the envelope is v3 and carries it; without, v2.
 */
export function seal(key: Buffer, plaintext: Buffer, aad: Buffer, keyId?: number): Buffer {
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce) as crypto.CipherGCM;
  const header = keyId === undefined ? Buffer.from([VERSION]) : Buffer.from([VERSION_WITH_KEY_ID, keyId & 0xff]);
  cipher.setAAD(keyId === undefined ? aad : Buffer.concat([aad, header]));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([header, nonce, tag, ciphertext]);
}

/** The key id a v3 envelope carries, or null for a v2 one (or anything else). */
export function envelopeKeyId(envelope: Buffer): number | null {
  return envelope.length >= HEADER_LEN_V3 && envelope[0] === VERSION_WITH_KEY_ID ? envelope.readUInt8(1) : null;
}

/**
 * Decrypt a v2 or v3 envelope, verifying `aad`. Throws on an unknown version (data
 * predates the v2 scheme), a truncated envelope, or a failed auth check (the wrong key,
 * or a changed value).
 */
export function open(key: Buffer, envelope: Buffer, aad: Buffer): Buffer {
  const version = envelope[0] ?? 0; // none: an empty envelope fails the length check below
  const headerLen = version === VERSION_WITH_KEY_ID ? HEADER_LEN_V3 : HEADER_LEN;
  if (envelope.length < headerLen) {
    throw new Error('Ciphertext is too short or not in the expected v2 envelope format');
  }
  if (version !== VERSION && version !== VERSION_WITH_KEY_ID) {
    throw new Error(
      `Unsupported ciphertext version 0x${version.toString(16).padStart(2, '0')} ` +
        `(expected 0x${VERSION.toString(16).padStart(2, '0')}); this value predates the ` +
        'v2 encryption scheme and cannot be decrypted — re-create it (fresh backup, ' +
        're-enter the SimpleFin URL, or reconnect OneDrive)'
    );
  }
  const start = headerLen - NONCE_LEN - TAG_LEN;
  const nonce = envelope.subarray(start, start + NONCE_LEN);
  const tag = envelope.subarray(start + NONCE_LEN, headerLen);
  const ciphertext = envelope.subarray(headerLen);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce) as crypto.DecipherGCM;
  decipher.setAAD(version === VERSION_WITH_KEY_ID ? Buffer.concat([aad, envelope.subarray(0, 2)]) : aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** AAD domain separators — one per at-rest consumer. */
export const AAD = {
  backup: Buffer.from('nuggets-backup'),
  credential: Buffer.from('nuggets-credential'),
  onedrive: Buffer.from('nuggets-onedrive'),
} as const;
