/**
 * Shared form-shape types + default-value factories.
 *
 * These are the generics and `defaultValues` for the pages' react-hook-form
 * `useForm(...)` calls. They derive from the API entity types and exclude
 * database-generated fields (id, uuid, user_id, created_at, updated_at).
 *
 * Validation is NOT done here: each form's `zodResolver` uses the shared
 * schemas in `@nuggets/shared`.
 */

import type { AdminUser, Patch, Transaction } from '../services/api';
import type {
  TransactionType,
  TransactionStatus,
  TransactionReviewStatus,
  CostBasisMethod,
  CorporateActionType,
  FeeType,
  TagReportFlowMeasure,
  BudgetItemAmountField,
  BudgetItemRequest,
} from '@nuggets/shared';
import { todayLocal } from '../utils/dateUtils';

// ====================================================================
// BASE FORM TYPES
// ====================================================================

/**
 * Generic form data type - excludes DB-generated fields. Use this as a base for an entity's
 * form type. Each field may be left out, `undefined` or `null` (none), as the API's request
 * schemas take them: under `exactOptionalPropertyTypes`, `Partial<T>` took
 * neither unless `T` did, so a form couldn't clear a field its entity's type had as `string`.
 */
type FormData<T> = Patch<Omit<T, 'id' | 'uuid' | 'user_id' | 'created_at' | 'updated_at'>>;

// ====================================================================
// BUDGET ITEM FORMS
// ====================================================================

/**
 * Base type for all budget item forms: the fields a budget item request writes
 * (BudgetItemRequest: each may be left out, `undefined`, and set to `null` where the item may
 * have none), its amounts as the numbers the amount inputs hold (NaN for one that can't be read,
 * which the request leaves out).
 */
export type BudgetItemFormData = {
  [K in keyof BudgetItemRequest]?: K extends BudgetItemAmountField ? number | null | undefined : BudgetItemRequest[K];
};

/**
 * Income form types + defaults now live with the shared field component:
 * components/forms/IncomeFormFields.tsx.
 */

/**
 * Expense form types + defaults now live with the shared field component:
 * components/forms/ExpenseFormFields.tsx.
 */

/**
 * Bill form types + defaults now live with the shared field component:
 * components/forms/BillFormFields.tsx.
 */

// ====================================================================
// ACCOUNT FORMS
// ====================================================================
// Account form types + defaults now live with the shared field component:
// components/forms/AccountFormFields.tsx.

// ====================================================================
// USER FORMS
// ====================================================================

/**
 * User form data - base type for user operations
 */
export type UserFormData = FormData<AdminUser>;

/**
 * User creation form - includes password field (not in User type)
 */
export interface CreateUserFormData extends UserFormData {
  email: string; // Required
  password: string; // Only for creation
  first_name: string; // Required
  last_name: string; // Required
}

/**
 * Creates default values for user creation form
 */
export const createDefaultUserForm = (): CreateUserFormData => ({
  email: '',
  password: '',
  first_name: '',
  last_name: '',
});

/**
 * =============================================================================
 * BUDGET PERIOD FORM TYPES
 * =============================================================================
 */

/**
 * Budget period creation form - minimal fields for creating new period
 */
export interface CreateBudgetPeriodFormData {
  year: number;
  month: number; // 1-12
}

/**
 * Creates default values for budget period creation form
 */
export const createDefaultBudgetPeriodForm = (): CreateBudgetPeriodFormData => ({
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1, // JavaScript months are 0-based
});

/**
 * =============================================================================
 * EDIT USER FORM TYPES (User Profile Editing)
 * =============================================================================
 */

/**
 * A deployment admin's edit of an account - the account (AdminUser) with a file upload field
 */
export interface EditUserFormData extends AdminUser {
  profile_image_file: File | null; // File object for upload (null = no change)
}

/**
 * Password change form - separate from user profile editing
 */
export interface PasswordChangeFormData {
  newPassword: string;
  confirmPassword: string;
}

/**
 * Creates default values for password change form
 */
export const createDefaultPasswordChangeForm = (): PasswordChangeFormData => ({
  newPassword: '',
  confirmPassword: '',
});

/**
 * =============================================================================
 * MERCHANT FORM TYPES
 * =============================================================================
 *
 * Merchant create/edit form types + defaults now live with the shared field
 * component: `components/forms/MerchantFormFields.tsx`. The merchant matching
 * rule form types remain below.
 */

/**
 * Institution form types + defaults now live with the shared field component:
 * `components/forms/InstitutionFormFields.tsx`.
 */

/**
 * Goal form types + defaults now live with the shared field component:
 * `components/forms/GoalFormFields.tsx`.
 */

/**
 * =============================================================================
 * TRANSACTION FORM TYPES
 * =============================================================================
 */

/**
 * Base transaction form data - derived from Transaction API type
 */
type TransactionFormData = Omit<Transaction, 'id' | 'uuid' | 'user_id' | 'created_at' | 'updated_at' | 'running_account_balance' | 'account_name' | 'account_uuid' | 'account_class' | 'budget_item_name' | 'budget_item_uuid' | 'budget_period_item_name' | 'budget_period_name' | 'merchant_name' | 'assigned_user'>;

/**
 * Add Transaction (AddTransactionPage, react-hook-form; validated by
 * `addTransactionFormSchema` there). The account comes from the route. The type,
 * status and review status are the database's values (`@nuggets/shared`): lowercase.
 */
export interface CreateTransactionFormData {
  merchant_name: string; // For merchant autocomplete/creation
  merchant_id: number | null;
  /** null until an amount is entered. */
  amount: number | null;
  transaction_date: string;
  type: TransactionType;
  status: TransactionStatus;
  review_status: TransactionReviewStatus;
  description: string;
  budget_item_id: number | null;
  budget_period_id: number | null;
}

/**
 * Creates default values for transaction creation form. The status was 'Pending',
 * which the database refuses (it takes 'pending'), so a transaction saved without
 * touching the Status select failed with a server error.
 */
export const createDefaultTransactionForm = (): CreateTransactionFormData => ({
  merchant_name: '',
  merchant_id: null,
  amount: null,
  description: '',
  transaction_date: todayLocal(),
  type: 'expense',
  status: 'pending',
  review_status: 'needs review',
  budget_item_id: null,
  budget_period_id: null,
});

/**
 * Transaction editing form - for editing existing transactions. The type, status and
 * review status are the database's values, as the create form's are: Save Changes sends
 * the form as it is, and the server refuses a label ('Cleared').
 */
export interface EditTransactionFormData extends Omit<TransactionFormData, 'merchant_name' | 'amount' | 'transaction_date' | 'type' | 'status' | 'review_status' | 'account_id' | 'description' | 'budget_item_id' | 'merchant_id' | 'budget_period_id' | 'notes' | 'assigned_to' | 'external_transaction_id' | 'external_link'> {
  merchant_name?: string; // Optional for editing (may already have merchant)
  amount: number;
  transaction_date: string;
  // The stored value, which a transaction may keep from before today's lists.
  type: Transaction['type'];
  status: Transaction['status'];
  review_status: Transaction['review_status'];
  account_id: number;
  description?: string;
  budget_item_id?: number | null;
  merchant_id?: number | null;
  budget_period_id?: number | null;
  notes?: string;
  assigned_to?: number | null;
  external_transaction_id?: string;
  external_link?: string;
}

/**
 * Category form types + defaults now live with the shared field component:
 * `components/forms/CategoryFormFields.tsx`.
 */

/**
 * =============================================================================
 * MERCHANT RULE FORM TYPES
 * =============================================================================
 */

/**
 * Merchant rule creation/editing form - for merchant matching rules
 */
export interface MerchantRuleFormData {
  method: 'exact' | 'contains' | 'starts_with' | 'ends_with' | 'regex';
  matching_text: string;
}

/**
 * Creates default values for merchant rule form
 */
export const createDefaultMerchantRuleForm = (): MerchantRuleFormData => ({
  method: 'contains',
  matching_text: '',
});

/**
 * =============================================================================
 * BUDGET MATCHING RULE FORM TYPES
 * =============================================================================
 *
 * Budget matching rule form types + defaults now live with the shared field
 * component: `components/forms/BudgetMatchingRuleFormFields.tsx`.
 */

/**
 * =============================================================================
 * MEMBERSHIP FORM TYPES
 * =============================================================================
 */

/** Invite someone to an organization (InviteMemberDialog); validated by `createInvitationSchema`. */
export interface InviteMemberFormData {
  email: string;
  isAdmin: boolean;
}

export const createDefaultInviteMemberForm = (): InviteMemberFormData => ({
  email: '',
  isAdmin: false,
});

/** Add a member of the ledger's organization to the ledger (AddLedgerMemberForm). */
export interface AddLedgerMemberFormData {
  /** The chosen organization member's user uuid; null for no selection. */
  userUuid: string | null;
  isAdmin: boolean;
}

export const createDefaultAddLedgerMemberForm = (): AddLedgerMemberFormData => ({
  userUuid: null,
  isAdmin: false,
});

/**
 * =============================================================================
 * INVESTMENT EVENT FORM TYPES
 * =============================================================================
 *
 * The six investment event pages share one form, `components/investments/InvestmentEventForm`,
 * each with its own field config (`components/investments/investmentEventConfigs.tsx`), which
 * checks a submit against the event's `@nuggets/shared` request schema. A share count or
 * ratio is text, sent as typed (the API reads it exactly); an amount is CurrencyInput's
 * number, null while empty; an optional amount (fees) is 0 when empty and NaN when its text
 * can't be read (forms/optionalAmount.ts).
 */

/** Record buy (`buyEventSchema`). */
export interface BuyEventFormData {
  account_uuid: string;
  security_uuid: string;
  event_date: string;
  shares: string;
  price_per_share: number | null;
  /** Optional: 0 when empty, NaN when unreadable. */
  fees: number;
  /** The shares and price are already adjusted for the splits recorded after its date. */
  adjusted_for_splits: boolean;
}

export const createDefaultBuyEventForm = (): BuyEventFormData => ({
  account_uuid: '',
  security_uuid: '',
  event_date: todayLocal(),
  shares: '',
  price_per_share: null,
  fees: 0,
  adjusted_for_splits: false,
});

/** Record sell (`sellEventSchema`): a buy's fields, the method, and each open lot's shares for a specific-lots sale. */
export interface SellEventFormData extends BuyEventFormData {
  method: CostBasisMethod;
  /** By lot uuid: the shares sold from it, as typed ('' or absent for none). */
  lot_shares: Record<string, string>;
}

export const createDefaultSellEventForm = (): SellEventFormData => ({
  ...createDefaultBuyEventForm(),
  method: 'fifo',
  lot_shares: {},
});

/** Record dividend (`dividendEventSchema`). */
export interface DividendEventFormData {
  account_uuid: string;
  security_uuid: string;
  event_date: string;
  total_amount: number | null;
  is_qualified: boolean;
  reinvest: boolean;
  /** The reinvestment price, sent only when reinvested. */
  price_per_share: number | null;
  /** The reinvestment price is already adjusted for the splits recorded after it; sent only when reinvested. */
  adjusted_for_splits: boolean;
}

export const createDefaultDividendEventForm = (): DividendEventFormData => ({
  account_uuid: '',
  security_uuid: '',
  event_date: todayLocal(),
  total_amount: null,
  is_qualified: true,
  reinvest: false,
  price_per_share: null,
  adjusted_for_splits: false,
});

/** The fee form's Security choice for a fee on the account as a whole. */
export const ACCOUNT_LEVEL_FEE = 'none';

/** Record fee (`feeEventSchema`). */
export interface FeeEventFormData {
  account_uuid: string;
  /** A security's uuid, or ACCOUNT_LEVEL_FEE. */
  security_uuid: string;
  fee_type: FeeType;
  amount: number | null;
  event_date: string;
  description: string;
}

export const createDefaultFeeEventForm = (): FeeEventFormData => ({
  account_uuid: '',
  security_uuid: ACCOUNT_LEVEL_FEE,
  fee_type: 'advisory',
  amount: null,
  event_date: todayLocal(),
  description: '',
});

/**
 * A corporate action (`splitActionSchema`, `returnOfCapitalSchema`, `spinoffActionSchema`,
 * `mergerCashSchema`, `mergerStockSchema`): each action sends the fields it uses. The split's
 * new shares, the spinoff's share ratio and the stock merger's exchange ratio are one value,
 * kept as the action changes.
 */
export interface CorporateActionFormData {
  security_uuid: string;
  /** The new security (spinoff) or the acquirer (stock merger). */
  other_security_uuid: string;
  action_type: CorporateActionType;
  action_date: string;
  numerator: string;
  denominator: string;
  /** Return of capital, or cash, per share. */
  amount_per_share: number | null;
  /** The spinoff's share of the basis, in percent, as typed. */
  allocation_percent: string;
}

export const createDefaultCorporateActionForm = (): CorporateActionFormData => ({
  security_uuid: '',
  other_security_uuid: '',
  action_type: 'split',
  action_date: todayLocal(),
  numerator: '2',
  denominator: '1',
  amount_per_share: null,
  allocation_percent: '20',
});

/** Add price (`priceUpsertSchema`). */
export interface PriceFormData {
  security_uuid: string;
  price_date: string;
  close: number | null;
}

export const createDefaultPriceForm = (securityUuid = ''): PriceFormData => ({
  security_uuid: securityUuid,
  price_date: todayLocal(),
  close: null,
});

/**
 * =============================================================================
 * PROFILE, FIRST-RUN SETUP AND TAG FORMS
 * =============================================================================
 */

/**
 * My Profile's details (ProfilePage), checked with `ownProfileUpdateSchema`'s fields and sent
 * to PUT /api/auth/profile as multipart, with the picture.
 */
export interface ProfileFormData {
  first_name: string;
  last_name: string;
  default_color: string;
  icon: string;
  /** A new picture to upload; null for none. */
  profile_image: File | null;
  /** Remove the current picture (sent as remove_profile_image: 'true'). */
  remove_profile_image: boolean;
}

/** The profile form for a signed-in user: their details, no picture change. */
export const createProfileForm = (user: {
  first_name?: string | null | undefined;
  last_name?: string | null | undefined;
  default_color?: string | null | undefined;
  icon?: string | null | undefined;
} | null): ProfileFormData => ({
  first_name: user?.first_name || '',
  last_name: user?.last_name || '',
  default_color: user?.default_color || '#3B82F6',
  icon: user?.icon || 'User',
  profile_image: null,
  remove_profile_image: false,
});

/** Change your own password (ProfilePage): the current one too (`changePasswordSchema`). */
export interface OwnPasswordChangeFormData extends PasswordChangeFormData {
  currentPassword: string;
}

export const createDefaultOwnPasswordChangeForm = (): OwnPasswordChangeFormData => ({
  currentPassword: '',
  ...createDefaultPasswordChangeForm(),
});

/** A new passkey's name (`passkeyRegistrationSchema`'s deviceName); empty for none. */
export interface PasskeyNameFormData {
  deviceName: string;
}

/** First-run setup (AdminSetupPage): the setup token and the first admin. */
export interface AdminSetupFormData {
  setupToken: string;
  email: string;
  password: string;
  confirmPassword: string;
  firstName: string;
  lastName: string;
}

export const createDefaultAdminSetupForm = (): AdminSetupFormData => ({
  setupToken: '',
  email: '',
  password: '',
  confirmPassword: '',
  firstName: '',
  lastName: '',
});

/** A tag, in the Tags page's Add and Edit dialogs (`tagWriteSchema`). */
export interface TagFormData {
  name: string;
  color: string;
  icon: string;
  description: string;
  parent_id: number | null;
  is_active: boolean;
  /** A top-level tag's report namespace (sent on its own after an edit). */
  is_report_root: boolean;
  report_flow_measure: TagReportFlowMeasure;
}

export const createDefaultTagForm = (parentId: number | null = null): TagFormData => ({
  name: '',
  color: '#3B82F6',
  icon: 'Tag',
  description: '',
  parent_id: parentId,
  is_active: true,
  is_report_root: false,
  report_flow_measure: 'effective',
});
