import { z } from 'zod';
import { instant, nullableInstant, nullableResponseAmount, nullableStoredValue, responseAmount, storedValue } from './responses.js';
import {
  moneyInput,
  accountType,
  accountGroup,
  assetType,
  queryAmountFilter,
  queryBoolean,
  queryCalendarDay,
  queryDayFilter,
  queryIdFilter,
  queryInt,
  queryPage,
  querySentOnce,
} from './primitives.js';

/**
 * Accounts entity — the reference for the shared-schema pattern.
 *
 * One definition feeds: backend request validation + response coercion,
 * the frontend react-hook-form resolver + inferred types, and the MCP
 * account tools' input schemas.
 */

/** Boolean flags that arrive as real booleans (JSON) or "true"/"false" (FormData). */
const formBoolean = z.union([z.boolean(), z.enum(['true', 'false'])]).transform((v) => v === true || v === 'true');

/** Fields shared by the create and update bodies. */
const accountFieldsSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: assetType.default('Asset'),
  account_type: accountType,
  account_group: accountGroup.default('cash'),
  institution_id: z.coerce.number().int().nullable().optional(),
  account_number: z.string().nullable().optional(),
  routing_number: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  instructions: z.string().nullable().optional(),
  icon: z.string().default('CreditCard'),
  is_active: formBoolean.default(true),
  hide_transactions: formBoolean.default(false),
  hide_account: formBoolean.default(false),
  exclude_account_balance: formBoolean.default(false),
  is_envelope_account: formBoolean.default(false),
});

/**
 * POST /api/accounts body. Mirrors the route's hand-validation, now declarative.
 * `initial_balance` becomes the account's 'starting balance' transaction. It is a
 * number or decimal text, as sent (moneyInput): the route reads it in cents.
 */
export const accountCreateSchema = accountFieldsSchema.extend({
  initial_balance: moneyInput('initial_balance must be a number').default(0),
});
export type AccountCreateInput = z.infer<typeof accountCreateSchema>;

/**
 * PUT /api/accounts/:uuid body. Adds the update-only fields. It has no
 * `initial_balance` (an unknown key is stripped): editing an account never
 * changes its balance. The opening balance is changed by editing its
 * 'starting balance' transaction, or with Adjust Balance.
 */
export const accountUpdateSchema = accountFieldsSchema.extend({
  subtype: z.string().nullable().optional(),
  custom_sort: z.coerce.number().int().nullable().optional(),
  require_zero_balance: formBoolean.default(false),
  // Self-reference to an asset account, pre-filled as the source when paying this
  // (liability) account from Close-Out. Empty string / null coerce to null so the
  // value can be cleared via the multipart edit form (Number('') is 0, so map ''
  // to null BEFORE coercion).
  default_pay_from_account_id: z
    .preprocess((v) => (v === '' || v == null ? null : v), z.coerce.number().int().nullable())
    .optional(),
});
export type AccountUpdateInput = z.infer<typeof accountUpdateSchema>;

/** An account's stored classification: the columns {@link accountUpdateSchemaFor} reads. */
export interface StoredAccountClassification {
  type?: string | null;
  account_type?: string | null;
  account_group?: string | null;
}

/** `allowed`, widened by exactly `stored` when that is a value outside it. */
const enumOrStored = <T extends z.ZodEnum>(allowed: T, stored: string | null | undefined) =>
  stored && !(allowed.options as readonly string[]).includes(stored)
    ? z.union([allowed, z.literal(stored)])
    : allowed;

/**
 * The PUT body for one stored account. Accounts saved before today's
 * classification enums can hold another value (`account_group 'Banking'`,
 * `account_type 'Checking'`): the edit form shows it as "(legacy value)", and
 * {@link accountUpdateSchema} rejects it, so such an account could not be saved
 * without reclassifying it. This schema also accepts each field's stored value,
 * and nothing else: a classification can stay what it is, or become one of
 * today's values, never a new free-form string. The backend validates the PUT
 * with it against the row it updates; the edit form uses it as its resolver.
 */
export const accountUpdateSchemaFor = (stored: StoredAccountClassification) =>
  accountUpdateSchema.extend({
    type: enumOrStored(assetType, stored.type).default('Asset'),
    account_type: enumOrStored(accountType, stored.account_type),
    account_group: enumOrStored(accountGroup, stored.account_group).default('cash'),
  });

/**
 * POST /api/accounts/:uuid/adjust-balance body. `targetBalance` is the new
 * balance the user wants the account to reflect (in the same pre-signed
 * convention as the account's calculated balance); the server inserts a single
 * `balance adjustment` transaction for the delta. Can be negative (e.g. a
 * liability balance), so no `.nonnegative()`. A number or decimal text, as sent
 * (moneyInput): the route reads it in cents.
 */
export const accountAdjustBalanceSchema = z.object({
  targetBalance: moneyInput('targetBalance must be a number'),
});
export type AccountAdjustBalanceInput = z.infer<typeof accountAdjustBalanceSchema>;

/** PUT /api/accounts/:uuid/instructions body: the account's instructions, text or null to clear them. */
export const accountInstructionsSchema = z.object({
  instructions: z.string({ error: 'instructions must be text, or null to clear them' }).nullable(),
});
export type AccountInstructionsInput = z.infer<typeof accountInstructionsSchema>;

/**
 * An account as `GET /api/accounts` lists it and `GET /api/accounts/:uuid` answers it:
 * every field, so a parse checks each and a field the schema doesn't name fails
 * the route tests (`answerProblem`). NUMERIC columns are read as numbers. The fields only
 * the single account has (the rest of its row) are optional.
 */
export const accountResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  name: z.string(),
  /**
   * accounts.type ('Asset' or 'Liability'), account_type and account_group: today's values,
   * or a classification the account kept from before today's lists.
   */
  type: nullableStoredValue(assetType.options),
  account_type: storedValue(accountType.options),
  account_group: storedValue(accountGroup.options),
  icon: z.string().nullable(),
  account_number: z.string().nullable(),
  routing_number: z.string().nullable(),
  notes: z.string().nullable(),
  instructions: z.string().nullable(),
  account_image: z.string().nullable(),
  close_account: z.boolean(),
  hide_transactions: z.boolean(),
  hide_account: z.boolean(),
  exclude_account_balance: z.boolean(),
  is_envelope_account: z.boolean(),
  require_zero_balance: z.boolean(),
  default_pay_from_account_id: z.number().int().nullable(),
  // The bank's figures (SimpleFin): null until a sync reports them.
  institution_current_balance: nullableResponseAmount,
  institution_available_balance: nullableResponseAmount,
  import_balance: nullableResponseAmount,
  import_available_balance: nullableResponseAmount,
  /** institution_current_balance, or 0 when there is none. */
  institution_balance: responseAmount,
  import_enabled: z.boolean(),
  import_account_id: z.string().nullable(),
  import_account_rebalance: z.boolean(),
  import_auto_match_merchants: z.boolean(),
  import_auto_assign_budget_period: z.boolean(),
  import_auto_assign_budget_item: z.boolean(),
  import_provider: z.string().nullable(),
  import_balance_date: nullableInstant,
  import_last_sync: nullableInstant,
  import_last_error_code: z.string().nullable(),
  import_last_error_at: nullableInstant,
  created_at: instant,
  updated_at: nullableInstant,
  institution_id: z.number().int().nullable(),
  institution_uuid: z.uuid().nullable(),
  institution_name: z.string().nullable(),
  institution_notes: z.string().nullable(),
  /**
   * The account balance: calculate_account_balance(), SUM of the account's
   * non-child transactions. null when it couldn't be computed, with
   * `balance_unavailable` set; show "Unavailable", never $0.
   */
  calculated_balance: nullableResponseAmount,
  balance_unavailable: z.boolean(),
  // GET /api/accounts/:uuid only: the rest of the row.
  tenant_id: z.number().int().optional(),
  subtype: z.string().nullable().optional(),
  custom_sort: z.number().int().nullable().optional(),
  link: z.string().nullable().optional(),
  last_sync_date: nullableInstant.optional(),
  simplefin_connection_id: z.number().int().nullable().optional(),
  import_auto_review: z.boolean().optional(),
  import_currency: z.string().nullable().optional(),
  import_default_assigned_to: z.number().int().nullable().optional(),
  import_extra: z.unknown().optional(),
});
export type Account = z.infer<typeof accountResponseSchema>;

/** GET /api/accounts. */
export const accountListResponseSchema = z.object({ accounts: z.array(accountResponseSchema) });

/**
 * GET /api/accounts/zero-balance/:periodUuid (Close-Out): each account that should end the
 * period at zero, its sum for the period and the adjustment that brings it there.
 */
export const zeroBalanceAuditResponseSchema = z.object({
  accounts: z.array(
    z.object({
      uuid: z.uuid(),
      name: z.string(),
      account_type: storedValue(accountType.options),
      icon: z.string(),
      /** The account's accounts.type ('Asset' or 'Liability'; '' when it has none). */
      color: z.string(),
      period_balance: responseAmount,
      current_balance: responseAmount,
      is_balanced: z.boolean(),
      adjustment_needed: responseAmount,
      adjustment_direction: z.enum(['credit', 'debit', 'balanced']),
    })
  ),
  summary: z.object({
    total_accounts: z.number().int(),
    balanced_count: z.number().int(),
    needs_adjustment_count: z.number().int(),
    total_adjustment_amount: responseAmount,
  }),
});
export type ZeroBalanceAudit = z.infer<typeof zeroBalanceAuditResponseSchema>;

// ---------------------------------------------------------------------------
// Query strings.

/**
 * GET /api/accounts query: include_hidden (false when not given), exclude_closed (true when
 * not given), exclude_balance (false when not given: true leaves out the balances, which
 * cost a query per account), each true or false; and as_of, a day (YYYY-MM-DD): the
 * balances at the end of that day, as Close-Out shows a month's, instead of today's.
 */
export const accountListQuery = z.object({
  include_hidden: queryBoolean({ default: false }),
  exclude_closed: queryBoolean({ default: true }),
  exclude_balance: queryBoolean({ default: false }),
  as_of: queryCalendarDay(),
});
export type AccountListQuery = z.infer<typeof accountListQuery>;

/** GET /api/accounts/:uuid/balance-history query: how many month-end points (12 when not given, 1 to 120). */
export const accountBalanceHistoryQuery = z.object({
  limit: queryInt({ min: 1, max: 120, default: 12 }),
});
export type AccountBalanceHistoryQuery = z.infer<typeof accountBalanceHistoryQuery>;

/**
 * GET /api/accounts/:uuid/transactions query: the page (50 rows by default, at most 200) and
 * the register's filters. A date that isn't a calendar date, or an id that isn't a whole
 * number, reached the query as text Postgres couldn't read (a 500); an amount that isn't a
 * number compared with NaN. Each is 400 VALIDATION_ERROR. Text filters are sent once.
 */
export const accountRegisterQuery = z.object({
  ...queryPage({ defaultLimit: 50, maxLimit: 200 }),
  search: querySentOnce('search'),
  status: querySentOnce('status'),
  type: querySentOnce('type'),
  review_status: querySentOnce('review_status'),
  date_from: queryDayFilter('date_from'),
  date_to: queryDayFilter('date_to'),
  budget_period_id: queryIdFilter('budget_period_id'),
  budget_item_id: queryIdFilter('budget_item_id'),
  amount_min: queryAmountFilter('amount_min'),
  amount_max: queryAmountFilter('amount_max'),
});
export type AccountRegisterQuery = z.infer<typeof accountRegisterQuery>;

// ---------------------------------------------------------------------------
// The other account answers.

/**
 * An account as a create (POST /api/accounts, 201) and an update (PUT /api/accounts/:uuid)
 * answer it: its row as written, without the balances or the institution's names the list
 * joins. `nuggets_balance` is retired (always 0, never read), but still a column.
 */
export const accountRowResponseSchema = accountResponseSchema
  .omit({
    institution_balance: true,
    institution_uuid: true,
    institution_name: true,
    institution_notes: true,
    calculated_balance: true,
    balance_unavailable: true,
  })
  .required({
    tenant_id: true,
    subtype: true,
    custom_sort: true,
    link: true,
    last_sync_date: true,
    simplefin_connection_id: true,
    import_auto_review: true,
    import_currency: true,
    import_default_assigned_to: true,
    import_extra: true,
  })
  .extend({ nuggets_balance: nullableResponseAmount });
export type AccountRow = z.infer<typeof accountRowResponseSchema>;

/** GET /api/accounts/:uuid/balance: calculate_account_balance(), or null with `balance_unavailable`. */
export const accountBalanceResponseSchema = z.object({
  account_id: z.number().int(),
  balance: nullableResponseAmount,
  balance_unavailable: z.boolean(),
});
export type AccountBalanceResponse = z.infer<typeof accountBalanceResponseSchema>;

/**
 * POST /api/accounts/:uuid/adjust-balance: one `balance adjustment` transaction of the
 * difference, or none when the balance already matched (`adjusted: false`, with a message).
 */
export const accountBalanceAdjustedResponseSchema = z.object({
  adjusted: z.boolean(),
  account_id: z.number().int(),
  transaction_uuid: z.uuid().optional(),
  /** The difference recorded, pre-signed. */
  adjustment: responseAmount.optional(),
  balance: responseAmount,
  message: z.string().optional(),
});
export type AccountBalanceAdjusted = z.infer<typeof accountBalanceAdjustedResponseSchema>;
