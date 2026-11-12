import * as fs from 'fs';
import { readFile } from 'fs/promises';
import { configFor } from '../config.js';

/**
 * Resolves the data-at-rest encryption secret: the `data_encryption_key`
 * Docker secret. It protects more than backups (the stored backup key, the SimpleFin access
 * URL, OneDrive tokens, the SMTP password); per-purpose keys are HKDF-derived from it.
 */
export const DATA_ENCRYPTION_SECRET_PATH = '/run/secrets/data_encryption_key';

function validate(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) {
    throw new Error('Docker secret file is empty');
  }
  if (trimmed.length < 32) {
    // HKDF derives the AES keys from this, so the length isn't fixed — but keep
    // a sane entropy floor. (The old scheme used the value as the raw AES key
    // and demanded exactly 32 characters.)
    throw new Error(`Docker secret must be at least 32 characters (found ${trimmed.length})`);
  }
  return trimmed;
}

/**
 * Where to look: DATA_ENCRYPTION_KEY_FILE first when set (the secret's file outside a
 * container, e.g. for the restore command), then the Docker secret.
 */
function candidatePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = configFor(env).DATA_ENCRYPTION_KEY_FILE;
  return override ? [override, DATA_ENCRYPTION_SECRET_PATH] : [DATA_ENCRYPTION_SECRET_PATH];
}

/** Async read (fs/promises) — first existing, non-empty candidate wins. */
export async function readDataEncryptionSecret(): Promise<string> {
  for (const path of candidatePaths()) {
    try {
      const raw = (await readFile(path, 'utf8')).trim();
      if (raw) return validate(raw);
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    `no data encryption secret found (looked in: ${candidatePaths().join(', ')})`
  );
}

/** Synchronous read — same resolution, for callers that load in a constructor. */
export function readDataEncryptionSecretSync(env: NodeJS.ProcessEnv = process.env): string {
  for (const path of candidatePaths(env)) {
    if (fs.existsSync(path)) {
      const raw = fs.readFileSync(path, 'utf8').trim();
      if (raw) return validate(raw);
    }
  }
  throw new Error(
    `no data encryption secret found (looked in: ${candidatePaths(env).join(', ')})`
  );
}
