import { sql } from 'kysely';
import { globalDb, getDb, organizationOfOpenTenant, withOrganization, withTenant } from '../db/withTenant.js';
import { EncryptionService } from './EncryptionService.js';
import { ControlPlaneError } from './controlPlaneErrors.js';
import { createLogger } from '../utils/logger.js';
import { simplefinErrorCodes } from '../utils/logSafeErrors.js';
import { assertSimpleFinUrl, simplefinRequest, SimpleFinUrlError } from '../utils/simplefinHttp.js';
import type {
  SimpleFinConnectionDto,
  SimpleFinConnectionStatus,
  BankAccountMappingDto,
  SimpleFinProtocolError,
} from '@nuggets/shared';

const logger = createLogger({ service: 'OrganizationSimpleFinService' });

/**
 * Organization-level SimpleFin connection management.
 *
 * The connection (one per org) lives in `organization_simplefin_connections`, under
 * the organization RLS policy: every read and write runs in
 * {@link withOrganization}, which joins a ledger's transaction (whose organization is
 * its tenant's) and otherwise opens a short one of its own. The SimpleFin calls run
 * outside any transaction.
 * The bearer credential (`access_url`) is stored AES-256-GCM-encrypted by
 * {@link EncryptionService} and only ever decrypted in-process for SimpleFin
 * calls — it is never returned to clients.
 *
 * Accounts (tenant-scoped, RLS) map to a connection via
 * `accounts.simplefin_connection_id`. Because RLS hides accounts from a
 * no-tenant context, any cross-ledger account work iterates the org's tenants
 * under {@link withTenant}.
 */

// One shared encryptor; initialize() is idempotent and loads the Docker secret.
const encryption = new EncryptionService();

// ---- SimpleFin API helpers ------------------------------------------------

interface RawSimplefinAccount {
  id: string;
  name: string;
  currency?: string | null;
  balance?: string | null;
  /** v2 — links to a Connection in `connections[]`. */
  conn_id?: string;
}

/**
 * Exchange a base64 SimpleFin **setup token** for a long-lived access URL. The token is
 * a URL the server POSTs to, so both it and the access URL it answers with must be on a
 * SimpleFin bridge host (simplefinHttp).
 */
export async function exchangeSetupToken(setupToken: string): Promise<string> {
  let claimUrl: URL;
  try {
    claimUrl = assertSimpleFinUrl(Buffer.from(setupToken, 'base64').toString('utf-8'));
  } catch (err) {
    if (err instanceof SimpleFinUrlError) {
      throw new ControlPlaneError(400, 'SIMPLEFIN_BAD_TOKEN', `Invalid SimpleFin setup token: ${err.message}.`);
    }
    throw new ControlPlaneError(400, 'SIMPLEFIN_BAD_TOKEN', 'Invalid SimpleFin setup token.');
  }

  let response;
  try {
    response = await simplefinRequest(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' }, maxBytes: 4096 });
  } catch (err) {
    logger.error({ err, host: claimUrl.hostname }, 'SimpleFin token exchange request failed');
    throw new ControlPlaneError(502, 'SIMPLEFIN_EXCHANGE_FAILED', 'Could not reach SimpleFin to claim the setup token.');
  }
  if (!response.ok) {
    logger.error({ status: response.status }, 'SimpleFin token exchange failed');
    throw new ControlPlaneError(502, 'SIMPLEFIN_EXCHANGE_FAILED', 'SimpleFin rejected the setup token.');
  }
  const accessUrl = response.text.trim();
  try {
    assertSimpleFinUrl(accessUrl);
  } catch (err) {
    logger.error({ err }, 'SimpleFin returned an access URL that is not allowed');
    throw new ControlPlaneError(502, 'SIMPLEFIN_EXCHANGE_FAILED', 'SimpleFin returned an invalid access URL.');
  }
  return accessUrl;
}

/**
 * Fetch the bank accounts visible to an access URL (validates the credential). The answer's
 * `connections` aren't read: nothing has used them since discovery was deleted.
 */
async function fetchBankAccounts(accessUrl: string): Promise<{ accounts: RawSimplefinAccount[] }> {
  let url: URL;
  try {
    url = new URL(accessUrl);
  } catch {
    throw new ControlPlaneError(400, 'SIMPLEFIN_BAD_URL', 'Stored SimpleFin access URL is malformed.');
  }
  const auth = url.username && url.password
    ? Buffer.from(`${url.username}:${url.password}`).toString('base64')
    : null;
  if (!auth) {
    throw new ControlPlaneError(400, 'SIMPLEFIN_BAD_URL', 'SimpleFin access URL is missing credentials.');
  }

  // SimpleFIN Protocol v2: structured errlist + connections.
  // The access URL carries a base path (e.g. `.../simplefin`) that must be kept
  // when appending `/accounts` — dropping it hits the wrong endpoint and 404s on
  // bridges served under a path (e.g. beta-bridge.simplefin.org). Credentials go
  // in the Authorization header, so they're excluded from the URL here.
  const basePath = url.pathname.replace(/\/$/, '');
  const apiUrl = `${url.protocol}//${url.host}${basePath}/accounts?balances-only=1&version=2`;
  let response;
  try {
    response = await simplefinRequest(apiUrl, { headers: { Authorization: `Basic ${auth}` }, maxBytes: 5 * 1024 * 1024 });
  } catch (err) {
    logger.error({ err, host: url.host }, 'SimpleFin account discovery request failed');
    throw new ControlPlaneError(502, 'SIMPLEFIN_DISCOVERY_FAILED', 'Could not reach SimpleFin to list the bank accounts.');
  }
  if (!response.ok) {
    logger.error({ status: response.status, host: url.host }, 'SimpleFin account discovery failed');
    throw new ControlPlaneError(502, 'SIMPLEFIN_DISCOVERY_FAILED', `SimpleFin API error: ${response.status}.`);
  }
  let data: {
    accounts?: RawSimplefinAccount[];
    errors?: string[];
    errlist?: SimpleFinProtocolError[];
  };
  try {
    data = JSON.parse(response.text);
  } catch {
    throw new ControlPlaneError(502, 'SIMPLEFIN_DISCOVERY_FAILED', 'SimpleFin answered with something other than JSON.');
  }
  // SimpleFIN errors flow to the error log (normalize any legacy v1 strings).
  const errlist = data.errlist ?? (data.errors ?? []).map((msg) => ({ code: 'gen.', msg }));
  if (errlist.length > 0) {
    // Codes and ids, not the errors' text, which may name the bank's accounts.
    logger.error({ simplefinErrors: simplefinErrorCodes(errlist), host: url.host }, 'SimpleFin discovery returned errors');
  }
  return { accounts: data.accounts ?? [] };
}

// ---- Connection row access ------------------------------------------------

/** Raw connection row for an org, or undefined. */
export async function getConnectionRow(orgId: number) {
  return withOrganization(orgId, (trx) =>
    trx
      .selectFrom('organization_simplefin_connections')
      .selectAll()
      .where('organization_id', '=', orgId)
      .executeTakeFirst()
  );
}

/** Active tenants belonging to an org (id/uuid/name), via the global table. */
async function orgTenants(orgId: number): Promise<Array<{ id: number; uuid: string; name: string }>> {
  return globalDb
    .selectFrom('tenants')
    .select(['id', 'uuid', 'name'])
    .where('organization_id', '=', orgId)
    .where('status', '=', 'active')
    .orderBy('id')
    .execute();
}

/**
 * Every ledger account across the org currently mapped to `connectionId`,
 * grouped by the bank account id (`import_account_id`). Iterates tenants under
 * `withTenant` so RLS exposes each ledger's rows.
 */
async function mappingsByBankAccount(
  orgId: number,
  connectionId: number
): Promise<Map<string, BankAccountMappingDto[]>> {
  const byBank = new Map<string, BankAccountMappingDto[]>();
  for (const tenant of await orgTenants(orgId)) {
    const rows = await withTenant(tenant.id, () =>
      getDb()
        .selectFrom('accounts')
        .select(['uuid', 'name', 'import_account_id'])
        .where('simplefin_connection_id', '=', connectionId)
        .where('import_account_id', 'is not', null)
        .execute()
    );
    for (const row of rows) {
      const bankId = row.import_account_id as string;
      const list = byBank.get(bankId) ?? [];
      list.push({
        accountUuid: row.uuid,
        accountName: row.name,
        tenantUuid: tenant.uuid,
        tenantName: tenant.name,
      });
      byBank.set(bankId, list);
    }
  }
  return byBank;
}

async function countMappedAccounts(orgId: number, connectionId: number): Promise<number> {
  const byBank = await mappingsByBankAccount(orgId, connectionId);
  let total = 0;
  for (const list of byBank.values()) total += list.length;
  return total;
}

function toDto(
  row: { uuid: string; label: string | null; status: string; last_synced_at: Date | null; created_at: Date },
  mappedAccountCount: number
): SimpleFinConnectionDto {
  return {
    uuid: row.uuid,
    label: row.label,
    status: row.status as SimpleFinConnectionStatus,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    mappedAccountCount,
  };
}

// ---- Public operations ----------------------------------------------------

/** The org's connection as a DTO (no credential), or null if none. */
export async function getConnection(orgId: number): Promise<SimpleFinConnectionDto | null> {
  const row = await getConnectionRow(orgId);
  if (!row) return null;
  const mapped = await countMappedAccounts(orgId, row.id);
  return toDto(row, mapped);
}

/**
 * Create or replace the org's connection from a setup token. Exchanges the
 * token, validates it by listing accounts, encrypts the access URL, and upserts
 * (one row per org). Returns the connection DTO.
 */
export async function createConnection(
  orgId: number,
  input: { setupToken: string; label?: string },
  userId: number
): Promise<SimpleFinConnectionDto> {
  const accessUrl = await exchangeSetupToken(input.setupToken);
  // Validate the credential works before persisting it.
  await fetchBankAccounts(accessUrl);

  const encrypted = await encryption.encryptString(accessUrl);

  const row = await withOrganization(orgId, (trx) =>
    trx
      .insertInto('organization_simplefin_connections')
      .values({
        organization_id: orgId,
        access_url: encrypted,
        label: input.label ?? null,
        status: 'active',
        created_by: userId,
      })
      .onConflict((oc) =>
        oc.column('organization_id').doUpdateSet({
          access_url: encrypted,
          label: input.label ?? null,
          status: 'active',
          updated_at: sql`NOW()`,
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow()
  );

  logger.info({ orgId, userId, connectionId: row.id }, 'SimpleFin connection created/updated');
  const mapped = await countMappedAccounts(orgId, row.id);
  return toDto(row, mapped);
}

/**
 * Disconnect the org's connection: unlink every mapped account across the org's
 * ledgers (clear import linkage), then delete the connection row.
 */
export async function deleteConnection(orgId: number): Promise<void> {
  const row = await getConnectionRow(orgId);
  if (!row) throw new ControlPlaneError(404, 'SIMPLEFIN_NOT_FOUND', 'No SimpleFin connection for this organization.');

  for (const tenant of await orgTenants(orgId)) {
    await withTenant(tenant.id, async () => {
      // In id order first, as a zone change and every other write of several
      // accounts lock them: the UPDATE alone took them in the order it found them.
      await getDb().selectFrom('accounts').select('id').where('simplefin_connection_id', '=', row.id).orderBy('id').forNoKeyUpdate().execute();
      await getDb()
        .updateTable('accounts')
        .set({
          simplefin_connection_id: null,
          import_account_id: null,
          import_enabled: false,
          import_provider: null,
          updated_at: sql`CURRENT_TIMESTAMP`,
        })
        .where('simplefin_connection_id', '=', row.id)
        .execute();
    });
  }

  await withOrganization(orgId, (trx) =>
    trx.deleteFrom('organization_simplefin_connections').where('id', '=', row.id).execute()
  );

  logger.info({ orgId, connectionId: row.id }, 'SimpleFin connection deleted and accounts unlinked');
}

/** Decrypted access URL for the org that owns `tenantId`, or null if none. */
export async function getAccessUrlForTenant(tenantId: number): Promise<string | null> {
  const row = await getConnectionForTenant(tenantId);
  if (!row) return null;
  return encryption.decryptString(row.access_url);
}

/**
 * Find an account in ANY of the org's ledgers (other than `exceptAccountUuid`)
 * already mapped to the given bank account on `connectionId`. Used to prevent
 * mapping one bank account to multiple Nuggets accounts, which would import the
 * same bank transactions into each (dedup keys on import_transaction_id +
 * account_id, so cross-account is not deduped). Returns null if unmapped.
 */
export async function findConflictingMapping(
  orgId: number,
  connectionId: number,
  importAccountId: string,
  exceptAccountUuid: string
): Promise<BankAccountMappingDto | null> {
  for (const tenant of await orgTenants(orgId)) {
    const row = await withTenant(tenant.id, () =>
      getDb()
        .selectFrom('accounts')
        .select(['uuid', 'name'])
        .where('simplefin_connection_id', '=', connectionId)
        .where('import_account_id', '=', importAccountId)
        .where('uuid', '!=', exceptAccountUuid)
        .executeTakeFirst()
    );
    if (row) {
      return { accountUuid: row.uuid, accountName: row.name, tenantUuid: tenant.uuid, tenantName: tenant.name };
    }
  }
  return null;
}

/**
 * The org's connection row resolved from a tenant id, or undefined. Inside the ledger's own
 * transaction its organization is the one that transaction set (withTenant), and the row is
 * read in it: reading `tenants` first took a second pooled connection while the ledger's
 * held one. Otherwise `tenants` (control plane) is read first, on its own.
 */
export async function getConnectionForTenant(tenantId: number) {
  let organizationId = organizationOfOpenTenant(tenantId);
  if (organizationId === undefined) {
    const tenant = await globalDb.selectFrom('tenants').select('organization_id').where('id', '=', tenantId).executeTakeFirst();
    organizationId = tenant?.organization_id ?? null;
  }
  if (organizationId === null) return undefined;
  return getConnectionRow(organizationId);
}

/**
 * Cross-ledger mapping annotations for the org that owns `tenantId`, keyed by
 * bank account id (`accounts.import_account_id`). Empty when the tenant's org
 * has no connection. Lets the per-ledger mapping UI proactively flag (gray out)
 * bank accounts already linked to another account elsewhere in the org — the
 * same duplicates the connect-bank guard rejects.
 */
export async function getMappingsByBankAccountForTenant(
  tenantId: number
): Promise<Record<string, BankAccountMappingDto[]>> {
  const row = await getConnectionForTenant(tenantId);
  if (!row) return {};
  const byBank = await mappingsByBankAccount(row.organization_id, row.id);
  return Object.fromEntries(byBank);
}

/** Stamp last_synced_at on the org's connection (called after a successful sync). */
export async function markSynced(orgId: number, connectionId: number): Promise<void> {
  await withOrganization(orgId, (trx) =>
    trx
      .updateTable('organization_simplefin_connections')
      .set({ last_synced_at: sql`NOW()`, status: 'active', updated_at: sql`NOW()` })
      .where('id', '=', connectionId)
      .execute()
  );
}

