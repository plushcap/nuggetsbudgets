/**
 * API fixtures for page tests, built from the `@nuggets/shared` response schemas.
 *
 * Each builder writes a row as the API sends it (NUMERIC columns as pg's strings, calendar
 * dates as 'YYYY-MM-DD', instants with their offset), typed as the schema's input, and checks
 * it with `answerProblem`: a fixture with a field the schema refuses (an unknown enum value,
 * '' as money, three decimals, a bad uuid) or one it doesn't name fails where it's built. The
 * frontend's api modules parse what the page reads with the same schemas.
 */
import type { z } from 'zod';
import {
  IMPORT_SETTING_KEYS,
  accountResponseSchema,
  adminUserListItemResponseSchema,
  adminUserUpdatedResponseSchema,
  annotationResponseSchema,
  annotationTimelineResponseSchema,
  answerProblem,
  attachmentResponseSchema,
  authMeResponseSchema,
  backupFileResponseSchema,
  backupListResponseSchema,
  backupStartedResponseSchema,
  backupStatusResponseSchema,
  budgetItemMatchingRuleListEntryResponseSchema,
  budgetItemMatchingRuleResponseSchema,
  generalSettingResponseSchema,
  importSettingsResponseSchema,
  loginResponseSchema,
  membershipSummarySchema,
  oneDriveStatusResponseSchema,
  ownAccountResponseSchema,
  settingsActionResponseSchema,
  budgetItemResponseSchema,
  budgetPeriodItemResponseSchema,
  budgetPeriodResponseSchema,
  buyResponseSchema,
  categoryResponseSchema,
  compositionUpsertResponseSchema,
  concentrationResponseSchema,
  costBasisMethodResponseSchema,
  dividendResponseSchema,
  feeResponseSchema,
  holdingResponseSchema,
  institutionResponseSchema,
  merchantLiteResponseSchema,
  merchantResponseSchema,
  merchantRuleResponseSchema,
  mergerCashResponseSchema,
  mergerStockResponseSchema,
  priceUpsertResponseSchema,
  returnOfCapitalResponseSchema,
  securityResponseSchema,
  sellResponseSchema,
  spinoffResponseSchema,
  splitResponseSchema,
  tagResponseSchema,
  taxLossHarvestResponseSchema,
  taxLotResponseSchema,
  tenantUserResponseSchema,
  transactionPageResponseSchema,
  transactionRangeDeleteResponseSchema,
  transactionRangePreviewResponseSchema,
  transactionResponseSchema,
} from '@nuggets/shared';

/** A NUMERIC column as pg sends it: a string with two decimals. */
export type WireMoney = string;

/** Throws, naming the fixture, when `value` isn't exactly something the API could send. */
function checked<S extends z.ZodType>(schema: S, name: string, value: z.input<S>): z.input<S> {
  const problem = answerProblem(schema, value);
  if (problem) throw new Error(`Fixture ${name} breaks the API contract: ${problem}`);
  return value;
}

/** A uuid in v7 form, numbered so tests can tell rows apart. */
export const uuidFor = (kind: number, n: number) =>
  `0190a000-${kind.toString(16).padStart(4, '0')}-7000-8000-${n.toString(16).padStart(12, '0')}`;

const STAMP = '2026-10-01T12:00:00.000Z';

// --- accounts ---------------------------------------------------------------

export type AccountWire = z.input<typeof accountResponseSchema>;

export function account(overrides: Partial<AccountWire> & { id: number; name: string }): AccountWire {
  return checked(accountResponseSchema, `account ${overrides.name}`, {
    uuid: uuidFor(1, overrides.id),
    type: 'Asset',
    account_type: 'checking',
    account_group: 'cash',
    icon: 'wallet',
    account_number: null,
    routing_number: null,
    notes: null,
    instructions: null,
    account_image: null,
    close_account: false,
    hide_transactions: false,
    hide_account: false,
    exclude_account_balance: false,
    is_envelope_account: false,
    require_zero_balance: false,
    default_pay_from_account_id: null,
    institution_current_balance: null,
    institution_available_balance: null,
    import_balance: null,
    import_available_balance: null,
    institution_balance: 0,
    import_enabled: false,
    import_account_id: null,
    import_account_rebalance: false,
    import_auto_match_merchants: false,
    import_auto_assign_budget_period: false,
    import_auto_assign_budget_item: false,
    import_provider: null,
    import_balance_date: null,
    import_last_sync: null,
    import_last_error_code: null,
    import_last_error_at: null,
    created_at: STAMP,
    updated_at: STAMP,
    institution_id: null,
    institution_uuid: null,
    institution_name: null,
    institution_notes: null,
    calculated_balance: '0.00',
    balance_unavailable: false,
    ...overrides,
  });
}

/** GET /accounts answers `{ accounts: [...] }`. */
export const accountsResponse = (accounts: AccountWire[]) => ({ accounts });

// --- budgets ----------------------------------------------------------------

export type BudgetPeriodWire = z.input<typeof budgetPeriodResponseSchema>;

export function budgetPeriod(year: number, month: number, overrides: Partial<BudgetPeriodWire> = {}): BudgetPeriodWire {
  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const id = year * 100 + month;
  return checked(budgetPeriodResponseSchema, `budget period ${year}-${month}`, {
    id,
    uuid: uuidFor(2, id),
    tenant_id: 1,
    name: `${year}-${month}`,
    month: new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }),
    year,
    month_number: month,
    start_date: `${year}-${mm}-01`,
    end_date: `${year}-${mm}-${lastDay}`,
    status: 'active',
    archived_at: null,
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  });
}

export type BudgetItemWire = z.input<typeof budgetItemResponseSchema>;

export function budgetItem(overrides: Partial<BudgetItemWire> & { id: number; name: string }): BudgetItemWire {
  return checked(budgetItemResponseSchema, `budget item ${overrides.name}`, {
    uuid: uuidFor(3, overrides.id),
    tenant_id: 1,
    description: null,
    expense_type: 'Expense',
    priority: 'Essential',
    type: 'Monthly',
    subtype: 'Fixed',
    status: 'active',
    rollover: false,
    isbill: false,
    recurring_payment: false,
    recurring_amount_varies: false,
    default_budget_amount: '0.00',
    rollover_starting_balance: '0.00',
    rollover_starting_balance_date: null,
    rollover_target_amount: '0.00',
    rollover_target_date: null,
    recurring_payment_frequency: 12,
    recurring_payment_amount: '0.00',
    recurring_last_payment_date: null,
    recurring_next_payment_date: null,
    goal_target_amount: null,
    goal_target_date: null,
    notes: null,
    instructions: null,
    color: 'blue',
    icon: 'circle',
    image_path: null,
    merchant_id: null,
    category_id: null,
    transaction_auto_tag_id: null,
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  });
}

export type BudgetPeriodItemWire = z.input<typeof budgetPeriodItemResponseSchema>;

/**
 * A budget period item with its computed figures, as GET
 * /budgets/periods/:uuid/items sends it (inside `{ success, data }`).
 */
export function budgetPeriodItem(
  period: Pick<BudgetPeriodWire, 'id'>,
  overrides: Partial<BudgetPeriodItemWire> & { id: number; budget_item_name: string },
): BudgetPeriodItemWire {
  return checked(budgetPeriodItemResponseSchema, `budget period item ${overrides.budget_item_name}`, {
    uuid: uuidFor(4, overrides.id),
    tenant_id: 1,
    budget_period_id: period.id,
    budget_item_id: overrides.id,
    budget_item_uuid: uuidFor(3, overrides.id),
    starting: '0.00',
    calculated_budget: '0.00',
    calculated_actual: '0.00',
    calculated_transfers: '0.00',
    calculated_remaining: '0.00',
    expense_type: 'Expense',
    priority: 'Essential',
    type: 'Monthly',
    subtype: 'Fixed',
    status: 'active',
    rollover: false,
    rollover_target_amount: '0.00',
    isbill: false,
    goal_target_amount: null,
    goal_target_date: null,
    image_path: null,
    icon: 'circle',
    color: 'blue',
    category_name: null,
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  });
}

// --- budget item matching rules ---------------------------------------

export type MatchingRuleWire = z.input<typeof budgetItemMatchingRuleListEntryResponseSchema>;
export type SavedMatchingRuleWire = z.input<typeof budgetItemMatchingRuleResponseSchema>;

/** A rule as GET /budgets/item-matching-rules lists it, with its item's and merchant's names. */
export function matchingRule(overrides: Partial<MatchingRuleWire> & { id: number }): MatchingRuleWire {
  return checked(budgetItemMatchingRuleListEntryResponseSchema, `matching rule ${overrides.id}`, {
    uuid: uuidFor(9, overrides.id),
    budget_item_id: 5,
    merchant_id: null,
    method: 'contains',
    matching_text: `TEXT${overrides.id}`,
    amount_min: null,
    amount_max: null,
    priority: 100,
    is_active: true,
    notes: null,
    created_at: STAMP,
    updated_at: STAMP,
    budget_item_name: 'Groceries',
    budget_item_uuid: uuidFor(5, 5),
    budget_item_icon: null,
    budget_item_color: null,
    merchant_name: null,
    ...overrides,
  });
}

const RULE_COLUMNS = [
  'id', 'uuid', 'budget_item_id', 'merchant_id', 'method', 'matching_text', 'amount_min', 'amount_max',
  'priority', 'is_active', 'notes', 'created_at', 'updated_at',
] as const;

/** The create or update answer for `rule` with `body` saved over it: the rule's own columns, without the names. */
export function savedMatchingRule(rule: Partial<MatchingRuleWire>, body: object = {}): SavedMatchingRuleWire {
  const merged = { ...rule, ...body } as Record<string, unknown>;
  const saved = Object.fromEntries(RULE_COLUMNS.map((column) => [column, merged[column] ?? null]));
  return checked(budgetItemMatchingRuleResponseSchema, `saved matching rule ${String(merged.id)}`, {
    ...saved,
    is_active: merged.is_active !== false,
    created_at: STAMP,
    updated_at: STAMP,
  } as SavedMatchingRuleWire);
}

// --- transactions -----------------------------------------------------------

export type TransactionWire = z.input<typeof transactionResponseSchema>;

/** A transaction as the lists send it (the fields every transaction answer has; add the others as overrides). */
export function transaction(overrides: Partial<TransactionWire> & { id: number }): TransactionWire {
  return checked(transactionResponseSchema, `transaction ${overrides.id}`, {
    uuid: uuidFor(5, overrides.id),
    description: `Transaction ${overrides.id}`,
    amount: '-10.00',
    type: 'expense',
    status: 'cleared',
    review_status: 'needs review',
    transaction_date: '2026-10-15',
    budget_item_id: null,
    budget_period_id: null,
    budget_period_item_id: null,
    merchant_id: null,
    is_split_parent: false,
    parent_transaction_id: null,
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  });
}

/** GET /transactions/paginated. */
export const transactionsPage = (transactions: TransactionWire[], { page = 1, limit = 30, total = transactions.length } = {}) =>
  checked(transactionPageResponseSchema, 'transactions page', {
    transactions,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  });

// --- users ------------------------------------------------------------------

export type TenantUserWire = z.input<typeof tenantUserResponseSchema>;

/** One of the ledger's people, as GET /tenants/current/users lists them. */
export function user(overrides: Partial<TenantUserWire> & { id: number; first_name: string | null }): TenantUserWire {
  return checked(tenantUserResponseSchema, `user ${overrides.first_name}`, {
    uuid: uuidFor(6, overrides.id),
    last_name: 'Example',
    profile_image: null,
    default_color: null,
    icon: null,
    ...overrides,
  });
}

// --- people, sign-in and settings ----------------------------------

export type OwnAccountWire = z.input<typeof ownAccountResponseSchema>;
export type MembershipWire = z.input<typeof membershipSummarySchema>;

/** The signed-in person's own account, as GET /auth/me answers it (`user`). */
export function ownAccount(overrides: Partial<OwnAccountWire> & { id: number } = { id: 1 }): OwnAccountWire {
  return checked(ownAccountResponseSchema, `own account ${overrides.id}`, {
    uuid: uuidFor(8, overrides.id),
    email: `person${overrides.id}@example.com`,
    first_name: 'Ada',
    last_name: 'Lovelace',
    default_color: null,
    icon: null,
    profile_image: null,
    created_at: STAMP,
    must_change_password: false,
    ...overrides,
  });
}

/** The person's ledgers and roles (GET /auth/tenants, and /me's `membership`): none, unless given. */
export function membership(overrides: Partial<MembershipWire> = {}): MembershipWire {
  return checked(membershipSummarySchema, 'membership', {
    isDeploymentAdmin: false,
    activeTenant: null,
    tenantRole: null,
    orgRole: null,
    tenants: [],
    organizations: [],
    ...overrides,
  });
}

/** GET /auth/me. */
export const authMe = (user: OwnAccountWire = ownAccount(), member: MembershipWire = membership()) =>
  checked(authMeResponseSchema, 'auth me', { user, membership: member });

/** POST /auth/login: signed in, with the account as /me answers it. */
export const loginAnswer = (user: OwnAccountWire = ownAccount()) =>
  checked(loginResponseSchema, 'login', { message: 'Login successful', user });

/** A write that answers only that it worked: `{ success: true, message }`. */
export const settingsAction = (message = 'Settings updated successfully') =>
  checked(settingsActionResponseSchema, 'settings action', { success: true, message });

export type GeneralSettingWire = z.input<typeof generalSettingResponseSchema>;

/** One of the ledger's general settings (GET /settings/general): the time zone, unless given. */
export function generalSetting(overrides: Partial<GeneralSettingWire> = {}): GeneralSettingWire {
  return checked(generalSettingResponseSchema, `general setting ${overrides.setting_key ?? 'application_timezone'}`, {
    setting_key: 'application_timezone',
    setting_type: 'string',
    description: "This tenant's time zone (an IANA name such as America/New_York)",
    setting_value: 'UTC',
    is_user_configurable: true,
    ...overrides,
  });
}

/** GET /import/settings: every import setting, none stored unless `values` gives it. */
export function importSettings(values: Partial<Record<(typeof IMPORT_SETTING_KEYS)[number], string | null>> = {}) {
  const settings = Object.fromEntries(
    IMPORT_SETTING_KEYS.map((key) => [key, { value: values[key] ?? null, type: key === 'import_days_back' || key === 'import_user_id' ? 'integer' : 'string', description: `The ${key} setting` }])
  ) as z.input<typeof importSettingsResponseSchema>['settings'];
  return checked(importSettingsResponseSchema, 'import settings', { settings });
}

export type AdminUserWire = z.input<typeof adminUserListItemResponseSchema>;

/** An account as a deployment admin's Users page lists it (GET /admin/users). */
export function adminUser(overrides: Partial<AdminUserWire> & { id: number; first_name: string }): AdminUserWire {
  return checked(adminUserListItemResponseSchema, `admin user ${overrides.first_name}`, {
    uuid: uuidFor(9, overrides.id),
    email: `${overrides.first_name.toLowerCase()}@example.com`,
    last_name: 'Doe',
    profile_image: null,
    default_color: null,
    icon: null,
    is_locked: false,
    login_disabled: false,
    is_deployment_admin: false,
    created_at: STAMP,
    ...overrides,
  });
}

/** PUT /admin/users/:uuid: the account as saved (the list's fields, but is_deployment_admin). */
export const adminUserUpdated = (account: AdminUserWire) => {
  const saved = Object.fromEntries(Object.entries(account).filter(([key]) => key !== 'is_deployment_admin'));
  return checked(adminUserUpdatedResponseSchema, 'admin user updated', {
    message: 'User updated successfully',
    user: saved as z.input<typeof adminUserUpdatedResponseSchema>['user'],
  });
};

export type BackupStatusWire = z.input<typeof backupStatusResponseSchema>;

/** GET /backup/status: automatic backups set up and off, no scheduler armed, unless given. */
export function backupStatus(overrides: Partial<BackupStatusWire['scheduler']> & { configured?: boolean } = {}): BackupStatusWire {
  const { configured = true, ...scheduler } = overrides;
  const enabled = scheduler.enabled ?? false;
  return checked(backupStatusResponseSchema, 'backup status', {
    configured,
    enabled,
    scheduler: {
      enabled,
      running: false,
      hasRunningBackup: false,
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastRunOutcome: null,
      waitingForBackupKey: false,
      ...scheduler,
    },
  });
}

/** GET /backup/list: these backup files. */
export const backupList = (backups: z.input<typeof backupFileResponseSchema>[] = []) =>
  checked(backupListResponseSchema, 'backup list', { success: true, backups });

/** GET /onedrive/status while OneDrive isn't set up for the deployment. */
export const oneDriveNotConfigured = () =>
  checked(oneDriveStatusResponseSchema, 'OneDrive status', {
    success: true,
    configured: false,
    message: 'OneDrive integration not configured.',
  });

/** POST /backup/create and the restores (202): started. */
export const backupStarted = (message = 'Backup started') =>
  checked(backupStartedResponseSchema, 'backup started', { success: true, started: true, message });

// --- deleting a range of transactions (/data-management) ------------------------

export type DeletionPreviewWire = z.input<typeof transactionRangePreviewResponseSchema>;
export type DeletionResultWire = z.input<typeof transactionRangeDeleteResponseSchema>;

/** What a deletion's preview found; `selectionKey` is 64 hex digits, as the server makes it. */
export function deletionPreview(overrides: Partial<DeletionPreviewWire> = {}): DeletionPreviewWire {
  return checked(transactionRangePreviewResponseSchema, 'deletion preview', {
    success: true,
    count: 0,
    affectedAccounts: 0,
    totalIncome: 0,
    totalExpenses: 0,
    earliestDate: null,
    latestDate: null,
    selectionKey: 'a'.repeat(64),
    ...overrides,
  });
}

/** What the deletion removed: the preview's figures, no key, and whether it backed up first. */
export function deletionResult(overrides: Partial<DeletionResultWire> = {}): DeletionResultWire {
  return checked(transactionRangeDeleteResponseSchema, 'deletion', {
    success: true,
    count: 0,
    affectedAccounts: 0,
    totalIncome: 0,
    totalExpenses: 0,
    earliestDate: null,
    latestDate: null,
    backupCreated: false,
    ...overrides,
  });
}

// --- investments ------------------------------------------------------------

export type SecurityWire = z.input<typeof securityResponseSchema>;

export function security(overrides: Partial<SecurityWire> & { id: number; ticker: string }): SecurityWire {
  return checked(securityResponseSchema, `security ${overrides.ticker}`, {
    uuid: uuidFor(7, overrides.id),
    tenant_id: 1,
    ticker_key: overrides.ticker.toUpperCase(),
    name: `${overrides.ticker} Fund`,
    security_type: 'etf',
    exchange: null,
    currency: 'USD',
    is_active: true,
    is_custom: false,
    is_pass_through: false,
    track_underlying_holdings: false,
    expense_ratio_percentage: null,
    notes: null,
    last_price_update_at: null,
    last_composition_update_at: null,
    last_expense_ratio_update_at: null,
    created_at: STAMP,
    updated_at: STAMP,
    latest_price: null,
    ...overrides,
  });
}

export type TaxLotWire = z.input<typeof taxLotResponseSchema>;

/** An open lot, as GET /investments/holdings/:uuid/lots lists them: `shares` at $100 a share unless overridden. */
export function taxLot(overrides: Partial<TaxLotWire> & { id: number; acquisition_date: string; shares: number }): TaxLotWire {
  const { shares, ...rest } = overrides;
  return checked(taxLotResponseSchema, `lot ${overrides.id}`, {
    uuid: uuidFor(9, overrides.id),
    tenant_id: 1,
    account_id: 1,
    security_id: 1,
    holding_period_start: overrides.acquisition_date,
    shares_original: shares.toFixed(6),
    shares_remaining: shares.toFixed(6),
    cost_basis_per_share: '100.0000',
    total_cost_basis: (shares * 100).toFixed(2),
    acquisition_method: 'purchase',
    is_open: true,
    is_covered: true,
    data_quality: 'complete',
    created_by_event_id: null,
    parent_lot_id: null,
    external_reference: null,
    metadata: null,
    created_at: STAMP,
    updated_at: STAMP,
    ...rest,
  });
}

export type HoldingWire = z.input<typeof holdingResponseSchema>;

/** A holding, as GET /investments/holdings lists them. */
export function holding(overrides: Partial<HoldingWire> & { security_id: number; ticker: string }): HoldingWire {
  return checked(holdingResponseSchema, `holding ${overrides.ticker}`, {
    security_uuid: uuidFor(7, overrides.security_id),
    name: `${overrides.ticker} Fund`,
    account_id: 1,
    total_shares: 10,
    total_cost_basis: 1000,
    average_cost_per_share: 100,
    latest_price: null,
    market_value: null,
    unrealized_gain_loss: null,
    ...overrides,
  });
}

const NO_WASH_SALE = { flagged: 0, disallowed: 0, adjustments: [] };
const EVENT = uuidFor(10, 1);

/**
 * What the investments writes answer when they record (not a dry run), as the app sends them
 * (the api module parses each one). Status 201 unless a test says otherwise.
 */
export const investmentAnswers = {
  buy: checked(buyResponseSchema, 'buy answer', { event_uuid: EVENT, lot_uuid: uuidFor(9, 99), total_cost_basis: 1000, wash_sale: NO_WASH_SALE }),
  sell: checked(sellResponseSchema, 'sale answer', {
    event_uuid: EVENT,
    method: 'fifo',
    plan: { consumptions: [], totalProceeds: 0, totalBasis: 0, totalRealized: 0, longTermRealized: 0, shortTermRealized: 0 },
    wash_sale: NO_WASH_SALE,
  }),
  dividend: checked(dividendResponseSchema, 'dividend answer', { event_uuid: EVENT, reinvest: false, reinvested_into_security_uuid: null }),
  fee: checked(feeResponseSchema, 'fee answer', { event_uuid: EVENT, status: 'created' }),
  price: checked(priceUpsertResponseSchema, 'price answer', { uuid: uuidFor(11, 1), price_date: '2026-10-15' }),
  split: checked(splitResponseSchema, 'split answer', { action_type: 'split', affected_lots: 1 }),
  returnOfCapital: checked(returnOfCapitalResponseSchema, 'return of capital answer', { action_type: 'return_of_capital', affected_lots: 1, realized_long_term_gain: 0 }),
  spinoff: checked(spinoffResponseSchema, 'spinoff answer', { action_type: 'spinoff', source_lots: 1, new_lots: 1 }),
  mergerCash: checked(mergerCashResponseSchema, 'cash merger answer', { action_type: 'merger_cash', closed_lots: 1, total_realized: 0 }),
  mergerStock: checked(mergerStockResponseSchema, 'stock merger answer', { action_type: 'merger_stock', converted_lots: 1, new_lots: 1 }),
  costBasisMethod: checked(costBasisMethodResponseSchema, 'cost basis method answer', { uuid: uuidFor(12, 1) }),
  composition: checked(compositionUpsertResponseSchema, 'composition answer', { security_uuid: uuidFor(7, 1), snapshot_date: '2026-10-15', rows_written: 1 }),
};

/** A write's answer, as mockApi takes it (201 Created). */
export const created = <T>(body: T) => ({ status: 201, body });

/** The planning page's reports with nothing to show. */
export const noTaxLossHarvest = checked(taxLossHarvestResponseSchema, 'tax-loss harvest', { candidates: [], note: 'Check wash-sale risk before harvesting.' });
export const noConcentration = checked(concentrationResponseSchema, 'concentration', { threshold_pct: 10, rows: [] });

// --- merchants, tags, categories, institutions, attachments, notes ----

export type MerchantWire = z.input<typeof merchantResponseSchema>;

/** A merchant as one merchant, a create or an update answers it; add `transaction_count`/`rule_count` for a full list's row. */
export function merchant(overrides: Partial<MerchantWire> & { id: number; name: string }): MerchantWire {
  return checked(merchantResponseSchema, `merchant ${overrides.name}`, {
    uuid: uuidFor(33, overrides.id),
    merchant_website: null,
    merchant_accountid: null,
    merchant_image: null,
    notes: null,
    instructions: null,
    transaction_auto_tag_id: null,
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  });
}

/** A merchant as GET /merchants?fields=lite lists it. */
export const merchantLite = (overrides: Partial<z.input<typeof merchantLiteResponseSchema>> & { id: number; name: string }) =>
  checked(merchantLiteResponseSchema, `merchant ${overrides.name} (lite)`, {
    uuid: uuidFor(33, overrides.id),
    merchant_website: null,
    ...overrides,
  });

/** A merchant's matching rule. */
export const merchantRule = (overrides: Partial<z.input<typeof merchantRuleResponseSchema>> & { id: number; matching_text: string }) =>
  checked(merchantRuleResponseSchema, `merchant rule ${overrides.id}`, {
    uuid: uuidFor(39, overrides.id),
    merchant_id: 1,
    method: 'contains',
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  });

export type TagWire = z.input<typeof tagResponseSchema>;

/** A tag as the list and one tag answer it (tags_with_hierarchy); a top-level tag unless parent_id and level say otherwise. */
export function tag(overrides: Partial<TagWire> & { id: number; name: string }): TagWire {
  return checked(tagResponseSchema, `tag ${overrides.name}`, {
    uuid: uuidFor(34, overrides.id),
    color: '#3B82F6',
    icon: 'Tag',
    description: null,
    parent_id: null,
    level: 0,
    sort_order: 0,
    is_active: true,
    is_report_root: false,
    report_flow_measure: 'effective',
    created_at: STAMP,
    updated_at: STAMP,
    hierarchy_path: overrides.name,
    parent_name: null,
    parent_uuid: null,
    child_count: 0,
    transaction_count: 0,
    budget_item_count: 0,
    last_used_at: null,
    ...overrides,
  });
}

export type CategoryWire = z.input<typeof categoryResponseSchema>;

export function category(overrides: Partial<CategoryWire> & { id: number; name: string }): CategoryWire {
  return checked(categoryResponseSchema, `category ${overrides.name}`, {
    uuid: uuidFor(35, overrides.id),
    description: null,
    priority: 'Undefined',
    notes: null,
    icon: 'Tag',
    created_at: STAMP,
    ...overrides,
  });
}

export type InstitutionWire = z.input<typeof institutionResponseSchema>;

/** An institution as one institution answers it; add `account_count` for a list's row. */
export function institution(overrides: Partial<InstitutionWire> & { id: number; name: string }): InstitutionWire {
  return checked(institutionResponseSchema, `institution ${overrides.name}`, {
    uuid: uuidFor(36, overrides.id),
    notes: null,
    created_at: STAMP,
    ...overrides,
  });
}

export type AttachmentWire = z.input<typeof attachmentResponseSchema>;

/** An attachment as a transaction's attachments list it. */
export function attachment(overrides: Partial<AttachmentWire> & { name: string }): AttachmentWire {
  return checked(attachmentResponseSchema, `attachment ${overrides.name}`, {
    uuid: uuidFor(37, 1),
    original_filename: overrides.name,
    safe_filename: `${uuidFor(37, 1)}.pdf`,
    file_extension: 'pdf',
    file_size: '2048',
    mime_type: 'application/pdf',
    date_uploaded: STAMP,
    bill_date: null,
    notes: null,
    attachment_type: 'document',
    created_at: STAMP,
    ...overrides,
  });
}

export type AnnotationWire = z.input<typeof annotationResponseSchema>;

/** One entry of a record's timeline: a person's note at the root of its thread unless overridden. */
export function annotation(overrides: Partial<AnnotationWire> & { uuid: string; body: string }): AnnotationWire {
  return checked(annotationResponseSchema, `annotation ${overrides.uuid}`, {
    parent_uuid: null,
    kind: 'note',
    meta: null,
    author_kind: 'user',
    author_user_id: 1,
    agent_name: null,
    author_first_name: 'Sam',
    status: 'open',
    notify: false,
    severity: null,
    pinned: false,
    feedback: null,
    feedback_reason: null,
    learning_status: null,
    created_at: STAMP,
    edited: false,
    ...overrides,
  });
}

/** GET /annotations: the record's timeline. */
export const annotationTimeline = (subjectType: string, subjectUuid: string, annotations: AnnotationWire[] = []) =>
  checked(annotationTimelineResponseSchema, 'annotation timeline', { subject_type: subjectType, subject_uuid: subjectUuid, annotations });
