import * as crypto from 'crypto';
import type { Pool } from 'pg';

/**
 * A schema's fingerprint: one line per object in public, its kind and name and a hash of its
 * definition, read from the catalogs. The migration runner compares a database it has just
 * cut over from v2.4.0 with a fresh baseline's (upgrade/baseline-fingerprint.txt), and logs
 * what differs: a production database's schema has a history of its own (older upgrade
 * paths, a change by hand), which a fresh v2.4.0's doesn't show.
 *
 * What it covers: extensions; tables, views, sequences (kind, row security enabled and
 * forced); columns (type, NOT NULL, default, generated); constraints; indexes; triggers
 * (enabled or not); policies; view definitions; functions (their whole definition); enum and
 * domain types; and the privileges the two fixed roles hold on tables, views, sequences,
 * columns and functions: the serving role nuggets_app and PUBLIC (whoever granted them; the
 * owner's own, whose name differs per deployment, aren't read). Not comments (the cutover
 * sets them all) or column order. Each definition is read whole, as text.
 * Read with an empty search_path, so every name is schema-qualified whatever the session's,
 * and with a varchar CHECK spelled one way (as backend/scripts/schema-compare.sed does):
 * Postgres prints it one way as a migration made it and another once reloaded from a dump.
 * An extension's own objects count as their extension.
 */

/** Each object's key ("index public.idx_x") and a hash of its definition. */
export type SchemaFingerprint = Map<string, string>;

/** What a database has that a fingerprint doesn't, lacks, or has otherwise: object keys, sorted. */
export interface SchemaDrift {
  missing: string[];
  extra: string[];
  changed: string[];
}

const notAnExtensionMember = (catalog: string, oid: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend e WHERE e.classid = '${catalog}'::pg_catalog.regclass AND e.objid = ${oid} AND e.deptype = 'e')`;

/** The fixed roles whose privileges count: PUBLIC (grantee 0) and the serving role. */
const FIXED_GRANTEE = `(a.grantee = 0 OR a.grantee = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'nuggets_app'))`;
/** One privilege of a fixed role, as text: `PUBLIC EXECUTE`, `nuggets_app SELECT`, `… grantable`. */
const GRANT_TEXT = `CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE 'nuggets_app' END || ' ' || a.privilege_type
                    || CASE WHEN a.is_grantable THEN ' grantable' ELSE '' END`;
/** The fixed roles' privileges in `acl`, sorted and joined; null when they have none. */
const grantsIn = (acl: string) =>
  `(SELECT pg_catalog.string_agg(g.line, ', ' ORDER BY g.line)
      FROM (SELECT DISTINCT ${GRANT_TEXT} AS line FROM pg_catalog.aclexplode(${acl}) a WHERE ${FIXED_GRANTEE}) g)`;

// Every definition is cast to text: a UNION takes its column's type from the first branch,
// and `name` (extname's) would cut each one to 63 characters.
const FINGERPRINT_SQL = `
  SELECT 'extension ' || x.extname::text AS key, x.extname::text AS def FROM pg_catalog.pg_extension x
  UNION ALL
  SELECT 'relation ' || c.oid::pg_catalog.regclass::text,
         c.relkind::text || ' rls ' || c.relrowsecurity || ' force ' || c.relforcerowsecurity
    FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'public'::pg_catalog.regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
     AND ${notAnExtensionMember('pg_catalog.pg_class', 'c.oid')}
  UNION ALL
  SELECT 'column ' || c.oid::pg_catalog.regclass::text || '.' || pg_catalog.quote_ident(a.attname),
         pg_catalog.format_type(a.atttypid, a.atttypmod) || ' not null ' || a.attnotnull || ' default '
           || coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '-') || ' generated ' || a.attgenerated::text
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE c.relnamespace = 'public'::pg_catalog.regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND a.attnum > 0 AND NOT a.attisdropped AND ${notAnExtensionMember('pg_catalog.pg_class', 'c.oid')}
  UNION ALL
  SELECT 'constraint ' || CASE WHEN k.conrelid <> 0 THEN k.conrelid::pg_catalog.regclass::text ELSE k.contypid::pg_catalog.regtype::text END || '.'
           || pg_catalog.quote_ident(k.conname),
         pg_catalog.pg_get_constraintdef(k.oid) || ' validated ' || k.convalidated
    FROM pg_catalog.pg_constraint k
   WHERE k.connamespace = 'public'::pg_catalog.regnamespace AND ${notAnExtensionMember('pg_catalog.pg_constraint', 'k.oid')}
  UNION ALL
  SELECT 'index ' || i.indexrelid::pg_catalog.regclass::text, pg_catalog.pg_get_indexdef(i.indexrelid)
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
   WHERE c.relnamespace = 'public'::pg_catalog.regnamespace AND ${notAnExtensionMember('pg_catalog.pg_class', 'c.oid')}
  UNION ALL
  SELECT 'trigger ' || t.tgrelid::pg_catalog.regclass::text || '.' || pg_catalog.quote_ident(t.tgname),
         pg_catalog.pg_get_triggerdef(t.oid) || ' enabled ' || t.tgenabled::text
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
   WHERE c.relnamespace = 'public'::pg_catalog.regnamespace AND NOT t.tgisinternal
  UNION ALL
  SELECT 'policy ' || p.polrelid::pg_catalog.regclass::text || '.' || pg_catalog.quote_ident(p.polname),
         p.polpermissive || ' ' || p.polcmd::text || ' '
           || (SELECT pg_catalog.string_agg(CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r)::text END, ',' ORDER BY 1)
                 FROM pg_catalog.unnest(p.polroles) AS r)
           || ' using ' || coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '-')
           || ' check ' || coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '-')
    FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
   WHERE c.relnamespace = 'public'::pg_catalog.regnamespace
  UNION ALL
  SELECT 'view ' || c.oid::pg_catalog.regclass::text, pg_catalog.pg_get_viewdef(c.oid)
    FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'public'::pg_catalog.regnamespace AND c.relkind IN ('v', 'm')
     AND ${notAnExtensionMember('pg_catalog.pg_class', 'c.oid')}
  UNION ALL
  SELECT 'function ' || p.oid::pg_catalog.regprocedure::text, pg_catalog.pg_get_functiondef(p.oid)
    FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'public'::pg_catalog.regnamespace AND p.prokind IN ('f', 'p')
     AND ${notAnExtensionMember('pg_catalog.pg_proc', 'p.oid')}
  UNION ALL
  SELECT 'privileges relation ' || c.oid::pg_catalog.regclass::text,
         ${grantsIn(`coalesce(c.relacl, pg_catalog.acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))`)}
    FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'public'::pg_catalog.regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
     AND ${notAnExtensionMember('pg_catalog.pg_class', 'c.oid')}
  UNION ALL
  SELECT 'privileges column ' || c.oid::pg_catalog.regclass::text || '.' || pg_catalog.quote_ident(t.attname), ${grantsIn('t.attacl')}
    FROM pg_catalog.pg_attribute t JOIN pg_catalog.pg_class c ON c.oid = t.attrelid
   WHERE c.relnamespace = 'public'::pg_catalog.regnamespace AND t.attacl IS NOT NULL AND t.attnum > 0 AND NOT t.attisdropped
     AND ${notAnExtensionMember('pg_catalog.pg_class', 'c.oid')}
  UNION ALL
  SELECT 'privileges function ' || p.oid::pg_catalog.regprocedure::text,
         ${grantsIn(`coalesce(p.proacl, pg_catalog.acldefault('f'::"char", p.proowner))`)}
    FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'public'::pg_catalog.regnamespace AND ${notAnExtensionMember('pg_catalog.pg_proc', 'p.oid')}
  UNION ALL
  SELECT 'type ' || t.oid::pg_catalog.regtype::text,
         t.typtype::text || ' ' || coalesce(
           (SELECT pg_catalog.string_agg(e.enumlabel::text, ',' ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid),
           pg_catalog.format_type(t.typbasetype, t.typtypmod) || ' not null ' || t.typnotnull)
    FROM pg_catalog.pg_type t
   WHERE t.typnamespace = 'public'::pg_catalog.regnamespace AND t.typtype IN ('e', 'd')
     AND ${notAnExtensionMember('pg_catalog.pg_type', 't.oid')}`;

/**
 * One spelling for a CHECK on a varchar column (backend/scripts/schema-compare.sed):
 * `(col)::text = ANY ((ARRAY['a'::character varying, …])::text[])` and
 * `(col)::text = ANY (ARRAY[('a'::character varying)::text, …])` are one constraint.
 */
export function normalizedDefinition(definition: string): string {
  return definition
    .replace(/\(('(?:[^']|'')*'::character varying)\)::text/g, '$1')
    .replace(/ANY \(\(ARRAY\[([^\]]*)\]\)::text\[\]\)/g, 'ANY (ARRAY[$1])');
}

const hash = (definition: string) => crypto.createHash('sha256').update(normalizedDefinition(definition)).digest('hex').slice(0, 16);

/** The fingerprint of the schema `pool`'s database has, read in one read-only transaction. */
export async function schemaFingerprint(pool: Pool): Promise<SchemaFingerprint> {
  return new Map([...(await schemaDefinitions(pool))].map(([key, definition]) => [key, hash(definition)]));
}

/** What schemaFingerprint hashes: each object's key and its definition, whole. */
export async function schemaDefinitions(pool: Pool): Promise<Map<string, string>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SELECT pg_catalog.set_config('search_path', '', true)`);
    // A few seconds at most: a migration or a restore holding a table's lock makes the
    // comparison fail ("could not compare"), not the start wait.
    await client.query(`SELECT pg_catalog.set_config('lock_timeout', '3s', true), pg_catalog.set_config('statement_timeout', '10s', true)`);
    const { rows } = await client.query<{ key: string; def: string | null }>(FINGERPRINT_SQL);
    await client.query('COMMIT');
    // A fixed role with no privilege on an object is no line: one granted later is extra, one revoked missing.
    return new Map(rows.filter((row) => row.def !== null).map((row) => [row.key, row.def!]));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** A fingerprint as the file holds it: `key<TAB>hash` lines, sorted. */
export function fingerprintText(fingerprint: SchemaFingerprint): string {
  return [...fingerprint].map(([key, value]) => `${key}\t${value}`).sort().join('\n') + '\n';
}

/** The fingerprint a file holds (fingerprintText). */
export function parseFingerprint(text: string): SchemaFingerprint {
  const fingerprint: SchemaFingerprint = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.lastIndexOf('\t');
    if (tab < 1) throw new Error(`Not a fingerprint line: ${line.slice(0, 80)}`);
    fingerprint.set(line.slice(0, tab), line.slice(tab + 1).trim());
  }
  return fingerprint;
}

/** The objects `actual` lacks, has besides, or has otherwise than `expected`. */
export function compareFingerprints(expected: SchemaFingerprint, actual: SchemaFingerprint): SchemaDrift {
  const sorted = (keys: Iterable<string>) => [...keys].sort();
  return {
    missing: sorted([...expected.keys()].filter((key) => !actual.has(key))),
    extra: sorted([...actual.keys()].filter((key) => !expected.has(key))),
    changed: sorted([...expected].filter(([key, value]) => actual.has(key) && actual.get(key) !== value).map(([key]) => key)),
  };
}

/**
 * A cutover's comparison as lines for a person (the restore command prints them): the
 * objects that differ, the first 50 of each kind, or that there are none; null drift is a
 * comparison that couldn't be made.
 */
export function driftLines(drift: SchemaDrift | null): string[] {
  if (drift === null) return ["Its schema couldn't be compared with a fresh baseline's (the log says why)."];
  const count = drift.missing.length + drift.extra.length + drift.changed.length;
  if (count === 0) return ["Its schema is a fresh baseline's."];
  const list = (keys: string[]) => (keys.length > 50 ? `${keys.slice(0, 50).join(', ')} and ${keys.length - 50} more` : keys.join(', '));
  return [
    `Its schema differs from a fresh baseline's in ${count} object(s), as it did before the cutover (which went on all the same):`,
    ...(drift.missing.length ? [`  missing: ${list(drift.missing)}`] : []),
    ...(drift.extra.length ? [`  extra: ${list(drift.extra)}`] : []),
    ...(drift.changed.length ? [`  changed: ${list(drift.changed)}`] : []),
  ];
}
