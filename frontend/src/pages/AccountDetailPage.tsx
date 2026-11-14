import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { logger } from '../utils/logger';
import { syncFailureMessage, syncOutcomeNotice } from '../utils/importSyncMessages';
import {
  ArrowLeft, Edit3, Plus, RefreshCw, Settings, ChevronDown, Scale
} from 'lucide-react';
import {
  type Transaction,
} from '../services/api';
import {
  useAccountQuery,
  useAccountBalanceQuery,
  useAccountTransactionsQuery,
  useBudgetPeriodsQuery,
  useBudgetItemsQuery,
  useUsersQuery,
  useSyncAccountMutation,
} from '../hooks/queries';
import RadixTransactionTable from '../components/RadixTransactionTable';
import AdjustBalanceModal from '../components/AdjustBalanceModal';
import SharedTransactionFilter, { TransactionFilters } from '../components/SharedTransactionFilter';
import SharedPagination from '../components/SharedPagination';
import { buildAccountTransactionFilterParams, parseUrlFilters } from '../utils/transactionFilterParams';
import toast from 'react-hot-toast';
import { config } from '../config/environment';
import { Flex, Heading, Text, Button, DropdownMenu, Box } from '@radix-ui/themes';
import { formatMoney } from '@nuggets/shared';
import { textColorProps } from '../utils/textColor';
import PageLoader from '../components/PageLoader';
import { usePageInRange } from '../hooks/usePageInRange';
import { TRANSACTION_PAGE_SIZES, useTransactionPageSize } from '../hooks/useTransactionPageSize';
import PageContainer from '../components/PageContainer';

const AccountDetailPage: React.FC = () => {
  const { uuid } = useParams<{ uuid: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [currentPage, setCurrentPage] = useState(parseInt(searchParams.get('page') || '1'));

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

  // Transaction selection state
  const [selectedTransactions, setSelectedTransactions] = useState<Set<string>>(new Set());

  // Manual balance-adjustment modal
  const [adjustBalanceOpen, setAdjustBalanceOpen] = useState(false);

  // Account + reference data
  const { data: account = null } = useAccountQuery(uuid);
  const { data: balanceData } = useAccountBalanceQuery(uuid);
  // null = unavailable: render "Unavailable", never $0.
  const balanceUnavailable = balanceData?.balance.balance_unavailable === true;
  const eventBasedBalance = balanceData?.balance.calculated_balance ?? null;
  const { data: budgetPeriods = [] } = useBudgetPeriodsQuery();
  const { data: budgetItems = [] } = useBudgetItemsQuery();
  const { data: users = [] } = useUsersQuery();

  // Account transactions. Uses the global React Query defaults
  // (refetchOnWindowFocus: false); mutation invalidation already refreshes this
  // list after in-app edits, so the per-focus refetch override was redundant.
  const [pageSize, setPageSize] = useTransactionPageSize();
  const transactionParams = useMemo(
    () => ({ page: currentPage, limit: pageSize, ...buildAccountTransactionFilterParams(filters) }),
    [currentPage, pageSize, filters],
  );
  const transactionsQuery = useAccountTransactionsQuery(uuid, transactionParams);

  // Back to the last page when the list shrinks under the one shown: after deletes, or
  // when the last transactions on the last page are moved or deleted. An answer still being fetched (the
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

  // Mutations
  const syncMutation = useSyncAccountMutation();
  const syncLoading = syncMutation.isPending;

  // Handle page change
  const handlePageChange = (newPage: number) => {
    setCurrentPage(newPage);
  };

  // Handle filter changes with page reset
  const handleFiltersChange = useCallback((newFilters: TransactionFilters) => {
    setFilters(newFilters);
    setCurrentPage(1);
  }, []);

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

  // Handle navigation to transaction detail preserving current state (matching TransactionsPage)
  const handleTransactionClick = (transaction: Transaction) => {
    // Encode the current page URL to return to after editing
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    navigate(`/transactions/${transaction.uuid}?edit=true&returnTo=${returnTo}`);
  };

  const handleSyncAccount = async () => {
    if (!account) return;

    try {
      // Sync invalidates account + transaction caches, refreshing this page.
      const result = await syncMutation.mutateAsync([account.uuid]);

      // A partial sync says what wasn't saved, rather than "completed successfully".
      const notice = syncOutcomeNotice(result, 'Account sync completed successfully');
      if (notice.tone === 'success') toast.success(notice.text);
      else if (notice.tone === 'warning') toast(notice.text, { duration: 8000 });
      else toast.error(notice.text);
    } catch (error) {
      logger.error({ err: error, accountUuid: uuid }, 'Failed to sync account');
      // e.g. 409: a sync of this Ledger is already running.
      const message = syncFailureMessage(error, 'Failed to sync account');
      if (message) toast.error(message);
    }
  };

  if (!account) {
    return (
      <PageContainer>
        <PageLoader label="Loading account details…" />
      </PageContainer>
    );
  }

  // Helper to render the Nuggets balance with sign-aware coloring + parentheses
  // for negative values. Used in the account header.
  const renderInlineBalance = (amount: number | null) => {
    if (amount === null) {
      return <Text size="4" weight="bold" color="gray">Unavailable</Text>;
    }
    const absAmount = Math.abs(amount);
    const formatted = formatMoney(absAmount);
    return (
      <Text size="4" weight="bold" {...textColorProps(amount < 0 ? 'red' : 'green')}>
        {amount < 0 ? `(${formatted})` : formatted}
      </Text>
    );
  };

  const nuggetsBalance: number | null = balanceUnavailable
    ? null
    : (eventBasedBalance ?? account.calculated_balance ?? null);
  const bankBalance = account.import_balance;
  const bankBalanceDate = account.import_balance_date;

  return (
    <PageContainer>
      <Flex direction="column" gap="6">

        {/* Custom Account Detail Header */}
        <div>
          {/* Back Button */}
          <Box mb="5">
            <Button
              variant="ghost"
              color="gray"
              onClick={() => navigate('/accounts')}
              aria-label="Back to accounts"
            >
              <ArrowLeft size={20} />
              Back to Accounts
            </Button>
          </Box>

          {/* Account Header Section */}
          <Flex
            direction={{ initial: 'column', sm: 'row' }}
            align={{ sm: 'center' }}
            justify="between"
            gap="4"
          >
            {/* Left: Account Info with Inline Balance */}
            <Flex align="center" gap="4" flexGrow="1" flexBasis="0%" minWidth="0px">
              {account.account_image && (
                <Box asChild flexShrink="0"><img
                  src={`${config.backendBaseUrl}${account.account_image}`}
                  alt={account.name}
                  className="border border-[var(--gray-5)] object-cover rounded-[var(--radius-3)]"
                  style={{ width: 56, height: 56 }}
                /></Box>
              )}

              <Box flexGrow="1" flexBasis="0%" minWidth="0px">
                {/* Title row with balance */}
                <Flex align="baseline" gap="3" wrap="wrap" mb="1">
                  <Heading as="h1" size="5" weight="bold" color="gray" highContrast>
                    {account.name}
                  </Heading>
                  {renderInlineBalance(nuggetsBalance)}
                </Flex>

                {/* Metadata */}
                <Flex align="center" gap="2" wrap="wrap">
                  <Text size="2" weight="medium" color="gray">
                    {account.institution_name}
                  </Text>
                  <Text size="2" className="hidden sm:inline text-[var(--gray-7)]" aria-hidden="true">•</Text>
                  <Text size="2" className="hidden sm:inline capitalize" color="gray">
                    {account.account_type?.replace(/_/g, ' ')}
                  </Text>
                  {bankBalance !== null && bankBalance !== undefined && bankBalanceDate && (
                    <>
                      <Text size="2" className="text-[var(--gray-7)]" aria-hidden="true">•</Text>
                      <Text
                        size="1" color="gray"
                        title={`Bank balance as of ${new Date(bankBalanceDate).toLocaleDateString()}`}
                      >
                        Bank: {(() => {
                          const abs = Math.abs(bankBalance);
                          const f = formatMoney(abs);
                          return bankBalance < 0 ? `(${f})` : f;
                        })()}
                      </Text>
                    </>
                  )}
                </Flex>
              </Box>
            </Flex>

            {/* Right: Action Buttons. Add Transaction is the primary CTA (full
                width on mobile); Adjust Balance + Manage share a second row on
                mobile and sit inline with it on desktop. */}
            <Flex
              direction={{ initial: 'column', sm: 'row' }}
              gap="2"
              width={{ initial: '100%', sm: 'auto' }}
            >
              <Button
                onClick={() => navigate(`/accounts/${account.uuid}/add-transaction`)}
                aria-label="Add transaction"
                size="3"
              >
                <Plus size={16} />
                Add Transaction
              </Button>

              <Flex gap="2" wrap="wrap">
                <Button
                  variant="soft"
                  color="gray"
                  size="3"
                  onClick={() => setAdjustBalanceOpen(true)}
                  aria-label="Adjust balance"
                >
                  <Scale size={16} />
                  Adjust Balance
                </Button>

                <DropdownMenu.Root>
                  <DropdownMenu.Trigger>
                    <Button variant="soft" color="gray" size="3" aria-label="Account actions menu">
                      <Settings size={16} />
                      Manage
                      <ChevronDown size={16} />
                    </Button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content align="end" sideOffset={8} style={{ minWidth: 200 }}>
                    <DropdownMenu.Item onSelect={() => navigate(`/accounts/edit/${account.uuid}`)}>
                      <Flex align="center" gap="2">
                        <Edit3 size={16} className="text-[var(--accent-11)]" />
                        Edit Account
                      </Flex>
                    </DropdownMenu.Item>
                    {account.import_account_id && (
                      <DropdownMenu.Item onSelect={() => handleSyncAccount()} disabled={syncLoading}>
                        <Flex align="center" gap="2">
                          <RefreshCw
                            size={16}
                            className={`text-[var(--green-12)] ${syncLoading ? 'animate-spin' : ''}`}
                          />
                          {syncLoading ? 'Syncing…' : 'Sync Transactions'}
                        </Flex>
                      </DropdownMenu.Item>
                    )}
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              </Flex>
            </Flex>
          </Flex>
        </div>

          <AdjustBalanceModal
            open={adjustBalanceOpen}
            onOpenChange={setAdjustBalanceOpen}
            accountUuid={account.uuid}
            accountName={account.name}
            currentBalance={nuggetsBalance}
          />

          {/* Transaction Filters */}
          <SharedTransactionFilter
            filters={filters}
            onFiltersChange={handleFiltersChange}
            budgetPeriods={budgetPeriods}
            budgetItems={budgetItems}
            loading={loading}
            totalCount={pagination.totalTransactions}
            filteredCount={pagination.totalTransactions}
          />


          {/* Transaction Table */}
          <RadixTransactionTable
            transactions={transactions}
            loading={loading}
            selectedTransactions={selectedTransactions}
            onTransactionSelect={handleTransactionSelect}
            onSelectAll={handleSelectAll}
            onTransactionClick={handleTransactionClick}
            budgetPeriods={budgetPeriods}
            users={users}
            budgetItems={budgetItems}
            showCheckboxes={true}
            showBalance={true}
            accountBalance={nuggetsBalance ?? undefined}
          />

          {/* Pagination - Mobile Friendly */}
          {!loading && transactions.length > 0 && (
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
          )}
      </Flex>
    </PageContainer>
  );
};

export default AccountDetailPage;
