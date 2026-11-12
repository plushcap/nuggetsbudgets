import crypto from 'crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { db } from '../db.js';
import type { DB } from '../db/schema.generated.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ service: 'SetupToken' });

/**
 * The one-time setup token that first-run admin setup requires.
 *
 * While the deployment has no users, `POST /api/auth/setup-admin` creates the first user
 * and makes them deployment admin. Without a secret, whoever reached a fresh instance first
 * got that. The token is the secret: the server logs a new one at startup while there are no
 * users ({@link announceSetupToken}), and `node dist/scripts/setup-token.js` prints a new one
 * on demand. Only its SHA-256 is stored (`deployment.setup_token_hash`), so a database
 * reader can't use it. Issuing a token replaces the hash, so only the newest one works, and
 * the transaction that creates the first admin clears it ({@link clearSetupToken}).
 *
 * Every step that decides whether setup may run holds {@link lockFirstRunSetup}, so two
 * concurrent setups can't both see "no users yet" and both create an admin.
 */

/** Advisory-lock key for first-run setup. Distinct from MigrationService's key. */
export const FIRST_RUN_SETUP_LOCK_KEY = 4242042457;

type Queryable = Kysely<DB> | Transaction<DB>;

/** SHA-256 (hex) of a setup token, as stored in `deployment.setup_token_hash`. */
export function hashSetupToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Serialize first-run setup: holds a transaction-level advisory lock until `trx` ends.
 * Checks made after it see what an earlier setup committed (READ COMMITTED takes a new
 * snapshot per statement), so run them after this call, in the same transaction.
 */
export async function lockFirstRunSetup(trx: Transaction<DB>): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${FIRST_RUN_SETUP_LOCK_KEY}::bigint)`.execute(trx);
}

/** Whether any user exists, i.e. first-run setup is over. */
export async function deploymentHasUsers(q: Queryable): Promise<boolean> {
  const row = await q.selectFrom('users').select('id').limit(1).executeTakeFirst();
  return row !== undefined;
}

/**
 * Whether `candidate` is the current setup token. Surrounding whitespace is ignored (it
 * comes from a copied log line). The hashes are compared in constant time.
 */
export async function setupTokenMatches(q: Queryable, candidate: unknown): Promise<boolean> {
  if (typeof candidate !== 'string') return false;
  const token = candidate.trim();
  if (token === '') return false;
  const row = await q
    .selectFrom('deployment')
    .select('setup_token_hash')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  const stored = row?.setup_token_hash;
  if (!stored || !/^[0-9a-f]{64}$/.test(stored)) return false;
  return crypto.timingSafeEqual(Buffer.from(hashSetupToken(token), 'hex'), Buffer.from(stored, 'hex'));
}

/** Forget the setup token, so no token works. */
export async function clearSetupToken(q: Queryable): Promise<void> {
  await q.updateTable('deployment').set({ setup_token_hash: null }).where('setup_token_hash', 'is not', null).execute();
}

/**
 * Issue a new setup token while the deployment has no users: stores its hash in place of any
 * earlier token's and returns the token, which is never stored. Once a user exists it issues
 * none, clears any leftover hash, and returns null.
 */
export async function issueSetupToken(q: Kysely<DB> = db): Promise<string | null> {
  return q.transaction().execute(async (trx) => {
    await lockFirstRunSetup(trx);
    if (await deploymentHasUsers(trx)) {
      await clearSetupToken(trx);
      return null;
    }
    const token = crypto.randomBytes(32).toString('hex');
    // The deployment table holds exactly one row (seeded with the schema).
    const result = await trx
      .updateTable('deployment')
      .set({ setup_token_hash: hashSetupToken(token) })
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      throw new Error('The deployment row is missing, so no setup token can be stored');
    }
    return token;
  });
}

/**
 * At startup: while the deployment has no users, issue a setup token and log it once, for
 * the operator to enter on the setup page. Logs nothing once a user exists.
 */
export async function announceSetupToken(
  q: Kysely<DB> = db,
  log: Pick<typeof logger, 'warn'> = logger
): Promise<void> {
  const token = await issueSetupToken(q);
  if (token === null) return;
  log.warn(
    "First-run setup: no admin exists yet. Enter this one-time setup token on the app's setup page to " +
      `create the first admin: ${token} (a restart, or running node dist/scripts/setup-token.js in the ` +
      'backend container, replaces it with a new one; it stops working once the first admin exists)'
  );
}
