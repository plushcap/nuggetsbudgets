import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, truncate, unlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import tarStream, { type Header } from 'tar-stream';
import { Decrypter, Encrypter, generateHybridIdentity, generateX25519Identity, identityToRecipient } from 'age-encryption';
import {
  AGE_MAGIC,
  BackupBundleError,
  BackupWrongKeyError,
  RecipientProblem,
  SIGNED_TAIL_BYTES,
  UploadChangedError,
  assertRecipientsCompatible,
  bundleChunks,
  checkRecipient,
  checkSignedTail,
  countStanzas,
  decryptBundle,
  detectBackupFormat,
  encryptToRecipients,
  extractBundle,
  hashBundle,
  hashFile,
  parseIdentityFile,
  parseSignerId,
  readAgeHeader,
  recipientFingerprint,
  signPayload,
  signerFromDataEncryptionSecret,
  signerFromSeed,
  signerId,
  type BundleInput,
} from '../../utils/backupFormat.js';

/**
 * The age backup format (utils/backupFormat.ts): written, encrypted, decrypted with a file key
 * the way the browser hands one over, and checked before anything is parsed. Keys are made
 * here, at run time: none is committed.
 */

const signer = signerFromSeed(randomBytes(32));
let dir: string;

const file = (name: string) => path.join(dir, name);

async function keyPair(kind: 'post-quantum' | 'classic' = 'post-quantum') {
  const identity = kind === 'post-quantum' ? await generateHybridIdentity() : await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

async function input(overrides: Partial<BundleInput> = {}): Promise<BundleInput> {
  await writeFile(file('db.dump'), Buffer.concat([Buffer.from('PGDMP'), randomBytes(70_000)]));
  return {
    dumpFile: file('db.dump'),
    uploadsDir: file('uploads'),
    manifest: {
      backupId: 'nuggets_backup_20261120_012958_362',
      createdAt: '2026-11-20T01:29:58.362Z',
      appVersion: '3.1.0',
      schemaVersion: '20261113000000',
      recipients: [],
      rowCounts: { accounts: 3, schema_migrations: 2, users: 1 },
    },
    signer,
    ...overrides,
  };
}

async function collect(chunks: AsyncIterable<Buffer>, delayMs = 0): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) {
    parts.push(chunk);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return Buffer.concat(parts);
}

/** A tar's members, packed by tar-stream, without its end marker: for bundles made by hand. */
async function packed(entries: Array<{ header: Partial<Header> & { name: string }; body?: Buffer }>): Promise<Buffer> {
  const pack = tarStream.pack();
  const out = collect(pack as unknown as AsyncIterable<Buffer>);
  for (const { header, body } of entries) {
    await new Promise<void>((resolve, reject) => pack.entry(header, body ?? Buffer.alloc(0), (err) => (err ? reject(err) : resolve())));
  }
  pack.finalize();
  const bytes = await out;
  return bytes.subarray(0, bytes.length - 1024);
}

/** A manifest.json: format 4 (before the row counts) unless `extra` says otherwise. */
const manifestOf = (members: Array<{ path: string; size: number }>, extra: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      manifestVersion: 4,
      backupId: 'nuggets_backup_20261120_012958_362',
      createdAt: '2026-11-20T01:29:58.362Z',
      appVersion: '3.1.0',
      schemaVersion: null,
      recipients: [],
      members,
      ...extra,
    })
  );

async function checkAndExtract(bundle: Buffer) {
  await writeFile(file('hand.tar'), bundle);
  const hashed = await hashBundle(file('hand.tar'));
  expect(checkSignedTail(hashed, [signer.publicKey]).signature).toBe('valid');
  return extractBundle(file('hand.tar'), hashed.size - SIGNED_TAIL_BYTES, file('out'));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'backup-format-'));
  await mkdir(file('uploads/statements/2026'), { recursive: true });
  await writeFile(file('uploads/statements/2026/march.pdf'), 'march statement');
  // A path longer than ustar's 100 bytes, and one that isn't ASCII: pax records.
  await writeFile(file(`uploads/${'n'.repeat(160)}.pdf`), 'long name');
  await writeFile(file('uploads/résumé.pdf'), 'unicode name');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('a backup made, encrypted and opened with a file key', () => {
  it('round-trips, and opens only with a key it was made for', async () => {
    const a = await keyPair();
    const b = await keyPair();
    const made = await encryptToRecipients(bundleChunks(await input()), [a.recipient, b.recipient], file('backup.tar.age'));
    expect(await hashFile(file('backup.tar.age'))).toEqual(made);
    expect(await detectBackupFormat(file('backup.tar.age'))).toBe('age');

    // Nothing of the data in the clear.
    const encrypted = await readFile(file('backup.tar.age'));
    expect(encrypted.includes(Buffer.from('PGDMP'))).toBe(false);
    expect(encrypted.includes(Buffer.from('march statement'))).toBe(false);

    // The browser's half: the header, opened with the private key, gives the file key.
    const header = await readAgeHeader(file('backup.tar.age'));
    expect(header.subarray(0, AGE_MAGIC.length)).toEqual(AGE_MAGIC);
    expect(countStanzas(header)).toBe(2);
    const opener = new Decrypter();
    opener.addIdentity(b.identity);
    const fileKey = Buffer.from(await opener.decryptHeader(header));
    expect(fileKey).toHaveLength(16);

    const decrypted = await decryptBundle(file('backup.tar.age'), { fileKey }, file('backup.tar'));
    expect(await detectBackupFormat(file('backup.tar'))).toBe('tar');
    expect(checkSignedTail(decrypted, [signer.publicKey])).toEqual({ signature: 'valid', signer: signerId(signer.publicKey) });
    const manifest = await extractBundle(file('backup.tar'), decrypted.size - SIGNED_TAIL_BYTES, file('out'));
    expect(manifest.members.map((m) => m.path)).toEqual([
      'database.dump',
      `uploads/${'n'.repeat(160)}.pdf`,
      'uploads/résumé.pdf',
      'uploads/statements/2026/march.pdf',
    ]);
    // Format 5: the row counts the backup was made with.
    expect(manifest).toMatchObject({ manifestVersion: 5, rowCounts: { accounts: 3, schema_migrations: 2, users: 1 } });
    expect(await readFile(file('out/database.dump'))).toEqual(await readFile(file('db.dump')));
    expect(await readFile(file('out/uploads/statements/2026/march.pdf'), 'utf8')).toBe('march statement');
    expect(await readFile(file(`out/uploads/${'n'.repeat(160)}.pdf`), 'utf8')).toBe('long name');
    expect(await readFile(file('out/uploads/résumé.pdf'), 'utf8')).toBe('unicode name');

    // A wrong file key, a short one, and the file key of another backup.
    await expect(decryptBundle(file('backup.tar.age'), { fileKey: randomBytes(16) }, file('w1'))).rejects.toBeInstanceOf(BackupWrongKeyError);
    await expect(decryptBundle(file('backup.tar.age'), { fileKey: randomBytes(15) }, file('w2'))).rejects.toBeInstanceOf(BackupWrongKeyError);
    await encryptToRecipients(bundleChunks(await input()), [a.recipient], file('other.tar.age'));
    const otherOpener = new Decrypter();
    otherOpener.addIdentity(a.identity);
    const otherKey = Buffer.from(await otherOpener.decryptHeader(await readAgeHeader(file('other.tar.age'))));
    await expect(decryptBundle(file('backup.tar.age'), { fileKey: otherKey }, file('w3'))).rejects.toBeInstanceOf(BackupWrongKeyError);

    // A damaged header is said to be damaged, not taken for a wrong key.
    // (An unknown stanza type would be a key the file isn't for; a broken line is damage.)
    const damaged = Buffer.from(encrypted);
    damaged.write('<> ', AGE_MAGIC.length, 'latin1');
    await writeFile(file('damaged.tar.age'), damaged);
    await expect(decryptBundle(file('damaged.tar.age'), { identities: [a.identity] }, file('w6'))).rejects.toBeInstanceOf(BackupBundleError);

    // The header's MAC changed: with a private key that unwrapped the file key, damage; with a
    // file key, it can't be told from a file key for another file.
    const macAt = encrypted.indexOf(Buffer.from('\n--- ')) + 5;
    const badMac = Buffer.from(encrypted);
    badMac[macAt] = badMac[macAt] === 0x41 ? 0x42 : 0x41;
    await writeFile(file('badmac.tar.age'), badMac);
    await expect(decryptBundle(file('badmac.tar.age'), { identities: [a.identity] }, file('w7'))).rejects.toBeInstanceOf(BackupBundleError);
    await expect(decryptBundle(file('badmac.tar.age'), { fileKey }, file('w8'))).rejects.toBeInstanceOf(BackupWrongKeyError);

    // A private key: the restore command's way.
    const c = await keyPair();
    await expect(decryptBundle(file('backup.tar.age'), { identities: [c.identity] }, file('w4'))).rejects.toBeInstanceOf(BackupWrongKeyError);
    const viaIdentity = await decryptBundle(file('backup.tar.age'), { identities: [a.identity] }, file('w5'));
    expect(viaIdentity.digest).toEqual(decrypted.digest);
  }, 60_000);

  it('signs the same bytes however slowly they are read', async () => {
    const fast = await collect(bundleChunks(await input()));
    const slow = await collect(bundleChunks(await input()), 2);
    for (const bytes of [fast, slow]) {
      await writeFile(file('b.tar'), bytes);
      expect(checkSignedTail(await hashBundle(file('b.tar')), [signer.publicKey]).signature).toBe('valid');
    }
    // Through a slow disk too: the encryption pulls at its writer's pace.
    const { recipient, identity } = await keyPair('classic');
    await encryptToRecipients(
      (async function* () {
        for await (const chunk of bundleChunks(await input())) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          yield chunk;
        }
      })(),
      [recipient],
      file('slow.tar.age')
    );
    const opened = await decryptBundle(file('slow.tar.age'), { identities: [identity] }, file('slow.tar'));
    expect(checkSignedTail(opened, [signer.publicKey]).signature).toBe('valid');
  }, 60_000);

  it('a backup an outsider re-encrypted keeps its signature check: a changed byte fails it', async () => {
    const bytes = await collect(bundleChunks(await input()));
    const changed = Buffer.from(bytes);
    changed[600] = (changed[600] ?? 0) ^ 1; // inside database.dump
    await writeFile(file('changed.tar'), changed);
    expect(checkSignedTail(await hashBundle(file('changed.tar')), [signer.publicKey]).signature).toBe('invalid');
  });

  it("refuses a tail that isn't the writer's, byte for byte, before anything is parsed", async () => {
    const bytes = await collect(bundleChunks(await input()));
    const tailAt = bytes.length - SIGNED_TAIL_BYTES;
    // The prefix field of manifest.sig's header (offset 345): it would rename the member
    // uploads/manifest.sig with the signature still valid, since the tail isn't signed.
    for (const offset of [345, 0, 100, 136, 156, 265, 512 + 3, 1024, 2047]) {
      const changed = Buffer.from(bytes);
      changed[tailAt + offset] = (changed[tailAt + offset] ?? 0) ^ 0x41;
      await writeFile(file('t.tar'), changed);
      expect(() => checkSignedTail({ ...hashBundleSync(changed) }, [signer.publicKey]), `offset ${offset}`).toThrow(BackupBundleError);
    }
    // Cut short, or with bytes added after it.
    expect(() => checkSignedTail(hashBundleSync(bytes.subarray(0, bytes.length - 512)), [signer.publicKey])).toThrow(BackupBundleError);
    expect(() => checkSignedTail(hashBundleSync(Buffer.concat([bytes, Buffer.alloc(512)])), [signer.publicKey])).toThrow(BackupBundleError);
  });

  it("says whose signature it is: this server's, a trusted signer's, another's, or unchecked", async () => {
    const bytes = await collect(bundleChunks(await input()));
    const hashed = hashBundleSync(bytes);
    const other = signerFromSeed(randomBytes(32));
    expect(checkSignedTail(hashed, [signer.publicKey]).signature).toBe('valid');
    expect(checkSignedTail(hashed, [other.publicKey, signer.publicKey]).signature).toBe('valid');
    expect(checkSignedTail(hashed, [other.publicKey])).toEqual({ signature: 'invalid', signer: signerId(signer.publicKey) });
    expect(checkSignedTail(hashed, []).signature).toBe('unchecked');
    // A signer id round-trips, and nothing else parses as one.
    expect(parseSignerId(signerId(other.publicKey))).toEqual(other.publicKey);
    expect(parseSignerId(` ${signerId(other.publicKey)}\n`)).toEqual(other.publicKey);
    for (const bad of ['', 'ed25519:', `ed25519:${'A'.repeat(42)}`, other.publicKey.toString('base64url'), `ed25519:${'_'.repeat(43)}`]) {
      expect(parseSignerId(bad), bad).toBeNull();
    }
    // The data key's signer is stable, and another key's differs.
    const fromData = signerFromDataEncryptionSecret('x'.repeat(40));
    expect(signerFromDataEncryptionSecret('x'.repeat(40)).publicKey).toEqual(fromData.publicKey);
    expect(signerFromDataEncryptionSecret('y'.repeat(40)).publicKey).not.toEqual(fromData.publicKey);
  });

  it('fails a backup whose upload changes size, or goes, while it is read', async () => {
    for (const change of [
      (f: string) => appendFile(f, 'more'),
      (f: string) => truncate(f, 2),
      (f: string) => unlink(f),
    ]) {
      const chunks = bundleChunks(await input());
      // The first chunk is the dump's header: by then the uploads' sizes are taken.
      await chunks.next();
      await change(file('uploads/statements/2026/march.pdf'));
      await expect(collect(chunks)).rejects.toBeInstanceOf(UploadChangedError);
      await writeFile(file('uploads/statements/2026/march.pdf'), 'march statement');
    }
  });

  it('leaves symlinks and other non-files out of a backup', async () => {
    const { symlink } = await import('fs/promises');
    await symlink('/etc/hostname', file('uploads/link.pdf'));
    const bytes = await collect(bundleChunks(await input()));
    await writeFile(file('b.tar'), bytes);
    const hashed = await hashBundle(file('b.tar'));
    const manifest = await extractBundle(file('b.tar'), hashed.size - SIGNED_TAIL_BYTES, file('out'));
    expect(manifest.members.map((m) => m.path)).not.toContain('uploads/link.pdf');
  });
});

/** hashBundle for bytes in memory. */
function hashBundleSync(bytes: Buffer) {
  const tailAt = Math.max(0, bytes.length - SIGNED_TAIL_BYTES);
  return { digest: createHash('sha256').update(bytes.subarray(0, tailAt)).digest(), tail: bytes.subarray(tailAt), size: bytes.length };
}

describe('a bundle whose signature checks is still parsed with care', () => {
  const dump = Buffer.from('PGDMP-test');
  const file0 = (name: string, body: Buffer) => ({ header: { name, type: 'file' as const, size: body.length, mode: 0o644 }, body });

  it('accepts exactly the members its manifest lists', async () => {
    const members = [{ path: 'database.dump', size: dump.length }, { path: 'uploads/a.pdf', size: 3 }];
    const manifest = await checkAndExtract(
      signPayload(await packed([file0('database.dump', dump), file0('uploads/a.pdf', Buffer.from('abc')), file0('manifest.json', manifestOf(members))]), signer)
    );
    expect(manifest.members).toEqual(members);
    expect((await readdir(file('out'))).sort()).toEqual(['database.dump', 'uploads']);
  });

  it.each([
    ['a member missing from the manifest', [{ path: 'database.dump', size: 10 }]],
    ['one the manifest lists that is not there', [{ path: 'database.dump', size: 10 }, { path: 'uploads/a.pdf', size: 3 }, { path: 'uploads/b.pdf', size: 1 }]],
    ['one of another size', [{ path: 'database.dump', size: 10 }, { path: 'uploads/a.pdf', size: 4 }]],
  ])('refuses %s', async (_what, members) => {
    const bundle = signPayload(
      await packed([file0('database.dump', dump), file0('uploads/a.pdf', Buffer.from('abc')), file0('manifest.json', manifestOf(members))]),
      signer
    );
    await expect(checkAndExtract(bundle)).rejects.toThrow(/entries and its manifest differ/);
  });

  it.each([
    ['a symlink', { name: 'uploads/link', type: 'symlink' as const, linkname: '/etc/passwd' }],
    ['a hard link', { name: 'uploads/hard', type: 'link' as const, linkname: 'database.dump' }],
    ['a directory', { name: 'uploads/dir/', type: 'directory' as const }],
    ['a path out of the bundle', { name: '../escape.pdf', type: 'file' as const }],
    ['a path out of uploads', { name: 'uploads/../../escape.pdf', type: 'file' as const }],
    ['an absolute path', { name: '/etc/cron.d/x', type: 'file' as const }],
    ['a backslash', { name: 'uploads/a\\..\\b', type: 'file' as const }],
    ['a member not of a backup', { name: 'other.txt', type: 'file' as const }],
    ['manifest.json twice', { name: 'manifest.json', type: 'file' as const }],
  ])('refuses %s', async (_what, header) => {
    const bundle = signPayload(
      await packed([file0('database.dump', dump), { header: { size: 0, ...header } }, file0('manifest.json', manifestOf([{ path: 'database.dump', size: dump.length }]))]),
      signer
    );
    await expect(checkAndExtract(bundle)).rejects.toBeInstanceOf(BackupBundleError);
    await expect(readFile(path.join(dir, '..', 'escape.pdf'))).rejects.toThrow();
  });

  it('reads the row counts of a format-5 manifest, and a format-4 one without them', async () => {
    const members = [{ path: 'database.dump', size: dump.length }];
    const v5 = await checkAndExtract(
      signPayload(await packed([file0('database.dump', dump), file0('manifest.json', manifestOf(members, { manifestVersion: 5, rowCounts: { users: 2, accounts: 0 } }))]), signer)
    );
    expect(v5).toMatchObject({ manifestVersion: 5, rowCounts: { users: 2, accounts: 0 } });
    await rm(file('out'), { recursive: true, force: true });
    const v4 = await checkAndExtract(signPayload(await packed([file0('database.dump', dump), file0('manifest.json', manifestOf(members))]), signer));
    expect(v4.manifestVersion).toBe(4);
    expect('rowCounts' in v4).toBe(false);
  });

  it.each([
    ['format 5 without its row counts', { manifestVersion: 5 }],
    ['format 4 with row counts (a field it never had)', { rowCounts: { users: 1 } }],
    ['a count that is not a whole number of rows', { manifestVersion: 5, rowCounts: { users: 1.5 } }],
    ['a negative count', { manifestVersion: 5, rowCounts: { users: -1 } }],
    ['a format after 5', { manifestVersion: 6, rowCounts: {} }],
  ])('refuses a manifest with %s', async (_what, extra) => {
    const members = [{ path: 'database.dump', size: dump.length }];
    await expect(
      checkAndExtract(signPayload(await packed([file0('database.dump', dump), file0('manifest.json', manifestOf(members, extra))]), signer))
    ).rejects.toThrow(/format-4 or format-5 manifest/);
  });

  it('refuses a member after the manifest, and a manifest that is not format 4 or 5', async () => {
    const members = [{ path: 'database.dump', size: dump.length }];
    await expect(
      checkAndExtract(signPayload(await packed([file0('database.dump', dump), file0('manifest.json', manifestOf(members)), file0('uploads/late.pdf', Buffer.from('x'))]), signer))
    ).rejects.toThrow(/after manifest.json/);
    await rm(file('out'), { recursive: true, force: true });
    await expect(
      checkAndExtract(signPayload(await packed([file0('database.dump', dump), file0('manifest.json', Buffer.from('{"manifestVersion":1}'))]), signer))
    ).rejects.toThrow(/format-4 or format-5 manifest/);
  });
});

describe('keys', () => {
  it('checks a public key, and never repeats a mistyped one', async () => {
    const pq = (await keyPair()).recipient;
    const classic = (await keyPair('classic')).recipient;
    expect(pq).toHaveLength(1959);
    expect(checkRecipient(pq)).toBe('post-quantum');
    expect(checkRecipient(classic)).toBe('classic');
    const typo = pq.slice(0, 500) + (pq[500] === 'q' ? 'p' : 'q') + pq.slice(501);
    for (const bad of [typo, pq.slice(0, -1), classic.slice(0, 30), 'age1yubikey1qwerty', 'ssh-ed25519 AAAA', '']) {
      try {
        checkRecipient(bad);
        expect.unreachable(bad.slice(0, 20));
      } catch (error) {
        expect(error).toBeInstanceOf(RecipientProblem);
        if (bad.length > 8) expect((error as Error).message).not.toContain(bad.slice(4, 30));
      }
    }
    expect(recipientFingerprint(pq)).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
  });

  it('refuses a mix of post-quantum and classic keys, on entry and when it encrypts', async () => {
    const pq = (await keyPair()).recipient;
    const classic = (await keyPair('classic')).recipient;
    expect(() => assertRecipientsCompatible([pq, classic])).toThrow(/Post-quantum and classic/);
    expect(() => assertRecipientsCompatible([])).toThrow(RecipientProblem);
    await expect(encryptToRecipients(bundleChunks(await input()), [classic, pq], file('mixed.tar.age'))).rejects.toThrow(/Post-quantum and classic/);
    // The library itself would have taken them.
    const encrypter = new Encrypter();
    encrypter.addRecipient(pq);
    encrypter.addRecipient(classic);
    await expect(encrypter.encrypt('x')).resolves.toBeInstanceOf(Uint8Array);
  });

  it('reads an identity file as age-keygen writes it, and never repeats a mistyped key', async () => {
    const { identity, recipient } = await keyPair();
    const text = `# created: 2026-11-13T12:00:00Z\n# public key: ${recipient}\n${identity}\n`;
    expect(parseIdentityFile(text)).toEqual([identity]);
    expect(parseIdentityFile(text.replace(/\n/g, '\r\n'))).toEqual([identity]);
    const typo = identity.slice(0, 40) + (identity[40] === 'Q' ? 'P' : 'Q') + identity.slice(41);
    for (const bad of [`${typo}\n`, '# only a comment\n', 'AGE-SECRET-KEY-1\n']) {
      try {
        parseIdentityFile(bad);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(BackupWrongKeyError);
        expect((error as Error).message).not.toMatch(/AGE-SECRET-KEY-(PQ-)?1[A-Z0-9]{10}/);
      }
    }
  });
});
