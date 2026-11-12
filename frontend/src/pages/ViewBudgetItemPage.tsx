import React, { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Flex, Text, Heading, Button, IconButton, Box, Grid, Callout } from '@radix-ui/themes';
import { Edit, ArrowLeft } from 'lucide-react';
import { ResponsiveBar, type BarCustomLayerProps } from '@nivo/bar';
import { ResponsiveTreeMap } from '@nivo/treemap';
import { currentPeriodFigures, type BudgetItem, type Transaction, type BudgetItemHistory } from '../services/api';
import {
  useBudgetItemsQuery,
  useBudgetItemHistoryQuery,
  useMerchantsQuery,
  useCategoriesQuery,
  useTransactionsWithFiltersQuery,
} from '../hooks/queries';
import { getIconByName } from '../utils/iconCatalog';
import NuggetSpinner from '../components/NuggetSpinner';
import PageLoader from '../components/PageLoader';
import { useChartTheme } from '../hooks/useChartTheme';
import ChartFigure from '../components/ChartFigure';
import ProgressTowardGoalCard from '../components/ProgressTowardGoalCard';
import RadixTransactionTable from '../components/RadixTransactionTable';
import SharedPagination from '../components/SharedPagination';
import { apiErrorMessage } from '../utils/errors';
import { EMPTY_LIST } from '../utils/emptyList';
import { useSeededState } from '../hooks/useSeededState';
import { usePageInRange } from '../hooks/usePageInRange';
import {
  type ChartRangeOption,
  CHART_RANGE_OPTIONS,
  getChartRangeOption,
  getRangeStartDate,
  getBucketKey,
  getBucketAxisLegend,
} from '../utils/chartRanges';
import {
  DateUtils,
  compareCalendarDates,
  formatCalendarDate,
  parseCalendarDate,
  toCalendarDateString,
} from '../utils/dateUtils';
import { calculateNextPaymentDate as calculateNextPaymentDateFor, nextDueDate } from '../utils/billSchedule';
import { amountSpent } from '../utils/budgetRemaining';
import PageContainer from '../components/PageContainer';
import { formatMoney, budgetExpenseType } from '@nuggets/shared';
import { centsOf, centsToAmount } from '../utils/currency';

interface MonthlyTotal {
  month: string;
  total: number;
  [key: string]: string | number; // Index signature for Nivo
}

interface MerchantSpending {
  name: string;
  value: number;
}

// The chart and table data for a budget item, from its transactions in the
// selected window (already scoped to the item by the fetch). Split parents are
// left out: their children carry the spending.
const spendingOf = (item: BudgetItem, transactions: Transaction[]) =>
  transactions.filter((t: Transaction) => t.budget_item_uuid === item.uuid && !t.is_split_parent);

// Amounts are pre-signed, so a bucket's total is the net of its transactions (an
// expense refunded, a paycheck less what went out of it), drawn as its size. Added in whole
// cents: as floats, -0.10, -0.20 and +0.30 left a 5.6e-17 sliver, a merchant
// drawn and listed at $0.00.

/** Spending bucketed by day (1-month view), week (3-6 months) or month (longer), oldest first. */
function transactionHistory(item: BudgetItem, transactions: Transaction[], range: ChartRangeOption): MonthlyTotal[] {
  const buckets = new Map<string, { cents: number; sortKey: Date }>();
  spendingOf(item, transactions).forEach((transaction: Transaction) => {
    const date = parseCalendarDate(transaction.transaction_date);
    const { label, sortKey } = getBucketKey(date, range.bucket);
    const current = buckets.get(label);
    if (current) {
      current.cents += centsOf(transaction.amount);
    } else {
      buckets.set(label, { cents: centsOf(transaction.amount), sortKey });
    }
  });
  return Array.from(buckets.entries())
    .map(([month, value]) => ({ month, total: centsToAmount(Math.abs(value.cents)), sortKey: value.sortKey }))
    .sort((a, b) => a.sortKey.getTime() - b.sortKey.getTime())
    .map(({ month, total }) => ({ month, total }));
}

/** Spending grouped by merchant name, largest first, for the treemap. */
function merchantSpending(item: BudgetItem, transactions: Transaction[]): { name: string; children: MerchantSpending[] } {
  const merchantCents = new Map<string, number>();
  spendingOf(item, transactions).forEach((transaction: Transaction) => {
    const name = transaction.merchant_name || 'No Merchant';
    merchantCents.set(name, (merchantCents.get(name) || 0) + centsOf(transaction.amount));
  });
  const children: MerchantSpending[] = Array.from(merchantCents.entries())
    .map(([name, cents]) => ({ name, value: centsToAmount(Math.abs(cents)) }))
    .filter(child => child.value > 0)
    .sort((a, b) => b.value - a.value);
  return { name: 'merchants', children };
}

/** The item's transactions, newest first. */
const itemTransactions = (item: BudgetItem, transactions: Transaction[]): Transaction[] =>
  spendingOf(item, transactions).sort((a, b) => compareCalendarDates(b.transaction_date, a.transaction_date));

const NO_MERCHANT_SPENDING = { name: 'merchants', children: [] as MerchantSpending[] };

/** Periods of envelope balance the chart shows. */
const ENVELOPE_HISTORY_PERIODS = 24;

/** An amount the server sent as NUMERIC text, as a number to draw (0 when absent). */
const amountOf = (value: number | string | null | undefined): number => Number(value ?? 0) || 0;

/** The envelope's remaining at each period, oldest first (the server orders by start_date). */
const envelopeBalances = (history: BudgetItemHistory | undefined): MonthlyTotal[] =>
  history ? history.periods.map((p) => ({ month: `${p.month} ${p.year}`, total: amountOf(p.remaining) })) : EMPTY_LIST;

const ViewBudgetItemPage: React.FC = () => {
  const { budgetItemUuid } = useParams<{ budgetItemUuid: string }>();
  const navigate = useNavigate();
  const chart = useChartTheme();

  // Reference data
  const { data: allBudgetItems = EMPTY_LIST, isLoading: itemsLoading } = useBudgetItemsQuery();
  const { data: categories = [] } = useCategoriesQuery();
  const { data: merchants = [] } = useMerchantsQuery({ lite: true });
  const budgetItem = useMemo(
    () => allBudgetItems.find((i: BudgetItem) => i.uuid === budgetItemUuid) ?? null,
    [allBudgetItems, budgetItemUuid],
  );
  const isLoading = itemsLoading;
  const error = !itemsLoading && budgetItemUuid && !budgetItem ? 'Budget item not found' : null;


  // Bar graph time range (default: the first option, 1 month / daily bars, for a fast initial
  // load; an unknown key such as '' resolves to it too, in getChartRangeOption)
  const [chartRangeKey, setChartRangeKey] = useState<string>(CHART_RANGE_OPTIONS[0]?.key ?? '');
  const chartRange = getChartRangeOption(chartRangeKey);

  // Budget item transactions paging: back to page 1 only on a chart-range change
  // (not on background refreshes).
  const [transactionPage, setTransactionPage] = useSeededState(() => 1, [chartRangeKey]);
  const transactionsPerPage = 25;

  // Range-scoped transactions for this item (only the selected window is fetched;
  // include_children pulls split allocations). keepPreviousData keeps the chart/
  // list stable while a background refresh (e.g. after a tag edit) runs.
  const rangeStartDate = useMemo(() => toCalendarDateString(getRangeStartDate(chartRange)), [chartRange]);
  const rangeTxQuery = useTransactionsWithFiltersQuery(
    budgetItem ? { budget_item_uuid: budgetItem.uuid, include_children: 'true', start_date: rangeStartDate } : {},
    { enabled: !!budgetItem, meta: { suppressErrorToast: true } },
  );
  const isChartLoading = rangeTxQuery.isLoading;
  const transactionsError = rangeTxQuery.isError
    ? apiErrorMessage(rangeTxQuery.error, "Could not load this budget item's transactions")
    : null;

  // The transaction-derived sections, from the scoped data (empty until it loads).
  const scoped = rangeTxQuery.data;
  const monthlyData = useMemo(
    () => (budgetItem && scoped ? transactionHistory(budgetItem, scoped, chartRange) : EMPTY_LIST),
    [budgetItem, scoped, chartRange],
  );
  const merchantSpendingData = useMemo(
    () => (budgetItem && scoped ? merchantSpending(budgetItem, scoped) : NO_MERCHANT_SPENDING),
    [budgetItem, scoped],
  );
  const budgetItemTransactions = useMemo(
    () => (budgetItem && scoped ? itemTransactions(budgetItem, scoped) : EMPTY_LIST),
    [budgetItem, scoped],
  );
  // Back to the last page when the list shrinks under the one shown.
  usePageInRange(
    transactionPage,
    scoped ? Math.ceil(budgetItemTransactions.length / transactionsPerPage) : undefined,
    setTransactionPage,
  );

  // The item's figures in the current period and, for an envelope, its last 24 periods:
  // one request, keyed under the item so a budget edit refreshes it.
  const isEnvelopeType = budgetItem?.type === 'Envelope' || budgetItem?.type === 'Non-Monthly';
  const historyQuery = useBudgetItemHistoryQuery(budgetItem?.uuid, isEnvelopeType ? ENVELOPE_HISTORY_PERIODS : 1, {
    enabled: !!budgetItem,
  });
  const isCurrentBudgetLoading = historyQuery.isLoading;
  const isEnvelopeLoading = historyQuery.isLoading;
  const historyError = historyQuery.isError ? apiErrorMessage(historyQuery.error, "Could not load this budget item's period figures") : null;
  const currentBudgetData = useMemo(() => currentPeriodFigures(historyQuery.data), [historyQuery.data]);
  const envelopeBalanceData = useMemo(() => envelopeBalances(historyQuery.data), [historyQuery.data]);

  // Calculate linear regression trend line
  const calculateTrendLine = (data: MonthlyTotal[]): { start: number; end: number } | null => {
    if (data.length < 2) return null;
    
    const n = data.length;
    const sumX = data.reduce((sum, _, i) => sum + i, 0);
    const sumY = data.reduce((sum, d) => sum + d.total, 0);
    const sumXY = data.reduce((sum, d, i) => sum + i * d.total, 0);
    const sumXX = data.reduce((sum, _, i) => sum + i * i, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    return {
      start: intercept,
      end: slope * (n - 1) + intercept
    };
  };

  const renderIcon = (iconName: string | undefined, size = 20, className?: string) => {
    if (!iconName) return null;
    const iconOption = getIconByName(iconName);
    if (iconOption) {
      const IconComponent = iconOption.component;
      return <IconComponent size={size} {...(className ? { className } : {})} />;
    }
    return <Box width={`${size}px`} height={`${size}px`} className={`${className ?? ''} bg-[var(--gray-6)] rounded-[var(--radius-2)]`} />;
  };


  // One-line text alternatives for the charts.
  const historyTotal = centsToAmount(monthlyData.reduce((sum, row) => sum + centsOf(row.total), 0));
  const historyPeak = monthlyData.reduce<MonthlyTotal | null>((top, row) => (!top || row.total > top.total ? row : top), null);
  const historySummary = historyPeak
    ? `${formatMoney(historyTotal)} in total across ${monthlyData.length} ${monthlyData.length === 1 ? 'period' : 'periods'}; the most, ${formatMoney(historyPeak.total)}, in ${historyPeak.month}.`
    : 'No transactions in this range.';
  const lastBalance = envelopeBalanceData[envelopeBalanceData.length - 1];
  const envelopeSummary = lastBalance
    ? `${formatMoney(lastBalance.total)} in ${lastBalance.month}${budgetItem?.rollover_target_amount ? `, against a target of ${formatMoney(budgetItem.rollover_target_amount)}` : ''}.`
    : 'No balance history.';
  const topMerchant = [...merchantSpendingData.children].sort((a, b) => b.value - a.value)[0];
  const merchantSummary = topMerchant
    ? `${merchantSpendingData.children.length} ${merchantSpendingData.children.length === 1 ? 'merchant' : 'merchants'}; the most at ${topMerchant.name}, ${formatMoney(topMerchant.value)}.`
    : 'No merchant spending.';

  // A calendar date (next/last payment): its own day, not a UTC instant.
  const formatDate = (dateString: string): string =>
    formatCalendarDate(dateString, 'en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  // Months between payments, or null for none: below 1 is no schedule (one stored before the API refused it).
  const frequency = budgetItem?.recurring_payment_frequency;
  const scheduledMonths = frequency != null && frequency >= 1 ? frequency : null;

  // The next payment date: the bill schedule's first due day on or after today.
  const calculateNextPaymentDate = (): Date | null =>
    calculateNextPaymentDateFor(budgetItem?.recurring_next_payment_date, budgetItem?.recurring_payment_frequency);

  // Calculate expected total by next payment date
  const calculateExpectedTotal = (): { amount: number; status: 'success' | 'warning' | 'danger' } | null => {
    if (!currentBudgetData || !budgetItem?.rollover_target_amount || budgetItem.rollover_target_amount <= 0) {
      return null;
    }
    
    const nextPaymentDate = calculateNextPaymentDate();
    if (!nextPaymentDate) {
      return null;
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Calculate months until next payment
    const monthsUntilPayment = (nextPaymentDate.getFullYear() - today.getFullYear()) * 12 + 
                               (nextPaymentDate.getMonth() - today.getMonth());
    
    // Expected total = current savings + (monthly budget * months remaining)
    const currentSavings = Math.max(0, currentBudgetData.calculated_remaining);
    const monthlyBudget = budgetItem.default_budget_amount || 0;
    const expectedTotal = currentSavings + (monthlyBudget * monthsUntilPayment);
    
    // Determine status based on target amount
    const targetAmount = budgetItem.rollover_target_amount;
    let status: 'success' | 'warning' | 'danger';
    
    if (expectedTotal < targetAmount) {
      status = 'danger'; // Red: won't have enough
    } else if (expectedTotal < targetAmount * 1.05) {
      status = 'warning'; // Yellow: within 5% buffer
    } else {
      status = 'success'; // Green: over the amount
    }
    
    return { amount: expectedTotal, status };
  };

  // Budget items are edited through the unified route, which infers the kind
  // (income / bill / expense) and renders the matching editor. The old per-kind
  // `/settings/{income|bills|expenses}/edit/:uuid` paths are retired.
  const getEditUrl = (): string => `/budget-items/${budgetItemUuid}/edit`;

  const shouldShowProgressCard = (): boolean => {
    if (!budgetItem) return false;
    
    // Show for:
    // 1. Bills with rollover (non-monthly bills saving up)
    // 2. Envelope type expenses (non-monthly expenses saving up)
    return (budgetItem.rollover && budgetItem.isbill) || 
           (budgetItem.type === 'Envelope' && budgetItem.expense_type === budgetExpenseType.enum.Expense) ||
           (budgetItem.type === 'Non-Monthly' && budgetItem.expense_type === budgetExpenseType.enum.Expense);
  };

  if (isLoading) {
    return (
      <PageContainer>
        <PageLoader label="Loading budget item…" minHeight="100vh" />
      </PageContainer>
    );
  }

  if (error || !budgetItem) {
    return (
      <PageContainer>
        <Callout.Root color="red">
          <Callout.Text>{error || 'Budget item not found'}</Callout.Text>
        </Callout.Root>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Flex direction="column" gap="6">
        {/* Custom identity header: budget item icon + name */}
        <Flex align="center" justify="between" wrap="wrap" gap="2">
          <Flex align="center" gap="3">
            <IconButton
              variant="soft"
              color="gray"
              aria-label="Go back"
              onClick={() => navigate(-1)}
            >
              <ArrowLeft size={16} />
            </IconButton>
            <Flex align="center" gap="2">
              {renderIcon(budgetItem.icon ?? undefined, 24)}
              <Heading as="h1" size="6">{budgetItem.name}</Heading>
            </Flex>
          </Flex>
          <Button onClick={() => navigate(getEditUrl())}>
            <Edit size={16} />
            Edit
          </Button>
        </Flex>

        {/* Two column layout */}
        <Grid columns={{ initial: '1', lg: '4' }} gap="6">
          {/* Left column - Chart and Details (3/4 width) */}
          <Flex direction="column" gap="6" gridColumn={{ lg: 'span 3' }}>
          {/* Transaction History Chart */}
          <Card>
            <Box p="4">
              <Flex justify="between" align="center" wrap="wrap" gap="2" mb="4">
                <Heading size="4">
                  Transaction History (Last {chartRange.label})
                </Heading>
                <Flex gap="1" wrap="wrap">
                  {CHART_RANGE_OPTIONS.map(option => (
                    <Button
                      key={option.key}
                      size="1"
                      variant={option.key === chartRangeKey ? 'solid' : 'soft'}
                      onClick={() => setChartRangeKey(option.key)}
                      disabled={isChartLoading}
                    >
                      {option.label}
                    </Button>
                  ))}
                </Flex>
              </Flex>
              <Box>
                {transactionsError ? (
                  <Flex align="center" justify="center" height="400px">
                    <Callout.Root color="red" role="alert">
                      <Callout.Text>{transactionsError}</Callout.Text>
                    </Callout.Root>
                  </Flex>
                ) : isChartLoading ? (
                  <Flex align="center" justify="center" height="400px">
                    <NuggetSpinner size={48} />
                  </Flex>
                ) : monthlyData.length > 0 ? (
                  <ChartFigure
                  title={`Transaction history, last ${chartRange.label}`}
                  summary={historySummary}
                  columns={[getBucketAxisLegend(chartRange.bucket) || 'Period', 'Total']}
                  rows={monthlyData.map((row) => [row.month, formatMoney(row.total)])}
                >
                  <Box height="400px">
                    <ResponsiveBar
                    data={monthlyData}
                    keys={['total']}
                    indexBy="month"
                    margin={{ top: 20, right: 30, bottom: 80, left: 80 }}
                    padding={0.3}
                    valueScale={{ type: 'linear' }}
                    indexScale={{ type: 'band', round: true }}
                    colors={chart.accent}
                    borderColor={{
                      from: 'color',
                      modifiers: [['darker', 1.6]]
                    }}
                    layers={[
                      'grid',
                      'axes',
                      'bars',
                      'markers',
                      'legends',
                      'annotations',
                      // Custom trend line layer
                      (props: BarCustomLayerProps<MonthlyTotal>) => {
                        const trendLine = calculateTrendLine(monthlyData);
                        if (!trendLine || monthlyData.length < 2) return null;
                        
                        const { bars, yScale } = props;
                        const firstBar = bars?.[0];
                        const lastBar = bars?.[bars.length - 1];
                        if (!firstBar || !lastBar) return null;
                        
                        const x1 = firstBar.x + firstBar.width / 2;
                        const y1 = yScale(trendLine.start);
                        const x2 = lastBar.x + lastBar.width / 2;
                        const y2 = yScale(trendLine.end);
                        
                        return (
                          <line
                            x1={x1}
                            y1={y1}
                            x2={x2}
                            y2={y2}
                            stroke={chart.warning}
                            strokeWidth={2}
                            strokeDasharray="5,5"
                            opacity={0.8}
                          />
                        );
                      }
                    ]}
                    axisTop={null}
                    axisRight={null}
                    axisBottom={{
                      tickSize: 5,
                      tickPadding: 5,
                      tickRotation: -45,
                      legend: getBucketAxisLegend(chartRange.bucket),
                      legendPosition: 'middle',
                      legendOffset: 60
                    }}
                    axisLeft={{
                      tickSize: 5,
                      tickPadding: 5,
                      tickRotation: 0,
                      legend: '',
                      legendPosition: 'middle',
                      legendOffset: -60,
                      format: (value) => formatMoney(value)
                    }}
                    enableLabel={false}
                    theme={chart.nivo}
                    tooltip={({ value, indexValue }) => (
                      <Box px="3" py="2" className="rounded-[var(--radius-4)] shadow-lg bg-[var(--color-panel-solid)] border border-[var(--gray-6)]">
                        <Box className="text-sm font-medium text-[var(--gray-12)]">
                          {formatMoney(value as number)}
                        </Box>
                        <Box className="text-xs text-[var(--gray-11)]">
                          {indexValue}
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

          {/* Envelope Balance Chart (only for envelope types) */}
          {(budgetItem.type === 'Envelope' || budgetItem.type === 'Non-Monthly') && (
            <Card>
              <Box p="4">
                <Heading size="4" mb="4">
                  Envelope Balance (Past 2 Years)
                </Heading>
                <Box>
                  {isEnvelopeLoading ? (
                    <Flex align="center" justify="center" height="400px">
                      <NuggetSpinner size={48} />
                    </Flex>
                  ) : historyError ? (
                    <Flex align="center" justify="center" height="400px">
                      <Callout.Root color="red" role="alert">
                        <Callout.Text>{historyError}</Callout.Text>
                      </Callout.Root>
                    </Flex>
                  ) : envelopeBalanceData.length > 0 ? (
                    <ChartFigure
                    title="Envelope balance, past 2 years"
                    summary={envelopeSummary}
                    columns={['Month', 'Balance']}
                    rows={envelopeBalanceData.map((row) => [row.month, formatMoney(row.total)])}
                  >
                  <Box height="400px">
                    <ResponsiveBar
                      data={envelopeBalanceData}
                      keys={['total']}
                      indexBy="month"
                      margin={{ top: 20, right: 30, bottom: 80, left: 80 }}
                      padding={0.3}
                      valueScale={{ 
                        type: 'linear',
                        min: 'auto',
                        max: budgetItem.rollover_target_amount 
                          ? Math.max(
                              ...envelopeBalanceData.map(d => d.total),
                              budgetItem.rollover_target_amount
                            ) * 1.1  // Add 10% padding above the max
                          : 'auto'
                      }}
                      indexScale={{ type: 'band', round: true }}
                      colors={chart.positive}
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
                        legend: '',
                        legendPosition: 'middle',
                        legendOffset: 32
                      }}
                      axisLeft={{
                        tickSize: 5,
                        tickPadding: 5,
                        tickRotation: 0,
                        legend: '',
                        legendPosition: 'middle',
                        legendOffset: -60,
                        format: (value) => formatMoney(value)
                      }}
                      enableLabel={false}
                      markers={budgetItem.rollover_target_amount ? [
                        {
                          axis: 'y',
                          value: budgetItem.rollover_target_amount,
                          lineStyle: { 
                            stroke: chart.warning,
                            strokeWidth: 2,
                            strokeDasharray: '6, 4'
                          },
                          legend: `Target: ${formatMoney(budgetItem.rollover_target_amount)}`,
                          legendOrientation: 'horizontal',
                          legendPosition: 'top-right',
                          textStyle: {
                            fill: chart.textStrong,
                            fontSize: 12,
                            fontWeight: 600
                          }
                        }
                      ] : []}
                      theme={chart.nivo}
                      tooltip={({ value, indexValue }) => (
                        <Box px="3" py="2" className="rounded-[var(--radius-4)] shadow-lg bg-[var(--color-panel-solid)] border border-[var(--gray-6)]">
                          <Box className="text-sm font-medium text-[var(--gray-12)]">
                            Balance: {formatMoney(value as number)}
                          </Box>
                          <Box className="text-xs text-[var(--gray-11)]">
                            {indexValue}
                          </Box>
                        </Box>
                      )}
                    />
                  </Box>
                  </ChartFigure>
                  ) : (
                    <Flex align="center" justify="center" height="400px">
                      <Text color="gray">No envelope balance history available</Text>
                    </Flex>
                  )}
                </Box>
              </Box>
            </Card>
          )}

          {/* Merchant Spending TreeMap */}
          <Card>
            <Box p="4">
              <Heading size="4" mb="4">
                Spending by Merchant (Last {chartRange.label})
              </Heading>
              <Box>
                {merchantSpendingData.children.length > 0 ? (
                  <ChartFigure
                  title={`Spending by merchant, last ${chartRange.label}`}
                  summary={merchantSummary}
                  columns={['Merchant', 'Spent']}
                  rows={[...merchantSpendingData.children]
                    .sort((a, b) => b.value - a.value)
                    .map((m) => [m.name, formatMoney(m.value)])}
                >
                  <Box height="400px">
                    <ResponsiveTreeMap
                    data={merchantSpendingData}
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
                    <Text color="gray">No merchant spending data available</Text>
                  </Flex>
                )}
              </Box>
            </Box>
          </Card>

          {/* Budget Item Transactions Table */}
          {budgetItemTransactions.length > 0 && (
            <Card mt="4" style={{ padding: 0 }}>
              {/* Zero the Card's intrinsic padding and drive it with a responsive
                  Box so the per-transaction cards (themselves Cards) aren't
                  doubly inset on mobile. */}
              <Box px={{ initial: '2', sm: '4' }} py="4">
                <Box mb="4">
                  <Text size="4" weight="bold" as="div" mb="1">
                    Transactions
                  </Text>
                  <Text size="2" color="gray" as="div">
                    {budgetItemTransactions.length} transaction{budgetItemTransactions.length !== 1 ? 's' : ''} in the last {chartRange.label}
                  </Text>
                </Box>

                {/* Transactions for current page */}
                <RadixTransactionTable
                  transactions={budgetItemTransactions.slice(
                    (transactionPage - 1) * transactionsPerPage,
                    transactionPage * transactionsPerPage
                  )}
                  showCheckboxes={false}
                  showAccount={false}
                  showBalance={false}
                  onTransactionClick={(transaction) => navigate(`/transactions/${transaction.uuid}`)}
                  // Refresh the scoped data in place (tags, review status, etc.)
                  // without a chart spinner flash or page reset, so it feels
                  // dynamic instead of a full reload.
                  onTransactionUpdated={() => rangeTxQuery.refetch()}
                />

                {/* Pagination Controls */}
                {budgetItemTransactions.length > transactionsPerPage && (
                  <Box mt="4">
                    <SharedPagination
                      currentPage={transactionPage}
                      totalPages={Math.ceil(budgetItemTransactions.length / transactionsPerPage)}
                      totalItems={budgetItemTransactions.length}
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

        {/* Right column - Progress Card and Budget Item Details (1/3 width) */}
        <Box gridColumn={{ lg: 'span 1' }}>
          {/* Placeholder while the current-period budget numbers load */}
          {shouldShowProgressCard() && budgetItem.rollover_target_amount && budgetItem.rollover_target_amount > 0 && isCurrentBudgetLoading && !currentBudgetData && (
            <Card>
              <Flex p="4" align="center" justify="center" minHeight="120px">
                <NuggetSpinner size={32} />
              </Flex>
            </Card>
          )}
          {shouldShowProgressCard() && budgetItem.rollover_target_amount && budgetItem.rollover_target_amount > 0 && historyError && !isEnvelopeType && (
            <Callout.Root color="red" role="alert">
              <Callout.Text>{historyError}</Callout.Text>
            </Callout.Root>
          )}
          {shouldShowProgressCard() && currentBudgetData && budgetItem.rollover_target_amount && budgetItem.rollover_target_amount > 0 && (
            <ProgressTowardGoalCard
              targetAmount={budgetItem.rollover_target_amount}
              currentSavings={Math.max(0, currentBudgetData.calculated_remaining)}
              monthlyBudget={currentBudgetData.calculated_budget}
              monthlySpent={currentBudgetData.calculated_actual}
              previouslySpent={amountSpent(currentBudgetData.calculated_actual)}
              transfers={currentBudgetData.calculated_transfers !== 0 ? currentBudgetData.calculated_transfers : undefined}
              expectedTotal={(() => {
                const expectedTotal = calculateExpectedTotal();
                const nextPaymentDate = calculateNextPaymentDate();
                if (expectedTotal && nextPaymentDate) {
                  return {
                    amount: expectedTotal.amount,
                    date: formatDate(toCalendarDateString(nextPaymentDate)),
                    status: expectedTotal.status
                  };
                }
                return null;
              })()}
            />
          )}

          {/* Budget Item Details */}
          <Card {...(shouldShowProgressCard() && currentBudgetData && budgetItem.rollover_target_amount && budgetItem.rollover_target_amount > 0 ? { mt: '4' as const } : {})}>
            <Box p="4">
              <Text size="3" weight="bold" mb="4">
                Budget Item Details
              </Text>
              
              <Flex direction="column" gap="3">
                {/* Basic Information */}
                <Flex direction="column" gap="2">
                  <Text size="1">
                    <span className="text-[var(--gray-11)]">Name:</span> {budgetItem.name}
                  </Text>
                  <Text size="1">
                    <span className="text-[var(--gray-11)]">Type:</span> {budgetItem.type}
                  </Text>
                  <Text size="1">
                    <span className="text-[var(--gray-11)]">Subtype:</span> {budgetItem.subtype}
                  </Text>
                  <Text size="1">
                    <span className="text-[var(--gray-11)]">Priority:</span> {budgetItem.priority}
                  </Text>
                  <Text size="1">
                    <span className="text-[var(--gray-11)]">Expense Type:</span> {budgetItem.expense_type}
                  </Text>
                  {budgetItem.merchant_id && (
                    <Text size="1">
                      <span className="text-[var(--gray-11)]">Merchant:</span> {merchants.find(m => m.id === budgetItem.merchant_id)?.name || 'Unknown'}
                    </Text>
                  )}
                  {budgetItem.category_id && (
                    <Text size="1">
                      <span className="text-[var(--gray-11)]">Category:</span> {categories.find(c => c.id === budgetItem.category_id)?.name || 'Unknown'}
                    </Text>
                  )}
                  <Text size="1">
                    <span className="text-[var(--gray-11)]">Icon:</span> {renderIcon(budgetItem.icon ?? undefined, 12, 'inline-block ml-1')}
                  </Text>
                  <Text size="1">
                    <span className="text-[var(--gray-11)]">Color:</span> 
                    <Box as="span" display="inline-block" width="12px" height="12px" ml="1" className="rounded-[var(--radius-2)] align-middle border border-[var(--gray-6)]" style={{ /* lint:guard colour: a swatch of the item's own colour */ backgroundColor: budgetItem.color ?? undefined }}></Box>
                    <Box as="span" display="inline" ml="1">{budgetItem.color}</Box>
                  </Text>
                </Flex>

                {/* Description (if exists) */}
                {budgetItem.description && (
                  <Text size="1" className="pt-2 border-t border-[var(--gray-4)]">
                    <span className="text-[var(--gray-11)]">Description:</span> {budgetItem.description}
                  </Text>
                )}

                {/* Budget Amounts */}
                {(budgetItem.default_budget_amount || budgetItem.recurring_payment_amount) && (
                  <Box pt="2" className="border-t border-[var(--gray-4)]">
                    <Flex direction="column" gap="2">
                      {budgetItem.default_budget_amount && (
                        <Text size="1">
                          <span className="text-[var(--gray-11)]">Default Budget Amount:</span> {formatMoney(budgetItem.default_budget_amount)}
                        </Text>
                      )}
                      {budgetItem.recurring_payment_amount && (
                        <Text size="1">
                          <span className="text-[var(--gray-11)]">Bill Amount:</span> {formatMoney(budgetItem.recurring_payment_amount)}
                        </Text>
                      )}
                    </Flex>
                  </Box>
                )}

                {/* Payment Information (if bill). A frequency below 1 (one stored before the API refused it)
                    is no schedule: such a bill isn't on the Bills page, and `0 &&` showed a stray 0. */}
                {(scheduledMonths !== null || budgetItem.isbill === true || !!budgetItem.recurring_next_payment_date || !!budgetItem.recurring_last_payment_date) && (
                  <Box pt="2" className="border-t border-[var(--gray-4)]">
                    <Flex direction="column" gap="2">
                      {scheduledMonths !== null ? (
                        <Text size="1">
                          <span className="text-[var(--gray-11)]">Payment Frequency:</span> Every {scheduledMonths} month(s)
                        </Text>
                      ) : budgetItem.isbill === true && (
                        <Text size="1">
                          <span className="text-[var(--gray-11)]">Payment Frequency:</span> None set, so the Bills page doesn’t list it. Edit the bill to choose one.
                        </Text>
                      )}
                      {budgetItem.recurring_next_payment_date && (
                        <Text size="1">
                          {/* The schedule's next due day, not its anchor (which may be long past). */}
                          <span className="text-[var(--gray-11)]">Next Payment Date:</span>{' '}
                          {formatDate(nextDueDate(budgetItem.recurring_next_payment_date, budgetItem.recurring_payment_frequency) ?? budgetItem.recurring_next_payment_date)}
                        </Text>
                      )}
                      {budgetItem.recurring_last_payment_date && (
                        <Text size="1">
                          <span className="text-[var(--gray-11)]">Last Payment Date:</span> {formatDate(budgetItem.recurring_last_payment_date)}
                        </Text>
                      )}
                    </Flex>
                  </Box>
                )}

                {/* Rollover Information */}
                {budgetItem.rollover && (
                  <Box pt="2" className="border-t border-[var(--gray-4)]">
                    <Flex direction="column" gap="2">
                      {budgetItem.rollover_starting_balance !== null && budgetItem.rollover_starting_balance !== undefined && (
                        <Text size="1">
                          <span className="text-[var(--gray-11)]">Starting Balance:</span> {formatMoney(budgetItem.rollover_starting_balance)}
                        </Text>
                      )}
                      {budgetItem.rollover_target_amount && (
                        <Text size="1">
                          <span className="text-[var(--gray-11)]">Target Amount:</span> {formatMoney(budgetItem.rollover_target_amount)}
                        </Text>
                      )}
                      {budgetItem.rollover_target_date && (
                        <Text size="1">
                          <span className="text-[var(--gray-11)]">Target Date:</span> {DateUtils.formatForDisplay(budgetItem.rollover_target_date)}
                        </Text>
                      )}
                      {budgetItem.rollover_starting_balance_date && (
                        <Text size="1">
                          <span className="text-[var(--gray-11)]">Starting Balance Date:</span> {DateUtils.formatForDisplay(budgetItem.rollover_starting_balance_date)}
                        </Text>
                      )}
                    </Flex>
                  </Box>
                )}

                {/* Notes (if exists) */}
                {budgetItem.notes && (
                  <Text size="1" className="pt-2 border-t border-[var(--gray-4)]">
                    <span className="text-[var(--gray-11)]">Notes:</span> {budgetItem.notes}
                  </Text>
                )}
              </Flex>
            </Box>
          </Card>
        </Box>
        </Grid>
      </Flex>
    </PageContainer>
  );
};

export default ViewBudgetItemPage;
