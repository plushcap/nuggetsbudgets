import type { ClientBase, Pool } from 'pg';
import { sql, type Transaction } from 'kysely';
import type { DB } from './schema.generated.js';
import { ControlPlaneError } from '../services/controlPlaneErrors.js';
import { createLogger } from '../utils/logger.js';
import { oneRow } from '../utils/present.js';
import { configFor } from '../config.js';
import { envSecret } from '../utils/docker-secrets.js';

const logger = createLogger({ service: 'ServingRole' });

type Queryable = Pool | ClientBase;

/**
 * The password for the role the app serves as (DB_USER). When DB_USER is also the
 * migration role (a single-role setup) that's the owner's password, as migrationPool uses:
 * MIGRATION_DB_PASSWORD or db_password. Otherwise a separate serving role (nuggets_app)
 * has the app_db_password secret; without MIGRATION_DB_USER, a present app_db_password is
 * taken to mean DB_USER is that serving role. Falling back to the owner's password for a
 * separate serving role could only "work" by connecting as the wrong role, so that's an error.
 */
export function servingRolePassword(
  secrets: { dbPassword: string; appDbPassword: string },
  env: NodeJS.ProcessEnv = process.env
): string {
  const settings = configFor(env);
  const servingRole = settings.DB_USER;
  const migrationRole = settings.MIGRATION_DB_USER;
  const ownerPassword = envSecret('MIGRATION_DB_PASSWORD', env) || secrets.dbPassword;
  if (migrationRole && migrationRole === servingRole) return ownerPassword;
  if (secrets.appDbPassword) return secrets.appDbPassword;
  if (!migrationRole) return ownerPassword;
  throw new Error(
    `DB_USER "${servingRole}" is not the migration role "${migrationRole}", so it needs its own password: ` +
      'set the app_db_password Docker secret (or APP_DB_PASSWORD).'
  );
}

/** Raised when the serving role could bypass RLS; other errors mean the check couldn't run. */
export class RlsBypassRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RlsBypassRoleError';
  }
}

// Predefined roles that reach past RLS: running programs or reading and writing files as
// the database server (its data files, or the owner's password in /run/secrets).
const SERVER_ACCESS_ROLES = ['pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files'];

/** Why RLS wouldn't hold for `role`, named `who` in the messages. */
async function problemsFor(db: Queryable, role: string, who: string): Promise<string[]> {
  const self = await db.query<{ rolsuper: boolean; rolbypassrls: boolean; rolreplication: boolean }>(
    'SELECT rolsuper, rolbypassrls, rolreplication FROM pg_catalog.pg_roles WHERE rolname = $1',
    [role]
  );
  const { rolsuper, rolbypassrls, rolreplication } = oneRow(self.rows, 'pg_roles');
  // A superuser counts as a member of every role, so the checks below would list them all.
  if (rolsuper) return [`${who} is a superuser`];

  const problems: string[] = [];
  if (rolbypassrls) problems.push(`${who} is BYPASSRLS`);
  if (rolreplication) problems.push(`${who} has REPLICATION, which can copy every table's data`);

  const roles = await db.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolreplication: boolean }>(
    `SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolreplication
       FROM pg_catalog.pg_roles r
      WHERE r.rolname <> $1
        AND (r.rolsuper OR r.rolbypassrls OR r.rolreplication OR r.rolname = ANY($2))
        AND pg_catalog.pg_has_role($1, r.oid, 'MEMBER')
      ORDER BY r.rolname`,
    [role, SERVER_ACCESS_ROLES]
  );
  for (const r of roles.rows) {
    const kind = r.rolsuper
      ? 'a superuser'
      : r.rolbypassrls
        ? 'BYPASSRLS'
        : r.rolreplication
          ? 'REPLICATION'
          : "a predefined role with access to the database server's files or programs";
    problems.push(`${who} can act as role ${r.rolname}, which is ${kind}`);
  }

  const owned = await db.query<{ table: string }>(
    `SELECT c.relname AS table
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND pg_catalog.pg_has_role($1, c.relowner, 'MEMBER')
      ORDER BY 1`,
    [role]
  );
  if (owned.rows.length > 0) {
    const tables = owned.rows.map((r) => r.table);
    const sample = tables.slice(0, 5).join(', ') + (tables.length > 5 ? ', …' : '');
    problems.push(`${who} owns ${tables.length} table(s) in the public schema, so it can turn RLS off (${sample})`);
  }
  return problems;
}

/**
 * Why row-level security wouldn't hold for this connection, if it wouldn't. Tenant
 * isolation rests entirely on RLS, and RLS doesn't apply to a superuser or a
 * BYPASSRLS role, or to a role that can act as one; a table's owner can turn it off for
 * that table; replication and server file or program access read the data around it.
 * Checks the role the session runs as and, when a role default changed it, the login
 * role too, which can switch back with RESET ROLE.
 */
export async function findRlsBypass(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ role: string; login: string }>('SELECT current_user AS role, session_user AS login');
  const { role, login } = oneRow(rows, 'current_user');
  const problems = await problemsFor(db, role, `role ${role}`);
  if (login !== role) problems.push(...(await problemsFor(db, login, `login role ${login}`)));
  return problems;
}

export async function countTenants(db: Queryable): Promise<number> {
  const res = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.tenants');
  return oneRow(res.rows, 'count(*)').n;
}

// Whether the role this process serves as can bypass RLS, as the last check found. Past
// startup it can only be true under ALLOW_RLS_BYPASS_ROLE; assertMayAddTenant reads it.
let rlsBypassActive = false;

/**
 * Refuse to serve as a role that can bypass RLS: every tenant's rows would be visible to
 * every other tenant. ALLOW_RLS_BYPASS_ROLE=true lets a deployment with at most one tenant
 * start anyway, with an error logged on every start, and assertMayAddTenant then keeps it
 * at one: the app relies on RLS to scope its queries, so two tenants' data would mix.
 * Runs again after a restore, while requests are being served.
 */
export async function assertServingRoleEnforcesRls(
  db: Queryable,
  env: NodeJS.ProcessEnv = process.env,
  deps: { countTenants: (db: Queryable) => Promise<number> } = { countTenants }
): Promise<void> {
  const problems = await findRlsBypass(db);
  // Set as soon as the role is known and never cleared in between: when this runs again,
  // assertMayAddTenant must keep refusing while the tenants are counted, and after a
  // refusal while the server shuts down.
  rlsBypassActive = problems.length > 0;
  if (problems.length === 0) return;
  if (configFor(env).ALLOW_RLS_BYPASS_ROLE) {
    let tenants: number;
    try {
      tenants = await deps.countTenants(db);
    } catch (err) {
      throw new Error(`ALLOW_RLS_BYPASS_ROLE=true needs the number of tenants, and counting them failed: ${(err as Error).message}`, {
        cause: err,
      });
    }
    if (tenants <= 1) {
      logger.error(
        { problems, tenants },
        'ALLOW_RLS_BYPASS_ROLE=true: serving as a role that can bypass row-level security, so adding a second tenant is refused'
      );
      return;
    }
    throw new RlsBypassRoleError(
      `Refusing to start: ALLOW_RLS_BYPASS_ROLE=true only works with one tenant, and this deployment has ${tenants}. ` +
        `The database role the app serves as can bypass row-level security (${problems.join('; ')}), and the app ` +
        "relies on it to keep each tenant's data apart. Serve as the unprivileged nuggets_app role instead."
    );
  }
  throw new RlsBypassRoleError(
    `Refusing to start: the database role the app serves as can bypass or turn off row-level security (${problems.join('; ')}), ` +
      "so every tenant's data would be visible to every other tenant. Serve as the unprivileged nuggets_app role: " +
      'DB_USER=nuggets_app with the app_db_password secret, and MIGRATION_DB_USER set to the owner role (migrations ' +
      'run as the owner and give nuggets_app its login). For a deployment with one tenant that accepts ' +
      'running without RLS, set ALLOW_RLS_BYPASS_ROLE=true instead.'
  );
}

/**
 * While ALLOW_RLS_BYPASS_ROLE is in effect the deployment stays at one tenant: refuse to
 * add another. Call inside the transaction that inserts the tenant; the table lock makes
 * concurrent callers take turns, so two can't both see none and both insert.
 */
export async function assertMayAddTenant(trx: Transaction<DB>): Promise<void> {
  if (!rlsBypassActive) return;
  await sql`LOCK TABLE public.tenants IN SHARE ROW EXCLUSIVE MODE`.execute(trx);
  const { n } = await trx
    .selectFrom('tenants')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  if (Number(n) >= 1) {
    throw new ControlPlaneError(
      409,
      'TENANT_LIMIT_RLS_BYPASS',
      "This deployment runs with ALLOW_RLS_BYPASS_ROLE=true, which only works with one tenant: another tenant's data " +
        'would mix with it. Switch the server to the nuggets_app role to add more.'
    );
  }
}
