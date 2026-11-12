import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.generated.js';

/**
 * The lock that keeps a user's credentials consistent with their account.
 *
 * Ending a user's access (locking them, disabling sign-in, a password change or reset,
 * signing out everywhere, an admin revoking their tokens) and creating a credential for
 * them (signing in, rotating a session, minting a personal access token) each run in one
 * transaction that first locks the user's `users` row:
 *
 * - ending access takes it FOR UPDATE, changes the account, then revokes;
 * - creating a credential takes it FOR KEY SHARE, re-checks the account (and the
 *   credential the request came with) under it, then inserts.
 *
 * The two conflict, so they can't interleave: a credential is either created first, and
 * the revocation that follows ends it, or created after the revocation committed, and the
 * re-check refuses it. Without the lock a sign-in, rotation or mint that had passed its
 * checks before the change could insert after the revocation ran, and its credential
 * would outlive the change. FOR KEY SHARE doesn't conflict with ordinary updates of the
 * row (e.g. last_tenant_id), only with FOR UPDATE and deletes.
 *
 * Run both in READ COMMITTED (the default): each statement after the lock sees what a
 * transaction that held it before had committed.
 */

/** Lock the user's row before creating a credential; returns the account as it stands. */
export function lockUserForNewCredential(db: Kysely<DB>, userId: number) {
  return db
    .selectFrom('users')
    .select(['id', 'is_locked', 'login_disabled', 'password_changed_at', 'last_tenant_id'])
    .where('id', '=', userId)
    .forKeyShare()
    .executeTakeFirst();
}

/** Lock the user's row before ending their access. */
export async function lockUserForAccessChange(db: Kysely<DB>, userId: number): Promise<void> {
  await db.selectFrom('users').select('id').where('id', '=', userId).forUpdate().executeTakeFirst();
}
