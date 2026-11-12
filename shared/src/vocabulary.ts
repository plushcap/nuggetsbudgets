import { z } from 'zod';
import { accountGroup, accountType, assetType } from './primitives.js';
import { transactionReviewStatus, transactionStatus, transactionType } from './transactions.js';
import {
  annotationAuthorKind,
  annotationFeedback,
  annotationKind,
  annotationLearningStatus,
  annotationSeverity,
  annotationStatus,
  annotationSubjectType,
} from './annotations.js';
import { acquisitionMethod, costBasisMethod, dataQuality, feeType, holdingEventType, securityType } from './investments.js';

/**
 * The ledger's vocabularies: the values each enum-like column takes, as constants with a
 * Zod enum for each. The database enforces the same lists:
 * `check_known_or_unchanged` triggers on the tables the app edits, list CHECKs on the
 * budget event log and the rest. backend `vocabulary.db.test.ts` reads both from the
 * database and fails when a list here and there disagree, or when a column gets a trigger
 * or a list CHECK with no constant here.
 *
 * Use these rather than repeating the literals: `REVIEW_STATUSES.includes(x)`,
 * `transactionReviewStatus.parse(x)`, `z.enum(TRANSACTION_TYPES)`.
 */

// Lists that already had a Zod enum: the constant is that enum's options.

/** transactions.type */
export const TRANSACTION_TYPES = transactionType.options;
/** transactions.status */
export const TRANSACTION_STATUSES = transactionStatus.options;
/** transactions.review_status */
export const REVIEW_STATUSES = transactionReviewStatus.options;
/** accounts.type */
export const ASSET_TYPES = assetType.options;
/** accounts.account_type */
export const ACCOUNT_TYPES = accountType.options;
/** accounts.account_group (with the legacy 'credit cards'; see accountGroup). */
export const ACCOUNT_GROUPS = accountGroup.options;
/** annotations.subject_type */
export const ANNOTATION_SUBJECT_TYPES = annotationSubjectType.options;
/** annotations.kind */
export const ANNOTATION_KINDS = annotationKind.options;
/** annotations.status */
export const ANNOTATION_STATUSES = annotationStatus.options;
/** annotations.author_kind */
export const ANNOTATION_AUTHOR_KINDS = annotationAuthorKind.options;
/** annotations.severity */
export const ANNOTATION_SEVERITIES = annotationSeverity.options;
/** annotations.feedback */
export const ANNOTATION_FEEDBACK = annotationFeedback.options;
/** annotations.learning_status */
export const ANNOTATION_LEARNING_STATUSES = annotationLearningStatus.options;
/** securities.security_type */
export const SECURITY_TYPES = securityType.options;
/** cost_basis_method_settings.method */
export const COST_BASIS_METHODS = costBasisMethod.options;
/** holding_events.event_type */
export const HOLDING_EVENT_TYPES = holdingEventType.options;
/** holding_events.fee_type (or NULL, on an event that isn't a fee) */
export const FEE_TYPES = feeType.options;
/** tax_lots.acquisition_method */
export const ACQUISITION_METHODS = acquisitionMethod.options;
/** tax_lots.data_quality */
export const DATA_QUALITIES = dataQuality.options;

// Lists new here.

/** transactions.budget_matching_method: BudgetItemMatcher's MatchResult methods. */
export const BUDGET_MATCHING_METHODS = [
  'none',
  'merchant-rule',
  'description-rule',
  'merchant-history',
  'description-similarity',
  'error',
] as const;
export const budgetMatchingMethod = z.enum(BUDGET_MATCHING_METHODS);
export type BudgetMatchingMethod = z.infer<typeof budgetMatchingMethod>;

/** budget_items.expense_type */
export const BUDGET_EXPENSE_TYPES = ['Expense', 'Income', 'Savings', 'Transfer', 'Transfer: Payment'] as const;
export const budgetExpenseType = z.enum(BUDGET_EXPENSE_TYPES);
export type BudgetExpenseType = z.infer<typeof budgetExpenseType>;

/** budget_items.priority */
export const BUDGET_PRIORITIES = ['Essential', 'Optional'] as const;
export const budgetPriority = z.enum(BUDGET_PRIORITIES);
export type BudgetPriority = z.infer<typeof budgetPriority>;

/** notifications.status */
export const NOTIFICATION_STATUSES = ['pending', 'processing', 'sent', 'failed', 'delivered', 'bounced'] as const;
export const notificationStatus = z.enum(NOTIFICATION_STATUSES);
export type NotificationStatus = z.infer<typeof notificationStatus>;

/** taggings.taggable_type */
export const TAGGABLE_TYPES = ['transaction', 'budget_item'] as const;
export const taggableType = z.enum(TAGGABLE_TYPES);
export type TaggableType = z.infer<typeof taggableType>;

/** taggings.type */
export const TAGGING_TYPES = ['manual', 'auto'] as const;
export const taggingType = z.enum(TAGGING_TYPES);
export type TaggingType = z.infer<typeof taggingType>;

/** budget_items.status, which a goal (a Savings budget item) has too. */
export const BUDGET_ITEM_STATUSES = ['active', 'completed', 'paused', 'archived'] as const;
export const budgetItemStatus = z.enum(BUDGET_ITEM_STATUSES);
export type BudgetItemStatus = z.infer<typeof budgetItemStatus>;

/** bill_occurrences.resolution (or NULL, when it's neither): skipped, or paid without a transaction. */
export const BILL_RESOLUTIONS = ['skipped', 'paid_manually'] as const;
export const billResolution = z.enum(BILL_RESOLUTIONS);
export type BillResolution = z.infer<typeof billResolution>;

/** bill_occurrence_transactions.matched_by: 'excluded' is a payment unlinked by hand, which matching leaves alone. */
export const BILL_PAYMENT_MATCHES = ['auto', 'manual', 'excluded'] as const;
export const billPaymentMatch = z.enum(BILL_PAYMENT_MATCHES);
export type BillPaymentMatch = z.infer<typeof billPaymentMatch>;

/** security_corporate_actions.action_type */
export const CORPORATE_ACTION_TYPES = ['split', 'reverse_split', 'return_of_capital', 'spinoff', 'merger_cash', 'merger_stock'] as const;
export const corporateActionType = z.enum(CORPORATE_ACTION_TYPES);
export type CorporateActionType = z.infer<typeof corporateActionType>;

/** data_freshness_thresholds.data_category: the reference data whose age the freshness report checks. */
export const DATA_FRESHNESS_CATEGORIES = ['price', 'composition', 'expense_ratio', 'underlying_holdings'] as const;
export const dataFreshnessCategory = z.enum(DATA_FRESHNESS_CATEGORIES);
export type DataFreshnessCategory = z.infer<typeof dataFreshnessCategory>;

/** tags.report_flow_measure: which figure a tag's flow report sums. */
export const TAG_REPORT_FLOW_MEASURES = ['actual', 'allocated', 'effective'] as const;
export const tagReportFlowMeasure = z.enum(TAG_REPORT_FLOW_MEASURES);
export type TagReportFlowMeasure = z.infer<typeof tagReportFlowMeasure>;

// The budget event log (budget_period_transactions), which only BudgetService writes.

/** budget_period_transactions.transaction_type */
export const BUDGET_EVENT_TRANSACTION_TYPES = ['add', 'remove', 'move_in', 'move_out'] as const;
export const budgetEventTransactionType = z.enum(BUDGET_EVENT_TRANSACTION_TYPES);
export type BudgetEventTransactionType = z.infer<typeof budgetEventTransactionType>;

/** budget_period_transactions.type */
export const BUDGET_EVENT_TYPES = ['budget_update', 'starting_balance', 'transfer'] as const;
export const budgetEventType = z.enum(BUDGET_EVENT_TYPES);
export type BudgetEventType = z.infer<typeof budgetEventType>;

/**
 * budget_period_transactions.event_type, which nothing reads. 'starting_balance' is on the
 * starting balances an earlier budget import wrote; no writer uses it now.
 */
export const BUDGET_EVENT_KINDS = ['budget_update', 'user_transfer', 'starting_balance'] as const;
export const budgetEventKind = z.enum(BUDGET_EVENT_KINDS);
export type BudgetEventKind = z.infer<typeof budgetEventKind>;

/**
 * budget_period_transactions.source_system. 'import' is on the starting balances an earlier
 * budget import wrote, which BudgetService counts as it does 'system' and 'nuggets_app'.
 */
export const BUDGET_EVENT_SOURCES = ['system', 'nuggets_app', 'type_change', 'merge', 'import'] as const;
export const budgetEventSource = z.enum(BUDGET_EVENT_SOURCES);
export type BudgetEventSource = z.infer<typeof budgetEventSource>;

// Control-plane tables (not a ledger's data), which CHECK their lists too.

/** personal_access_tokens.scope: a read token may only read (middleware/tokenAccess.ts). */
export const PERSONAL_ACCESS_TOKEN_SCOPES = ['read', 'read_write'] as const;
export const personalAccessTokenScope = z.enum(PERSONAL_ACCESS_TOKEN_SCOPES);
export type PersonalAccessTokenScope = z.infer<typeof personalAccessTokenScope>;

/** webauthn_challenges.purpose: the passkey ceremony a stored challenge is for. */
export const WEBAUTHN_CHALLENGE_PURPOSES = ['registration', 'authentication', 'reauthentication'] as const;
export const webauthnChallengePurpose = z.enum(WEBAUTHN_CHALLENGE_PURPOSES);
export type WebauthnChallengePurpose = z.infer<typeof webauthnChallengePurpose>;

/**
 * Each database-checked column and its list, keyed `table.column`, for the test that
 * compares them with the database (and for code that needs to look one up by column).
 * The ledger's own tables; CONTROL_PLANE_VOCABULARIES has the rest.
 */
export const TENANT_VOCABULARIES = {
  'transactions.type': TRANSACTION_TYPES,
  'transactions.status': TRANSACTION_STATUSES,
  'transactions.review_status': REVIEW_STATUSES,
  'transactions.budget_matching_method': BUDGET_MATCHING_METHODS,
  'accounts.type': ASSET_TYPES,
  'accounts.account_type': ACCOUNT_TYPES,
  'accounts.account_group': ACCOUNT_GROUPS,
  'budget_items.expense_type': BUDGET_EXPENSE_TYPES,
  'budget_items.priority': BUDGET_PRIORITIES,
  'notifications.status': NOTIFICATION_STATUSES,
  'taggings.taggable_type': TAGGABLE_TYPES,
  'taggings.type': TAGGING_TYPES,
  'annotations.subject_type': ANNOTATION_SUBJECT_TYPES,
  'annotations.kind': ANNOTATION_KINDS,
  'annotations.status': ANNOTATION_STATUSES,
  'annotations.author_kind': ANNOTATION_AUTHOR_KINDS,
  'annotations.severity': ANNOTATION_SEVERITIES,
  'annotations.feedback': ANNOTATION_FEEDBACK,
  'annotations.learning_status': ANNOTATION_LEARNING_STATUSES,
  'budget_period_transactions.transaction_type': BUDGET_EVENT_TRANSACTION_TYPES,
  'budget_period_transactions.type': BUDGET_EVENT_TYPES,
  'budget_period_transactions.event_type': BUDGET_EVENT_KINDS,
  'budget_period_transactions.source_system': BUDGET_EVENT_SOURCES,
  'budget_items.status': BUDGET_ITEM_STATUSES,
  'bill_occurrences.resolution': BILL_RESOLUTIONS,
  'bill_occurrence_transactions.matched_by': BILL_PAYMENT_MATCHES,
  'securities.security_type': SECURITY_TYPES,
  'cost_basis_method_settings.method': COST_BASIS_METHODS,
  'holding_events.event_type': HOLDING_EVENT_TYPES,
  'holding_events.fee_type': FEE_TYPES,
  'tax_lots.acquisition_method': ACQUISITION_METHODS,
  'tax_lots.data_quality': DATA_QUALITIES,
  'security_corporate_actions.action_type': CORPORATE_ACTION_TYPES,
  'data_freshness_thresholds.data_category': DATA_FRESHNESS_CATEGORIES,
  'tags.report_flow_measure': TAG_REPORT_FLOW_MEASURES,
} as const satisfies Record<string, readonly string[]>;

/**
 * The control-plane columns with a list CHECK, as TENANT_VOCABULARIES has the tenant's.
 * (tenant_settings.setting_key's list is the backend's TENANT_SETTING_KEYS.)
 */
export const CONTROL_PLANE_VOCABULARIES = {
  'personal_access_tokens.scope': PERSONAL_ACCESS_TOKEN_SCOPES,
  'webauthn_challenges.purpose': WEBAUTHN_CHALLENGE_PURPOSES,
} as const satisfies Record<string, readonly string[]>;

// What people see for a value. A page builds a list's options from its constant above and
// shows these words, and keeps the value itself for what it sends and compares (a page
// that held 'Cleared' in its form sent it, and the server, which checks the exact value,
// refused). Each map has a word for every value of its list and nothing else, so a value
// added to a list doesn't build until it has one.

/** A label for each value of `List`. */
export type VocabularyLabels<List extends readonly string[]> = Readonly<Record<List[number], string>>;

/**
 * The label for `value`, or the value itself when it isn't one of the list's: a row can still
 * hold a value from before its list (the database keeps one an edit leaves unchanged).
 */
export function vocabularyLabel<Value extends string>(
  labels: Readonly<Record<Value, string>>,
  value: string | null | undefined
): string {
  if (value === null || value === undefined) return '';
  return Object.prototype.hasOwnProperty.call(labels, value) ? labels[value as Value] : value;
}

export const TRANSACTION_TYPE_LABELS: VocabularyLabels<typeof TRANSACTION_TYPES> = {
  income: 'Income',
  expense: 'Expense',
  payment: 'Payment',
  transfer: 'Transfer',
  'starting balance': 'Starting Balance',
  'balance adjustment': 'Balance Adjustment',
};

export const TRANSACTION_STATUS_LABELS: VocabularyLabels<typeof TRANSACTION_STATUSES> = {
  pending: 'Pending',
  cleared: 'Cleared',
  reconciled: 'Reconciled',
};

export const REVIEW_STATUS_LABELS: VocabularyLabels<typeof REVIEW_STATUSES> = {
  'needs review': 'Needs Review',
  reviewed: 'Reviewed',
  flagged: 'Flagged',
};

export const ASSET_TYPE_LABELS: VocabularyLabels<typeof ASSET_TYPES> = {
  Asset: 'Asset',
  Liability: 'Liability',
};

export const ACCOUNT_TYPE_LABELS: VocabularyLabels<typeof ACCOUNT_TYPES> = {
  checking: 'Checking Account',
  savings: 'Savings Account',
  cash: 'Cash Account',
  investment: 'Investment Account',
  business: 'Business Account',
  credit_card: 'Credit Card',
  loan: 'Loan Account',
  mortgage: 'Mortgage',
  line_of_credit: 'Line of Credit',
  other: 'Other',
};

/** Both spellings of the credit-card group read the same (see accountGroup). */
export const ACCOUNT_GROUP_LABELS: VocabularyLabels<typeof ACCOUNT_GROUPS> = {
  cash: 'Cash',
  'credit cards': 'Credit Cards',
  credit_cards: 'Credit Cards',
  investments: 'Investments',
  loans: 'Loans',
  other: 'Other',
};

export const BUDGET_PRIORITY_LABELS: VocabularyLabels<typeof BUDGET_PRIORITIES> = {
  Essential: 'Essential',
  Optional: 'Optional',
};

export const BUDGET_ITEM_STATUS_LABELS: VocabularyLabels<typeof BUDGET_ITEM_STATUSES> = {
  active: 'Active',
  completed: 'Completed',
  paused: 'Paused',
  archived: 'Archived',
};

export const ANNOTATION_KIND_LABELS: VocabularyLabels<typeof ANNOTATION_KINDS> = {
  reasoning: 'Reasoning',
  question: 'Question',
  answer: 'Answer',
  observation: 'Observation',
  decision: 'Decision',
  flag: 'Flag',
  correction: 'Correction',
  note: 'Note',
};

export const ANNOTATION_STATUS_LABELS: VocabularyLabels<typeof ANNOTATION_STATUSES> = {
  open: 'Open',
  answered: 'Answered',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
  acknowledged: 'Acknowledged',
};

export const SECURITY_TYPE_LABELS: VocabularyLabels<typeof SECURITY_TYPES> = {
  stock: 'Stock',
  etf: 'ETF',
  mutual_fund: 'Mutual fund',
  bond: 'Bond',
  money_market: 'Money market',
  crypto: 'Crypto',
  other: 'Other',
};

export const COST_BASIS_METHOD_LABELS: VocabularyLabels<typeof COST_BASIS_METHODS> = {
  fifo: 'FIFO (first in, first out)',
  lifo: 'LIFO (last in, first out)',
  hifo: 'HIFO (highest cost first)',
  specific_id: 'Specific lots',
  average_cost: 'Average cost',
};

export const HOLDING_EVENT_TYPE_LABELS: VocabularyLabels<typeof HOLDING_EVENT_TYPES> = {
  buy: 'Buy',
  sell: 'Sell',
  dividend: 'Dividend',
  dividend_reinvest: 'Dividend reinvested',
  split: 'Split',
  reverse_split: 'Reverse split',
  spinoff: 'Spinoff',
  merger_cash: 'Merger (cash)',
  merger_stock: 'Merger (stock)',
  return_of_capital: 'Return of capital',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
  fee: 'Fee',
  manual_adjustment: 'Manual adjustment',
  lot_correction: 'Lot correction',
  historical_import: 'Historical import',
};

export const FEE_TYPE_LABELS: VocabularyLabels<typeof FEE_TYPES> = {
  commission: 'Commission',
  advisory: 'Advisory',
  account_maintenance: 'Account maintenance',
  inactivity: 'Inactivity',
  wire_transfer: 'Wire transfer',
  transfer_out: 'Transfer out',
  paper_statement: 'Paper statement',
  tax_loss_harvesting: 'Tax-loss harvesting',
  expense_ratio_drag: 'Expense ratio drag',
  other: 'Other',
};

export const CORPORATE_ACTION_TYPE_LABELS: VocabularyLabels<typeof CORPORATE_ACTION_TYPES> = {
  split: 'Stock split',
  reverse_split: 'Reverse split',
  return_of_capital: 'Return of capital',
  spinoff: 'Spinoff',
  merger_cash: 'Merger (cash)',
  merger_stock: 'Merger (stock)',
};

export const TAG_REPORT_FLOW_MEASURE_LABELS: VocabularyLabels<typeof TAG_REPORT_FLOW_MEASURES> = {
  effective: 'Effective',
  actual: 'Actual',
  allocated: 'Allocated',
};

export const PERSONAL_ACCESS_TOKEN_SCOPE_LABELS: VocabularyLabels<typeof PERSONAL_ACCESS_TOKEN_SCOPES> = {
  read: 'Read only',
  read_write: 'Read and write',
};
