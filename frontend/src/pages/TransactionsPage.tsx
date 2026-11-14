import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, ArrowLeftRight } from 'lucide-react';
import { type Transaction } from '../services/api';
import {
  useAccountsQuery,
  useBudgetItemsQuery,
  useBudgetPeriodsQuery,
  useUsersQuery,
  usePaginatedTransactionsQuery,
} from '../hooks/queries';
import RadixTransactionTable from '../components/RadixTransactionTable';
import SharedTransactionFilter, { TransactionFilters } from '../components/SharedTransactionFilter';
import SharedPagination from '../components/SharedPagination';
import { buildTransactionFilterParams, parseUrlFilters } from '../utils/transactionFilterParams';
import { Button, Box } from '@radix-ui/themes';
import PageHeader from '../components/PageHeader';
import { useSeededState } from '../hooks/useSeededState';
import { usePageInRange } from '../hooks/usePageInRange';
import { TRANSACTION_PAGE_SIZES, useTransactionPageSize } from '../hooks/useTransactionPageSize';
import PageContainer from '../components/PageContainer';

const TransactionsPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedTransactions, setSelectedTransactions] = useState<Set<string>>(new Set());

  // Initialize filter state from URL parameters
  const [filters, setFilters] = useState<TransactionFilters>(() => {
    const urlFilters = parseUrlFilters(searchParams);
    return {
      search: urlFilters.search || '',
      reviewStatus: urlFilters.reviewStatus || 'all',
      dateFrom: urlFilters.dateFrom || '',
      dateTo: urlFilters.dateTo || '',
      transactionType: urlFilters.transactionType || 'all',
      budgetPeriodId: urlFilters.budgetPeriodId || null,
      budgetItemId: urlFilters.budgetItemId || null,
      // An amount bound only when the URL has one (a 0 reads as none).
      ...(urlFilters.amountMin ? { amountMin: urlFilters.amountMin } : {}),
      ...(urlFilters.amountMax ? { amountMax: urlFilters.amountMax } : {}),
    };
  });

  // The page starts as the URL has it, and goes back to 1 when the filters change.
  const [currentPage, setCurrentPage] = useSeededState<number>(
    (current) => (current === undefined ? parseInt(searchParams.get('page') || '1') : 1),
    [filters],
  );

  // Reference data
  const { data: budgetPeriods = [] } = useBudgetPeriodsQuery();
  const { data: budgetItems = [] } = useBudgetItemsQuery();
  const { data: users = [] } = useUsersQuery();
  const { data: accounts = [] } = useAccountsQuery();

  // Paginated transactions, keyed on the filters + page.
  const filterParams = useMemo(() => buildTransactionFilterParams(filters), [filters]);
  const [pageSize, setPageSize] = useTransactionPageSize();
  const transactionsQuery = usePaginatedTransactionsQuery(currentPage, pageSize, filterParams);

  // Back to the last page when the list shrinks under the one shown: after deletes, or
  // when the last transactions on the last page are moved out of the filter. An answer still being fetched (the
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

  // Keep the URL in sync with filters + current page.
  useEffect(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== '' && value !== 'all') {
        params.set(key, value.toString());
      }
    });
    if (currentPage > 1) params.set('page', currentPage.toString());
    if (window.location.search.slice(1) !== params.toString()) {
      setSearchParams(params, { replace: true });
    }
  }, [filters, currentPage, setSearchParams]);

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
    if (selectedTransactions.size === transactions.length) {
      setSelectedTransactions(new Set());
    } else {
      setSelectedTransactions(new Set(transactions.map(t => t.uuid)));
    }
  };


  // Handle navigation to transaction detail preserving current filters and page in URL
  const handleTransactionClick = (transaction: Transaction) => {
    // Current URL contains all filter and pagination state
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    navigate(`/transactions/${transaction.uuid}?edit=true&returnTo=${returnTo}`);
  };

  const handlePageChange = (newPage: number) => {
    setCurrentPage(newPage);
  };

  return (
    <PageContainer>
      {/* Header - Mobile Optimized */}
      <PageHeader
        title="All Transactions"
        subtitle="Manage all your financial transactions"
        actions={
          <>
            <Button
              size="3"
              onClick={() => navigate('/transfertransaction', { state: { from: '/transactions' } })}
              className="flex-1 sm:flex-initial cursor-pointer"
            >
              <ArrowLeftRight size={16} />
              Transfer
            </Button>
            <Button
              size="3"
              onClick={() => navigate('/accounts')}
              className="flex-1 sm:flex-initial cursor-pointer"
            >
              <Plus size={16} />
              Add Transaction
            </Button>
          </>
        }
      >
        {/* Transaction Filters */}
        <SharedTransactionFilter
          filters={filters}
          onFiltersChange={setFilters}
          budgetPeriods={budgetPeriods}
          budgetItems={budgetItems}
          loading={loading}
          totalCount={pagination.totalTransactions}
          filteredCount={pagination.totalTransactions}
        />
      </PageHeader>

      {/* Transaction Table */}
      <Box mb="4">
        <RadixTransactionTable
          transactions={transactions}
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
      {!loading && transactions.length > 0 && (
        <Box pb="6">
          <SharedPagination
            currentPage={pagination.currentPage}
            totalPages={pagination.totalPages}
            totalItems={pagination.totalTransactions}
            itemsPerPage={pageSize}
            onPageChange={handlePageChange}
            itemLabel="transactions"
            pageSizeOptions={TRANSACTION_PAGE_SIZES}
            onItemsPerPageChange={setPageSize}
          />
        </Box>
      )}
    </PageContainer>
  );
};

export default TransactionsPage;
