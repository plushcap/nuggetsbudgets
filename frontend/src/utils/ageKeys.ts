import type { BackupKeyKind } from '@nuggets/shared';

/**
 * age in the browser, for the backup keys: making a key pair, reading a private key file,
 * and opening a backup's header to get its file key, which is all the server is sent. The
 * private key never leaves the browser.
 *
 * age's own error messages are never shown, logged or kept as a cause: its checksum error
 * repeats the whole key it was given, a private key included. Every failure here is a
 * BackupKeyProblem with a message of the app's own.
 *
 * The library (age-encryption, by age's author) is loaded only when one of these runs, so
 * only the pages that use it carry it. It runs no eval and no WebAssembly: the CSP needs no
 * change for it.
 */

const loadAge = () => import('age-encryption');

/** A key problem, written for people: its message never repeats a key. */
export class BackupKeyProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupKeyProblem';
  }
}

/** The first bytes of every age file. */
const AGE_MAGIC = 'age-encryption.org/v1\n';

/** The largest age header a backup has (five post-quantum keys make 7,855 bytes). */
export const MAX_AGE_HEADER_BYTES = 16 * 1024;

const PRIVATE_KEY_LINE = /^AGE-SECRET-KEY-(PQ-)?1[0-9A-Z]+$/;

const NOT_A_KEY = "That isn't an age private key: a key file has a line starting AGE-SECRET-KEY-, and a key may have a typo or be cut short.";
const WRONG_KEY = "That key doesn't open this backup: it isn't one of the keys the backup was made for.";
const DAMAGED = "This backup's header can't be read: the file isn't an age backup, or it is damaged.";
const NO_WEBCRYPTO =
  'This page isn’t served over HTTPS, so the browser can’t use a classic key here. Open Nuggets over HTTPS, or use a post-quantum key.';

/**
 * Whether the browser can use a classic (X25519) key: age uses its WebCrypto for those, which a
 * page served over plain HTTP doesn't have. Post-quantum keys need none.
 */
export function classicKeysWork(): boolean {
  return typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.subtle !== 'undefined';
}

const isClassicIdentity = (identity: string) => identity.startsWith('AGE-SECRET-KEY-1');

/**
 * The keys the browser can use: all of them, or over plain HTTP the post-quantum ones. Refuses,
 * saying why, when none is left.
 */
function usable(identities: readonly string[]): string[] {
  if (classicKeysWork()) return [...identities];
  const left = identities.filter((identity) => !isClassicIdentity(identity));
  if (left.length === 0) throw new BackupKeyProblem(NO_WEBCRYPTO);
  return left;
}

/** A key pair made here, and its private key as a file in age-keygen's format. */
export interface MadeKeyPair {
  identity: string;
  recipient: string;
  kind: BackupKeyKind;
  fileText: string;
}

/** A private key file as age-keygen writes one: two comments, then the key. */
export function identityFileText(identity: string, recipient: string, created: Date): string {
  return `# created: ${created.toISOString().replace(/\.\d{3}Z$/, 'Z')}\n# public key: ${recipient}\n${identity}\n`;
}

type AgeLibrary = Awaited<ReturnType<typeof loadAge>>;

/** How each kind of key pair is made: age 1.3's `age-keygen -pq`, or a classic one. */
const GENERATE: Record<BackupKeyKind, (age: AgeLibrary) => Promise<string>> = {
  'post-quantum': (age) => age.generateHybridIdentity(),
  classic: (age) => age.generateX25519Identity(),
};

/** Make a key pair of `kind` (post-quantum is the page's default). */
export async function makeKeyPair(kind: BackupKeyKind, created = new Date()): Promise<MadeKeyPair> {
  const age = await loadAge();
  const identity = await GENERATE[kind](age);
  usable([identity]);
  const recipient = await age.identityToRecipient(identity);
  return { identity, recipient, kind, fileText: identityFileText(identity, recipient, created) };
}

/**
 * The private keys in pasted text: each `AGE-SECRET-KEY-…` in it, wherever it is, since a whole
 * key file pasted into a one-line field loses its line breaks. Throws BackupKeyProblem.
 */
export function identitiesFromPasted(text: string): string[] {
  // A key's data and checksum are 58 characters whatever its kind, so keys run together, or
  // followed by other capitals, still come apart.
  const keys = text.match(/AGE-SECRET-KEY-(?:PQ-)?1[0-9A-Z]{58}/g) ?? [];
  if (keys.length === 0) throw new BackupKeyProblem(NOT_A_KEY);
  return keys;
}

/** The private keys in a key file's text. Throws BackupKeyProblem. */
export function parseIdentities(text: string): string[] {
  const keys = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  if (keys.length === 0 || keys.some((key) => !PRIVATE_KEY_LINE.test(key))) throw new BackupKeyProblem(NOT_A_KEY);
  return keys;
}

/** The public key of each private key. Throws BackupKeyProblem for a mistyped one. */
export async function recipientsOf(identities: readonly string[]): Promise<string[]> {
  const keys = usable(identities);
  const age = await loadAge();
  try {
    return await Promise.all(keys.map((identity) => age.identityToRecipient(identity)));
  } catch {
    throw new BackupKeyProblem(NOT_A_KEY);
  }
}

/** A blob's bytes, or its text (FileReader: it works wherever the page does). */
function readBlob(blob: Blob, as: 'text'): Promise<string>;
function readBlob(blob: Blob, as: 'bytes'): Promise<Uint8Array>;
function readBlob(blob: Blob, as: 'text' | 'bytes'): Promise<string | Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(as === 'text' ? String(reader.result ?? '') : new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new BackupKeyProblem("That file couldn't be read."));
    if (as === 'text') reader.readAsText(blob);
    else reader.readAsArrayBuffer(blob);
  });
}

/** The private keys in a key file chosen on this computer. Throws BackupKeyProblem. */
export async function identitiesFromFile(file: Blob): Promise<string[]> {
  // A key file is a few hundred bytes: a larger one isn't one.
  if (file.size > 64 * 1024) throw new BackupKeyProblem(NOT_A_KEY);
  return parseIdentities(await readBlob(file, 'text'));
}

/** What a backup file is, from its first bytes: age, the older .enc format, or neither. */
export async function backupFormatOf(file: Blob): Promise<'age' | 'legacy' | 'unknown'> {
  const head = await readBlob(file.slice(0, AGE_MAGIC.length), 'bytes');
  if (new TextDecoder().decode(head) === AGE_MAGIC) return 'age';
  return head[0] === 0x02 || head[0] === 0x03 ? 'legacy' : 'unknown';
}

/** The age header at the start of `bytes`: through its MAC line ("--- …"). Throws BackupKeyProblem. */
export function headerFrom(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder('latin1').decode(bytes);
  const macAt = text.startsWith(AGE_MAGIC) ? text.indexOf('\n--- ') : -1;
  const end = macAt === -1 ? -1 : text.indexOf('\n', macAt + 1);
  if (end === -1) throw new BackupKeyProblem(DAMAGED);
  return bytes.slice(0, end + 1);
}

/** The header of a backup file chosen on this computer. */
export async function headerOfFile(file: Blob): Promise<Uint8Array> {
  return headerFrom(await readBlob(file.slice(0, MAX_AGE_HEADER_BYTES), 'bytes'));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Open a backup's header with the private keys, and give its file key, in base64: the 16
 * bytes that open that one backup, all the server gets. A wrong key fails here, before
 * anything is uploaded. Throws BackupKeyProblem.
 */
export async function fileKeyFor(header: Uint8Array, identities: readonly string[]): Promise<string> {
  const keys = usable(identities);
  const age = await loadAge();
  const opener = new age.Decrypter();
  try {
    for (const identity of keys) opener.addIdentity(identity);
  } catch {
    throw new BackupKeyProblem(NOT_A_KEY);
  }
  let fileKey: Uint8Array;
  try {
    fileKey = await opener.decryptHeader(header);
  } catch (error) {
    // Read only to tell a wrong key from a damaged header; the message itself goes nowhere. A
    // private key that unwrapped the file key and then failed the header's MAC found damage.
    const message = error instanceof Error ? error.message : '';
    throw new BackupKeyProblem(message.includes('no identity matched') ? WRONG_KEY : DAMAGED);
  }
  const encoded = toBase64(fileKey);
  fileKey.fill(0);
  return encoded;
}

/** A file name for a key's private key file, from its label. */
export function keyFileName(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `nuggets-backup-key${slug ? `-${slug}` : ''}.txt`;
}
