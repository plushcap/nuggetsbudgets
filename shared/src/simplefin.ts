import { z } from 'zod';
import { instant, nullableInstant } from './responses.js';
import { IMPORT_SETTING_KEYS } from './settings.js';

/**
 * SimpleFin organization-level connection types.
 *
 * A SimpleFin connection is a paid, per-connection credential owned by an
 * **organization** and reused by accounts across the org's ledgers (tenants).
 * The bearer credential (access URL) is encrypted at rest and NEVER crosses the
 * API boundary — these DTOs expose only status/metadata. Connection management
 * is org-admin scoped; account↔bank-account mapping is ledger-scoped.
 */

/** Lifecycle status of an org's SimpleFin connection. */
export const simpleFinConnectionStatus = z.enum(['active', 'error', 'disconnected']);
export type SimpleFinConnectionStatus = z.infer<typeof simpleFinConnectionStatus>;

/**
 * An organization's SimpleFin connection as returned by the API (GET, POST
 * /api/organizations/:uuid/simplefin/connection). Deliberately omits the access URL
 * (secret) — only metadata and aggregate mapping info.
 */
export const simpleFinConnectionDtoSchema = z.object({
  uuid: z.uuid(),
  label: z.string().nullable(),
  status: simpleFinConnectionStatus,
  lastSyncedAt: nullableInstant,
  createdAt: instant,
  /** Accounts across ALL the org's ledgers currently mapped to this connection. */
  mappedAccountCount: z.number().int(),
});
export type SimpleFinConnectionDto = z.infer<typeof simpleFinConnectionDtoSchema>;

/**
 * Create (or adopt) an org's connection from a SimpleFin **setup token** — the
 * base64 claim token from the user's SimpleFin app. The backend exchanges it for
 * the access URL, then encrypts and stores it.
 */
export const createSimpleFinConnectionSchema = z.object({
  setupToken: z.string({ error: 'Setup token is required' }).trim().min(1, 'Setup token is required'),
  label: z.string().trim().max(100, 'Label must be 100 characters or less').optional(),
});
export type CreateSimpleFinConnectionInput = z.infer<typeof createSimpleFinConnectionSchema>;

/** A single ledger account currently mapped to a discovered bank account. */
export const bankAccountMappingDtoSchema = z.object({
  accountUuid: z.uuid(),
  accountName: z.string(),
  tenantUuid: z.uuid(),
  tenantName: z.string(),
});
export type BankAccountMappingDto = z.infer<typeof bankAccountMappingDtoSchema>;

/** Map a ledger account to a discovered bank account (ledger-scoped action). */
export const mapSimpleFinAccountSchema = z.object({
  importAccountId: z.string({ error: 'Bank account is required' }).trim().min(1, 'Bank account is required'),
});
export type MapSimpleFinAccountInput = z.infer<typeof mapSimpleFinAccountSchema>;

/**
 * SimpleFIN Protocol v2 — structured error.
 * `code` is a categorized prefix+subcode: `gen.*` (general), `con.*` (connection,
 * carries `conn_id`, e.g. `con.auth`), `act.*` (account, carries `account_id`).
 * Replaces the deprecated v1 plain-string `errors[]`.
 */
export interface SimpleFinProtocolError {
  code: string;
  msg: string;
  conn_id?: string;
  account_id?: string;
}

/**
 * SimpleFIN Protocol v2 — Connection object. Represents one credential set to a
 * bank; an org may hold several for the same institution. Flatter replacement
 * for the per-account `org` object.
 */
export interface SimpleFinConnection {
  conn_id: string;
  name: string;
  org_id: string;
  org_url?: string;
  sfin_url: string;
}

/**
 * Connection health for an account, derived from cheap persisted fields (no live
 * SimpleFIN call): the v2 error code observed on the last sync + balance-date
 * freshness. Shared by the dashboard card, the per-account pill, and the
 * SimpleFin Accounts page so all three agree.
 */
export const accountConnectionStatus = z.enum(['connected', 'delayed', 'disconnected']);
export type AccountConnectionStatus = z.infer<typeof accountConnectionStatus>;

export interface AccountConnectionHealthInput {
  import_provider?: string | null;
  import_balance_date?: string | null; // ISO timestamp
  import_last_error_code?: string | null; // v2 code, e.g. 'con.auth'
}

export interface AccountConnectionHealth {
  status: AccountConnectionStatus;
  reason: string;
  /** True when the connection's credentials need re-auth (v2 `con.auth`). */
  needsReconnect: boolean;
}

const CONNECTION_FRESH_DAYS = 3;
const CONNECTION_STALE_DAYS = 14;

/** Derive an account's connection health. `nowMs` is injectable for testing. */
export function deriveAccountConnectionHealth(
  account: AccountConnectionHealthInput,
  nowMs: number = Date.now(),
): AccountConnectionHealth {
  const code = account.import_last_error_code ?? null;

  if (code) {
    if (code.startsWith('con.auth')) {
      return { status: 'disconnected', reason: 'Reconnect needed', needsReconnect: true };
    }
    if (code.startsWith('con')) {
      return { status: 'disconnected', reason: 'Connection error', needsReconnect: false };
    }
    if (code.startsWith('act')) {
      return { status: 'delayed', reason: 'Bank reported a temporary error', needsReconnect: false };
    }
    // gen.* (incl. rate/quota warnings) and anything else: a soft service issue.
    return { status: 'delayed', reason: 'Service issue at the provider', needsReconnect: false };
  }

  // No error → judge by balance-date freshness.
  if (!account.import_balance_date) {
    return { status: 'connected', reason: 'Connected', needsReconnect: false };
  }
  const ageMs = nowMs - new Date(account.import_balance_date).getTime();
  const ageDays = Math.floor(ageMs / 86_400_000);
  if (ageMs < CONNECTION_FRESH_DAYS * 86_400_000) {
    return { status: 'connected', reason: 'Up to date', needsReconnect: false };
  }
  if (ageMs < CONNECTION_STALE_DAYS * 86_400_000) {
    return { status: 'delayed', reason: `Last update ${ageDays} day${ageDays === 1 ? '' : 's'} ago`, needsReconnect: false };
  }
  return { status: 'disconnected', reason: `No update in ${ageDays} days`, needsReconnect: false };
}

// ---- The bank import's answers (/api/import) -----------------------------------------

/**
 * SimpleFin's own objects, which the import routes pass on as SimpleFin sent them: their
 * known fields are checked, and any others a bridge adds are kept as they came (they vary by
 * institution).
 */
export const simpleFinProtocolErrorResponseSchema = z.looseObject({
  code: z.string(),
  msg: z.string(),
  conn_id: z.string().optional(),
  account_id: z.string().optional(),
});
export const simpleFinBankConnectionResponseSchema = z.looseObject({
  conn_id: z.string(),
  name: z.string(),
  org_id: z.string(),
  org_url: z.string().optional(),
  sfin_url: z.string(),
});
/** A transaction as SimpleFin sent it (its fields vary by institution). */
export const simpleFinRawTransactionResponseSchema = z.looseObject({
  id: z.string(),
  posted: z.number(),
  amount: z.string(),
  description: z.string(),
});
export type SimpleFinRawTransaction = z.infer<typeof simpleFinRawTransactionResponseSchema>;

/**
 * GET /api/import/accounts: the organization's bank accounts as SimpleFin sent them, each
 * with the ledger accounts, across the organization, mapped to it.
 */
export const discoveredBankAccountResponseSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  currency: z.string().optional(),
  balance: z.string().optional(),
  'balance-date': z.number().optional(),
  conn_id: z.string().optional(),
  /** Protocol v1's institution (deprecated; v2 names it in `connections`). */
  org: z.looseObject({ name: z.string().optional() }).optional(),
  mappings: z.array(bankAccountMappingDtoSchema),
});
export type DiscoveredBankAccount = z.infer<typeof discoveredBankAccountResponseSchema>;
export const importAccountsResponseSchema = z.object({
  success: z.literal(true),
  accounts: z.array(discoveredBankAccountResponseSchema),
  errors: z.array(simpleFinProtocolErrorResponseSchema),
  connections: z.array(simpleFinBankConnectionResponseSchema),
});
export type ImportAccountsResponse = z.infer<typeof importAccountsResponseSchema>;

/**
 * GET /api/import/status: whether SimpleFin answers for the organization, the ledger's import
 * settings as stored (only those that are), and its automatic import: `enabled` is the stored
 * setting, `running` whether a timer is armed, `nextSyncTime` the next run while one is.
 */
export const importStatusResponseSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  provider: z.literal('simplefin'),
  settings: z.record(z.string(), z.string().nullable()),
  scheduler: z.object({
    enabled: z.boolean(),
    running: z.boolean(),
    nextSyncTime: nullableInstant,
    lastAutomaticSync: z.string().nullable(),
  }),
});
export type ImportStatus = z.infer<typeof importStatusResponseSchema>;

/** One of the ledger's import settings as GET /api/import/settings shows it: its stored value (or null), type and description. */
export const importSettingResponseSchema = z.object({
  value: z.string().nullable(),
  type: z.string(),
  description: z.string(),
});
export type ImportSettingDefinition = z.infer<typeof importSettingResponseSchema>;
/** GET /api/import/settings: every import setting, by key. */
export const importSettingsResponseSchema = z.object({
  settings: z.record(z.enum(IMPORT_SETTING_KEYS), importSettingResponseSchema),
});
export type ImportSettingsResponse = z.infer<typeof importSettingsResponseSchema>;
export type ImportSettingsMap = ImportSettingsResponse['settings'];

/** One person GET /api/import/users offers as the ledger's import user: someone with access to it, unlocked. */
export const importUserResponseSchema = z.object({
  id: z.number().int(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  email: z.string(),
});
export type ImportUser = z.infer<typeof importUserResponseSchema>;
export const importUsersResponseSchema = z.object({ success: z.literal(true), users: z.array(importUserResponseSchema) });
export type ImportUsersResponse = z.infer<typeof importUsersResponseSchema>;

/**
 * POST /api/import/sync: how a manual sync of the ledger ended. `status` is what its sync
 * log row says: 'partial' when accounts or transactions couldn't be saved, and `message`
 * then says what. A sync of the ledger already running is refused 409 instead.
 */
export const importSyncResponseSchema = z.object({
  success: z.boolean(),
  status: z.enum(['completed', 'partial', 'failed']),
  message: z.string(),
});
export type ImportSyncResponse = z.infer<typeof importSyncResponseSchema>;

/** POST /api/import/sync/:accountUuid: one account's sync, and what it did (`result`). */
export const importAccountSyncResponseSchema = z.object({
  success: z.boolean(),
  status: z.enum(['completed', 'partial', 'failed']).optional(),
  message: z.string(),
  error: z.string().optional(),
  result: z.object({
    success: z.boolean(),
    status: z.enum(['completed', 'partial']).optional(),
    notice: z.string().optional(),
    transactionsImported: z.number().int(),
    transactionsUpdated: z.number().int(),
    transactionsFailed: z.number().int().optional(),
    balanceAdjustments: z.number().int(),
    message: z.string(),
    error: z.string().optional(),
  }),
});
export type ImportAccountSyncResponse = z.infer<typeof importAccountSyncResponseSchema>;

/** One entry of the ledger's sync log (GET /api/import/sync-log): ids, counts and codes, never names or amounts. */
export const syncLogResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  sync_type: z.string(),
  sync_status: z.string(),
  sync_trigger: z.string(),
  import_provider: z.string(),
  institution_id: z.number().int().nullable(),
  account_id: z.number().int().nullable(),
  sync_start_time: nullableInstant,
  sync_end_time: nullableInstant,
  records_processed: z.number().int().nullable(),
  accounts_synced: z.number().int().nullable(),
  transactions_imported: z.number().int().nullable(),
  transactions_updated: z.number().int().nullable(),
  balance_adjustments_created: z.number().int().nullable(),
  /** What went wrong, written for people (publicErrorMessage), never an internal error's text. */
  error_message: z.string().nullable(),
  api_response_time_ms: z.number().int().nullable(),
  user_id: z.number().int().nullable(),
  created_at: instant,
});
export type SyncLog = z.infer<typeof syncLogResponseSchema>;
export const syncLogPageResponseSchema = z.object({
  success: z.literal(true),
  syncLogs: z.array(syncLogResponseSchema),
  pagination: z.object({ limit: z.number().int(), offset: z.number().int(), total: z.number().int() }),
});
export type SyncLogPage = z.infer<typeof syncLogPageResponseSchema>;

/** POST /api/import/scheduler/start and /stop: the ledger's automatic import turned on or off, and whether a timer is armed. */
export const importSchedulerResponseSchema = z.object({
  success: z.literal(true),
  running: z.boolean(),
  /** The ledger's next run, while a timer is armed (start only). */
  nextSyncTime: nullableInstant.optional(),
  message: z.string(),
});
export type ImportSchedulerResponse = z.infer<typeof importSchedulerResponseSchema>;

/** POST /api/import/test-sync: what SimpleFin has for the organization, read and not saved. */
export const importTestSyncResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  preview: z.object({
    accountCount: z.number().int(),
    accounts: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        balance: z.string(),
        currency: z.string(),
        transactionCount: z.number().int(),
      })
    ),
    errors: z.array(simpleFinProtocolErrorResponseSchema),
  }),
});
export type TestImportConnectionResponse = z.infer<typeof importTestSyncResponseSchema>;

/** POST /api/import/fix-budget-period-items: how many transactions it linked to their period's item, and how many it couldn't. */
export const importBudgetPeriodRepairResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  updated: z.number().int(),
  errors: z.number().int(),
});

/** One SimpleFin account as the SimpleFin accounts page lists it (GET /api/import/simplefin-accounts). */
export const simpleFinAccountInfoResponseSchema = z.object({
  simplefin_account_id: z.string(),
  simplefin_name: z.string(),
  simplefin_org: z.string().nullable(),
  nuggets_account_name: z.string().nullable(),
  /** How fresh its balance is: within 3 days, 14, or older. */
  status: z.enum(['Connected', 'Stale', 'Disconnected']),
  last_transaction_date: nullableInstant,
  balance_date: instant,
  balance: z.string(),
});
export type SimpleFinAccountInfo = z.infer<typeof simpleFinAccountInfoResponseSchema>;
export const simpleFinAccountsResponseSchema = z.object({
  success: z.literal(true),
  accounts: z.array(simpleFinAccountInfoResponseSchema),
  errors: z.array(simpleFinProtocolErrorResponseSchema),
  connections: z.array(simpleFinBankConnectionResponseSchema),
});
export type SimpleFinAccountsResponse = z.infer<typeof simpleFinAccountsResponseSchema>;

/**
 * GET /api/import/simplefin-account-transactions: one SimpleFin account's last `days`, read
 * live and not saved (research). `currency` and `available_balance` are SimpleFin's, as it
 * sent them.
 */
export const simpleFinAccountDetailResponseSchema = z.object({
  success: z.literal(true),
  account: z.object({
    id: z.string(),
    name: z.string(),
    org: z.string().nullable(),
    currency: z.unknown(),
    balance: z.string(),
    available_balance: z.unknown(),
    balance_date: nullableInstant,
  }),
  days: z.number().int(),
  transactions: z.array(simpleFinRawTransactionResponseSchema),
  errors: z.array(simpleFinProtocolErrorResponseSchema),
});
export type SimpleFinAccountDetailResponse = z.infer<typeof simpleFinAccountDetailResponseSchema>;

/**
 * POST /api/accounts/:uuid/connect-bank and /disconnect-bank, PATCH /import-settings: an
 * account's link to its bank account, or how it imports, changed.
 */
export const bankLinkChangedResponseSchema = z.object({ success: z.literal(true) });
