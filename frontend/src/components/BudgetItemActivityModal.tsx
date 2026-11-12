import React from 'react';
import { Dialog, Button, Flex, Text, Card, Tabs, Box } from '@radix-ui/themes';
import { Activity, Edit, ArrowDownUp } from 'lucide-react';
import type { BudgetPeriodItem, BudgetItemActivityEntry, BudgetItemAssignedTransaction } from '../services/api';
import { useBudgetItemActivityQuery, useBudgetItemTransactionsQuery } from '../hooks/queries';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { formatCalendarDate } from '../utils/dateUtils';
import { EMPTY_LIST } from '../utils/emptyList';
import { formatMoney, budgetEventTransactionType, budgetEventType } from '@nuggets/shared';

interface BudgetItemActivityModalProps {
  isOpen: boolean;
  onClose: () => void;
  budgetPeriodItem?: BudgetPeriodItem;
}

const BudgetItemActivityModal: React.FC<BudgetItemActivityModalProps> = ({
  isOpen,
  onClose,
  budgetPeriodItem
}) => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Only fetch while the modal is open for a given budget period item.
  const enabled = isOpen && !!budgetPeriodItem;
  const activityQuery = useBudgetItemActivityQuery(budgetPeriodItem?.uuid, { enabled });
  const transactionsQuery = useBudgetItemTransactionsQuery(budgetPeriodItem?.uuid, { enabled });
  const budgetTransactions: BudgetItemActivityEntry[] = activityQuery.data ?? EMPTY_LIST;
  const actualTransactions: BudgetItemAssignedTransaction[] = transactionsQuery.data ?? EMPTY_LIST;
  const loading = activityQuery.isLoading || transactionsQuery.isLoading;

  const handleEditTransaction = (transactionUuid: string) => {
    const currentUrl = `/budgets?${searchParams.toString()}`;
    navigate(`/transactions/${transactionUuid}?edit=true&returnTo=${encodeURIComponent(currentUrl)}`);
    onClose();
  };


  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  };

  if (!budgetPeriodItem) return null;

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content maxWidth="600px" maxHeight="90vh">
        <Dialog.Title>
          <Flex align="center" gap="2">
            <Activity size={20} />
            Budget Item Activity
          </Flex>
        </Dialog.Title>

        <Dialog.Description size="2" mb="4">
          Activity for {budgetPeriodItem.budget_item_name}
        </Dialog.Description>

        <Tabs.Root defaultValue="budget">
          <Tabs.List>
            <Tabs.Trigger value="budget">Budget Activity</Tabs.Trigger>
            <Tabs.Trigger value="transactions">Transactions</Tabs.Trigger>
          </Tabs.List>

          <Box pt="4">
            {/* Budget Activity Tab */}
            <Tabs.Content value="budget">
              <Box className="space-y-2">
                {loading ? (
                  <Text size="2" color="gray">Loading budget activity...</Text>
                ) : budgetTransactions.length === 0 ? (
                  <Card>
                    <Text size="2" color="gray">No budget activity for this period</Text>
                  </Card>
                ) : (
                  budgetTransactions.map((transaction) => (
                    <Card key={transaction.id} >
                      <Flex justify="between" align="center">
                        <Flex direction="column" gap="1">
                          <Flex align="center" gap="2">
                            <ArrowDownUp size={16} className="text-[var(--gray-11)]" />
                            <Text size="2" weight="medium">
                              {transaction.type === budgetEventType.enum.transfer
                                ? 'Transfer'
                                : 'Budget Update'
                              }
                            </Text>
                          </Flex>
                          <Text size="1" color="gray">
                            {transaction.description}
                          </Text>
                          <Text size="1" color="gray">
                            {formatDate(transaction.created_at)}
                          </Text>
                        </Flex>
                        <Text
                          size="3"
                          weight="bold"
                          className={transaction.transaction_type === budgetEventTransactionType.enum.move_in || transaction.transaction_type === budgetEventTransactionType.enum.add ? 'text-[var(--green-12)]' : 'text-[var(--red-11)]'}
                        >
                          {transaction.transaction_type === budgetEventTransactionType.enum.move_in || transaction.transaction_type === budgetEventTransactionType.enum.add ? '+' : '-'}
                          {formatMoney(Math.abs(transaction.amount))}
                        </Text>
                      </Flex>
                    </Card>
                  ))
                )}
              </Box>
            </Tabs.Content>

            {/* Transactions Tab */}
            <Tabs.Content value="transactions">
              <Box className="space-y-2">
                {loading ? (
                  <Text size="2" color="gray">Loading transactions...</Text>
                ) : actualTransactions.length === 0 ? (
                  <Card>
                    <Text size="2" color="gray">No transactions for this budget item</Text>
                  </Card>
                ) : (
                  actualTransactions.map((transaction) => (
                    <Card key={transaction.id} >
                      <Flex justify="between" align="center">
                        <Flex direction="column" gap="1" flexGrow="1" flexBasis="0%" minWidth="0px">
                          <Text size="2" weight="medium" className="truncate">
                            {transaction.description}
                          </Text>
                          <Text size="1" color="gray">
                            {transaction.account_name} • {formatCalendarDate(transaction.date)}
                          </Text>
                        </Flex>
                        <Flex align="center" gap="2">
                          <Text size="3" weight="bold">
                            {formatMoney(transaction.amount)}
                          </Text>
                          <Button
                            size="1"
                            variant="soft"
                            onClick={() => handleEditTransaction(transaction.uuid)}
                            aria-label="Edit transaction"
                          >
                            <Edit size={12} />
                          </Button>
                        </Flex>
                      </Flex>
                    </Card>
                  ))
                )}
              </Box>
            </Tabs.Content>
          </Box>
        </Tabs.Root>

        <Flex gap="3" mt="4" justify="end">
          <Dialog.Close>
            <Button variant="soft" color="gray">
              Close
            </Button>
          </Dialog.Close>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default BudgetItemActivityModal;
