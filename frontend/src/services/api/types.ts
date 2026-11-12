/**
 * API Type Definitions
 * 
 * Centralized TypeScript interfaces for all API entities used throughout
 * the Nuggets frontend application. This file contains type definitions for:
 * 
 * - Financial entities (Accounts, Transactions, Budgets)
 * - User and authentication types
 * - Import and sync data structures
 * - Goal tracking interfaces
 * - Monthly close-out and reconciliation types
 * 
 * Extracted from api.ts for better maintainability and type reusability.
 */

import type { z } from 'zod';
import type {
  Account as SharedAccount,
  AttachmentResponse,
  CategoryResponse,
  InstitutionResponse,
  MerchantResponse,
  MerchantRuleResponse,
  TagResponse,
  BudgetItemMatchingRule as SharedBudgetItemMatchingRule,
  BudgetItemResponse,
  BudgetPeriodItemResponse,
  BudgetPeriodResponse,
  GoalCreateRequest,
  GoalResponse,
  GoalUpdateRequest,
  goalProgressSnapshotResponseSchema,
  goalProjectionResponseSchema,
  TenantUser,
  User as SharedAdminUser,
  TransactionPageResponse,
  TransactionResponse,
  ZeroBalanceAudit,
} from '@nuggets/shared';

/**
 * An account as the API answers it: `@nuggets/shared`'s accountResponseSchema,
 * so a field the route adds is typed here once the schema has it. type, account_type and
 * account_group are today's values or a legacy classification the account kept.
 */
export type Account = SharedAccount;

// ---------------------------------------------------------------------------
// Request bodies.

/** `T` without an index signature: a loose schema's `[key: string]: unknown`, which would let any key through. */
export type KnownFields<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : symbol extends K ? never : K]: T[K];
};

/**
 * The body a route reads with `schema`, its own request schema from `@nuggets/shared`:
 * the schema's input, so a field takes `null` and `undefined` exactly where
 * the route does, under `exactOptionalPropertyTypes`. A loose schema's other fields are left
 * out of the type. Prefer it to a hand-written body type or `Partial<Entity>`, which can't
 * carry a `null` an entity's own type doesn't (Category's `notes?: string` couldn't clear).
 */
export type RequestBody<S extends z.ZodType> = KnownFields<z.input<S>>;

/**
 * A partial write of `T`'s fields, for a route with no body schema of its own: each field
 * may be left out, `undefined` (JSON leaves it out) or `null` (none: the route clears it).
 * `Partial<T>` takes neither under `exactOptionalPropertyTypes` unless `T` does.
 */
export type Patch<T> = { [K in keyof T]?: T[K] | null | undefined };

/** An institution: institutionResponseSchema. The list adds its account count. */
export type Institution = InstitutionResponse;
/**
 * Someone who can open the active ledger (GET /tenants/current/users: its members and its
 * organization's admins), as the pickers that assign one show them: tenantUserResponseSchema.
 */
export type User = TenantUser;
/** An account as a deployment admin's Users page lists and edits it (GET /admin/users): `@nuggets/shared`'s User. */
export type AdminUser = SharedAdminUser;
/**
 * A transaction as the API answers it: `@nuggets/shared`'s transactionResponseSchema.
 * The fields only some answers carry (the row's other columns, the names the lists
 * join) are optional.
 */
export type Transaction = TransactionResponse;
/** An attachment: attachmentResponseSchema. An upload's answer adds the rest of its row. */
export type Attachment = AttachmentResponse;
/** An account's register and the transactions page: transactionPageResponseSchema. */
export type AccountTransactionsResponse = TransactionPageResponse;
/** A budget item (the template): budgetItemResponseSchema. */
export type BudgetItem = BudgetItemResponse;
/** A budget period: budgetPeriodResponseSchema. */
export type BudgetPeriod = BudgetPeriodResponse;
/**
 * A budget period item with its item's fields and the event-sourced figures:
 * budgetPeriodItemResponseSchema.
 */
export type BudgetPeriodItem = BudgetPeriodItemResponse;
/**
 * A period item's budget events (GET /budget-periods/items/:uuid/budget-activity), its
 * transactions (…/transactions) and the budget event log (GET /budgets/events): the shared
 * response schemas' types.
 */
export type { BudgetItemActivityEntry, BudgetItemAssignedTransaction, BudgetEventHistory } from '@nuggets/shared';
/** A category: categoryResponseSchema. */
export type Category = CategoryResponse;
/** A merchant: merchantResponseSchema. The full lists add its counts. */
export type Merchant = MerchantResponse;
/** A merchant's matching rule: merchantRuleResponseSchema. */
export type MerchantRule = MerchantRuleResponse;
/**
 * A tag: tagResponseSchema. The list and one tag carry every field; a create
 * or an update its columns; a transaction's or a budget item's tags their path (and for a
 * budget item its namespace).
 */
export type Tag = TagResponse;
/** A budget item matching rule as the list answers it, with its item's and merchant's names: budgetItemMatchingRuleListEntryResponseSchema. */
export type BudgetItemMatchingRule = SharedBudgetItemMatchingRule;

/** The bank import's answers: `@nuggets/shared`'s schemas. */
export type {
  DiscoveredBankAccount,
  ImportAccountsResponse,
  ImportSettingDefinition,
  ImportSettingsMap,
  ImportSettingsResponse,
  ImportStatus,
  ImportUser,
  ImportUsersResponse,
  SimpleFinAccountInfo,
  SimpleFinAccountsResponse,
  SyncLog,
  SystemSetting,
  TestImportConnectionResponse,
  TimezoneOption,
} from '@nuggets/shared';
/** A goal: goalResponseSchema. The list, one goal and the create/update answers carry different parts. */
export type Goal = GoalResponse;
/** A goal's progress at the end of one day: decimal text, computed when it is read. */
export type GoalProgressSnapshot = z.infer<typeof goalProgressSnapshotResponseSchema>;
export type GoalProjection = z.infer<typeof goalProjectionResponseSchema>;
/** A goal create's body: goalCreateSchema's input, null or left out where the route takes either. */
export type CreateGoalRequest = GoalCreateRequest;
export type UpdateGoalRequest = GoalUpdateRequest;
/** One account of the Close-Out zero-balance audit: zeroBalanceAuditResponseSchema. */
export type ZeroBalanceAccount = ZeroBalanceAudit['accounts'][number];
export type ZeroBalanceSummary = ZeroBalanceAudit['summary'];
/** Close-Out's envelope reconciliation, worked out by `@nuggets/shared`'s envelopeReconciliation. */
export type { EnvelopeAccount, EnvelopeBudgetSummary, EnvelopeVariance, EnvelopeReconciliation } from '@nuggets/shared';
