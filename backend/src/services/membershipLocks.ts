/**
 * The order membership changes take their row locks in. Two transactions that lock
 * the same rows in different orders can each hold one the other waits for: Postgres then
 * fails one of them (40P01, "deadlock detected"), which answers a 500. So a change to the
 * people of an organization or tenant, and deleting a user, takes its locks in this order,
 * a step's rows in id order:
 *
 *   1. organization_invitations: the ones it changes (removing someone from an
 *      organization revokes the open invitations to them, accepting one marks it used,
 *      deleting a user clears `invited_by` / `accepted_by` on theirs);
 *   2. users: the user's row, when deleting the user (FOR UPDATE); accepting an
 *      invitation takes the accepter's and the sender's, and adding someone to an
 *      organization (a deployment admin) or a tenant theirs and the adder's (FOR KEY SHARE,
 *      as the membership's foreign keys do, which otherwise took them only at the insert,
 *      after the membership rows or after a delete had gone through);
 *   3. organization_users: the member's row, and when the change could leave the
 *      organization without an admin (a demotion, a removal) its admins' too, in one
 *      statement (lockMember in OrganizationService), then decides on them as they stand:
 *      deciding from an unlocked read whether to lock the admins locked them after the
 *      member when the member was promoted in between; accepting takes the
 *      accepter's and the sender's in one statement; adding someone to a tenant
 *      share-locks theirs; deleting a user takes in one statement the admins of each
 *      organization they're in, their own memberships and the ones they created (it
 *      clears `created_by`);
 *   4. tenant_users: the same for tenants (lockMember in TenantAdminService); removing
 *      someone from an organization takes in one statement their memberships of its
 *      tenants and the admins of those;
 *   5. deployment_users: accepting a deployment admin's invitation share-locks their row;
 *      deleting a user takes in one statement theirs, the ones they created (it clears
 *      `created_by`) and the deleting admin's, then decides on the admin's role as it
 *      stands (deciding from an unlocked read let a removal of that role commit in
 *      between, still counting the deleted user as the admin who stays: the deployment was
 *      left with none); removing someone's deployment role takes the admins' rows and
 *      theirs in one statement, and then reads the remover's role under that lock;
 *      granting it takes the granter's row and the user's in one statement, after their
 *      accounts (step 2, FOR KEY SHARE), and decides on the granter's role as it stands.
 *      The serving role can't lock these rows itself, so each of these runs in a
 *      SECURITY DEFINER function (lock_deployment_admin, lock_deployment_users_of,
 *      revoke_deployment_admin, grant_deployment_admin);
 *
 * and only then writes. A change that holds a step's rows waits for another at the first
 * row they share, never on a row of an earlier step, so the one it waits for never waits
 * on it. Deleting a user cascades into the rows of steps 1, 3, 4 and 5 it locked first
 * (and into rows of the user's own, sessions and tokens, that a change locks only after
 * their membership row).
 *
 * A row changed while the lock waited is read again as it then is, and one deleted
 * meanwhile isn't returned, so a refusal that would leave a place without an admin
 * (LAST_ADMIN) counts the admins as they stand.
 */

/** An organization or tenant, as a refusal names it. */
export interface NamedPlace {
  uuid: string;
  name: string;
}

/**
 * Of the admin rows given (one membership table's, locked, every admin of each place the
 * user is in among them), the places `userId` is an admin of and nobody else is, by name.
 */
export function soleAdminOf(rows: { placeId: number; user_id: number; uuid: string; name: string }[], userId: number): NamedPlace[] {
  const places = new Map<number, NamedPlace & { theirs: boolean; others: number }>();
  for (const row of rows) {
    const place = places.get(row.placeId) ?? { uuid: row.uuid, name: row.name, theirs: false, others: 0 };
    if (row.user_id === userId) place.theirs = true;
    else place.others += 1;
    places.set(row.placeId, place);
  }
  return [...places.values()]
    .filter((p) => p.theirs && p.others === 0)
    .map(({ uuid, name }) => ({ uuid, name }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

/** "the organization "A" and of the tenants "B", "C"" */
export function describePlaces({ organizations, tenants }: { organizations: NamedPlace[]; tenants: NamedPlace[] }): string {
  const named = (kind: string, places: NamedPlace[]) =>
    `the ${kind}${places.length === 1 ? '' : 's'} ${places.map((p) => `"${p.name}"`).join(', ')}`;
  return [
    ...(organizations.length > 0 ? [named('organization', organizations)] : []),
    ...(tenants.length > 0 ? [named('tenant', tenants)] : []),
  ].join(' and of ');
}
