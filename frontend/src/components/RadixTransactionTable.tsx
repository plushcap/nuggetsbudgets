import React from 'react';
import { Box, Flex, Text } from '@radix-ui/themes';
import type { Transaction, BudgetPeriod, User as UserType, Account, BudgetItem } from '../services/api';
import { useTransactionQuickActions } from '../hooks/useTransactionQuickActions';
import { useTransactionActionsSheet } from '../hooks/useTransactionActionsSheet';
import { useTransactionTableReferenceData } from '../hooks/useTransactionTableReferenceData';
import { transactionRowLookups } from './transactions/transactionRows';
import TransactionTableDesktop from './transactions/TransactionTableDesktop';
import TransactionRowContextMenu from './transactions/TransactionRowContextMenu';
import TransactionCard from './transactions/TransactionCard';
import TransactionActionsDialog from './transactions/TransactionActionsDialog';

export interface RadixTransactionTableProps {
  transactions: Transaction[];
  loading?: boolean | undefined;
  selectedTransactions?: Set<string> | undefined;
  onTransactionSelect?: ((uuid: string) => void) | undefined;
  onSelectAll?: (() => void) | undefined;
  onTransactionClick?: ((transaction: Transaction) => void) | undefined;
  budgetPeriods?: BudgetPeriod[] | undefined;
  users?: UserType[] | undefined;
  accounts?: Account[] | undefined; // For showing account names on transaction pages
  budgetItems?: BudgetItem[] | undefined; // For budget item context menu
  showCheckboxes?: boolean | undefined;
  showAccount?: boolean | undefined; // Show account column (for transaction pages with multiple accounts)
  showBalance?: boolean | undefined; // Show running balance column (for account detail pages)
  accountBalance?: number | undefined; // Current account balance for running balance calculation
  /** Called after a quick action saves. The lists that use React Query refresh on their own. */
  onTransactionUpdated?: (() => void) | undefined;
}

// Nothing selected (never changed: the page passes its own set to select)
const NO_SELECTION = new Set<string>();

/**
 * A list of transactions: a table on a desktop (with a right-click menu of quick actions and a
 * button that opens them), cards on a phone, and the quick-actions sheet both open. Its parts
 * are in components/transactions/; the quick actions are useTransactionQuickActions', the same
 * on every page.
 */
const RadixTransactionTable: React.FC<RadixTransactionTableProps> = ({
  transactions,
  loading = false,
  selectedTransactions = NO_SELECTION,
  onTransactionSelect,
  onSelectAll,
  onTransactionClick,
  budgetPeriods: budgetPeriodsProps = [],
  users: usersProps = [],
  accounts = [],
  budgetItems: budgetItemsProps = [],
  showCheckboxes = true,
  showAccount = false,
  showBalance = false,
  onTransactionUpdated,
}) => {
  // Reference data, fetched only when the page didn't pass it.
  const { budgetPeriods, users, budgetItems, allTags, activeTags } = useTransactionTableReferenceData({
    budgetPeriods: budgetPeriodsProps,
    users: usersProps,
    budgetItems: budgetItemsProps,
  });
  const actions = useTransactionQuickActions({ budgetPeriods, budgetItems, users, tags: allTags }, onTransactionUpdated);
  const sheet = useTransactionActionsSheet(actions);

  if (loading) {
    return (
      <Flex direction="column" gap="4" className="animate-pulse">
        <Box height="48px" className="rounded-[var(--radius-2)] bg-[var(--gray-3)]" />
        <Box height="384px" className="rounded-[var(--radius-2)] bg-[var(--gray-3)]" />
      </Flex>
    );
  }

  if (transactions.length === 0) {
    return (
      <Flex justify="center" py="9">
        <Text color="gray">No transactions found</Text>
      </Flex>
    );
  }

  const rowProps = {
    lookups: transactionRowLookups({ users, budgetPeriods, accounts, showBalance }),
    showCheckboxes,
    showAccount,
    showBalance,
    onSelect: onTransactionSelect,
    onEdit: (transaction: Transaction) => onTransactionClick?.(transaction),
    onOpenActions: sheet.openFor,
  };
  const lists = { budgetPeriods, budgetItems, users, tags: activeTags };

  return (
    <>
      {/* Desktops (Tailwind's md, 768px, is Radix's sm) */}
      <Box display={{ initial: 'none', sm: 'block' }}>
        <TransactionTableDesktop
          {...rowProps}
          transactions={transactions}
          selectedTransactions={selectedTransactions}
          onSelectAll={onSelectAll}
          menuFor={(transaction) => <TransactionRowContextMenu transaction={transaction} actions={actions} {...lists} />}
        />
      </Box>

      {/* Phones */}
      <Flex direction="column" gap="3" display={{ initial: 'flex', sm: 'none' }}>
        {transactions.map((transaction) => (
          <TransactionCard
            key={transaction.id}
            {...rowProps}
            transaction={transaction}
            selected={selectedTransactions.has(transaction.uuid)}
            onToggleReviewed={actions.toggleReviewed}
          />
        ))}
      </Flex>

      <TransactionActionsDialog sheet={sheet} actions={actions} {...lists} onEdit={rowProps.onEdit} />
    </>
  );
};

export default RadixTransactionTable;
