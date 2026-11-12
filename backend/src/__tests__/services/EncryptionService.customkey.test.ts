import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { EncryptionService } from '../../services/EncryptionService.js';

/**
 * Round-trip tests for the custom-key (backup key K) file encryption. These use
 * the custom-key path only — which derives from the supplied key, not the Docker
 * secret — so they need no Docker secret and run anywhere.
 */
describe('EncryptionService custom-key file encryption', () => {
  const svc = new EncryptionService();
  // A realistic 44-char base64 key (32 bytes), like `openssl rand -base64 32`.
  const KEY = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU='; // gitleaks:allow (made-up)
  let dir: string;
  const payload = Buffer.from('the quick brown fox — backup contents 🦊', 'utf8');

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuggets-enc-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('encrypts with a key and decrypts with the same key', async () => {
    const input = path.join(dir, 'in.bin');
    const enc = path.join(dir, 'a.enc');
    const out = path.join(dir, 'out.bin');
    await fs.writeFile(input, payload);

    await svc.encryptFileWithCustomKey(input, enc, KEY);
    await svc.decryptFileWithCustomKey(enc, out, KEY);

    expect(await fs.readFile(out)).toEqual(payload);
  });

  it('tolerates surrounding whitespace on the key (the pasted-newline case)', async () => {
    const input = path.join(dir, 'in2.bin');
    const enc = path.join(dir, 'b.enc');
    const out = path.join(dir, 'out2.bin');
    await fs.writeFile(input, payload);

    // Encrypt with a clean key, decrypt with the "same" key wrapped in whitespace.
    await svc.encryptFileWithCustomKey(input, enc, KEY);
    await svc.decryptFileWithCustomKey(enc, out, `  ${KEY}\n`);

    expect(await fs.readFile(out)).toEqual(payload);
  });

  it('fails with a clear error on the wrong key', async () => {
    const input = path.join(dir, 'in3.bin');
    const enc = path.join(dir, 'c.enc');
    const out = path.join(dir, 'out3.bin');
    await fs.writeFile(input, payload);

    await svc.encryptFileWithCustomKey(input, enc, KEY);
    const wrong = 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ=';
    await expect(svc.decryptFileWithCustomKey(enc, out, wrong)).rejects.toThrow(/Invalid encryption key/i);
  });

  it('rejects a too-short key', async () => {
    const enc = path.join(dir, 'a.enc');
    const out = path.join(dir, 'out4.bin');
    await expect(svc.decryptFileWithCustomKey(enc, out, 'short')).rejects.toThrow(/at least 32 characters/i);
  });
});
