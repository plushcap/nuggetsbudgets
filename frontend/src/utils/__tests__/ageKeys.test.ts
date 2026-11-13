import { describe, it, expect } from 'vitest';
import { generateHybridIdentity, generateX25519Identity } from 'age-encryption';
import { BackupKeyProblem, identitiesFromPasted, keyFileName } from '../ageKeys';

/** Reading pasted private keys (utils/ageKeys.ts): keys made at run time, never committed. */
describe('identitiesFromPasted', () => {
  it('finds each key, however it was pasted', async () => {
    const pq = await generateHybridIdentity();
    const classic = await generateX25519Identity();
    expect(identitiesFromPasted(pq)).toEqual([pq]);
    // A whole key file in a one-line field, two keys run together, a key followed by capitals.
    expect(identitiesFromPasted(`# created: 2026-11-13T12:00:00Z # public key: age1pq1xyz ${pq}`)).toEqual([pq]);
    expect(identitiesFromPasted(`${pq}${classic}`)).toEqual([pq, classic]);
    expect(identitiesFromPasted(`${classic}NOTES`)).toEqual([classic]);
  });

  it('refuses text with no key, and a key cut short, without repeating it', async () => {
    const pq = await generateHybridIdentity();
    for (const text of ['', 'hello', pq.slice(0, -3)]) {
      try {
        identitiesFromPasted(text);
        expect.unreachable(text);
      } catch (error) {
        expect(error).toBeInstanceOf(BackupKeyProblem);
        expect((error as Error).message).not.toContain(pq.slice(20, 40));
      }
    }
  });
});

describe('keyFileName', () => {
  it('names the file after the key', () => {
    expect(keyFileName('Password manager')).toBe('nuggets-backup-key-password-manager.txt');
    expect(keyFileName('***')).toBe('nuggets-backup-key.txt');
  });
});
