import * as crypto from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { lstat, mkdir, open as openFile, readdir, rename, rm } from 'fs/promises';
import * as path from 'path';
import { Readable, Transform, Writable, type TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import { Decrypter, Encrypter, type Identity } from 'age-encryption';
import tarStream from 'tar-stream';
import { z } from 'zod';
import { MAX_BACKUP_RECIPIENTS } from '@nuggets/shared';
import { DOMAIN, deriveKey } from './crypto-envelope.js';

/**
 * The backup file format from 3.x on: a tar bundle, signed by the server that made it and
 * encrypted with age (https://age-encryption.org) to the owner's public keys.
 *
 *   nuggets_backup_YYYYMMDD_HHMMSS_mmm.tar.age    age v1, one stanza per recipient
 *   └── tar (ustar, a pax record for a long name), in this order:
 *       database.dump    pg_dump --format=custom
 *       uploads/…        the uploads directory, regular files only
 *       manifest.json    format 5: the backup's id and time, the app and schema version, the
 *                        recipients' fingerprints, each member's path and size, and the
 *                        number of rows in each table of the dump (format 4, without them,
 *                        is still read)
 *       manifest.sig     the Ed25519 signature of the SHA-256 of every tar byte before it, and
 *                        the signer's public key; then tar's end marker
 *
 * The last 2,048 bytes (manifest.sig's header, its data padded to a block, the end marker)
 * are always the same apart from the signer and the signature, so a reader checks them byte
 * for byte, then the signature, before it parses anything. The writer is this file's own:
 * it hashes each byte as it emits it, so what is signed never depends on how fast the
 * encryption reads (a library writer's buffering made the signed range come out short).
 *
 * The server can't open what it writes: only the owner's private keys open a backup. A
 * restore through the app gets the file key (16 bytes, which open that one file) from the
 * browser, which opened the header with the private key; the restore command reads the
 * private key itself, or takes a bundle the owner decrypted (`age -d`).
 *
 * age proves nothing about who made a file (anyone with the public key can encrypt one):
 * the signature does. Messages from the age library are never shown, logged or attached as
 * a cause: its checksum error repeats the whole key it was given, a private key included.
 */

/** The first bytes of every age file. */
export const AGE_MAGIC = Buffer.from('age-encryption.org/v1\n');

/** The largest age header a backup has: five post-quantum recipients make 7,855 bytes. */
export const MAX_AGE_HEADER_BYTES = 16 * 1024;

/** At most this many keys a backup is encrypted to (@nuggets/shared's, which the page uses too). */
export { MAX_BACKUP_RECIPIENTS };

/** An age file key: 16 bytes. */
export const FILE_KEY_BYTES = 16;

const BLOCK = 512;
/** manifest.sig's header, its data padded to a block, and tar's end marker (two zero blocks). */
export const SIGNED_TAIL_BYTES = 4 * BLOCK;

/** The manifest format these backups carry: 5 has the row counts. Format 4 (without them) is still read. */
export const MANIFEST_VERSION = 5;

/** Limits on what a bundle may hold, checked once the signature has been. */
const MAX_MEMBERS = 500_000;
const MAX_PATH_BYTES = 1024;
const MAX_SEGMENT_BYTES = 255;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
/** At most this many tables a manifest counts the rows of. */
const MAX_COUNTED_TABLES = 5000;

/** What a backup's file is, from its first bytes (never from its name alone). */
export type BackupFileFormat =
  /** age, this format. */
  | 'age'
  /** The format before it: v2 or v3, encrypted with the backup key K. */
  | 'legacy'
  /** A bundle decrypted with `age -d` (a tar), for the restore command's --decrypted. */
  | 'tar'
  | 'unknown';

/** The backup isn't one this code reads, or it is damaged. Its message is written for people. */
export class BackupBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupBundleError';
  }
}

/** The key given can't open this backup: none of its recipients, or a file key for another file. */
export class BackupWrongKeyError extends Error {
  constructor(message = "That key doesn't open this backup: it isn't one of the keys the backup was made for.") {
    super(message);
    this.name = 'BackupWrongKeyError';
  }
}

/** An upload changed size, or went, while the backup read it: the backup is retried. */
export class UploadChangedError extends Error {
  constructor(readonly member: string) {
    super(`An upload file changed while the backup read it (${member}), so the backup was not made from it`);
    this.name = 'UploadChangedError';
  }
}

/** A key a server can't encrypt to: its message is written for people and never repeats the key. */
export class RecipientProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipientProblem';
  }
}

// ── Format detection ────────────────────────────────────────────────────────────────

/** Read the first `length` bytes of `file` (fewer when it is shorter). */
async function readHead(file: string, length: number): Promise<Buffer> {
  const handle = await openFile(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The format of a backup file, from its first bytes. */
export async function detectBackupFormat(file: string): Promise<BackupFileFormat> {
  const head = await readHead(file, BLOCK);
  if (head.length >= AGE_MAGIC.length && head.subarray(0, AGE_MAGIC.length).equals(AGE_MAGIC)) return 'age';
  if (head.length >= 1 && (head[0] === 0x02 || head[0] === 0x03)) return 'legacy';
  if (head.length === BLOCK && head.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
  return 'unknown';
}

/**
 * Whether a file name is a backup's: `.tar.age` (or any `.age`) for this format, `.enc` for
 * the one before. The list, the upload filter, deletion and OneDrive use it; what a file is
 * comes from its bytes ({@link detectBackupFormat}).
 */
export function isBackupFileName(name: string): boolean {
  return name.endsWith('.age') || name.endsWith('.enc');
}

// ── Keys: recipients ────────────────────────────────────────────────────────────────

/** Post-quantum (ML-KEM-768 + X25519, age 1.3's `-pq`) or classic (X25519). */
export type RecipientKind = 'classic' | 'post-quantum';

/** The kind of an age public key, from its prefix. */
export function recipientKind(recipient: string): RecipientKind {
  return recipient.startsWith('age1pq1') || recipient.startsWith('age1tagpq1') ? 'post-quantum' : 'classic';
}

/** A hardware key's tag form (age 1.3: `age1tag1…`, `age1tagpq1…`): the browser can't check one. */
export function isHardwareRecipient(recipient: string): boolean {
  return recipient.startsWith('age1tag1') || recipient.startsWith('age1tagpq1');
}

/** A short, stable name for a public key: the first 8 bytes of its SHA-256, as hex in groups. */
export function recipientFingerprint(recipient: string): string {
  const hex = crypto.createHash('sha256').update(recipient, 'utf8').digest('hex').slice(0, 16);
  return hex.match(/.{4}/g)?.join(' ') ?? hex;
}

/**
 * Check a public key the way age reads it (the prefix, the length, the Bech32 checksum), and
 * say its kind. Throws RecipientProblem, whose message never repeats the key.
 */
export function checkRecipient(recipient: string): RecipientKind {
  if (!recipient.startsWith('age1')) {
    throw new RecipientProblem("That isn't an age public key: one starts with age1 (age1pq1 for a post-quantum key).");
  }
  try {
    new Encrypter().addRecipient(recipient);
  } catch {
    // age's own message isn't shown: it can repeat what it was given.
    throw new RecipientProblem(
      "That public key isn't valid: it may have a typo, or be cut short, or be a plugin's own form (a hardware key needs age 1.3's age1tag1 or age1tagpq1 form)."
    );
  }
  return recipientKind(recipient);
}

/**
 * Refuse a set of keys age wouldn't encrypt to together: post-quantum and classic keys in
 * one file (age 1.3 refuses the mix, since the classic key undoes the post-quantum
 * protection; the library doesn't), or more than {@link MAX_BACKUP_RECIPIENTS}.
 */
export function assertRecipientsCompatible(recipients: readonly string[]): RecipientKind {
  if (recipients.length === 0) throw new RecipientProblem('There is no backup key to encrypt to.');
  if (recipients.length > MAX_BACKUP_RECIPIENTS) {
    throw new RecipientProblem(`A backup is encrypted to at most ${MAX_BACKUP_RECIPIENTS} keys.`);
  }
  const kinds = new Set(recipients.map((r) => checkRecipient(r)));
  if (kinds.size > 1) {
    throw new RecipientProblem(
      'Post-quantum and classic keys can’t be used together: a classic key in the same file undoes the post-quantum protection. Use keys of one kind.'
    );
  }
  return [...kinds][0] ?? 'post-quantum';
}

// ── Keys: the signer ────────────────────────────────────────────────────────────────

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SIGNER_PREFIX = 'ed25519:';
const SIGNATURE_CONTEXT = Buffer.from('nuggets-backup-signature-v1\n');

/** The key a server signs its backups with. Its public key can be handed out: it only checks. */
export interface BackupSigner {
  privateKey: crypto.KeyObject;
  /** The 32-byte Ed25519 public key. */
  publicKey: Buffer;
}

/** A signer from a 32-byte seed. */
export function signerFromSeed(seed: Buffer): BackupSigner {
  if (seed.length !== 32) throw new Error('An Ed25519 seed is 32 bytes');
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return { privateKey, publicKey: Buffer.from(spki.subarray(spki.length - 32)) };
}

/**
 * The signer a server's data encryption secret gives: HKDF with a domain of its own, so it
 * follows the data key and needs no storage. A rotation (rewrap-secrets) changes it.
 */
export function signerFromDataEncryptionSecret(secret: string): BackupSigner {
  return signerFromSeed(deriveKey(secret, DOMAIN.backupSigner));
}

/** How a signer's public key is written: `ed25519:` and its 32 bytes in base64url. */
export function signerId(publicKey: Buffer): string {
  return SIGNER_PREFIX + publicKey.toString('base64url');
}

/** The public key in a signer id ({@link signerId}), or null when it isn't one. */
export function parseSignerId(text: string): Buffer | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SIGNER_PREFIX)) return null;
  const encoded = trimmed.slice(SIGNER_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return null;
  const key = Buffer.from(encoded, 'base64url');
  return key.length === 32 && key.toString('base64url') === encoded ? key : null;
}

function signDigest(signer: BackupSigner, digest: Buffer): Buffer {
  return crypto.sign(null, Buffer.concat([SIGNATURE_CONTEXT, digest]), signer.privateKey);
}

function verifyDigest(publicKey: Buffer, digest: Buffer, signature: Buffer): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.concat([SIGNATURE_CONTEXT, digest]), key, signature);
  } catch {
    return false;
  }
}

// ── The manifest ────────────────────────────────────────────────────────────────────

/** `nuggets_backup_YYYYMMDD_HHMMSS_mmm`: a backup's id, and its file name without the extension. */
export const BACKUP_ID = /^nuggets_backup_\d{8}_\d{6}_\d{3}$/;

const manifestFields = {
  backupId: z.string().regex(BACKUP_ID),
  createdAt: z.iso.datetime({ offset: true }),
  appVersion: z.string().max(200),
  schemaVersion: z.string().regex(/^\d{14}$/).nullable(),
  recipients: z.array(z.string().max(64)).max(MAX_BACKUP_RECIPIENTS),
  members: z.array(z.strictObject({ path: z.string().max(MAX_PATH_BYTES), size: z.number().int().nonnegative() })).max(MAX_MEMBERS),
};

/**
 * The rows in each `public` table, counted in the snapshot pg_dump dumped: a restore
 * compares them with what pg_restore put back, before the migrations change any.
 */
const rowCountsSchema = z
  .record(z.string().min(1).max(63), z.number().int().nonnegative())
  .refine((counts) => Object.keys(counts).length <= MAX_COUNTED_TABLES, { error: 'too many tables' });

const manifestV5Schema = z.strictObject({ manifestVersion: z.literal(MANIFEST_VERSION), ...manifestFields, rowCounts: rowCountsSchema });
const manifestSchema = z.discriminatedUnion('manifestVersion', [
  z.strictObject({ manifestVersion: z.literal(4), ...manifestFields }),
  manifestV5Schema,
]);

/** What manifest.json says: format 5, or format 4 (a backup made before the row counts). */
export type BundleManifest = z.infer<typeof manifestSchema>;
/** What this version writes. */
export type CurrentBundleManifest = z.infer<typeof manifestV5Schema>;

// ── Writing ─────────────────────────────────────────────────────────────────────────

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

/** A ustar header. `name` must fit (100 bytes); a longer one goes in a pax record first. */
function ustarHeader(fields: { name: string; size: number; mode: number; mtime: number; type: '0' | 'x' }): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(fields.name, 0, 100, 'utf8');
  header.write(octal(fields.mode, 8), 100, 'latin1');
  header.write(octal(0, 8), 108, 'latin1');
  header.write(octal(0, 8), 116, 'latin1');
  header.write(octal(fields.size, 12), 124, 'latin1');
  header.write(octal(fields.mtime, 12), 136, 'latin1');
  header.write(' '.repeat(8), 148, 'latin1');
  header.write(fields.type, 156, 'latin1');
  header.write('ustar\0', 257, 'latin1');
  header.write('00', 263, 'latin1');
  header.write(octal(0, 8), 329, 'latin1');
  header.write(octal(0, 8), 337, 'latin1');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return header;
}

/** ustar's size field holds 11 octal digits: 8 GiB less a byte. */
const USTAR_MAX_SIZE = 0o77777777777;

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  // The length counts its own digits.
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`, 'utf8');
}

function padding(size: number): Buffer {
  const rest = size % BLOCK;
  return Buffer.alloc(rest === 0 ? 0 : BLOCK - rest, 0);
}

/** A member's header blocks: a pax record first when its name or size doesn't fit ustar's. */
function memberHeader(name: string, size: number, mtime: number): Buffer[] {
  const nameFits = Buffer.byteLength(name) <= 100 && /^[\x20-\x7e]*$/.test(name);
  if (nameFits && size <= USTAR_MAX_SIZE) return [ustarHeader({ name, size, mode: 0o644, mtime, type: '0' })];
  const records = Buffer.concat([
    ...(nameFits ? [] : [paxRecord('path', name)]),
    ...(size <= USTAR_MAX_SIZE ? [] : [paxRecord('size', String(size))]),
  ]);
  // A stand-in name for readers without pax: ASCII, and short enough.
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').slice(-99);
  return [
    ustarHeader({ name: 'PaxHeader', size: records.length, mode: 0o644, mtime, type: 'x' }),
    records,
    padding(records.length),
    ustarHeader({ name: fallback, size: Math.min(size, USTAR_MAX_SIZE), mode: 0o644, mtime, type: '0' }),
  ];
}

const SIG_LINE_1 = 'nuggets-backup-signature-v1\n';
const SIG_SIGNER_AT = Buffer.byteLength(SIG_LINE_1) + 'signer '.length;
const SIG_SIGNER_LEN = SIGNER_PREFIX.length + 43;
const SIG_SIGNATURE_AT = SIG_SIGNER_AT + SIG_SIGNER_LEN + '\nsignature '.length;
const SIG_SIGNATURE_LEN = 86;

function signatureData(publicKey: Buffer, signature: Buffer): Buffer {
  return Buffer.from(`${SIG_LINE_1}signer ${signerId(publicKey)}\nsignature ${signature.toString('base64url')}\n`, 'latin1');
}

const SIG_DATA_LEN = signatureData(Buffer.alloc(32), Buffer.alloc(64)).length;

/** The last 2,048 bytes of a bundle: fixed apart from the signer and the signature. */
function signedTail(publicKey: Buffer, signature: Buffer): Buffer {
  const data = signatureData(publicKey, signature);
  return Buffer.concat([
    ustarHeader({ name: 'manifest.sig', size: data.length, mode: 0o644, mtime: 0, type: '0' }),
    data,
    padding(data.length),
    Buffer.alloc(2 * BLOCK, 0),
  ]);
}

/**
 * `payload` (a tar's members, without an end marker) signed as the writer signs a bundle:
 * the tests make bundles of their own with it.
 */
export function signPayload(payload: Buffer, signer: BackupSigner): Buffer {
  const digest = crypto.createHash('sha256').update(payload).digest();
  return Buffer.concat([payload, signedTail(signer.publicKey, signDigest(signer, digest))]);
}

/** One file of the bundle: its path in the bundle, where it is read from, and its size. */
interface SourceMember {
  path: string;
  source: string;
  size: number;
  mtime: number;
}

/** A path in the bundle that the reader accepts: database.dump, manifest.json, or under uploads/. */
function memberPathProblem(name: string): string | null {
  if (name === 'database.dump' || name === 'manifest.json') return null;
  if (!name.startsWith('uploads/')) return 'outside uploads/';
  if (Buffer.byteLength(name) > MAX_PATH_BYTES) return 'too long';
  const segments = name.slice('uploads/'.length).split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return 'not a normalized path';
    if (segment.includes('\\') || segment.includes('\0')) return 'a backslash or NUL in it';
    if (Buffer.byteLength(segment) > MAX_SEGMENT_BYTES) return 'a name too long';
  }
  return null;
}

/**
 * The regular files under `dir`, as bundle members under uploads/, sorted. A symlink, a
 * device or anything else is left out, as is a name the reader would refuse (a backslash);
 * a file that goes while this lists it is skipped.
 */
export async function listUploads(dir: string): Promise<{ members: SourceMember[]; skipped: number }> {
  const members: SourceMember[] = [];
  let skipped = 0;
  const walk = async (relative: string): Promise<void> => {
    let entries: string[];
    try {
      entries = (await readdir(path.join(dir, relative))).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && relative !== '') return;
      throw error;
    }
    for (const name of entries) {
      const rel = relative ? `${relative}/${name}` : name;
      const full = path.join(dir, rel);
      const stats = await lstat(full).catch(() => null);
      if (!stats) continue;
      if (stats.isDirectory()) {
        await walk(rel);
      } else if (stats.isFile() && memberPathProblem(`uploads/${rel}`) === null) {
        members.push({ path: `uploads/${rel}`, source: full, size: stats.size, mtime: Math.floor(stats.mtimeMs / 1000) });
      } else {
        skipped++;
      }
    }
  };
  await walk('');
  return { members, skipped };
}

/** A file's bytes, exactly `size` of them: fewer, more, or the file gone is UploadChangedError. */
async function* exactBytes(member: SourceMember): AsyncGenerator<Buffer> {
  let read = 0;
  let stream: AsyncIterable<Buffer>;
  try {
    stream = createReadStream(member.source);
    for await (const chunk of stream) {
      read += chunk.length;
      if (read > member.size) throw new UploadChangedError(member.path);
      yield chunk;
    }
  } catch (error) {
    if (error instanceof UploadChangedError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') throw new UploadChangedError(member.path);
    throw error;
  }
  if (read !== member.size) throw new UploadChangedError(member.path);
}

export interface BundleInput {
  /** The pg_dump file. */
  dumpFile: string;
  /** The uploads directory (it may not exist). */
  uploadsDir: string;
  manifest: Omit<CurrentBundleManifest, 'manifestVersion' | 'members'>;
  signer: BackupSigner;
  /** What the uploads directory holds: files and bytes backed up, and entries left out. */
  onUploadsListed?: (info: { files: number; bytes: number; skipped: number }) => void;
}

/**
 * The bundle's bytes, in order, signed: each chunk is hashed as it is yielded, and the tail
 * is made from the hash of everything yielded before it.
 */
export async function* bundleChunks(input: BundleInput): AsyncGenerator<Buffer> {
  const hash = crypto.createHash('sha256');
  const emit = (chunk: Buffer): Buffer => {
    hash.update(chunk);
    return chunk;
  };
  const dumpStats = await lstat(input.dumpFile);
  const createdAt = Math.floor(new Date(input.manifest.createdAt).getTime() / 1000);
  const dump: SourceMember = { path: 'database.dump', source: input.dumpFile, size: dumpStats.size, mtime: createdAt };
  const { members: uploads, skipped } = await listUploads(input.uploadsDir);
  input.onUploadsListed?.({ files: uploads.length, bytes: uploads.reduce((sum, m) => sum + m.size, 0), skipped });

  const listed: Array<{ path: string; size: number }> = [];
  for (const member of [dump, ...uploads]) {
    for (const block of memberHeader(member.path, member.size, member.mtime)) yield emit(block);
    for await (const chunk of exactBytes(member)) yield emit(chunk);
    yield emit(padding(member.size));
    listed.push({ path: member.path, size: member.size });
  }

  const manifest: CurrentBundleManifest = { manifestVersion: MANIFEST_VERSION, ...input.manifest, members: listed };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  for (const block of memberHeader('manifest.json', manifestBytes.length, createdAt)) yield emit(block);
  yield emit(manifestBytes);
  yield emit(padding(manifestBytes.length));

  const digest = hash.digest();
  yield signedTail(input.signer.publicKey, signDigest(input.signer, digest));
}

/** Passes data through, counting it and hashing it with SHA-256. */
class HashTap extends Transform {
  readonly hash = crypto.createHash('sha256');
  bytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    callback(null, chunk);
  }
}

/** A web stream that pulls `source` one chunk at a time, so the consumer sets the pace. */
function webStreamOf(source: AsyncIterable<Buffer>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/** The number of recipient stanzas (`-> ` lines) in an age header. */
export function countStanzas(header: Buffer): number {
  return header
    .toString('latin1')
    .split('\n')
    .filter((line) => line.startsWith('-> ')).length;
}

/**
 * Encrypt `chunks` to `recipients` into `outPath` (0600, flushed to disk), streaming. Returns
 * the SHA-256 and size of what was written. Refuses a mix of key kinds first.
 */
export async function encryptToRecipients(
  chunks: AsyncIterable<Buffer>,
  recipients: readonly string[],
  outPath: string
): Promise<{ sha256: string; size: number }> {
  assertRecipientsCompatible(recipients);
  const encrypter = new Encrypter();
  for (const recipient of recipients) encrypter.addRecipient(recipient);
  const encrypted = await encrypter.encrypt(webStreamOf(chunks));
  const tap = new HashTap();
  await pipeline(
    Readable.fromWeb(encrypted as import('stream/web').ReadableStream<Uint8Array>),
    tap,
    createWriteStream(outPath, { mode: 0o600, flags: 'wx', flush: true })
  );
  return { sha256: tap.hash.digest('hex'), size: tap.bytes };
}

/** The SHA-256 and size of a file. */
export async function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  const tap = new HashTap();
  await pipeline(createReadStream(file), tap, new Writable({ write: (_chunk, _encoding, done) => done() }));
  return { sha256: tap.hash.digest('hex'), size: tap.bytes };
}

/**
 * The age header of `file` (up to and including its MAC line), for the browser to open with
 * a private key. Throws BackupBundleError when the file isn't age or its header is too long.
 */
export async function readAgeHeader(file: string): Promise<Buffer> {
  const head = await readHead(file, MAX_AGE_HEADER_BYTES);
  if (!head.subarray(0, AGE_MAGIC.length).equals(AGE_MAGIC)) {
    throw new BackupBundleError('This backup is not encrypted with age');
  }
  // The MAC line, "--- <base64>\n", ends the header.
  const macAt = head.indexOf('\n--- ');
  const end = macAt === -1 ? -1 : head.indexOf('\n', macAt + 1);
  if (end === -1) throw new BackupBundleError("This backup's header is damaged, or longer than a backup's");
  return head.subarray(0, end + 1);
}

/**
 * Move `partial` to `final` in the same directory, then flush the directory, so a crash
 * leaves either the old name or the new one.
 */
export async function publishFile(partial: string, final: string): Promise<void> {
  await rename(partial, final);
  const dir = await openFile(path.dirname(final), 'r').catch(() => null);
  if (dir) {
    await dir.sync().catch(() => undefined);
    await dir.close();
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────────────

/**
 * Passes data through, and hashes all of it but the last {@link SIGNED_TAIL_BYTES}, which it
 * keeps: the signature covers everything before the tail.
 */
export class TailHoldingHash extends Transform {
  private readonly hash = crypto.createHash('sha256');
  private held = Buffer.alloc(0);
  bytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    const all = this.held.length ? Buffer.concat([this.held, chunk]) : chunk;
    const cut = Math.max(0, all.length - SIGNED_TAIL_BYTES);
    if (cut > 0) this.hash.update(all.subarray(0, cut));
    this.held = Buffer.from(all.subarray(cut));
    callback(null, chunk);
  }

  /** The digest of everything before the tail, and the tail. Call once the stream has ended. */
  result(): { digest: Buffer; tail: Buffer; size: number } {
    return { digest: this.hash.digest(), tail: this.held, size: this.bytes };
  }
}

/**
 * Whether age failed because the key doesn't open the file, not because its header is damaged.
 * No private key matching a stanza is a wrong key. A header MAC that fails is a wrong key only
 * for a file key (one for another file); a private key that unwrapped the file key and then
 * failed the MAC found a damaged header.
 */
function isWrongKeyFailure(error: unknown, key: BundleKey): boolean {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('no identity matched')) return true;
  return message.includes('invalid header HMAC') && 'fileKey' in key;
}

/** An age identity that knows one file key: the browser opened the header and sent it. */
function fileKeyIdentity(fileKey: Uint8Array): Identity {
  return { unwrapFileKey: () => fileKey };
}

/** How the bundle is opened: with a file key (the web app), or with private keys (the command line). */
export type BundleKey = { fileKey: Buffer } | { identities: readonly string[] };

/**
 * Parse the private keys in an identity file (age-keygen's format: comments, blank lines,
 * then `AGE-SECRET-KEY-…` lines). Throws BackupWrongKeyError, whose message repeats none of it.
 */
export function parseIdentityFile(text: string): string[] {
  const identities = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  if (identities.length === 0) throw new BackupWrongKeyError("That file holds no age private key (a line starting AGE-SECRET-KEY-).");
  for (const identity of identities) {
    try {
      new Decrypter().addIdentity(identity);
    } catch {
      throw new BackupWrongKeyError("That isn't a valid age private key: a line of it isn't an AGE-SECRET-KEY-… key, or it has a typo.");
    }
  }
  return identities;
}

function decrypterFor(key: BundleKey): Decrypter {
  const decrypter = new Decrypter();
  if ('fileKey' in key) {
    if (key.fileKey.length !== FILE_KEY_BYTES) throw new BackupWrongKeyError();
    decrypter.addIdentity(fileKeyIdentity(new Uint8Array(key.fileKey)));
    return decrypter;
  }
  try {
    for (const identity of key.identities) decrypter.addIdentity(identity);
  } catch {
    throw new BackupWrongKeyError("That isn't a valid age private key.");
  }
  return decrypter;
}

/**
 * Decrypt an age backup into `outPath` (0600), hashing as it goes. Throws BackupWrongKeyError
 * for a key that doesn't open it, BackupBundleError for a damaged file. The library's own
 * messages go nowhere.
 */
export async function decryptBundle(
  inPath: string,
  key: BundleKey,
  outPath: string
): Promise<{ digest: Buffer; tail: Buffer; size: number }> {
  const decrypter = decrypterFor(key);
  let plaintext: ReadableStream<Uint8Array>;
  try {
    // Resolves once the header is checked: a failure here is the key, or the header.
    plaintext = await decrypter.decrypt(Readable.toWeb(createReadStream(inPath)) as ReadableStream<Uint8Array>);
  } catch (error) {
    // Read only to tell the two apart; the message itself goes nowhere.
    if (isWrongKeyFailure(error, key)) throw new BackupWrongKeyError();
    throw new BackupBundleError("The backup's header is damaged: the file isn't a backup age can read");
  }
  const hash = new TailHoldingHash();
  try {
    await pipeline(
      Readable.fromWeb(plaintext as import('stream/web').ReadableStream<Uint8Array>),
      hash,
      createWriteStream(outPath, { mode: 0o600, flags: 'wx' })
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A local problem (a full disk) is the server's to report, not a damaged backup.
    // Node's own error (the file system's), so it may go on as the cause; age's never does.
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) throw new Error(`Writing the decrypted backup failed (${code})`, { cause: error });
    throw new BackupBundleError('The backup is damaged or cut short: its encrypted data does not check out');
  }
  return hash.result();
}

/** Hash a bundle (a tar) as its signature covers it, reading it once. */
export async function hashBundle(file: string): Promise<{ digest: Buffer; tail: Buffer; size: number }> {
  const hash = new TailHoldingHash();
  await pipeline(createReadStream(file), hash, new Writable({ write: (_chunk, _encoding, done) => done() }));
  return hash.result();
}

/**
 * Copy a bundle the owner decrypted themselves (the restore command's --decrypted) to `outPath`
 * (0600), hashing it in the same pass: what is checked is then the copy that is parsed.
 */
export async function copyAndHashBundle(file: string, outPath: string): Promise<{ digest: Buffer; tail: Buffer; size: number }> {
  const hash = new TailHoldingHash();
  await pipeline(createReadStream(file), hash, createWriteStream(outPath, { mode: 0o600, flags: 'wx' }));
  return hash.result();
}

/** Whether the bundle is signed by one of `trusted`, by another key, or couldn't be checked. */
export type BundleSignature = 'valid' | 'invalid' | 'unchecked';

/**
 * Check the tail byte for byte against the one the writer makes, then the signature over the
 * digest of everything before it. `trusted` are the signers' public keys to accept (this
 * server's, a `--signer`); with none, the signature can't be checked. Throws
 * BackupBundleError when the tail isn't the writer's.
 */
export function checkSignedTail(
  bundle: { digest: Buffer; tail: Buffer; size: number },
  trusted: readonly Buffer[]
): { signature: BundleSignature; signer: string } {
  const { tail, size } = bundle;
  const notOurs = new BackupBundleError("This isn't a Nuggets backup, or it was changed: its signature block isn't the one Nuggets writes");
  if (tail.length !== SIGNED_TAIL_BYTES || size % BLOCK !== 0 || size < SIGNED_TAIL_BYTES + 2 * BLOCK) throw notOurs;
  const data = tail.subarray(BLOCK, BLOCK + SIG_DATA_LEN);
  const publicKey = parseSignerId(data.subarray(SIG_SIGNER_AT, SIG_SIGNER_AT + SIG_SIGNER_LEN).toString('latin1'));
  const encodedSignature = data.subarray(SIG_SIGNATURE_AT, SIG_SIGNATURE_AT + SIG_SIGNATURE_LEN).toString('latin1');
  const signature = /^[A-Za-z0-9_-]{86}$/.test(encodedSignature) ? Buffer.from(encodedSignature, 'base64url') : null;
  if (!publicKey || !signature || signature.length !== 64) throw notOurs;
  if (!signedTail(publicKey, signature).equals(tail)) throw notOurs;

  const signer = signerId(publicKey);
  if (trusted.length === 0) return { signature: 'unchecked', signer };
  if (!trusted.some((key) => key.equals(publicKey))) return { signature: 'invalid', signer };
  return { signature: verifyDigest(publicKey, bundle.digest, signature) ? 'valid' : 'invalid', signer };
}

/**
 * Extract a bundle's members (the bytes before its tail) into `destDir`: database.dump,
 * manifest.json and uploads/…. Only after its tail and signature have been checked. Every
 * member must be a regular file at a path the writer makes, none twice, and exactly the
 * members the manifest lists, at their sizes; manifest.json comes last. Throws
 * BackupBundleError, and leaves what it wrote for the caller to delete.
 */
export async function extractBundle(tarPath: string, payloadSize: number, destDir: string): Promise<BundleManifest> {
  const destRoot = path.resolve(destDir);
  await mkdir(destRoot, { recursive: true, mode: 0o700 });
  const seen = new Map<string, number>();
  let manifestText: string | null = null;
  const refuse = (why: string) => new BackupBundleError(`This backup's contents aren't what a Nuggets backup holds: ${why}`);

  // A header without ustar's magic is refused (tar-stream's default).
  const extract = tarStream.extract();
  extract.on('entry', (header, stream, next) => {
    const fail = (error: Error) => {
      // The extract ends this entry's stream with the error too: it must have a listener.
      stream.on('error', () => undefined);
      stream.resume();
      extract.destroy(error);
    };
    const name = header.name;
    if (header.type !== 'file') return fail(refuse(`a ${header.type ?? 'unknown'} entry (only files)`));
    if (manifestText !== null) return fail(refuse('an entry after manifest.json'));
    const problem = memberPathProblem(name);
    if (problem) return fail(refuse(`an entry ${problem}`));
    if (seen.has(name)) return fail(refuse('an entry twice'));
    if (seen.size >= MAX_MEMBERS) return fail(refuse('too many entries'));
    const size = header.size ?? 0;
    seen.set(name, size);

    if (name === 'manifest.json') {
      if (size > MAX_MANIFEST_BYTES) return fail(refuse('a manifest too large'));
      const parts: Buffer[] = [];
      stream.on('data', (chunk: unknown) => parts.push(chunk as Buffer));
      stream.on('end', () => {
        manifestText = Buffer.concat(parts).toString('utf8');
        next();
      });
      stream.on('error', (error: Error) => extract.destroy(error));
      return;
    }

    // memberPathProblem has refused every name that leaves the bundle; checked again where the
    // file is written, the way a zip-slip check reads, so no later change to it can open a way out.
    const target = path.resolve(destRoot, ...name.split('/'));
    if (!target.startsWith(destRoot + path.sep)) return fail(refuse('an entry outside the bundle'));
    mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      .then(() => pipeline(stream, createWriteStream(target, { mode: 0o600, flags: 'wx' })))
      .then(() => next())
      .catch((error: Error) => fail(error));
  });

  const source = payloadSize > 0 ? createReadStream(tarPath, { start: 0, end: payloadSize - 1 }) : Readable.from([]);
  await pipeline(source, extract).catch((error: Error) => {
    throw error instanceof BackupBundleError ? error : refuse('it is not a tar archive this code reads');
  });

  if (manifestText === null) throw refuse('no manifest.json');
  let manifest: BundleManifest;
  try {
    manifest = manifestSchema.parse(JSON.parse(manifestText));
  } catch {
    throw refuse("its manifest isn't a format-4 or format-5 manifest");
  }
  seen.delete('manifest.json');
  const listed = new Map(manifest.members.map((m) => [m.path, m.size]));
  if (listed.size !== manifest.members.length) throw refuse('its manifest lists an entry twice');
  if (!listed.has('database.dump')) throw refuse('no database dump');
  if (listed.size !== seen.size) throw refuse('its entries and its manifest differ');
  for (const [name, size] of seen) {
    if (listed.get(name) !== size) throw refuse('its entries and its manifest differ');
  }
  return manifest;
}

/** Remove `partial` files left in `dir` by a backup that was cut short (`nuggets_backup_*.partial`). */
export async function sweepPartialBackups(dir: string): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    if (/^nuggets_backup_.*\.partial$/.test(entry)) {
      await rm(path.join(dir, entry), { force: true });
      removed.push(entry);
    }
  }
  return removed;
}
