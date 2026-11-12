import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client, type Pool } from 'pg';

/** A v2.4.0 install's database (src/test/fixtures/v2.4.0-install.sql), as its owner loads it. */
export const V2_4_0_INSTALL = path.join(import.meta.dirname, 'fixtures', 'v2.4.0-install.sql');

/**
 * Load the v2.4.0 install into `database` (empty), on a connection of its own: the dump
 * leaves its session's search_path empty.
 */
export async function loadV240Install(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(readFileSync(V2_4_0_INSTALL, 'utf8'));
  } finally {
    await client.end();
  }
}

/**
 * What pg_dump --schema-only compares, read from the catalogs (no pg_dump of the server's
 * version needed): the extensions, every relation with its privileges and row security,
 * columns, constraints, indexes, triggers, policies, views, functions with their bodies and
 * privileges, comments, default privileges and the database's own settings. Two databases
 * made one way or another have the same schema when their snapshots are equal.
 */
export async function schemaSnapshot(pool: Pool): Promise<Record<string, string[]>> {
  const queries: Record<string, string> = {
    extensions: `SELECT extname || ' ' || extversion FROM pg_extension`,
    relations: `SELECT c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '-') || ' rls ' || c.relrowsecurity || ' force ' || c.relforcerowsecurity
                  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace`,
    columns: `SELECT c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull || ' '
                     || coalesce(pg_get_expr(d.adbin, d.adrelid), '-') || ' ' || a.attgenerated::text || ' ' || coalesce(a.attacl::text, '-')
                FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
               WHERE c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped`,
    constraints: `SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) || ' ' || convalidated
                    FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
    indexes: `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    triggers: `SELECT pg_get_triggerdef(t.oid) || ' ' || t.tgenabled::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal`,
    policies: `SELECT tablename || ' ' || policyname || ' ' || permissive || ' ' || roles::text || ' ' || cmd || ' '
                      || coalesce(qual, '-') || ' ' || coalesce(with_check, '-')
                 FROM pg_policies WHERE schemaname = 'public'`,
    views: `SELECT viewname || ' ' || definition FROM pg_views WHERE schemaname = 'public'`,
    functions: `SELECT pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')`,
    functionPrivileges: `SELECT p.oid::regprocedure::text || ' ' || coalesce(p.proacl::text, '-') FROM pg_proc p
                          WHERE p.pronamespace = 'public'::regnamespace`,
    comments: `SELECT pg_describe_object(d.classoid, d.objoid, d.objsubid) || ': ' || d.description
                 FROM pg_description d CROSS JOIN LATERAL pg_identify_object(d.classoid, d.objoid, d.objsubid) o
                WHERE o.schema = 'public'`,
    defaultPrivileges: `SELECT defaclobjtype::text || ' ' || defaclacl::text FROM pg_default_acl`,
    databaseSettings: `SELECT unnest(setconfig) FROM pg_db_role_setting
                        WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) AND setrole = 0`,
  };
  const snapshot: Record<string, string[]> = {};
  for (const [name, query] of Object.entries(queries)) {
    const { rows } = await pool.query<{ line: string }>(`SELECT line FROM (${query}) AS q(line) ORDER BY 1`);
    snapshot[name] = rows.map((r) => r.line);
  }
  return snapshot;
}

/** The rows of schema_migrations: version, name and checksum, oldest first. */
export async function migrationRows(pool: Pool): Promise<{ version: string; name: string; checksum: string }[]> {
  return (await pool.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version')).rows;
}
