import yauzl from 'yauzl';
import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import path from 'path';
import { createLogger } from './logger.js';

const logger = createLogger({ service: 'SafeUnzip' });

const S_IFLNK = 0o120000; // symlink bit in a unix file mode

/**
 * Extract a zip archive to `destDir` safely.
 *
 * Replaces `extract-zip` (unmaintained; GHSA-jmr9-qjv8-65gv — unvalidated
 * symlink path traversal, no fixed release exists). yauzl only *parses* the
 * archive; we control every write, so we can:
 *   - reject any entry whose resolved path escapes `destDir` (zip-slip), and
 *   - skip symlink entries entirely (a symlink can't then redirect a later
 *     write outside the extraction tree).
 */
export async function safeExtractZip(zipPath: string, destDir: string): Promise<void> {
  const destRoot = path.resolve(destDir);
  await mkdir(destRoot, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) return reject(openErr ?? new Error('Failed to open zip archive'));

      const fail = (err: Error) => {
        zipfile.close();
        reject(err);
      };

      zipfile.on('error', reject);
      zipfile.on('end', () => resolve());

      zipfile.on('entry', (entry) => {
        const target = path.resolve(destRoot, entry.fileName);

        // zip-slip: the resolved path must stay within destDir.
        if (target !== destRoot && !target.startsWith(destRoot + path.sep)) {
          return fail(new Error(`Blocked path traversal in archive entry: ${entry.fileName}`));
        }

        // Skip symlink entries (unix mode high bits in external attributes).
        const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (unixMode === S_IFLNK) {
          logger.warn({ entry: entry.fileName }, 'Skipping symlink entry during extraction');
          return zipfile.readEntry();
        }

        // Directory entries end with '/'.
        if (/\/$/.test(entry.fileName)) {
          mkdir(target, { recursive: true }).then(() => zipfile.readEntry()).catch(fail);
          return;
        }

        // Regular file: ensure the parent dir exists, then stream it out.
        mkdir(path.dirname(target), { recursive: true })
          .then(() => {
            zipfile.openReadStream(entry, (streamErr, readStream) => {
              if (streamErr || !readStream) return fail(streamErr ?? new Error('Failed to read zip entry'));
              const ws = createWriteStream(target);
              readStream.on('error', fail);
              ws.on('error', fail);
              ws.on('close', () => zipfile.readEntry());
              readStream.pipe(ws);
            });
          })
          .catch(fail);
      });

      zipfile.readEntry();
    });
  });
}
