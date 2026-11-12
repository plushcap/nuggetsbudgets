import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

/** The unprivileged, RLS-enforced role the app serves as. */
export const SERVING_ROLE = 'nuggets_app';

/** Postgres's defaults for a verifier it makes (scram_iterations, SCRAM_DEFAULT_SALT_LEN). */
const SCRAM_ITERATIONS = 4096;
const SCRAM_SALT_BYTES = 16;

/**
 * SASLprep (RFC 4013) as node-postgres's client applies it before deriving its key: non-ASCII
 * spaces become a space, the characters "commonly mapped to nothing" go, then NFKC. The
 * verifier must be made from the same text the client signs in with. Postgres makes the same
 * for any password it allows, and an ASCII password is unchanged.
 */
function saslprep(password: string): string {
  return password
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\u00AD\u034F\u1806\u180B\u180C\u180D\u200C\u200D\u2060\uFE00-\uFE0F\uFEFF]/g, '')
    .normalize('NFKC');
}

/**
 * A SCRAM-SHA-256 verifier for `password` (RFC 5802 §3, RFC 7677), in the form Postgres
 * stores and accepts in place of a password: `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`,
 * as psql's \password makes it. It checks a password; no one can sign in with it.
 */
export function scramSha256Verifier(
  password: string,
  opts: { salt?: Buffer; iterations?: number } = {}
): string {
  const salt = opts.salt ?? randomBytes(SCRAM_SALT_BYTES);
  const iterations = opts.iterations ?? SCRAM_ITERATIONS;
  const saltedPassword = pbkdf2Sync(Buffer.from(saslprep(password), 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** The statement-logging settings turned off while the verifier is set, and to what. */
const LOGGING_OFF: Record<string, string> = {
  log_statement: "'none'",
  log_min_duration_statement: '-1',
};

/**
 * Give `role` LOGIN and `password`. ALTER ROLE takes no bind parameter, so its
 * password is a literal in the statement, which Postgres logs in full when it runs longer
 * than log_min_duration_statement (or under log_statement = 'ddl'); log_parameter_max_length
 * doesn't hide a literal. So it sends a SCRAM-SHA-256 verifier made here instead, which Postgres
 * stores as it is, and in its transaction turns statement logging off where the role may
 * (a superuser, or one granted SET on them). Run as the schema owner (the migration pool).
 */
export async function syncServingRoleLogin(pool: Pick<Pool, 'connect'>, password: string, role: string = SERVING_ROLE): Promise<void> {
  const verifier = scramSha256Verifier(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ name: string; may_set: boolean }>(
      `SELECT name, has_parameter_privilege(name, 'SET') AS may_set FROM unnest($1::text[]) AS name`,
      [Object.keys(LOGGING_OFF)]
    );
    for (const { name, may_set } of rows) {
      if (may_set) await client.query(`SET LOCAL ${name} = ${LOGGING_OFF[name]}`);
    }
    await client.query(`ALTER ROLE ${client.escapeIdentifier(role)} WITH LOGIN PASSWORD ${client.escapeLiteral(verifier)}`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
