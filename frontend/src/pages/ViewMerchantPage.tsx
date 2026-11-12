import React, { useState, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Card, Flex, Text, Heading, Button, IconButton, Box, Grid, Checkbox, Dialog, DropdownMenu, Callout } from '@radix-ui/themes';
import { Edit, ArrowLeft, Settings, Shield } from 'lucide-react';
import { ResponsiveBar } from '@nivo/bar';
import { ResponsiveTreeMap } from '@nivo/treemap';
import { mergeMerchants, getTransactionsWithFilters, type BudgetItem, type Merchant, type MerchantSpending } from '../services/api';
import {
  useMerchantQuery,
  useMerchantsQuery,
  useMerchantSpendingQuery,
  usePaginatedTransactionsQuery,
  useBudgetItemsQuery,
  useBulkUpdateTransactionsMutation,
  invalidateTransactionData,
} from '../hooks/queries';
import PageLoader from '../components/PageLoader';
import { useChartTheme } from '../hooks/useChartTheme';
import ChartFigure from '../components/ChartFigure';
import { toast } from 'react-hot-toast';
import RadixTransactionTable from '../components/RadixTransactionTable';
import SharedPagination from '../components/SharedPagination';
import RadixBudgetItemSelector from '../components/RadixBudgetItemSelector';
import { logger } from '../utils/logger';
import { EMPTY_LIST } from '../utils/emptyList';
import { useSeededState } from '../hooks/useSeededState';
import { usePageInRange } from '../hooks/usePageInRange';
import { websiteHref } from '../utils/safeUrls';
import { formatCalendarMonth } from '../utils/dateUtils';
import { apiErrorMessage, errorStatus } from '../utils/errors';
import PageContainer from '../components/PageContainer';
import { formatMoney } from '@nuggets/shared';

interface MonthlyTotal {
  month: string;
  total: number;
  [key: string]: string | number; // Index signature for Nivo
}

interface BudgetItemSpending {
  name: string;
  value: number;
}

/** A merchant the duplicates card offers to merge: what the lite list has of it, without counts. */
type DuplicateCandidate = Pick<Merchant, 'id' | 'uuid' | 'name'>;

/** The summary's months, oldest first, labelled for the axis. Totals arrive as NUMERIC text. */
function monthlyTotals(spending: MerchantSpending | undefined): MonthlyTotal[] {
  if (!spending) return [];
  return spending.monthly.map((m) => ({
    month: formatCalendarMonth(m.month, 'en-US', { month: 'short', year: 'numeric' }),
    total: Number(m.total) || 0,
  }));
}

/** The summary's per-budget-item totals, largest first, for the treemap. */
function budgetItemTotals(
  spending: MerchantSpending | undefined,
  budgetItems: readonly BudgetItem[],
): { name: string; children: BudgetItemSpending[] } {
  // Names from the live budget items when they're loaded (a rename refreshes them), else the summary's.
  const nameOf = (uuid: string, fallback: string | null) =>
    budgetItems.find((b) => b.uuid === uuid)?.name || fallback || 'Unknown Budget Item';
  const children = (spending?.by_budget_item ?? [])
    .map((b) => ({ name: b.budget_item_uuid ? nameOf(b.budget_item_uuid, b.budget_item_name) : 'No Budget Item', value: Number(b.total) || 0 }))
    .filter((item) => item.value > 0);
  return { name: 'budgetItems', children };
}

const ViewMerchantPage: React.FC = () => {
  const { merchantUuid } = useParams<{ merchantUuid: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const chart = useChartTheme();

  const queryClient = useQueryClient();
  // One merchant by uuid for the header; the names (lite: no per-merchant counts) only to
  // offer duplicates; the charts and counts as one summary; the table a page at a time
  // from the server.
  const merchantQuery = useMerchantQuery(merchantUuid, { meta: { suppressErrorToast: true } });
  const merchant = merchantQuery.data ?? null;
  const { data: allMerchants = EMPTY_LIST } = useMerchantsQuery({ lite: true });
  const { data: budgetItems = EMPTY_LIST } = useBudgetItemsQuery();
  const spendingQuery = useMerchantSpendingQuery(merchantUuid);
  const spending = spendingQuery.data;
  // The full list (with each merchant's transaction count) only while a merge is being
  // confirmed, so the destructive dialog says how many transactions each one carries.
  const [showMergeConfirmation, setShowMergeConfirmation] = useState(false);
  const { data: mergeCandidates = EMPTY_LIST } = useMerchantsQuery(undefined, { enabled: showMergeConfirmation });

  // Pagination for the merchant transactions table: back to the first page when
  // switching merchants.
  const [transactionPage, setTransactionPage] = useSeededState(() => 1, [merchantUuid]);
  const transactionsPerPage = 25;
  const transactionsQuery = usePaginatedTransactionsQuery(
    transactionPage,
    transactionsPerPage,
    { merchant_uuid: merchantUuid ?? '' },
    { enabled: !!merchantUuid, meta: { suppressErrorToast: true } },
  );
  const pageTransactions = transactionsQuery.data?.transactions ?? EMPTY_LIST;
  const totalTransactions = transactionsQuery.data?.pagination.total ?? 0;
  // Back to the last page when the list shrinks under the one shown.
  usePageInRange(
    transactionPage,
    transactionsQuery.data && !transactionsQuery.isFetching ? Math.ceil(totalTransactions / transactionsPerPage) : undefined,
    setTransactionPage,
  );
  // The count for the assign dialog: unknown until the page has loaded (the action itself
  // asks for every uuid when it runs).
  const assignCount = transactionsQuery.data ? `${totalTransactions} transaction(s)` : 'all transaction(s)';

  const isLoading = merchantQuery.isLoading;
  const error = merchantQuery.isError
    ? (errorStatus(merchantQuery.error) === 404 ? 'Merchant not found' : apiErrorMessage(merchantQuery.error, 'Could not load the merchant'))
    : null;
  const spendingError = spendingQuery.isError ? apiErrorMessage(spendingQuery.error, 'Could not load the spending charts') : null;
  const transactionsError = transactionsQuery.isError ? apiErrorMessage(transactionsQuery.error, 'Could not load the transactions') : null;

  const [selectedMerchantsToMerge, setSelectedMerchantsToMerge] = useState<Set<string>>(new Set());
  const [isMerging, setIsMerging] = useState(false);

  // Assign budget item state
  const [showAssignBudgetItem, setShowAssignBudgetItem] = useState(false);
  const [selectedBudgetItemId, setSelectedBudgetItemId] = useState<number | null>(null);
  const bulkUpdateMutation = useBulkUpdateTransactionsMutation();
  const [collectingUuids, setCollectingUuids] = useState(false);
  const isAssigning = collectingUuids || bulkUpdateMutation.isPending;

  // Derived chart/table data. Memoized on exact inputs (no state-mirroring, no
  // extra render): each value recomputes only when its own inputs change.

  // Monthly spending over the last 24 months (bar chart), from the server's summary.
  const monthlyData = useMemo<MonthlyTotal[]>(() => monthlyTotals(spending), [spending]);

  // Spending grouped by budget item over the same 24 months (treemap).
  const budgetItemSpendingData = useMemo(() => budgetItemTotals(spending, budgetItems), [spending, budgetItems]);

  // Possible duplicate merchants (name similarity) offered for merging: names from the lite
  // list, which has no counts (the merge confirmation states each one's).
  const similarMerchants = useMemo<DuplicateCandidate[]>(() => {
    if (!merchant) return [];
    const currentName = merchant.name.toLowerCase().trim();
    const currentWords = currentName.split(/\s+/).filter((w: string) => w.length > 2);

    return allMerchants.filter((m) => {
      if (m.id === merchant.id) return false; // Exclude current merchant
      const merchantName = m.name.toLowerCase().trim();

      // Exact match, or one name contains the other.
      if (currentName === merchantName) return true;
      if (currentName.includes(merchantName) || merchantName.includes(currentName)) return true;

      // Otherwise require shared significant words (exact, case-insensitive):
      // 2 by default, or 1 when both names are short (≤2 words).
      const merchantWords = merchantName.split(/\s+/).filter((w: string) => w.length > 2);
      const sharedWords = currentWords.filter(word => merchantWords.includes(word));
      const minSharedWords = (currentWords.length <= 2 && merchantWords.length <= 2) ? 1 : 2;
      return sharedWords.length >= minSharedWords;
    }).map(({ id, uuid, name }) => ({ id, uuid, name }));
  }, [merchant, allMerchants]);

  const handleMergeCheckboxChange = (merchantUuid: string) => {
    setSelectedMerchantsToMerge(prev => {
      const newSet = new Set(prev);
      if (newSet.has(merchantUuid)) {
        newSet.delete(merchantUuid);
      } else {
        newSet.add(merchantUuid);
      }
      return newSet;
    });
  };

  const handleAssignBudgetItemToAll = async () => {
    if (!merchant || selectedBudgetItemId === null) {
      toast.error('Please select a budget item');
      return;
    }

    try {
      // Every one of the merchant's transactions, asked for only now (the table holds one page).
      setCollectingUuids(true);
      let transactionUuids: string[];
      try {
        transactionUuids = (await getTransactionsWithFilters({ merchant_uuid: merchant.uuid })).map((t) => t.uuid);
      } finally {
        setCollectingUuids(false);
      }
      if (transactionUuids.length === 0) {
        toast.error('No transactions to update');
        return;
      }

      // Bulk update all transactions (invalidation refreshes the lists)
      await bulkUpdateMutation.mutateAsync([transactionUuids, { budget_item_id: selectedBudgetItemId }]);

      toast.success(`Assigned ${transactionUuids.length} transaction(s) to budget item`);
      setShowAssignBudgetItem(false);
      setSelectedBudgetItemId(null);
    } catch (err) {
      logger.error({ err, merchantUuid }, 'Failed to assign budget item');
      toast.error('Failed to assign budget item to transactions');
    }
  };

  const handleMergeConfirm = async () => {
    if (!merchant || selectedMerchantsToMerge.size === 0) return;

    setIsMerging(true);
    try {
      // Merge each selected merchant into the current merchant
      const merchantUuids = Array.from(selectedMerchantsToMerge);
      for (const sourceMerchantUuid of merchantUuids) {
        await mergeMerchants(sourceMerchantUuid, merchant.uuid);
      }

      toast.success(`Successfully merged ${selectedMerchantsToMerge.size} merchant(s)`);

      // Merges change merchants and the transactions reassigned to the target.
      invalidateTransactionData(queryClient);
      setSelectedMerchantsToMerge(new Set());
      setShowMergeConfirmation(false);
    } catch (err) {
      logger.error({ err, merchantUuid }, 'Failed to merge merchants');
      toast.error('Failed to merge merchants');
    } finally {
      setIsMerging(false);
    }
  };


  // One-line text alternatives for the charts.
  const monthlyTotal = monthlyData.reduce((sum, row) => sum + row.total, 0);
  const firstMonth = monthlyData[0];
  const lastMonth = monthlyData[monthlyData.length - 1];
  const monthlySummary = firstMonth && lastMonth
    ? `${formatMoney(monthlyTotal)} over ${monthlyData.length} ${monthlyData.length === 1 ? 'month' : 'months'}, from ${firstMonth.month} to ${lastMonth.month}.`
    : 'No spending in the past 24 months.';
  const topItem = [...budgetItemSpendingData.children].sort((a, b) => b.value - a.value)[0];
  const budgetItemSummary = topItem
    ? `${budgetItemSpendingData.children.length} ${budgetItemSpendingData.children.length === 1 ? 'budget item' : 'budget items'}; the most under ${topItem.name}, ${formatMoney(topItem.value)}.`
    : 'No spending by budget item.';

  if (isLoading) {
    return (
      <PageContainer>
        <PageLoader label="Loading merchant…" minHeight="100vh" />
      </PageContainer>
    );
  }

  if (error || !merchant) {
    return (
      <PageContainer>
        <Callout.Root color="red">
          <Callout.Text>{error || 'Merchant not found'}</Callout.Text>
          <Box mt="2">
            <Button variant="soft" color="red" onClick={() => navigate('/settings/merchants')}>
              <ArrowLeft size={16} />
              Back to Merchants
            </Button>
          </Box>
        </Callout.Root>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Flex direction="column" gap="6">
        {/* Custom identity header: merchant name + actions */}
        <Flex justify="between" align="center" wrap="wrap" gap="2">
          <Flex align="center" gap="3">
            <IconButton
              variant="soft"
              color="gray"
              aria-label="Go back"
              onClick={() => navigate(-1)}
            >
              <ArrowLeft size={16} />
            </IconButton>
            <Heading as="h1" size="6">{merchant.name}</Heading>
          </Flex>
          <Flex gap="2">
            {/* Admin Menu */}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <IconButton variant="soft" aria-label="Administrative actions">
                  <Settings size={16} />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                <DropdownMenu.Label>
                  <Flex align="center" gap="2">
                    <Shield size={16} />
                    <Text size="2">Administrative Actions</Text>
                  </Flex>
                </DropdownMenu.Label>
                <DropdownMenu.Separator />
                <DropdownMenu.Item onClick={() => setShowAssignBudgetItem(true)}>
                  <Text size="2" weight="medium">Assign Budget Item to All</Text>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>

            {/* Edit Button */}
            <Button
              onClick={() => navigate(`/settings/merchants/${merchant.uuid}/edit`)}
            >
              <Edit size={16} />
              Edit
            </Button>
          </Flex>
        </Flex>

        {/* Main Grid Layout */}
        <Grid columns={{ initial: '1', lg: '3' }} gap="6">
          {/* Left column - Charts (2/3 width) */}
          <Flex direction="column" gap="6" gridColumn={{ lg: 'span 2' }}>
          {/* Monthly Spending Chart */}
          <Card>
            <Box p="4">
              <Heading size="4" mb="4">
                Monthly Spending (Past 24 Months)
              </Heading>
              <Box>
                {spendingError ? (
                  <Flex align="center" justify="center" height="400px">
                    <Callout.Root color="red" role="alert">
                      <Callout.Text>{spendingError}</Callout.Text>
                    </Callout.Root>
                  </Flex>
                ) : spendingQuery.isLoading ? (
                  <Flex align="center" justify="center" height="400px">
                    <PageLoader label="Loading spending…" />
                  </Flex>
                ) : monthlyData.length > 0 ? (
                  <ChartFigure
                  title="Monthly spending, past 24 months"
                  summary={monthlySummary}
                  columns={['Month', 'Spent']}
                  rows={monthlyData.map((row) => [row.month, formatMoney(row.total)])}
                >
                  <Box height="400px">
                    <ResponsiveBar
                    data={monthlyData}
                    keys={['total']}
                    indexBy="month"
                    margin={{ top: 20, right: 20, bottom: 60, left: 80 }}
                    padding={0.3}
                    valueScale={{ type: 'linear' }}
                    indexScale={{ type: 'band', round: true }}
                    colors={chart.accent}
                    borderColor={{
                      from: 'color',
                      modifiers: [['darker', 1.6]]
                    }}
                    axisTop={null}
                    axisRight={null}
                    axisBottom={{
                      tickSize: 5,
                      tickPadding: 5,
                      tickRotation: -45,
                      legend: 'Month',
                      legendPosition: 'middle',
                      legendOffset: 50
                    }}
                    axisLeft={{
                      tickSize: 5,
                      tickPadding: 5,
                      tickRotation: 0,
                      legend: 'Amount',
                      legendPosition: 'middle',
                      legendOffset: -60,
                      format: (value) => formatMoney(value)
                    }}
                    enableLabel={false}
                    theme={chart.nivo}
                    tooltip={({ value }) => (
                      <Box px="3" py="2" className="rounded-[var(--radius-4)] shadow-lg bg-[var(--color-panel-solid)] border border-[var(--gray-6)]">
                        <Box className="text-sm font-bold text-[var(--gray-12)]">
                          {formatMoney(value as number)}
                        </Box>
                      </Box>
                    )}
                  />
                  </Box>
                  </ChartFigure>
                ) : (
                  <Flex align="center" justify="center" height="400px">
                    <Text color="gray">No transaction history available</Text>
                  </Flex>
                )}
              </Box>
            </Box>
          </Card>

          {/* Budget Item Spending TreeMap */}
          <Card>
            <Box p="4">
              <Heading size="4" mb="4">
                Spending by Budget Item (Past 2 Years)
              </Heading>
              <Box>
                {spendingError ? (
                  <Flex align="center" justify="center" height="400px">
                    <Callout.Root color="red" role="alert">
                      <Callout.Text>{spendingError}</Callout.Text>
                    </Callout.Root>
                  </Flex>
                ) : spendingQuery.isLoading ? (
                  <Flex align="center" justify="center" height="400px">
                    <PageLoader label="Loading spending…" />
                  </Flex>
                ) : budgetItemSpendingData.children.length > 0 ? (
                  <ChartFigure
                  title="Spending by budget item, past 2 years"
                  summary={budgetItemSummary}
                  columns={['Budget item', 'Spent']}
                  rows={[...budgetItemSpendingData.children]
                    .sort((a, b) => b.value - a.value)
                    .map((item) => [item.name, formatMoney(item.value)])}
                >
                  <Box height="400px">
                    <ResponsiveTreeMap
                    data={budgetItemSpendingData}
                    identity="name"
                    value="value"
                    valueFormat={(value: number) => formatMoney(value)}
                    label={(node) => node.id}
                    margin={{ top: 10, right: 10, bottom: 10, left: 10 }}
                    labelSkipSize={12}
                    labelTextColor={(node) => chart.textOn(node.color)}
                    parentLabelPosition="left"
                    parentLabelTextColor={(node) => chart.textOn(node.color)}
                    borderColor={{
                      from: 'color',
                      modifiers: [['darker', 0.1]]
                    }}
                    colors={chart.series}
                    theme={chart.nivo}
                    tooltip={({ node }) => (
                      <Box px="3" py="2" className="rounded-[var(--radius-4)] shadow-lg bg-[var(--color-panel-solid)] border border-[var(--gray-6)]">
                        <Flex align="center" gap="2" mb="1">
                          <Box
                            width="12px" height="12px" className="rounded-[var(--radius-2)]"
                            style={{ /* lint:guard colour: the chart slice's colour (nivo) */ backgroundColor: node.color }}
                          />
                          <Box className="text-sm font-medium text-[var(--gray-12)]">
                            {node.id}
                          </Box>
                        </Flex>
                        <Box className="text-sm font-bold text-[var(--gray-12)]">
                          {formatMoney(node.value)}
                        </Box>
                      </Box>
                    )}
                  />
                  </Box>
                  </ChartFigure>
                ) : (
                  <Flex align="center" justify="center" height="400px">
                    <Text color="gray">No budget item spending data available</Text>
                  </Flex>
                )}
              </Box>
            </Box>
          </Card>

          {/* Merchant Transactions Table */}
          {transactionsError ? (
            <Callout.Root color="red" role="alert" mt="4">
              <Callout.Text>{transactionsError}</Callout.Text>
            </Callout.Root>
          ) : totalTransactions > 0 && (
            <Card mt="4">
              <Box p="4">
                <Box mb="4">
                  <Text size="4" weight="bold" as="div" mb="1">
                    Transactions
                  </Text>
                  <Text size="2" color="gray" as="div">
                    {totalTransactions} transaction{totalTransactions !== 1 ? 's' : ''}
                  </Text>
                </Box>

                {/* Transactions for current page */}
                <RadixTransactionTable
                  transactions={pageTransactions}
                  showCheckboxes={false}
                  showAccount={false}
                  showBalance={false}
                  onTransactionClick={(transaction) =>
                    // Back returns here, not to the transactions list.
                    navigate(`/transactions/${transaction.uuid}?returnTo=${encodeURIComponent(location.pathname + location.search)}`)
                  }
                />

                {/* Pagination Controls */}
                {totalTransactions > transactionsPerPage && (
                  <Box mt="4">
                    <SharedPagination
                      currentPage={transactionPage}
                      totalPages={Math.ceil(totalTransactions / transactionsPerPage)}
                      totalItems={totalTransactions}
                      itemsPerPage={transactionsPerPage}
                      onPageChange={setTransactionPage}
                      itemLabel="transactions"
                    />
                  </Box>
                )}
              </Box>
            </Card>
          )}
        </Flex>

        {/* Right column - Merchant Details (1/3 width) */}
        <Box gridColumn={{ lg: 'span 1' }}>
          {/* Merchant Details */}
          <Card>
            <Box p="4">
              <Text size="3" weight="bold" mb="4">
                Merchant Details
              </Text>

              <Flex direction="column" gap="3">
                {/* Basic Information */}
                <Flex direction="column" gap="2">
                  <Text size="1">
                    <span className="text-[var(--gray-11)]">Name:</span> {merchant.name}
                  </Text>
                  {merchant.merchant_website && (
                    <Text size="1">
                      <span className="text-[var(--gray-11)]">Website:</span>{' '}
                      {websiteHref(merchant.merchant_website) ? (
                        <a
                          href={websiteHref(merchant.merchant_website)!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--accent-11)] hover:underline"
                        >
                          {merchant.merchant_website}
                        </a>
                      ) : (
                        merchant.merchant_website
                      )}
                    </Text>
                  )}
                  {merchant.merchant_accountid && (
                    <Text size="1">
                      <span className="text-[var(--gray-11)]">Account ID:</span> {merchant.merchant_accountid}
                    </Text>
                  )}
                  {spending && (
                    <Text size="1">
                      <span className="text-[var(--gray-11)]">Total Transactions:</span> {spending.transaction_count}
                    </Text>
                  )}
                  {spending && (
                    <Text size="1">
                      <span className="text-[var(--gray-11)]">Matching Rules:</span> {spending.rule_count}
                    </Text>
                  )}
                </Flex>

                {/* Notes (if exists) */}
                {merchant.notes && (
                  <Text size="1" className="pt-2 border-t border-[var(--gray-4)]">
                    <span className="text-[var(--gray-11)]">Notes:</span> {merchant.notes}
                  </Text>
                )}
              </Flex>
            </Box>
          </Card>

          {/* Merchant Duplicates */}
          {similarMerchants.length > 0 && (
            <Card mt="4">
              <Box p="4">
                <Flex justify="between" align="center" mb="4">
                  <Text size="3" weight="bold">
                    Merchant Duplicates
                  </Text>
                  <Button
                    size="2"
                    disabled={selectedMerchantsToMerge.size === 0}
                    onClick={() => setShowMergeConfirmation(true)}
                  >
                    Merge ({selectedMerchantsToMerge.size})
                  </Button>
                </Flex>

                <Text size="2" color="gray" mb="3" as="div">
                  Select merchants to merge into {merchant.name}
                </Text>

                <Flex direction="column" gap="2">
                  {similarMerchants.map((similarMerchant) => (
                    <Flex
                      asChild
                      align="center"
                      gap="2"
                      p="2"
                      className="rounded-[var(--radius-2)] cursor-pointer row-hover"
                    >
                      <label key={similarMerchant.uuid}>
                        <Checkbox
                          checked={selectedMerchantsToMerge.has(similarMerchant.uuid)}
                          onCheckedChange={() => handleMergeCheckboxChange(similarMerchant.uuid)}
                          aria-labelledby={`similar-merchant-${similarMerchant.uuid}`}
                        />
                        <Box flexGrow="1" minWidth="0">
                          <Text id={`similar-merchant-${similarMerchant.uuid}`} size="2" weight="medium" as="div" className="truncate">
                            {similarMerchant.name}
                          </Text>
                        </Box>
                      </label>
                    </Flex>
                  ))}
                </Flex>
              </Box>
            </Card>
          )}
        </Box>
        </Grid>

      {/* Merge Confirmation Dialog */}
      <Dialog.Root open={showMergeConfirmation} onOpenChange={setShowMergeConfirmation}>
        <Dialog.Content maxWidth="500px">
          <Dialog.Title>Confirm Merchant Merge</Dialog.Title>
          <Dialog.Description size="2" mb="4">
            Are you sure you want to merge the selected merchant(s) into <strong>{merchant?.name}</strong>?
          </Dialog.Description>

          <Box mb="4">
            <Text size="2" weight="bold" mb="2" as="div">
              Merchants to be merged and deleted:
            </Text>
            <Flex direction="column" gap="1">
              {Array.from(selectedMerchantsToMerge).map((uuid) => {
                const merchantToMerge = mergeCandidates.find((m) => m.uuid === uuid) ?? allMerchants.find((m) => m.uuid === uuid);
                return merchantToMerge ? (
                  <Text key={uuid} size="2" color="red" as="div">
                    • {merchantToMerge.name}{'transaction_count' in merchantToMerge && merchantToMerge.transaction_count !== undefined ? ` (${merchantToMerge.transaction_count} transactions)` : ''}
                  </Text>
                ) : null;
              })}
            </Flex>
          </Box>

          <Box p="3" mb="4" className="bg-[var(--gray-3)] rounded-[var(--radius-4)]">
            <Text size="2" as="div">
              <strong>This action will:</strong>
            </Text>
            <Text size="2" as="div" mt="2">
              • Move all transactions from selected merchants to <strong>{merchant?.name}</strong>
            </Text>
            <Text size="2" as="div">
              • Delete the selected merchants
            </Text>
            <Text size="2" as="div">
              • This action cannot be undone
            </Text>
          </Box>

          <Flex gap="3" justify="end">
            <Dialog.Close>
              <Button variant="soft" color="gray">
                Cancel
              </Button>
            </Dialog.Close>
            <Button
              color="red"
              onClick={handleMergeConfirm}
              disabled={isMerging}
            >
              {isMerging ? 'Merging...' : 'Confirm Merge'}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      {/* Assign Budget Item Dialog */}
      <Dialog.Root open={showAssignBudgetItem} onOpenChange={setShowAssignBudgetItem}>
        <Dialog.Content maxWidth="500px">
          <Dialog.Title>Assign Budget Item to All Transactions</Dialog.Title>
          <Dialog.Description size="2" mb="4">
            Assign {transactionsQuery.data ? `all ${assignCount}` : assignCount} for {merchant?.name} to a specific budget item.
          </Dialog.Description>

          <Box mb="4">
            <Text as="div" id="merchant-assign-budget-item" size="2" weight="medium" mb="2">
              Select Budget Item
            </Text>
            <RadixBudgetItemSelector
              aria-labelledby="merchant-assign-budget-item"
              value={selectedBudgetItemId}
              onChange={setSelectedBudgetItemId}
              budgetItems={budgetItems}
              placeholder="Select a budget item..."
            />
          </Box>

          <Box p="3" mb="4" className="bg-[var(--amber-3)] border border-[var(--amber-6)] rounded-[var(--radius-4)]">
            <Text size="2" weight="bold" as="div" mb="2" color="amber" highContrast>
              ⚠️ Warning
            </Text>
            <Text size="2" as="div" color="amber" highContrast>
              This will update <strong>{assignCount}</strong> and assign them to the selected budget item. Existing budget item assignments will be overwritten.
            </Text>
          </Box>

          <Flex gap="3" justify="end">
            <Dialog.Close>
              <Button variant="soft" color="gray">
                Cancel
              </Button>
            </Dialog.Close>
            <Button
              onClick={handleAssignBudgetItemToAll}
              disabled={isAssigning || selectedBudgetItemId === null}
            >
              {isAssigning ? 'Assigning...' : 'Assign to All'}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
      </Flex>
    </PageContainer>
  );
};

export default ViewMerchantPage;
