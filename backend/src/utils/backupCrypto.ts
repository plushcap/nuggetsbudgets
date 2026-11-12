import * as crypto from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { open as openFile, readFile, writeFile } from 'fs/promises';
import { Transform, type TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import { AAD, DOMAIN, deriveKey, open as openV2 } from './crypto-envelope.js';

/**
 * The backup file format: encrypted in chunks, so a backup
 * of any size streams through a fixed amount of memory, and signed by the server that made
 * it, so a restore can tell its own backups from anyone else's.
 *
 * v3, bytes:
 *   [0]                 version = 0x03
 *   [1 .. 17)           16-byte random salt: the chunk key is HKDF(backup key, salt), new per file
 *   [17 .. 21)          plaintext chunk size, uint32 big-endian
 *   then the chunks     each AES-256-GCM(chunk) || 16-byte tag; every chunk but the last is
 *                       exactly chunk size long. Chunk i's nonce is i (96 bits, big-endian) and
 *                       its AAD is the header plus a byte saying whether it is the last, so
 *                       chunks can't be reordered, dropped or cut off undetected.
 *   [size-32 .. size)   HMAC-SHA256 over everything before it, keyed with the server's backup
 *                       signing key (HKDF of the data_encryption_key secret, which no app
 *                       session can read). The backup key K can be downloaded by any
 *                       deployment admin, so it proves nothing about who made a file.
 *
 * v2 was one AES-GCM envelope over the whole file (crypto-envelope.ts), with
 * no signature. Those still decrypt, held in memory as before, and count as unsigned.
 */

const VERSION_V2 = 0x02;
const VERSION_V3 = 0x03;
const SALT_LEN = 16;
const HEADER_LEN = 1 + SALT_LEN + 4;
const TAG_LEN = 16;
const SIGNATURE_LEN = 32;
const CHUNK_KEY_INFO = Buffer.from('nuggets-backup-v3-chunks');

export const DEFAULT_BACKUP_CHUNK_SIZE = 1024 * 1024;
/** A header asking for more than this is not one of ours. */
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;

/** Whether the file was signed by the server that is reading it. */
export type BackupSignature =
  /** Signed with this server's signing key. */
  | 'valid'
  /** Signed, but not with this server's signing key: another server's, or tampered with. */
  | 'invalid'
  /** A v2 file, from before backups were signed. */
  | 'unsigned'
  /** Signed, but the reader had no signing key to check it with. */
  | 'unchecked';

/** The key can't open this backup (or its first chunk is damaged). */
export class BackupKeyError extends Error {
  constructor(options?: ErrorOptions) {
    super('Invalid encryption key. Please check that you entered the correct key used when this backup was created.', options);
    this.name = 'BackupKeyError';
  }
}

/** The file is not a backup in a format this code reads, or it is damaged. */
export class BackupFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BackupFormatError';
  }
}

/** Trimmed, and at least 32 characters, as backup keys always have been. */
export function normalizeBackupKey(key: string | null | undefined): string {
  const trimmed = (key ?? '').trim();
  if (!trimmed) throw new Error('Custom encryption key is required');
  if (trimmed.length < 32) throw new Error(`Encryption key must be at least 32 characters (found ${trimmed.length})`);
  return trimmed;
}

/** The key a server signs its backups with, from its data encryption secret. */
export function backupSigningKey(dataEncryptionSecret: string): Buffer {
  return deriveKey(dataEncryptionSecret, DOMAIN.backupSignature);
}

function chunkKey(backupKey: string, salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', deriveKey(backupKey, DOMAIN.backup), salt, CHUNK_KEY_INFO, 32));
}

function chunkNonce(index: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(index, 4);
  return nonce;
}

function chunkAad(header: Buffer, last: boolean): Buffer {
  return Buffer.concat([header, Buffer.from([last ? 1 : 0])]);
}

/**
 * Cuts its input into chunks of `size` bytes and hands each to `processChunk`, marking the last.
 * A chunk is only emitted once more input follows it, so the last one is always known; an
 * empty input still emits one (empty) last chunk.
 */
abstract class Chunker extends Transform {
  private pending: Buffer[] = [];
  private pendingLength = 0;

  constructor(private readonly size: number) {
    super();
  }

  protected abstract processChunk(chunk: Buffer, last: boolean): Buffer;

  override _transform(data: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.pending.push(data);
      this.pendingLength += data.length;
      if (this.pendingLength > this.size) {
        let buffered = Buffer.concat(this.pending);
        while (buffered.length > this.size) {
          this.push(this.processChunk(buffered.subarray(0, this.size), false));
          buffered = buffered.subarray(this.size);
        }
        this.pending = [buffered];
        this.pendingLength = buffered.length;
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.push(this.processChunk(Buffer.concat(this.pending), true));
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}

class ChunkEncryptor extends Chunker {
  private index = 0n;

  constructor(private readonly key: Buffer, private readonly header: Buffer, chunkSize: number) {
    super(chunkSize);
  }

  protected processChunk(plaintext: Buffer, last: boolean): Buffer {
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, chunkNonce(this.index++)) as crypto.CipherGCM;
    cipher.setAAD(chunkAad(this.header, last));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([ciphertext, cipher.getAuthTag()]);
  }
}

class ChunkDecryptor extends Chunker {
  private index = 0n;

  constructor(private readonly key: Buffer, private readonly header: Buffer, chunkSize: number) {
    super(chunkSize + TAG_LEN);
  }

  protected processChunk(sealed: Buffer, last: boolean): Buffer {
    const index = this.index++;
    if (sealed.length < TAG_LEN) throw new BackupFormatError('The backup file is cut short or damaged');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, chunkNonce(index)) as crypto.DecipherGCM;
    decipher.setAAD(chunkAad(this.header, last));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
    try {
      return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_LEN)), decipher.final()]);
    } catch (error) {
      // The first chunk failing is what a wrong key looks like; a later one, a damaged file.
      if (index === 0n) throw new BackupKeyError({ cause: error });
      throw new BackupFormatError(`The backup file is damaged (chunk ${index} does not authenticate)`, { cause: error });
    }
  }
}

/** Passes data through, adding it to an HMAC; `prefix` goes first, and the digest last if `appendDigest`. */
class HmacTap extends Transform {
  readonly hmac: crypto.Hmac;

  constructor(key: Buffer, prefix: Buffer | null, private readonly appendDigest: boolean) {
    super();
    this.hmac = crypto.createHmac('sha256', key);
    if (prefix) {
      this.hmac.update(prefix);
      this.push(prefix);
    }
  }

  override _transform(data: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.hmac.update(data);
    callback(null, data);
  }

  override _flush(callback: TransformCallback): void {
    if (this.appendDigest) this.push(this.hmac.digest());
    callback();
  }
}

/**
 * Encrypt `inputPath` with backup key `backupKey` into a signed v3 file at `outputPath`
 * (written 0600), streaming: memory use is about two chunks whatever the file's size.
 */
export async function encryptBackupFile(
  inputPath: string,
  outputPath: string,
  backupKey: string,
  signingKey: Buffer,
  chunkSize = DEFAULT_BACKUP_CHUNK_SIZE
): Promise<void> {
  const key = normalizeBackupKey(backupKey);
  const salt = crypto.randomBytes(SALT_LEN);
  const header = Buffer.alloc(HEADER_LEN);
  header[0] = VERSION_V3;
  salt.copy(header, 1);
  header.writeUInt32BE(chunkSize, 1 + SALT_LEN);
  await pipeline(
    createReadStream(inputPath),
    new ChunkEncryptor(chunkKey(key, salt), header, chunkSize),
    new HmacTap(signingKey, header, true),
    createWriteStream(outputPath, { mode: 0o600 })
  );
}

/**
 * Decrypt a backup file (v3, or an older v2 one) into `outputPath` (written
 * 0600). Throws BackupKeyError for a key that can't open it. Says whether the file was
 * signed by `signingKey`, or 'unchecked' when there is none to check with; a signature
 * that doesn't match is reported, not thrown: the caller decides what it may restore.
 */
export async function decryptBackupFile(
  inputPath: string,
  outputPath: string,
  backupKey: string,
  signingKey: Buffer | null
): Promise<{ version: 2 | 3; signature: BackupSignature }> {
  const key = normalizeBackupKey(backupKey);
  const header = Buffer.alloc(HEADER_LEN);
  const trailer = Buffer.alloc(SIGNATURE_LEN);
  let size: number;
  let headerBytes: number;
  const file = await openFile(inputPath, 'r');
  try {
    size = (await file.stat()).size;
    headerBytes = (await file.read(header, 0, HEADER_LEN, 0)).bytesRead;
    if (size >= HEADER_LEN + SIGNATURE_LEN) await file.read(trailer, 0, SIGNATURE_LEN, size - SIGNATURE_LEN);
  } finally {
    await file.close();
  }

  if (headerBytes >= 1 && header[0] === VERSION_V2) {
    // The old format: one envelope over the whole file, opened in memory.
    let plaintext: Buffer;
    try {
      plaintext = openV2(deriveKey(key, DOMAIN.backup), await readFile(inputPath), AAD.backup);
    } catch (error) {
      throw new BackupKeyError({ cause: error });
    }
    await writeFile(outputPath, plaintext, { mode: 0o600 });
    return { version: 2, signature: 'unsigned' };
  }
  if (headerBytes < HEADER_LEN || header[0] !== VERSION_V3) {
    throw new BackupFormatError('This is not a Nuggets backup file, or it was made by a newer version of Nuggets');
  }
  if (size < HEADER_LEN + TAG_LEN + SIGNATURE_LEN) {
    throw new BackupFormatError('The backup file is cut short or damaged');
  }

  const chunkSize = header.readUInt32BE(1 + SALT_LEN);
  if (chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) {
    throw new BackupFormatError('The backup file has an invalid header');
  }
  const salt = header.subarray(1, 1 + SALT_LEN);
  // Without a signing key the HMAC is still computed (it costs little), just not compared.
  const tap = new HmacTap(signingKey ?? Buffer.alloc(32), header, false);
  // The tap pushes the header first: skip it again before decrypting.
  const skipHeader = new SkipBytes(HEADER_LEN);
  await pipeline(
    createReadStream(inputPath, { start: HEADER_LEN, end: size - SIGNATURE_LEN - 1 }),
    tap,
    skipHeader,
    new ChunkDecryptor(chunkKey(key, Buffer.from(salt)), header, chunkSize),
    createWriteStream(outputPath, { mode: 0o600 })
  );
  if (!signingKey) return { version: 3, signature: 'unchecked' };
  const signature = crypto.timingSafeEqual(tap.hmac.digest(), trailer) ? 'valid' : 'invalid';
  return { version: 3, signature };
}

/** Drops the first `count` bytes that pass through. */
class SkipBytes extends Transform {
  constructor(private remaining: number) {
    super();
  }

  override _transform(data: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.remaining >= data.length) {
      this.remaining -= data.length;
      callback();
      return;
    }
    const rest = data.subarray(this.remaining);
    this.remaining = 0;
    callback(null, rest);
  }
}
