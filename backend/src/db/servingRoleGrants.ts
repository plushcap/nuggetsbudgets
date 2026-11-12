/**
 * The object privileges the baseline (init.sql) and the migrations give the serving role
 * (nuggets_app), for a database that has none: a restore leaves the archive's privileges
 * out (BackupService), so these are the only ones the restored database gets.
 *
 * - The blanket grants: DML on every table, the sequences, EXECUTE on every routine, and
 *   the same for later objects (the baseline's default privileges).
 * - Then what is taken back: the tables the serving role may only read, the deployment
 *   row it may read and set the setup token of but not add or delete, and the SECURITY
 *   DEFINER functions only it may run (EXECUTE revoked from PUBLIC, which a function has
 *   by default).
 *
 * A migration that narrows the serving role's grants again changes this too;
 * BackupService.roundTrip.db.test.ts checks a restored database's grants are the migrated ones.
 */

/** Tables RLS doesn't cover that the serving role may only read (it writes them through functions, or not at all). */
export const SERVING_ROLE_READ_ONLY_TABLES = ['deployment_users', 'schema_migrations'] as const;

/**
 * The columns of the deployment row the serving role may set (SetupTokenService); it may read
 * the row but not add or delete one. Deleting it would cascade to every deployment_users row,
 * and the functions below use the row with the lowest id, which an added one could be.
 */
export const SERVING_ROLE_DEPLOYMENT_COLUMNS = ['setup_token_hash'] as const;

/**
 * The SECURITY DEFINER functions in public, which only the serving role may run. Each is
 * also a tracked exception in rls-catalog.test.ts.
 */
export const SERVING_ROLE_DEFINER_FUNCTIONS = [
  'grant_deployment_admin(integer,integer)',
  'lock_deployment_admin(integer)',
  'lock_deployment_users_of(integer,integer)',
  'revoke_deployment_admin(integer)',
] as const;

/**
 * Takes EXECUTE on the SECURITY DEFINER functions from PUBLIC, which a function has by default
 * and a restore (pg_restore --no-privileges) leaves it with. Needed whichever role serves: a
 * serving role that is the owner may run them anyway, but every other role could too.
 */
export function definerFunctionsRevokeSql(): string {
  return SERVING_ROLE_DEFINER_FUNCTIONS.map((fn) => `REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC;`).join('\n');
}

/** The grant script for the serving role, `role` already quoted as an identifier. */
export function servingRoleGrantsSql(role: string): string {
  const readOnly = SERVING_ROLE_READ_ONLY_TABLES.map((t) => `public.${t}`).join(', ');
  const deploymentColumns = SERVING_ROLE_DEPLOYMENT_COLUMNS.join(', ');
  return [
    `GRANT USAGE ON SCHEMA public TO ${role};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};`,
    `GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO ${role};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${role};`,
    `REVOKE INSERT, UPDATE, DELETE ON ${readOnly} FROM ${role};`,
    `REVOKE INSERT, UPDATE, DELETE ON public.deployment FROM ${role};`,
    `GRANT UPDATE (${deploymentColumns}) ON public.deployment TO ${role};`,
    definerFunctionsRevokeSql(),
  ].join('\n');
}
