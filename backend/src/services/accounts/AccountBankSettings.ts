import { sql } from 'kysely';
import type { UpdateObject } from 'kysely';
import type { DB } from '../../db/schema.generated.js';
import { getDb } from '../../db/withTenant.js';
import { getCurrentTenantId } from '../../context/requestContext.js';
import { getConnectionForTenant, findConflictingMapping } from '../OrganizationSimpleFinService.js';
import { isAssignableUser } from '../MembershipService.js';
import { AccountError, accountNotFound } from './AccountError.js';

/**
 * An account's link to the bank: which SimpleFin account it imports from, and how
 * the import treats it (rebalancing, matching, review, the default assignee). Runs on the
 * request's tenant transaction (getDb()). The organization's SimpleFin connection is
 * under the organization RLS policy, read through OrganizationSimpleFinService in this
 * same transaction (its organization is the ledger's).
 */

/**
 * Map the account to a bank account of the organization's SimpleFin connection, and turn
 * its import on. The caller is an organization admin: the connection covers every ledger
 * of the organization. One bank account maps to at most one account across the
 * organization's ledgers, or its transactions would import twice.
 */
export async function connectAccountToBank(uuid: string, importAccountId: unknown): Promise<void> {
  // Another ledger's account is not found.
  if (!(await getDb().selectFrom('accounts').select('id').where('uuid', '=', uuid).executeTakeFirst())) {
    throw accountNotFound();
  }

  // Tie the account to the organization's shared SimpleFin connection when one
  // exists. NULL stays valid: installs still on the legacy deployment-wide credential keep
  // working through ImportService's fallback.
  const tenantId = getCurrentTenantId();
  const connection = tenantId != null ? await getConnectionForTenant(tenantId) : undefined;

  if (connection) {
    const conflict = await findConflictingMapping(connection.organization_id, connection.id, String(importAccountId), String(uuid));
    if (conflict) {
      const message = `That bank account is already mapped to "${conflict.accountName}" in tenant "${conflict.tenantName}". Unmap it there first to avoid duplicate transactions.`;
      throw new AccountError(409, { error: message, code: 'SIMPLEFIN_BANK_ACCOUNT_ALREADY_MAPPED', message });
    }
  }

  await getDb()
    .updateTable('accounts')
    .set({
      // As the client sent it: pg writes a number as its text.
      import_account_id: importAccountId as string,
      import_enabled: true,
      import_provider: 'simplefin',
      simplefin_connection_id: connection?.id ?? null,
      updated_at: sql<Date>`CURRENT_TIMESTAMP`,
    })
    .where('uuid', '=', uuid)
    .execute();
}

/** The import settings a PATCH may change; anything else in the body is ignored. */
export interface AccountImportSettings {
  import_enabled?: unknown;
  import_account_rebalance?: unknown;
  import_auto_match_merchants?: unknown;
  import_auto_assign_budget_period?: unknown;
  import_auto_assign_budget_item?: unknown;
  import_auto_review?: unknown;
  import_default_assigned_to?: unknown;
}

const BOOLEAN_IMPORT_SETTINGS = [
  'import_enabled',
  'import_account_rebalance',
  'import_auto_match_merchants',
  'import_auto_assign_budget_period',
  'import_auto_assign_budget_item',
  'import_auto_review',
] as const;

/**
 * Change the import settings sent: each flag only when it is a boolean, and the default
 * assignee to null ('' or null) or to someone with access to the ledger.
 */
export async function updateAccountImportSettings(uuid: string, settings: AccountImportSettings): Promise<void> {
  const updateValues: UpdateObject<DB, 'accounts'> = {};
  for (const key of BOOLEAN_IMPORT_SETTINGS) {
    const value = settings[key];
    if (typeof value === 'boolean') updateValues[key] = value;
  }

  const assignee = settings.import_default_assigned_to;
  if (assignee !== undefined) {
    if (assignee === null || assignee === '') {
      updateValues.import_default_assigned_to = null;
    } else if (await isAssignableUser(assignee, getCurrentTenantId())) {
      updateValues.import_default_assigned_to = Number(assignee);
    } else {
      throw new AccountError(400, {
        error: 'import_default_assigned_to must be a user with access to this tenant',
        code: 'INVALID_ASSIGNEE',
      });
    }
  }

  if (Object.keys(updateValues).length === 0) throw new AccountError(400, { error: 'No valid settings provided' });

  updateValues.updated_at = sql<Date>`CURRENT_TIMESTAMP`;
  const updated = await getDb().updateTable('accounts').set(updateValues).where('uuid', '=', uuid).executeTakeFirst();
  if (!updated.numUpdatedRows) throw accountNotFound();
}

/** Stop the account's imports. Its transactions and balance stay as they are. */
export async function disconnectAccountFromBank(uuid: string): Promise<void> {
  const updated = await getDb()
    .updateTable('accounts')
    .set({
      import_account_id: null,
      import_enabled: false,
      import_account_rebalance: false,
      updated_at: sql<Date>`CURRENT_TIMESTAMP`,
    })
    .where('uuid', '=', uuid)
    .executeTakeFirst();
  if (!updated.numUpdatedRows) throw accountNotFound();
}
