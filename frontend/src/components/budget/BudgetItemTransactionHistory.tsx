import React from 'react';
import { Link } from 'react-router-dom';
import { Receipt, ChevronLeft, ChevronRight } from 'lucide-react';
import { Card, Callout, Flex, Text, ScrollArea, IconButton, Box } from '@radix-ui/themes';
import { textColorProps } from '../../utils/textColor';
import type { Transaction } from '../../services/api';
import { calendarMonthKey, formatCalendarDate, formatCalendarMonth } from '../../utils/dateUtils';
import { formatMoney } from '@nuggets/shared';

/**
 * Transaction-history sidebar shared by the budget-item edit pages (Income, Expense
 * and Bill). Renders one page of the item's transactions grouped by month, newest
 * first; the page comes from the server (useBudgetItemTransactionsPage). Pulled out of EditIncomePage/EditExpensePage,
 * which carried near-identical copies; the bill page's own widget
 * went too.
 */
export interface BudgetItemTransactionHistoryProps {
  /** One page of the item's transactions, newest first. */
  transactions: Transaction[];
  /** All of the item's transactions, across pages. */
  total: number;
  /** The page shown, from 1. */
  page: number;
  onPageChange: (page: number) => void;
  loading: boolean;
  /** Why the transactions couldn't be loaded, shown in place of the list. */
  error?: string | null;
  /** Empty-state copy (differs by kind, e.g. income vs expense). */
  emptyStateDescription: string;
  /** Page size (the page asked of the server holds this many). */
  recordsPerPage?: number;
  /** Fallback label when a transaction has no merchant/description. */
  fallbackMerchantName?: string;
}


/** Merchant display, in priority order, falling back to a kind-specific label. */
const merchantLabel = (tx: Transaction, fallback: string): string => {
  if (tx.merchant_name && tx.merchant_name.trim()) return tx.merchant_name;
  if (tx.synced_name && tx.synced_name.trim()) return tx.synced_name;
  if (tx.import_description && tx.import_description.trim()) return tx.import_description;
  if (tx.description && tx.description.trim()) return tx.description;
  return fallback;
};

// transaction_date is a calendar day ('YYYY-MM-DD' or 'YYYY-MM-DDT…').
const formatTxDate = (raw: string): string =>
  formatCalendarDate(raw, 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });

const monthLabel = (monthKey: string): string =>
  formatCalendarMonth(monthKey, 'en-US', { year: 'numeric', month: 'long' });

const BudgetItemTransactionHistory: React.FC<BudgetItemTransactionHistoryProps> = ({
  transactions,
  total,
  page,
  onPageChange,
  loading,
  error = null,
  emptyStateDescription,
  recordsPerPage = 20,
  fallbackMerchantName = 'Unknown Merchant',
}) => {
  const totalPages = Math.ceil(total / recordsPerPage);
  const pageTransactions = transactions;

  // Group the current page's transactions by 'YYYY-MM' month, newest month first.
  const groupedByMonth = pageTransactions.reduce<Record<string, Transaction[]>>((groups, tx) => {
    const key = calendarMonthKey(tx.transaction_date) ?? '';
    (groups[key] ||= []).push(tx);
    return groups;
  }, {});
  const sortedGroups = Object.entries(groupedByMonth).sort(([a], [b]) => b.localeCompare(a));

  return (
    <Card>
      <Flex direction="column" gap="4">
        <Text size="5" weight="bold">History</Text>

        <Flex align="center" justify="between">
          <Text size="2" weight="medium">Transactions ({total})</Text>
        </Flex>

        {error ? (
          <Callout.Root color="red" role="alert">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        ) : loading ? (
          <Flex direction="column" align="center" gap="3" py="8">
            <Box height="24px" width="24px" className="animate-spin rounded-full border-b-2 border-[var(--blue-9)]" />
            <Text size="2" color="gray">Loading transactions...</Text>
          </Flex>
        ) : (
          <Flex direction="column" gap="4">
            <ScrollArea style={{ maxHeight: '40rem' }}>
              {total === 0 ? (
                <Flex direction="column" align="center" gap="3" py="8">
                  <Receipt className="text-[var(--gray-11)]" size={48} />
                  <Text size="2" weight="medium" align="center">No transactions yet</Text>
                  <Text size="2" color="gray" align="center">
                    {emptyStateDescription}
                  </Text>
                </Flex>
              ) : (
                <Flex direction="column" gap="4">
                  {sortedGroups.map(([month, monthTransactions]) => (
                    <Flex direction="column" gap="2" key={month}>
                      {/* Month header */}
                      <Flex direction="column" gap="1" pb="2" className="border-b border-[var(--gray-6)]">
                        <Text size="2" weight="bold">{monthLabel(month)}</Text>
                        <Text size="1" color="gray">
                          {monthTransactions.length} transaction{monthTransactions.length !== 1 ? 's' : ''}
                        </Text>
                      </Flex>

                      {/* Transactions for this month */}
                      <Flex direction="column" gap="2">
                        {monthTransactions.map((transaction) => (
                          <Card key={transaction.id} className="[--card-background-color:var(--gray-2)]">
                            <Flex direction="column" gap="2">
                              <Link
                                to={`/transactions/${transaction.uuid}?edit=true&returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Edit transaction (opens in new tab)"
                              >
                                <Text size="2" weight="medium" className="hover:underline text-[var(--accent-11)]" truncate>
                                  {merchantLabel(transaction, fallbackMerchantName)}
                                </Text>
                              </Link>

                              <Flex justify="between" align="center">
                                <Text size="1" color="gray" truncate>
                                  {formatTxDate(transaction.transaction_date)}
                                  {transaction.account_name && ` • ${transaction.account_name}`}
                                </Text>
                                <Text size="2" weight="bold" {...textColorProps(transaction.amount > 0 ? 'green' : 'red')}>
                                  {transaction.amount > 0 ? '+' : '-'}
                                  {formatMoney(Number(Math.abs(transaction.amount)) || 0)}
                                </Text>
                              </Flex>
                            </Flex>
                          </Card>
                        ))}
                      </Flex>
                    </Flex>
                  ))}
                </Flex>
              )}
            </ScrollArea>

            {/* Pagination */}
            {totalPages > 1 && (
              <Flex direction="column" gap="3" pt="4" className="border-t border-[var(--gray-6)]">
                <Text size="1" align="center" color="gray">
                  Showing {((page - 1) * recordsPerPage) + 1} to {Math.min(page * recordsPerPage, total)} of {total}
                </Text>
                <Flex justify="center" align="center" gap="3">
                  <IconButton
                    onClick={() => onPageChange(Math.max(1, page - 1))}
                    disabled={page === 1}
                    variant="soft"
                    size="2"
                    title="Previous page"
                    aria-label="Previous page"
                  >
                    <ChevronLeft />
                  </IconButton>
                  <Text size="2" weight="medium">Page {page} of {totalPages}</Text>
                  <IconButton
                    onClick={() => onPageChange(Math.min(totalPages, page + 1))}
                    disabled={page === totalPages}
                    variant="soft"
                    size="2"
                    title="Next page"
                    aria-label="Next page"
                  >
                    <ChevronRight />
                  </IconButton>
                </Flex>
              </Flex>
            )}
          </Flex>
        )}
      </Flex>
    </Card>
  );
};

export default BudgetItemTransactionHistory;
