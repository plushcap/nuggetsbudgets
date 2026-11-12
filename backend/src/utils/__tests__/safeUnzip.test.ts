import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'fs/promises';
import { createWriteStream, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { ZipArchive } from 'archiver';
import { safeExtractZip } from '../safeUnzip.js';

/**
 * safeUnzip replaces extract-zip (GHSA-jmr9-qjv8-65gv). These tests confirm it
 * extracts normal content and refuses to materialise a symlink entry from the
 * archive.
 */
function buildZip(zipPath: string, build: (a: ZipArchive) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(zipPath);
    const archive = new ZipArchive();
    out.on('close', () => resolve());
    archive.on('error', reject);
    archive.pipe(out);
    build(archive);
    void archive.finalize();
  });
}

describe('safeExtractZip', () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'safeunzip-'));
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('extracts nested files with their content', async () => {
    const zipPath = path.join(tmp, 'normal.zip');
    await buildZip(zipPath, (a) => {
      a.append('hello', { name: 'root.txt' });
      a.append('world', { name: 'sub/nested.txt' });
    });

    const dest = path.join(tmp, 'out-normal');
    await safeExtractZip(zipPath, dest);

    expect(await readFile(path.join(dest, 'root.txt'), 'utf8')).toBe('hello');
    expect(await readFile(path.join(dest, 'sub', 'nested.txt'), 'utf8')).toBe('world');
  });

  it('skips symlink entries instead of writing them', async () => {
    const zipPath = path.join(tmp, 'symlink.zip');
    await buildZip(zipPath, (a) => {
      a.append('safe', { name: 'keep.txt' });
      a.symlink('evil-link', '/etc/passwd');
    });

    const dest = path.join(tmp, 'out-symlink');
    await safeExtractZip(zipPath, dest);

    // The real file is extracted; the symlink entry is not materialised.
    expect(await readFile(path.join(dest, 'keep.txt'), 'utf8')).toBe('safe');
    expect(existsSync(path.join(dest, 'evil-link'))).toBe(false);
    const entries = await readdir(dest);
    expect(entries).not.toContain('evil-link');
  });
});
