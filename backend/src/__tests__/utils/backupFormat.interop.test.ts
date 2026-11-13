import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  SIGNED_TAIL_BYTES,
  bundleChunks,
  checkSignedTail,
  decryptBundle,
  encryptToRecipients,
  extractBundle,
  signerFromSeed,
} from '../../utils/backupFormat.js';

/**
 * A backup opens with stock tools, and a file stock tools encrypt opens here: `age -d … | tar
 * -x` is the way in when Nuggets itself can't run. Post-quantum keys need age 1.3 or later.
 *
 * Needs the age binaries: AGE_BIN (the directory holding age and age-keygen), or on PATH. CI
 * fetches age 1.3's release, pinned by its checksum; elsewhere, without them, it is skipped
 * (and says so). GNU or BSD tar lists the bundle.
 */

function ageTool(name: 'age' | 'age-keygen'): string {
  return process.env.AGE_BIN ? path.join(process.env.AGE_BIN, name) : name;
}

const ageVersion = (() => {
  try {
    return execFileSync(ageTool('age'), ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
})();
// age 1.3 makes post-quantum keys; 1.1 (Ubuntu 24.04's) neither makes nor opens them.
const runnable = ageVersion !== null && /^v?1\.([3-9]|\d{2,})\./.test(ageVersion);
if (!runnable && process.env.CI) {
  throw new Error(`The age interop test needs age 1.3 or later (found ${ageVersion ?? 'none'}): set AGE_BIN`);
}

describe.skipIf(!runnable)(`backups and the age command line (${ageVersion})`, () => {
  const signer = signerFromSeed(randomBytes(32));
  let dir: string;
  const file = (name: string) => path.join(dir, name);
  const run = (tool: string, args: string[], input?: Buffer | string) => execFileSync(tool, args, { input, maxBuffer: 64 * 1024 * 1024 });

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'backup-interop-'));
    await mkdir(file('uploads/statements'), { recursive: true });
    await writeFile(file('uploads/statements/march.pdf'), 'march statement');
    await writeFile(file(`uploads/${'p'.repeat(170)}.pdf`), 'a long path');
    await writeFile(file('db.dump'), Buffer.concat([Buffer.from('PGDMP'), randomBytes(200_000)]));
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const bundle = () =>
    bundleChunks({
      dumpFile: file('db.dump'),
      uploadsDir: file('uploads'),
      manifest: {
        backupId: 'nuggets_backup_20261120_012958_362',
        createdAt: '2026-11-20T01:29:58.362Z',
        appVersion: 'test',
        schemaVersion: null,
        recipients: [],
      },
      signer,
    });

  it.each(['post-quantum', 'classic'] as const)('a %s backup opens with age -d, and tar lists every member', async (kind) => {
    const keyFile = file(`${kind}.key`);
    run(ageTool('age-keygen'), [...(kind === 'post-quantum' ? ['-pq'] : []), '-o', keyFile]);
    const recipient = run(ageTool('age-keygen'), ['-y', keyFile]).toString('utf8').trim();
    expect(recipient.startsWith(kind === 'post-quantum' ? 'age1pq1' : 'age1')).toBe(true);

    await encryptToRecipients(bundle(), [recipient], file(`${kind}.tar.age`));
    const tar = run(ageTool('age'), ['-d', '-i', keyFile, file(`${kind}.tar.age`)]);
    await writeFile(file(`${kind}.tar`), tar);
    const listing = run('tar', ['-tf', file(`${kind}.tar`)]).toString('utf8').trim().split('\n');
    expect(listing).toEqual(['database.dump', `uploads/${'p'.repeat(170)}.pdf`, 'uploads/statements/march.pdf', 'manifest.json', 'manifest.sig']);
    // tar extracts it as it was.
    await mkdir(file(`${kind}-x`));
    run('tar', ['-xf', file(`${kind}.tar`), '-C', file(`${kind}-x`)]);
    expect(await readFile(file(`${kind}-x/uploads/statements/march.pdf`), 'utf8')).toBe('march statement');
    expect(await readFile(file(`${kind}-x/database.dump`))).toEqual(await readFile(file('db.dump')));
  }, 60_000);

  it.each(['post-quantum', 'classic'] as const)('a %s file age -e made opens here', async (kind) => {
    const keyFile = file(`${kind}-e.key`);
    run(ageTool('age-keygen'), [...(kind === 'post-quantum' ? ['-pq'] : []), '-o', keyFile]);
    const recipient = run(ageTool('age-keygen'), ['-y', keyFile]).toString('utf8').trim();
    // The bundle's bytes, encrypted by age itself.
    const parts: Buffer[] = [];
    for await (const chunk of bundle()) parts.push(chunk);
    run(ageTool('age'), ['-e', '-r', recipient, '-o', file(`${kind}-e.tar.age`)], Buffer.concat(parts));

    const identity = (await readFile(keyFile, 'utf8')).split('\n').find((line) => line.startsWith('AGE-SECRET-KEY-'))!;
    const opened = await decryptBundle(file(`${kind}-e.tar.age`), { identities: [identity] }, file(`${kind}-e.tar`));
    expect(checkSignedTail(opened, [signer.publicKey]).signature).toBe('valid');
    const manifest = await extractBundle(file(`${kind}-e.tar`), opened.size - SIGNED_TAIL_BYTES, file(`${kind}-e-x`));
    expect(manifest.members).toHaveLength(3);
  }, 60_000);
});

// GNU or BSD tar, without age: the bundle is a plain tar.
describe('a bundle is a tar the tar command reads', () => {
  it('lists its members, a long path included', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'backup-tar-'));
    try {
      await mkdir(path.join(dir, 'uploads'), { recursive: true });
      await writeFile(path.join(dir, 'uploads', `${'q'.repeat(170)}.pdf`), 'x');
      await writeFile(path.join(dir, 'db.dump'), 'PGDMP');
      const parts: Buffer[] = [];
      for await (const chunk of bundleChunks({
        dumpFile: path.join(dir, 'db.dump'),
        uploadsDir: path.join(dir, 'uploads'),
        manifest: { backupId: 'nuggets_backup_20261120_012958_362', createdAt: '2026-11-20T01:29:58.362Z', appVersion: 'test', schemaVersion: null, recipients: [] },
        signer: signerFromSeed(randomBytes(32)),
      })) {
        parts.push(chunk);
      }
      await writeFile(path.join(dir, 'b.tar'), Buffer.concat(parts));
      const listing = execFileSync('tar', ['-tf', path.join(dir, 'b.tar')], { encoding: 'utf8' }).trim().split('\n');
      expect(listing).toEqual(['database.dump', `uploads/${'q'.repeat(170)}.pdf`, 'manifest.json', 'manifest.sig']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
