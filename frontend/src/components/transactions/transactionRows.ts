import { Tag as TagIcon } from 'lucide-react';
import type { Account, BudgetPeriod, Transaction, User } from '../../services/api';
import { DateUtils } from '../../utils/dateUtils';
import { getIconByName, type IconComponent } from '../../utils/iconCatalog';
import { transactionStatus } from '@nuggets/shared';

/**
 * What the transaction table shows in its columns, worked out from a transaction and the
 * ledger's lists, for the desktop rows, the mobile cards and the quick-actions sheet alike.
 */

/** Who or what the row is: the merchant's name, else the bank's description. */
export const payeeOf = (transaction: Transaction): string | null => transaction.merchant_name || transaction.description;

/** Which transaction a row's controls act on, for their names ("Corner store, 10/20/2026"). */
export const rowLabel = (transaction: Transaction): string =>
  `${payeeOf(transaction)}, ${DateUtils.formatDateUS(transaction.transaction_date)}`;

/** The accessible name of a row's selection checkbox: the payee the row shows, and its date. */
export const selectLabel = (transaction: Transaction): string => `Select ${rowLabel(transaction)}`;

/**
 * A status badge's colour: green once the bank has it (cleared, reconciled), gray while it's
 * pending or a value from before today's list (the database's lower-case values, compared
 * as they are, and shown with their label). The badge is highContrast, so its text is step 12.
 */
export const statusBadgeColor = (status: Transaction['status']): 'green' | 'gray' =>
  status === transactionStatus.enum.cleared || status === transactionStatus.enum.reconciled ? 'green' : 'gray';

const REVIEW_STATUS_WORDS: Record<string, string> = { reviewed: 'Reviewed', flagged: 'Flagged' };

/** The review status in words, for a screen reader and a tooltip. */
export const reviewStatusWords = (transaction: Transaction): string =>
  REVIEW_STATUS_WORDS[transaction.review_status] ?? 'Needs review';

/** An amount's colour: red going out, green coming in (amounts are pre-signed). */
export const amountColor = (amount: number): 'red' | 'green' => (amount < 0 ? 'red' : 'green');

/** The periods the quick actions offer: the three latest not archived, newest first (the list is oldest first). */
export const latestBudgetPeriods = (budgetPeriods: BudgetPeriod[]): BudgetPeriod[] =>
  budgetPeriods.filter((period) => !period.archived_at).slice(-3).reverse();

/** A tag's chosen icon, or the plain tag icon. */
export const tagIconComponent = (tag: { icon?: string | null | undefined }): IconComponent =>
  getIconByName(tag.icon || 'Tag')?.component || TagIcon;

/** What a desktop row and a mobile card take: one transaction, and how the table shows it. */
export interface TransactionRowViewProps {
  transaction: Transaction;
  lookups: TransactionRowLookups;
  showCheckboxes: boolean;
  showAccount: boolean;
  showBalance: boolean;
  selected: boolean;
  onSelect?: ((uuid: string) => void) | undefined;
  /** Opens the transaction (the page's onTransactionClick). */
  onEdit: (transaction: Transaction) => void;
  /**
   * Opens the quick-actions sheet for it; `opener` (the button clicked) takes the focus back
   * when it closes. Safari doesn't focus a clicked button, so the focused element won't do.
   */
  onOpenActions: (transaction: Transaction, opener?: HTMLElement | null) => void;
}

export interface TransactionRowLookups {
  /** The person the transaction is assigned to, if they're in the list. */
  assignedUser: (transaction: Transaction) => User | null;
  /** The name of the transaction's budget period, if it has one in the list. */
  budgetPeriodName: (transaction: Transaction) => string | null;
  /** The account's name: the one the list sent, else the account's from the list. */
  accountName: (transaction: Transaction) => string | null;
  /** The running balance the server worked out (the account page's), or 0 without one. */
  runningBalance: (transaction: Transaction) => number;
}

/** The lookups a row makes in the ledger's people, periods and accounts. */
export function transactionRowLookups({
  users,
  budgetPeriods,
  accounts,
  showBalance,
}: {
  users: User[];
  budgetPeriods: BudgetPeriod[];
  accounts: Account[];
  showBalance: boolean;
}): TransactionRowLookups {
  return {
    assignedUser: (transaction) =>
      (transaction.assigned_to && users.find((u) => u.id === transaction.assigned_to)) || null,
    budgetPeriodName: (transaction) =>
      (transaction.budget_period_id && budgetPeriods.find((p) => p.id === transaction.budget_period_id)?.name) || null,
    accountName: (transaction) => {
      if (transaction.account_name) return transaction.account_name;
      if (!transaction.account_id) return null;
      return accounts.find((a) => a.id === transaction.account_id)?.name || null;
    },
    runningBalance: (transaction) => (showBalance ? (transaction.running_account_balance ?? 0) : 0),
  };
}
