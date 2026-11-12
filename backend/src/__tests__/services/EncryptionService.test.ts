import { describe, it, expect, vi } from 'vitest';

/**
 * Unit tests for EncryptionService.encryptString/decryptString — the at-rest
 * protection for the org SimpleFin access URL. The key normally
 * comes from the data_encryption_key Docker secret; here we mock the secret
 * read so the tests are hermetic.
 */

// A fixed 32-char key (the service requires exactly 32 chars).
const TEST_KEY = 'abcdefghijklmnopqrstuvwxyz012345';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => (String(p).includes('data_encryption_key') ? TEST_KEY : '')),
}));

const { EncryptionService } = await import('../../services/EncryptionService.js');

describe('EncryptionService string credential encryption', () => {
  const sampleAccessUrl = 'https://user:s3cr3t-token@bridge.simplefin.org/simplefin'; // gitleaks:allow (made-up)

  it('round-trips an access URL through encrypt/decrypt', async () => {
    const svc = new EncryptionService();
    const cipher = await svc.encryptString(sampleAccessUrl);
    expect(cipher).not.toContain(sampleAccessUrl);
    expect(cipher).not.toContain('s3cr3t-token');
    const plain = await svc.decryptString(cipher);
    expect(plain).toBe(sampleAccessUrl);
  });

  it('produces a base64 envelope distinct per call (random IV)', async () => {
    const svc = new EncryptionService();
    const a = await svc.encryptString(sampleAccessUrl);
    const b = await svc.encryptString(sampleAccessUrl);
    expect(a).not.toBe(b); // random IV → different ciphertext
    expect(Buffer.from(a, 'base64').toString('base64')).toBe(a); // valid base64
    // both still decrypt to the same plaintext
    expect(await svc.decryptString(a)).toBe(sampleAccessUrl);
    expect(await svc.decryptString(b)).toBe(sampleAccessUrl);
  });

  it('fails to decrypt tampered ciphertext (GCM auth)', async () => {
    const svc = new EncryptionService();
    const cipher = await svc.encryptString(sampleAccessUrl);
    const bytes = Buffer.from(cipher, 'base64');
    bytes[bytes.length - 1] ^= 0xff; // flip a ciphertext byte
    await expect(svc.decryptString(bytes.toString('base64'))).rejects.toThrow();
  });
});
