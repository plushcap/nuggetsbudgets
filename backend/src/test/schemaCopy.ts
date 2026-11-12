import type { Pool } from 'pg';

/**
 * Copy the public function `signature` (e.g. `revoke_deployment_admin(integer)`) into
 * `schema`, its definition as the database has it with `public` replaced by `schema`, for a
 * test whose copies of the control-plane tables live there (they are deployment-wide, so a
 * test that counts their rows can't share them with the files running alongside it).
 *
 * The copy is SECURITY INVOKER: rls-catalog.test.ts, which runs alongside, allows no SECURITY
 * DEFINER function but the tracked ones in public. So the copy runs as the app's role, which
 * needs the privileges on the copied tables that the function's owner has on the real ones;
 * servingRoleGrants.db.test.ts checks the real functions as the app's role.
 */
export async function copyFunctionToSchema(owner: Pool, signature: string, schema: string, appRole: string): Promise<void> {
  const { rows } = await owner.query<{ def: string }>('SELECT pg_get_functiondef($1::regprocedure) AS def', [`public.${signature}`]);
  const copy = rows[0].def
    .replace(/\bpublic\./g, `${schema}.`)
    .replace(/'public'/g, `'${schema}'`)
    .replace(/^ SECURITY DEFINER$/m, ' SECURITY INVOKER');
  if (copy.includes('public') || copy.includes('SECURITY DEFINER')) {
    throw new Error(`copyFunctionToSchema: the copy of ${signature} still names public or runs as its owner`);
  }
  await owner.query(copy);
  await owner.query(`REVOKE ALL ON FUNCTION ${schema}.${signature} FROM PUBLIC`);
  await owner.query(`GRANT EXECUTE ON FUNCTION ${schema}.${signature} TO ${appRole}`);
}
