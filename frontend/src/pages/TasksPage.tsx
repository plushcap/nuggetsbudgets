import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  useAccountsQuery,
  useBudgetItemsQuery,
  useBudgetPeriodsQuery,
  useUsersQuery,
  usePaginatedTransactionsQuery,
} from '../hooks/queries';
import RadixTransactionTable from '../components/RadixTransactionTable';
import SharedPagination from '../components/SharedPagination';
import { buildTransactionFilterParams } from '../utils/transactionFilterParams';
import { TransactionFilters } from '../components/SharedTransactionFilter';
import { useAuth } from '../contexts/AuthContext';
import { useOpenTransactionEdit } from '../hooks/useOpenTransactionEdit';
import { Card, Switch, Flex, Text, Box } from '@radix-ui/themes';
import PageHeader from '../components/PageHeader';
import { useSeededState } from '../hooks/useSeededState';
import { readStoredJson, writeStoredJson } from '../utils/storage';
import { usePageInRange } from '../hooks/usePageInRange';
import PageContainer from '../components/PageContainer';

// Fixed filter for tasks page - only show transactions that need review
const TASK_FILTERS: Partial<TransactionFilters> = {
  reviewStatus: 'needs review',
};

const TasksPage: React.FC = () => {
  const handleTransactionClick = useOpenTransactionEdit();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedTransactions, setSelectedTransactions] = useState<Set<string>>(new Set());

  // Filter switches - defaulted to show user's tasks, exclude unassigned
  // Initialize from URL params first, then session storage, then defaults
  const [showMyTasks, setShowMyTasks] = useState(() => {
    const urlParam = searchParams.get('showMyTasks');
    if (urlParam !== null) {
      return urlParam === 'true';
    }
    return readStoredJson<boolean>('session', 'tasksPage_showMyTasks', true) === true;
  });
  const [showUnassigned, setShowUnassigned] = useState(() => {
    const urlParam = searchParams.get('includeUnassigned');
    if (urlParam !== null) {
      return urlParam === 'true';
    }
    return readStoredJson<boolean>('session', 'tasksPage_showUnassigned', false) === true;
  });

  // Reference data
  // The page starts as the URL has it, and goes back to 1 when a switch changes.
  const [currentPage, setCurrentPage] = useSeededState<number>(
    (current) => (current === undefined ? parseInt(searchParams.get('page') || '1') : 1),
    [showMyTasks, showUnassigned],
  );

  const { data: budgetPeriods = [] } = useBudgetPeriodsQuery();
  const { data: budgetItems = [] } = useBudgetItemsQuery();
  const { data: users = [] } = useUsersQuery();
  const { data: accounts = [] } = useAccountsQuery();

  // Save switch values to session storage whenever they change
  useEffect(() => {
    writeStoredJson('session', 'tasksPage_showMyTasks', showMyTasks);
  }, [showMyTasks]);

  useEffect(() => {
    writeStoredJson('session', 'tasksPage_showUnassigned', showUnassigned);
  }, [showUnassigned]);

  // Keep the URL's page param in sync with the current page.
  useEffect(() => {
    const params = new URLSearchParams();
    if (currentPage > 1) params.set('page', currentPage.toString());
    if (window.location.search.slice(1) !== params.toString()) {
      setSearchParams(params, { replace: true });
    }
  }, [currentPage, setSearchParams]);

  // Build API filter params (fixed "needs review" + the switch combination).
  // All filtering happens on the backend.
  const filterParams = useMemo(() => {
    const params = buildTransactionFilterParams(TASK_FILTERS);
    if (showMyTasks && !showUnassigned && user) {
      // Show ONLY user's tasks
      params.assigned_to = user.id.toString();
    } else if (!showMyTasks && showUnassigned) {
      // Show ALL tasks - no additional filter
    } else if (!showMyTasks && !showUnassigned) {
      // Show ONLY assigned tasks (excluding unassigned)
      params.exclude_unassigned = 'true';
    } else if (showMyTasks && showUnassigned && user) {
      // Show user's tasks AND unassigned (exclude other users)
      params.assigned_to_or_unassigned = user.id.toString();
    }
    return params;
  }, [showMyTasks, showUnassigned, user]);

  const transactionsQuery = usePaginatedTransactionsQuery(currentPage, 30, filterParams);

  // Back to the last page when the list shrinks under the one shown: after deletes, or
  // when the last tasks on the last page are reviewed. An answer still being fetched (the
  // previous page's, kept while the next loads, or a cached one being refreshed) doesn't count.
  usePageInRange(
    currentPage,
    transactionsQuery.data && !transactionsQuery.isFetching ? transactionsQuery.data.pagination.totalPages : undefined,
    setCurrentPage,
  );
  const transactions = useMemo(() => transactionsQuery.data?.transactions ?? [], [transactionsQuery.data]);
  const loading = transactionsQuery.isLoading;
  const pagination = {
    totalTransactions: transactionsQuery.data?.pagination.total ?? 0,
    totalPages: transactionsQuery.data?.pagination.totalPages ?? 0,
    currentPage,
  };

  // No client-side filtering - all filtering happens on backend
  const filteredTransactions = transactions;

  // Calculate summary statistics - show current page breakdown
  const taskSummary = useMemo(() => {
    if (!user) return {
      unassignedOnPage: 0,
      assignedOnPage: 0,
      totalOnPage: 0,
      totalAllPages: pagination.totalTransactions
    };

    const unassignedOnPage = transactions.filter(t => !t.assigned_to).length;
    const assignedOnPage = transactions.filter(t => t.assigned_to).length;
    const totalOnPage = transactions.length;

    return {
      unassignedOnPage,
      assignedOnPage,
      totalOnPage,
      totalAllPages: pagination.totalTransactions
    };
  }, [transactions, user, pagination.totalTransactions]);

  // Transaction selection handlers
  const handleTransactionSelect = (transactionUuid: string) => {
    setSelectedTransactions(prev => {
      const newSet = new Set(prev);
      if (newSet.has(transactionUuid)) {
        newSet.delete(transactionUuid);
      } else {
        newSet.add(transactionUuid);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    if (selectedTransactions.size === filteredTransactions.length) {
      setSelectedTransactions(new Set());
    } else {
      setSelectedTransactions(new Set(filteredTransactions.map(t => t.uuid)));
    }
  };

  const handlePageChange = (newPage: number) => {
    setCurrentPage(newPage);
  };

  return (
    <PageContainer>
      <PageHeader title="Tasks" subtitle="Transactions that need review">
        {/* Filter Switches */}
        <Card className="p-4 sm:p-6">
          <Flex direction={{ initial: 'column', sm: 'row' }} gap="4" justify="between">
            {/* Show My Tasks Switch */}
            <Flex align="center" gap="3" width="fit-content" asChild>
              <label className="cursor-pointer">
                <Switch
                  checked={showMyTasks}
                  onCheckedChange={setShowMyTasks}
                  size="2"
                  aria-labelledby="tasks-mine-label"
                  aria-describedby="tasks-mine-help"
                />
                <Flex direction="column" gap="1">
                  <Text id="tasks-mine-label" size="2" weight="medium">
                    Show My Tasks
                  </Text>
                  <Text id="tasks-mine-help" size="1" color="gray">
                    Only show tasks assigned to me
                  </Text>
                </Flex>
              </label>
            </Flex>

            {/* Show Unassigned Switch */}
            <Flex align="center" gap="3" width="fit-content" asChild>
              <label className="cursor-pointer">
                <Switch
                  checked={showUnassigned}
                  onCheckedChange={setShowUnassigned}
                  size="2"
                  aria-labelledby="tasks-unassigned-label"
                  aria-describedby="tasks-unassigned-help"
                />
                <Flex direction="column" gap="1">
                  <Text id="tasks-unassigned-label" size="2" weight="medium">
                    Include Unassigned
                  </Text>
                  <Text id="tasks-unassigned-help" size="1" color="gray">
                    Show unassigned tasks
                  </Text>
                </Flex>
              </label>
            </Flex>
          </Flex>

          {/* Filter Status Message */}
          <Flex direction="column" gap="4" mt="4" pt="4" className="border-t border-[var(--gray-6)]">
            <Text size="2" color="gray">
              {showMyTasks && showUnassigned && (
                <>Showing <Text weight="medium" className="text-[var(--gray-12)]">your tasks</Text> and <Text weight="medium" className="text-[var(--gray-12)]">unassigned tasks</Text></>
              )}
              {showMyTasks && !showUnassigned && (
                <>Showing <Text weight="medium" className="text-[var(--gray-12)]">only your tasks</Text></>
              )}
              {!showMyTasks && showUnassigned && (
                <>Showing <Text weight="medium" className="text-[var(--gray-12)]">all tasks</Text> (all users + unassigned)</>
              )}
              {!showMyTasks && !showUnassigned && (
                <>Showing <Text weight="medium" className="text-[var(--gray-12)]">only assigned tasks</Text> (excluding unassigned)</>
              )}
              {' - '}
              <Text weight="medium" className="text-[var(--gray-12)]">{filteredTransactions.length}</Text> of <Text weight="medium" className="text-[var(--gray-12)]">{taskSummary.totalAllPages}</Text>
            </Text>
          </Flex>
        </Card>
      </PageHeader>

      {/* Transaction Table */}
      <Box mb="4">
        <RadixTransactionTable
          transactions={filteredTransactions}
          loading={loading}
          selectedTransactions={selectedTransactions}
          onTransactionSelect={handleTransactionSelect}
          onSelectAll={handleSelectAll}
          onTransactionClick={handleTransactionClick}
          budgetPeriods={budgetPeriods}
          users={users}
          accounts={accounts}
          budgetItems={budgetItems}
          showCheckboxes={true}
          showAccount={true}
          showBalance={false}
        />
      </Box>

      {/* Pagination */}
      {!loading && filteredTransactions.length > 0 && (
        <Box pb="6">
          <SharedPagination
            currentPage={pagination.currentPage}
            totalPages={pagination.totalPages}
            totalItems={pagination.totalTransactions}
            itemsPerPage={30}
            onPageChange={handlePageChange}
            itemLabel="tasks"
          />
        </Box>
      )}

      {/* Empty State */}
      {!loading && filteredTransactions.length === 0 && (
        <Box pb="6">
          <Card className="text-center py-12">
            <Flex direction="column" gap="2" align="center">
              <Text size="4" weight="medium">
                No tasks found
              </Text>
              <Text size="2" color="gray">
                {transactions.length === 0 ? (
                  "There are no transactions that need review."
                ) : (
                  showMyTasks && showUnassigned ? (
                    "No tasks assigned to you or unassigned. Try adjusting your filters."
                  ) : showMyTasks && !showUnassigned ? (
                    "No tasks assigned to you. Try enabling 'Include Unassigned' or disabling 'Show My Tasks'."
                  ) : !showMyTasks && showUnassigned ? (
                    "No tasks match your current filters."
                  ) : (
                    "No assigned tasks found (unassigned tasks are hidden)."
                  )
                )}
              </Text>
            </Flex>
          </Card>
        </Box>
      )}
    </PageContainer>
  );
};

export default TasksPage;
