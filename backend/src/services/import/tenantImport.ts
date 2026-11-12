import { sql } from 'kysely';
import { getDb, globalDb, withTenant } from '../../db/withTenant.js';
import { DomainError } from '../domainErrors.js';
import { loadTenantAccess } from '../MembershipService.js';
import type { SimplefinAccountSet } from './types.js';

/**
 * A ledger's bank import as its settings page reads it (/api/import): its sync log, who
 * may be its import user, and which of its accounts are linked to the bank. The import
 * itself is ImportService's.
 */

/** A request about the ledger's bank import that can't be carried out: answered with its status. */
export class ImportRequestError extends DomainError {}

/** A single-account sync of an account that isn't the ledger's, or isn't linked to the bank. */
export const accountNotLinked = (): ImportRequestError =>
  new ImportRequestError(404, 'NOT_FOUND', 'Account not found or not linked to bank import');

/** The research drill-down asked for an account SimpleFin didn't answer with. */
export const simpleFinAccountNotFound = (accountId: string): ImportRequestError =>
  new ImportRequestError(404, 'NOT_FOUND', 'Account not found in SimpleFin response', { accountId });

/** The import user must be someone who can open the ledger. */
export const notAnImportUser = (): ImportRequestError =>
  new ImportRequestError(400, 'VALIDATION_ERROR', 'import_user_id must be someone with access to this tenant');

/** A page of the active ledger's sync log, newest first, and how many entries it has. */
export async function readSyncLog({ limit, offset }: { limit: number; offset: number }) {
  const { count } = await getDb()
    .selectFrom('import_sync_log')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  const syncLogs = await getDb()
    .selectFrom('import_sync_log')
    .select([
      'id', 'uuid', 'sync_type', 'sync_status', 'sync_trigger', 'import_provider',
      'institution_id', 'account_id', 'sync_start_time', 'sync_end_time',
      'records_processed', 'accounts_synced', 'transactions_imported',
      'transactions_updated', 'balance_adjustments_created', 'error_message',
      'api_response_time_ms', 'user_id', 'created_at',
    ])
    .orderBy('sync_start_time', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();
  return { syncLogs, total: parseInt(count, 10) };
}

/**
 * Refuse an import user who can't open the ledger: the import stamps them as who made what
 * it writes, so they must have access to it (a member, or an admin of its organization),
 * not just an account, and not a locked one.
 */
export async function assertMayBeImportUser(userId: number, tenantId: number): Promise<void> {
  const user = await globalDb
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .where('is_locked', '=', false)
    .executeTakeFirst();
  const access = user ? await loadTenantAccess(userId, tenantId, false) : null;
  if (!access?.hasAccess) throw notAnImportUser();
}

/**
 * The people who may be the ledger's import user: those with access to it (its members and
 * its organization's admins), unlocked. users and the membership tables are
 * control plane (no RLS), so the ledger is named here.
 */
export async function importUserCandidates(tenantId: number) {
  return globalDb
    .selectFrom('users as u')
    .select(['u.id', 'u.first_name', 'u.last_name', 'u.email'])
    .where('u.is_locked', '=', false)
    .where((eb) =>
      eb.or([
        eb.exists(
          eb.selectFrom('tenant_users as tu').select(sql.lit(1).as('one'))
            .whereRef('tu.user_id', '=', 'u.id')
            .where('tu.tenant_id', '=', tenantId)
        ),
        eb.exists(
          eb.selectFrom('organization_users as ou')
            .innerJoin('tenants as t', 't.organization_id', 'ou.organization_id')
            .select(sql.lit(1).as('one'))
            .whereRef('ou.user_id', '=', 'u.id')
            .where('ou.is_admin', '=', true)
            .where('t.id', '=', tenantId)
        ),
      ])
    )
    .orderBy('u.first_name')
    .orderBy('u.last_name')
    .orderBy('u.id')
    .execute();
}

/**
 * Refuse a single-account sync of an account that isn't the ledger's or isn't linked to the
 * bank. In a short transaction of its own: the sync route has none open while
 * SimpleFin answers.
 */
export async function assertLinkedAccount(tenantId: number, accountUuid: string): Promise<void> {
  const linked = await withTenant(tenantId, () =>
    getDb()
      .selectFrom('accounts')
      .select('id')
      .where('uuid', '=', accountUuid)
      .where('import_account_id', 'is not', null)
      .executeTakeFirst()
  );
  if (!linked) throw accountNotLinked();
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The organization's SimpleFin accounts as the SimpleFin accounts page lists them: each with
 * the ledger account linked to it (in a short transaction of the ledger's), how fresh its
 * balance is, and when its last transaction posted.
 */
export async function describeSimpleFinAccounts(tenantId: number, sfData: SimplefinAccountSet, now = Date.now()) {
  const mappedRows = await withTenant(tenantId, () =>
    getDb()
      .selectFrom('accounts')
      .select(['name', 'import_account_id'])
      .where('import_account_id', 'is not', null)
      .where('import_provider', '=', 'simplefin')
      .execute()
  );
  const mappedAccounts = new Map<string, string>();
  for (const row of mappedRows) {
    if (row.import_account_id != null) mappedAccounts.set(row.import_account_id, row.name);
  }

  // v2: institution name comes from connections[] joined via account.conn_id;
  // fall back to the deprecated per-account org object (v1), for an account whose
  // connection names none (or that has none).
  const connById = new Map(
    (sfData.connections ?? []).map((c) => {
      const cc = c as typeof c & { org_name?: string };
      return [c.conn_id, cc.org_name ?? c.name ?? null] as const;
    })
  );

  return sfData.accounts.map((acc) => {
    // Connection status from how fresh the balance is.
    const ageMs = now - acc['balance-date'] * 1000;
    const status = ageMs < THREE_DAYS_MS ? 'Connected' : ageMs < FOURTEEN_DAYS_MS ? 'Stale' : 'Disconnected';

    let lastTransactionDate: string | null = null;
    if (acc.transactions && acc.transactions.length > 0) {
      const maxPosted = Math.max(...acc.transactions.map((t) => t.posted));
      lastTransactionDate = new Date(maxPosted * 1000).toISOString();
    }

    return {
      simplefin_account_id: acc.id,
      simplefin_name: acc.name,
      simplefin_org: (acc.conn_id ? connById.get(acc.conn_id) : null) ?? acc.org?.name ?? null,
      nuggets_account_name: mappedAccounts.get(acc.id) || null,
      status,
      last_transaction_date: lastTransactionDate,
      balance_date: new Date(acc['balance-date'] * 1000).toISOString(),
      balance: acc.balance,
    };
  });
}
