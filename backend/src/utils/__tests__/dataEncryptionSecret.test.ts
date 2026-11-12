import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Where the data encryption key is read from: DATA_ENCRYPTION_KEY_FILE when it is set,
 * then the data_encryption_key Docker secret, and nowhere else. The secret's name before
 * that, backup_encryption_key, was read as a fallback until 3.0.0; a deployment that still
 * mounts only that one has no key now. The files are in memory, so whatever this machine
 * has under /run/secrets doesn't answer.
 */
const files = vi.hoisted(() => new Map<string, string>());

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync: (path: string) => files.has(path),
  readFileSync: (path: string) => {
    const content = files.get(path);
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return content;
  },
}));
vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs/promises')>()),
  readFile: async (path: string) => {
    const content = files.get(path);
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return content;
  },
}));

const { DATA_ENCRYPTION_SECRET_PATH, readDataEncryptionSecret, readDataEncryptionSecretSync } = await import(
  '../data-encryption-secret.js'
);

const KEY = 'a-data-encryption-key-of-at-least-32-characters';
const OTHER = 'another-data-encryption-key-of-32-characters-or-more';

describe('the data encryption key', () => {
  beforeEach(() => {
    files.clear();
    vi.unstubAllEnvs();
  });

  it('is the data_encryption_key secret', async () => {
    expect(DATA_ENCRYPTION_SECRET_PATH).toBe('/run/secrets/data_encryption_key');
    files.set(DATA_ENCRYPTION_SECRET_PATH, `${KEY}\n`);
    expect(readDataEncryptionSecretSync()).toBe(KEY);
    await expect(readDataEncryptionSecret()).resolves.toBe(KEY);
  });

  it('is never read from the backup_encryption_key secret, its old name', async () => {
    files.set('/run/secrets/backup_encryption_key', KEY);
    const missing = 'no data encryption secret found (looked in: /run/secrets/data_encryption_key)';
    expect(() => readDataEncryptionSecretSync()).toThrow(missing);
    await expect(readDataEncryptionSecret()).rejects.toThrow(missing);
    // Beside the current one, the old one changes nothing.
    files.set(DATA_ENCRYPTION_SECRET_PATH, OTHER);
    expect(readDataEncryptionSecretSync()).toBe(OTHER);
  });

  it('comes from DATA_ENCRYPTION_KEY_FILE first, then the secret', async () => {
    vi.stubEnv('DATA_ENCRYPTION_KEY_FILE', '/elsewhere/data_encryption_key.txt');
    files.set(DATA_ENCRYPTION_SECRET_PATH, OTHER);
    expect(readDataEncryptionSecretSync()).toBe(OTHER);
    files.set('/elsewhere/data_encryption_key.txt', KEY);
    expect(readDataEncryptionSecretSync()).toBe(KEY);
    await expect(readDataEncryptionSecret()).resolves.toBe(KEY);
    files.clear();
    expect(() => readDataEncryptionSecretSync()).toThrow(
      'no data encryption secret found (looked in: /elsewhere/data_encryption_key.txt, /run/secrets/data_encryption_key)'
    );
  });

  it('is refused when it is shorter than 32 characters', () => {
    files.set(DATA_ENCRYPTION_SECRET_PATH, 'too-short');
    expect(() => readDataEncryptionSecretSync()).toThrow('Docker secret must be at least 32 characters (found 9)');
  });
});
