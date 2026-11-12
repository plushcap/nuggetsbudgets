import { z } from 'zod';
import {
  assetType,
  CALENDAR_DAY_YEARS,
  isCalendarDay,
  moneyInput,
  queryAmountFilter,
  queryDayFilter,
  queryIdFilter,
  queryInt,
  queryPage,
  querySentOnce,
  emptyAsUndefined,
  readDecimal,
  rowIdInput,
} from './primitives.js';
import {
  dayText,
  instant,
  nullableDayText,
  nullableInstant,
  nullableResponseAmount,
  nullableResponseDecimal,
  responseAmount,
  nullableStoredValue,
  storedValue,
} from './responses.js';

/**
 * Transactions entity (response coercion focus).
 *
 * Backend create/update validation is deliberately NOT added here yet — the
 * legacy route has reconciliation subtleties (e.g. the `!amount` check rejects
 * amount 0, and the type/status enums need grounding) best handled in a
 * dedicated pass. This schema covers the high-value win: coercing the
 * NUMERIC fields on API responses so amounts/balances arrive as real numbers.
 */

/**
 * The values the database allows in transactions.type, .status and .review_status
 * (CHECK constraints). Lowercase, with a space in
 * 'needs review'.
 */
export const transactionType = z.enum(['income', 'expense', 'payment', 'transfer', 'starting balance', 'balance adjustment']);
export type TransactionType = z.infer<typeof transactionType>;
export const transactionStatus = z.enum(['pending', 'cleared', 'reconciled']);
export type TransactionStatus = z.infer<typeof transactionStatus>;
export const transactionReviewStatus = z.enum(['needs review', 'reviewed', 'flagged']);
export type TransactionReviewStatus = z.infer<typeof transactionReviewStatus>;

const CREATE_TAG_IDS = 'tag_ids must be a list of tag ids (whole numbers)';
const CREATE_TAG_UUIDS = 'tag_uuids must be a list of tag uuids';

/**
 * POST /api/transactions body. Validates the always-required fields; the
 * uuid-or-id resolution for merchant/budget and the account lookup stay in the
 * handler, so this is loose (other fields pass through). amount must be a
 * non-zero number (the legacy `!amount` rejected 0/missing): a number or decimal text,
 * as sent (moneyInput), which the handler reads in cents. The tags, when sent, are lists:
 * of ids (a positive whole number, or its digits as text) and of uuids; anything else is a
 * 400 here (a single id, a string or an object was ignored, the transaction saved
 * without its tags). Whether each names a tag of the ledger is the handler's check.
 */
export const transactionCreateSchema = z.looseObject({
  // Each uuid it names is one: one that wasn't failed the lookup, a 500.
  account_uuid: z.string({ error: 'account_uuid is required' }).min(1, 'account_uuid is required').pipe(z.uuid({ error: 'account_uuid must be a uuid' })),
  merchant_uuid: z.uuid({ error: 'merchant_uuid must be a uuid' }).nullish(),
  budget_item_uuid: z.uuid({ error: 'budget_item_uuid must be a uuid' }).nullish(),
  budget_period_uuid: z.uuid({ error: 'budget_period_uuid must be a uuid' }).nullish(),
  amount: moneyInput('amount is required and must be a number')
    .refine((v) => Number(v) !== 0, 'amount is required and must be non-zero'),
  transaction_date: z.string({ error: 'transaction_date is required' }).min(1, 'transaction_date is required'),
  type: z.string({ error: 'type is required' }).min(1, 'type is required'),
  tag_ids: z.array(rowIdInput(CREATE_TAG_IDS), { error: CREATE_TAG_IDS }).nullish(),
  tag_uuids: z.array(z.uuid({ error: CREATE_TAG_UUIDS }), { error: CREATE_TAG_UUIDS }).nullish(),
});
export type TransactionCreateInput = z.infer<typeof transactionCreateSchema>;

/**
 * POST /api/transactions/bulk body — the agent-driven statement/CSV backfill
 * (the batch counterpart of the single create, mirroring batch_import_lots on
 * the investments side). Strict rows: because validateBody runs before the
 * handler regardless of dry_run, dry-run rejects exactly what the real write
 * rejects. Rows whose (account, external_transaction_id) already exists are
 * skipped, making re-imports idempotent.
 */
export const bulkTransactionRowSchema = z.object({
  account_uuid: z.uuid(),
  // Past what the column holds, a row fails alone, as one with too many decimals does.
  amount: moneyInput('amount must be a non-zero number', { range: false })
    .refine((v) => Number(v) !== 0, 'amount must be a non-zero number'),
  transaction_date: z.string().min(1),
  type: transactionType,
  description: z.string().nullable().optional(),
  merchant_uuid: z.uuid().nullable().optional(),
  budget_item_uuid: z.uuid().nullable().optional(),
  budget_period_uuid: z.uuid().nullable().optional(),
  external_transaction_id: z.string().nullable().optional(),
  review_status: transactionReviewStatus.default('needs review'),
  status: transactionStatus.exclude(['reconciled']).default('cleared'),
});
export const bulkTransactionsCreateSchema = z.object({
  transactions: z.array(bulkTransactionRowSchema).min(1).max(500),
  dry_run: z.boolean().default(false),
});
export type BulkTransactionsCreateInput = z.infer<typeof bulkTransactionsCreateSchema>;

/** A tag as the transaction answers carry it. */
export const transactionTagResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  name: z.string(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
});
export type TransactionTag = z.infer<typeof transactionTagResponseSchema>;

/**
 * One split of a parent: its own columns, and the fields `GET /api/transactions/:uuid` and
 * the split answer add (`transactionSplitChildDetailResponseSchema`), optional here.
 */
export const transactionSplitChildResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  amount: responseAmount,
  description: z.string().nullable(),
  budget_item_id: z.number().int().nullable(),
  budget_period_id: z.number().int().nullable(),
  budget_period_item_id: z.number().int().nullable(),
  budget_item_name: z.string().nullable().optional(),
  budget_item_uuid: z.uuid().nullable().optional(),
  status: storedValue(transactionStatus.options).optional(),
  transaction_date: dayText.optional(),
  type: storedValue(transactionType.options).optional(),
  /** The split's own tags: GET /api/transactions/:uuid and the split answer send them. */
  tags: z.array(transactionTagResponseSchema).optional(),
});
export type TransactionSplitChild = z.infer<typeof transactionSplitChildResponseSchema>;

/**
 * One split as `GET /api/transactions/:uuid` lists it: with its budget item's name, its
 * type, status and date, and its own tags. The tags are what re-editing the splits sends
 * back; without them it sent none, and the re-split lost them.
 */
export const transactionSplitChildDetailResponseSchema = transactionSplitChildResponseSchema.required({
  budget_item_name: true,
  budget_item_uuid: true,
  status: true,
  transaction_date: true,
  type: true,
  tags: true,
});
export type TransactionSplitChildDetail = z.infer<typeof transactionSplitChildDetailResponseSchema>;

/**
 * A transaction as the API answers it: the list (`GET /api/transactions`),
 * the page (`/paginated`), an account's register, one transaction, and the edit, split and
 * unsplit answers. Every field is named, so a parse checks each and one the schema doesn't
 * name fails the route tests (`answerProblem`). The fields every one of those answers has
 * are required; the table columns only the single-row answers carry, and the names only the
 * lists join, are optional. NUMERIC columns are read as numbers.
 *
 * type, status and review_status are today's values, or one a row kept from before them.
 */
export const transactionResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  /** Pre-signed: an income positive, an expense negative. */
  amount: responseAmount,
  type: storedValue(transactionType.options),
  status: storedValue(transactionStatus.options),
  review_status: storedValue(transactionReviewStatus.options),
  transaction_date: dayText,
  description: z.string().nullable(),
  budget_item_id: z.number().int().nullable(),
  budget_period_id: z.number().int().nullable(),
  budget_period_item_id: z.number().int().nullable(),
  merchant_id: z.number().int().nullable(),
  is_split_parent: z.boolean(),
  parent_transaction_id: z.number().int().nullable(),
  created_at: instant,
  updated_at: nullableInstant,
  // The rest of the row: one transaction, and the edit, split and unsplit answers.
  tenant_id: z.number().int().optional(),
  account_id: z.number().int().optional(),
  assigned_to: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
  external_transaction_id: z.string().nullable().optional(),
  external_link: z.string().nullable().optional(),
  institution_transaction_status: z.string().nullable().optional(),
  transfer_transaction_id: z.number().int().nullable().optional(),
  transfer_source_account_id: z.number().int().nullable().optional(),
  budget_matching_confidence: nullableResponseDecimal.optional(),
  budget_matching_method: z.string().nullable().optional(),
  budget_matching_rule_id: z.number().int().nullable().optional(),
  /** The budget period an edit last took it out of, which a bank sync doesn't put it back in. */
  budget_period_cleared_from: z.number().int().nullable().optional(),
  /** That period's first day: deleted, and its month's period made again, a sync puts it back in that one. */
  budget_period_cleared_start: dayText.nullable().optional(),
  synced_amount: nullableResponseAmount.optional(),
  synced_transactiondate: nullableInstant.optional(),
  synced_category: z.string().nullable().optional(),
  synced_name: z.string().nullable().optional(),
  synced_location: z.string().nullable().optional(),
  synced_description: z.string().nullable().optional(),
  is_import: z.boolean().optional(),
  import_provider: z.string().nullable().optional(),
  import_transaction_id: z.string().nullable().optional(),
  import_payee: z.string().nullable().optional(),
  import_posted_date: nullableInstant.optional(),
  import_transacted_at: nullableInstant.optional(),
  import_amount: nullableResponseAmount.optional(),
  import_description: z.string().nullable().optional(),
  import_pending: z.boolean().optional(),
  import_extra: z.unknown().optional(),
  import_imported_at: nullableInstant.optional(),
  // Joined: the lists and one transaction.
  /**
   * The account's accounts.type, 'Asset' or 'Liability' (list rows, GET /:uuid and an
   * account's transactions): whether it takes an income. Not `account_type`, which the
   * account answers use for accounts.account_type (checking, credit_card, ...).
   */
  account_class: nullableStoredValue(assetType.options).optional(),
  account_name: z.string().nullable().optional(),
  account_uuid: z.uuid().nullable().optional(),
  assigned_user: z.string().nullable().optional(),
  budget_item_name: z.string().nullable().optional(),
  budget_item_uuid: z.uuid().nullable().optional(),
  budget_period_name: z.string().nullable().optional(),
  budget_period_item_name: z.string().nullable().optional(),
  merchant_name: z.string().nullable().optional(),
  /** A tag's transactions (GET /api/tags/:uuid/transactions). */
  merchant_uuid: z.uuid().nullable().optional(),
  parent_transaction_uuid: z.uuid().nullable().optional(),
  tags: z.array(transactionTagResponseSchema).optional(),
  split_children: z.array(transactionSplitChildResponseSchema).optional(),
  /** An account's register: the account's balance after this transaction. */
  running_account_balance: nullableResponseAmount.optional(),
});
export type TransactionResponse = z.infer<typeof transactionResponseSchema>;

/**
 * One transaction (`GET /api/transactions/:uuid`) and the edit, split and unsplit answers:
 * the whole row, so its columns are there (null when empty), not optional.
 */
export const transactionDetailResponseSchema = transactionResponseSchema.required({
  tenant_id: true,
  account_id: true,
  assigned_to: true,
  notes: true,
  external_transaction_id: true,
  external_link: true,
  institution_transaction_status: true,
  transfer_transaction_id: true,
  transfer_source_account_id: true,
  budget_matching_confidence: true,
  budget_matching_method: true,
  budget_matching_rule_id: true,
  budget_period_cleared_from: true,
  budget_period_cleared_start: true,
  synced_amount: true,
  synced_transactiondate: true,
  synced_category: true,
  synced_name: true,
  synced_location: true,
  synced_description: true,
  is_import: true,
  import_provider: true,
  import_transaction_id: true,
  import_payee: true,
  import_posted_date: true,
  import_transacted_at: true,
  import_amount: true,
  import_description: true,
  import_pending: true,
  import_imported_at: true,
});
export type TransactionDetail = z.infer<typeof transactionDetailResponseSchema>;

/**
 * One transaction, as `GET /api/transactions/:uuid` and the split answer
 * (`POST /api/transactions/:uuid/split`) give it: the whole row, with its splits (none
 * unless it is a split parent), each with its names and tags.
 */
export const transactionWithSplitsResponseSchema = transactionDetailResponseSchema.extend({
  split_children: z.array(transactionSplitChildDetailResponseSchema),
});
export type TransactionWithSplits = z.infer<typeof transactionWithSplitsResponseSchema>;

/** The paging of a list answer. */
export const pageResponseSchema = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

/** GET /api/transactions/paginated, and an account's register (GET /api/accounts/:uuid/transactions). */
export const transactionPageResponseSchema = z.object({
  transactions: z.array(transactionResponseSchema),
  pagination: pageResponseSchema,
});
export type TransactionPageResponse = z.infer<typeof transactionPageResponseSchema>;

/** PUT /api/transactions/bulk: how many changed, and each one's new statuses. */
export const transactionBulkEditResponseSchema = z.object({
  updated: z.number().int(),
  transactions: z.array(
    z.object({
      id: z.number().int(),
      uuid: z.uuid(),
      status: storedValue(transactionStatus.options),
      review_status: storedValue(transactionReviewStatus.options),
    })
  ),
});
export type TransactionBulkEditResponse = z.infer<typeof transactionBulkEditResponseSchema>;

// ---------------------------------------------------------------------------
// The transaction lists' query strings (GET /api/transactions and its /paginated page).

// The filters are the shared query*Filter helpers (primitives.ts).

/**
 * The filters GET / and GET /paginated share. An id that isn't a whole number, a date that
 * isn't a calendar date, or an amount that isn't a number failed casting in the query (a
 * 500) or compared with NaN; each is 400 VALIDATION_ERROR. A search, a status, a type
 * or a uuid is text, sent once (`all` for a status or a type is no filter; a uuid that names
 * nothing matches nothing). Other keys pass as they are.
 */
const transactionFilters = {
  search: querySentOnce('search'),
  review_status: querySentOnce('review_status'),
  type: querySentOnce('type'),
  date_from: queryDayFilter('date_from'),
  date_to: queryDayFilter('date_to'),
  budget_period_id: queryIdFilter('budget_period_id'),
  budget_item_id: queryIdFilter('budget_item_id'),
  budget_item_uuid: querySentOnce('budget_item_uuid'),
  merchant_id: queryIdFilter('merchant_id'),
  merchant_uuid: querySentOnce('merchant_uuid'),
  amount_min: queryAmountFilter('amount_min'),
  amount_max: queryAmountFilter('amount_max'),
  account_id: queryIdFilter('account_id'),
  account_uuid: querySentOnce('account_uuid'),
  assigned_to: queryIdFilter('assigned_to'),
};
export type TransactionFilterQuery = { [K in keyof typeof transactionFilters]?: string | undefined };

/**
 * The most rows GET /api/transactions returns. Every caller passes a scoping filter
 * (budget_item_uuid, merchant_uuid, account, date), so the cap is a backstop; a caller that
 * needs to page uses /paginated. A caller may ask for fewer with ?limit=.
 */
export const TRANSACTION_LIST_MAX = 10000;

/** GET /api/transactions's query string: the filters, a split's children with include_children=true, a date range, and limit. */
export const transactionListQuerySchema = z.looseObject({
  ...transactionFilters,
  include_children: querySentOnce('include_children'),
  start_date: queryDayFilter('start_date'),
  end_date: queryDayFilter('end_date'),
  limit: queryInt({ min: 1, max: TRANSACTION_LIST_MAX, default: TRANSACTION_LIST_MAX }),
});
export type TransactionListQuery = z.infer<typeof transactionListQuerySchema>;

/**
 * GET /api/transactions/paginated's query string: the filters, the Tasks page's
 * exclude_unassigned=true and assigned_to_or_unassigned, and the page (20 rows by default,
 * at most 200: the MCP tools ask for up to 200).
 */
export const transactionPageQuerySchema = z.looseObject({
  ...transactionFilters,
  exclude_unassigned: querySentOnce('exclude_unassigned'),
  assigned_to_or_unassigned: queryIdFilter('assigned_to_or_unassigned'),
  ...queryPage({ defaultLimit: 20, maxLimit: 200 }),
});
export type TransactionPageQuery = z.infer<typeof transactionPageQuerySchema>;

// ---------------------------------------------------------------------------
// Writes of several transactions, and splits.

// The fields an edit of one transaction, or of several, may set. Each is checked
// for what it is here, 400 VALIDATION_ERROR naming it; whether it is allowed for this row
// (a type or status it may keep from before today's lists, an amount for its type and its
// transfer, a row of this ledger) is the service's check, as before.

/**
 * A reference a body sets: a row's id, as a number or its digits, or none, as null or ''. Only
 * its kind is checked here: whether it names a row of this ledger (or a person who can see it)
 * is the service's 400 INVALID_REFERENCE (INVALID_ASSIGNEE), as it was, for any value.
 */
const editedReference = (field: string) =>
  z.union([z.number(), z.string()], { error: `${field} must be the id of a row, or null for none` }).nullable().optional();
/** Free text a body sets: text, or null (or '') for none. */
const editedText = (field: string) => z.string({ error: `${field} must be text, or null for none` }).nullable().optional();
/** A word a row always has (its type or a status): text, never none. It may be one the row kept from before today's lists. */
const editedWord = (field: string) =>
  z.string({ error: `${field} must be text: one of its values` }).min(1, `${field} must be one of its values`).optional();
const EDITED_DATE = `transaction_date must be a real date, as YYYY-MM-DD, from ${CALENDAR_DAY_YEARS.min} to ${CALENDAR_DAY_YEARS.max}`;

/**
 * PUT /api/transactions/:uuid body: the fields an edit may change (the service's
 * EDITABLE_FIELDS). Text and references take null (or '') for none; the amount, the type, the
 * statuses and the date are never none. A date that wasn't a real day, or null, reached the
 * UPDATE, a 500. Other fields pass through and are ignored (a whole-form save sends the form's
 * account and merchant name).
 */
export const transactionUpdateSchema = z.looseObject({
  description: editedText('description'),
  notes: editedText('notes'),
  external_transaction_id: editedText('external_transaction_id'),
  external_link: editedText('external_link'),
  /** A number or decimal text: the service reads it in whole cents, signed for its type. */
  amount: z.union([z.number(), z.string()], { error: 'amount must be a number' }).optional(),
  type: editedWord('type'),
  status: editedWord('status'),
  review_status: editedWord('review_status'),
  transaction_date: z.string({ error: EDITED_DATE }).refine(isCalendarDay, EDITED_DATE).optional(),
  merchant_id: editedReference('merchant_id'),
  budget_item_id: editedReference('budget_item_id'),
  budget_period_id: editedReference('budget_period_id'),
  budget_period_item_id: editedReference('budget_period_item_id'),
  assigned_to: editedReference('assigned_to'),
});
export type TransactionUpdateInput = z.infer<typeof transactionUpdateSchema>;

/**
 * PUT /api/transactions/bulk's `updates`: the fields a bulk edit may set (the service's
 * BULK_EDITABLE_FIELDS), checked as an edit of one checks them. Other fields pass through and
 * are ignored.
 */
export const transactionBulkUpdatesSchema = z.looseObject(
  {
    review_status: editedWord('review_status'),
    status: editedWord('status'),
    budget_item_id: editedReference('budget_item_id'),
    budget_period_id: editedReference('budget_period_id'),
    budget_period_item_id: editedReference('budget_period_item_id'),
    assigned_to: editedReference('assigned_to'),
  },
  { error: 'updates object is required' }
);

/**
 * PUT /api/transactions/bulk body: the transactions (by uuid, at least one; one that names
 * nothing is skipped) and the fields to set on them (review status, status, envelope,
 * assignee: the service picks those it allows). A uuid that isn't one failed casting in the
 * lookup, a 500; it is 400 now.
 */
export const transactionBulkUpdateSchema = z.object({
  transactionUuids: z
    .array(z.uuid({ error: 'transactionUuids must be the uuids of transactions' }), { error: 'transactionUuids array is required' })
    .min(1, 'transactionUuids array is required'),
  updates: transactionBulkUpdatesSchema,
});
export type TransactionBulkUpdateInput = z.infer<typeof transactionBulkUpdateSchema>;

/** Whether `amount` is whole cents a DECIMAL(12,2) column holds as written (the backend's toCents). */
const isWholeCents = (amount: number) => 'units' in readDecimal(amount, 2, 12);

const SPLIT_AMOUNT = 'Each split must have a numeric amount';
const SPLIT_TAGS = "Each split's tag_ids and tag_uuids must be lists";
/** A split's budget item or period by uuid: a uuid, or empty, null or absent for none. */
const splitUuid = (field: string) => emptyAsUndefined(z.uuid({ error: `Each split's ${field} must be a uuid` }).nullable());

/**
 * One split of POST /api/transactions/:uuid/split: its amount (a JSON number, whole cents:
 * 33.333 is refused, not rounded to a split that no longer adds up), its tags as
 * lists (a number beside tag_ids was a TypeError, and a string's characters were taken for
 * ids), and its budget item and period uuids, when sent, as uuids (other text failed
 * the service's query, a 500). Its ids and names pass through, resolved by the
 * service, which refuses a uuid of no row of the ledger.
 */
export const transactionSplitItemSchema = z.looseObject(
  {
    amount: z.number({ error: SPLIT_AMOUNT }).refine(isWholeCents, 'Each split amount must have at most 2 decimal places'),
    tag_ids: z.array(z.unknown(), { error: SPLIT_TAGS }).nullish(),
    tag_uuids: z.array(z.unknown(), { error: SPLIT_TAGS }).nullish(),
    budget_item_uuid: splitUuid('budget_item_uuid'),
    budget_period_uuid: splitUuid('budget_period_uuid'),
  },
  { error: SPLIT_AMOUNT }
);

/** POST /api/transactions/:uuid/split body: at least two splits, which the service checks add up to the transaction. */
export const transactionSplitSchema = z.looseObject({
  splits: z.array(transactionSplitItemSchema, { error: 'At least 2 splits are required' }).min(2, 'At least 2 splits are required'),
});
export type TransactionSplitInput = z.infer<typeof transactionSplitSchema>;

// ---------------------------------------------------------------------------
// Delete Transactions (POST /api/data-management/preview-delete-transactions and
// /delete-transactions): every transaction of a date range, previewed first.

/** A day of the range: given, and a calendar day (YYYY-MM-DD, 1800 to 2999). */
const deletionDay = z
  .string({ error: 'Date range is required' })
  .min(1, 'Date range is required')
  .refine(isCalendarDay, 'Invalid date format');

const deletionRange = {
  dateFrom: deletionDay,
  dateTo: deletionDay,
  /** Keep the transactions in a budget period. Not given: kept, as the query read a missing value. */
  excludeBudgetPeriod: z.boolean({ error: 'excludeBudgetPeriod must be true or false' }).default(true),
};

/** The range runs forwards (calendar days compare as strings); a day that isn't one is refused on its own. */
const forwards = (range: { dateFrom: string; dateTo: string }) =>
  !isCalendarDay(range.dateFrom) || !isCalendarDay(range.dateTo) || range.dateFrom <= range.dateTo;
const FORWARDS = { message: 'Start date must be before or equal to end date', path: ['dateTo'] };

/** The preview's body: the range, and whether to keep those in a budget period. */
export const transactionRangePreviewSchema = z.object(deletionRange).refine(forwards, FORWARDS);
export type TransactionRangePreviewInput = z.infer<typeof transactionRangePreviewSchema>;

/**
 * The deletion's body: the range as previewed, the preview's selectionKey (the server
 * deletes what that preview found, or nothing: 409 PREVIEW_OUTDATED), and whether to back up
 * first (a deployment admin only).
 */
export const transactionRangeDeleteSchema = z
  .object({
    ...deletionRange,
    selectionKey: z
      .string({ error: 'Preview the deletion first: send the selectionKey its preview answered' })
      .regex(/^[0-9a-f]{64}$/, 'Preview the deletion first: send the selectionKey its preview answered'),
    createBackup: z.boolean({ error: 'createBackup must be true or false' }).default(false),
  })
  .refine(forwards, FORWARDS);
export type TransactionRangeDeleteInput = z.infer<typeof transactionRangeDeleteSchema>;

/**
 * What a range deletion's preview found (POST /api/data-management/preview-delete-transactions):
 * how many transactions, how many accounts, their days, and their incomes and expenses added
 * up (both as positive amounts). `selectionKey` names exactly these rows: the deletion sends it.
 */
export const transactionRangePreviewResponseSchema = z.object({
  success: z.literal(true),
  count: z.number().int(),
  affectedAccounts: z.number().int(),
  earliestDate: nullableDayText,
  latestDate: nullableDayText,
  totalIncome: responseAmount,
  totalExpenses: responseAmount,
  selectionKey: z.string().regex(/^[0-9a-f]{64}$/),
});
export type TransactionRangePreview = z.infer<typeof transactionRangePreviewResponseSchema>;

/**
 * What the deletion removed (POST /api/data-management/delete-transactions), and whether it
 * backed up first: `backupFileName` names the backup when it did.
 */
export const transactionRangeDeleteResponseSchema = transactionRangePreviewResponseSchema
  .omit({ selectionKey: true })
  .extend({ backupCreated: z.boolean(), backupFileName: z.string().optional() });
export type TransactionRangeDeleteResult = z.infer<typeof transactionRangeDeleteResponseSchema>;

// ---------------------------------------------------------------------------
// The other transaction answers.

/**
 * POST /api/transactions (201): the transaction written, with its account's, merchant's,
 * period's and budget item's names. Its uuid names it; the answer has no id.
 */
export const transactionCreatedResponseSchema = z.object({
  message: z.string(),
  transaction: z.object({
    uuid: z.uuid(),
    account_id: z.number().int(),
    account_uuid: z.uuid().nullable(),
    account_name: z.string().nullable(),
    merchant_id: z.number().int().nullable(),
    merchant_name: z.string().nullable(),
    /** Pre-signed. */
    amount: responseAmount,
    description: z.string().nullable(),
    transaction_date: dayText,
    type: storedValue(transactionType.options),
    budget_period_id: z.number().int().nullable(),
    budget_period_name: z.string().nullable(),
    budget_item_id: z.number().int().nullable(),
    budget_item_name: z.string().nullable(),
    status: storedValue(transactionStatus.options),
    review_status: storedValue(transactionReviewStatus.options),
    institution_transaction_status: z.string().nullable(),
    created_at: instant,
    updated_at: nullableInstant,
  }),
});
export type TransactionCreatedResponse = z.infer<typeof transactionCreatedResponseSchema>;

/** POST and DELETE /api/transactions/:uuid/tags/:tagUuid: the tag put on, or taken off. */
export const transactionTagDoneResponseSchema = z.object({ success: z.literal(true) });

/** DELETE /api/transactions/:uuid. */
export const transactionDeletedResponseSchema = z.object({ message: z.string() });

/**
 * POST /api/transactions/bulk (201, or 200 for a dry run): each row's result, by its index
 * in the request, and the counts.
 */
export const transactionBulkCreateResponseSchema = z.object({
  dry_run: z.boolean(),
  total: z.number().int(),
  created: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
  results: z.array(
    z.object({
      index: z.number().int(),
      status: z.enum(['created', 'skipped', 'failed']),
      transaction_uuid: z.uuid().optional(),
      reason: z.string().optional(),
    })
  ),
});
export type TransactionBulkCreateResponse = z.infer<typeof transactionBulkCreateResponseSchema>;
