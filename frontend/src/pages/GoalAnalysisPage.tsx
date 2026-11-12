import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Target, ArrowLeft, TrendingUp, Wallet, Edit, DollarSign, Calendar
} from 'lucide-react';
import { type Goal } from '../services/api';
import { useGoalQuery, useGoalBalanceHistoryQuery, useGoalAccountBalanceHistoryQuery } from '../hooks/queries';
import toast from 'react-hot-toast';
import { Box, Card, Flex, Grid, Heading, Text, Button, IconButton, Badge } from '@radix-ui/themes';
import ChartFigure from '../components/ChartFigure';
import { useChartTheme } from '../hooks/useChartTheme';
import { ResponsiveLine } from '@nivo/line';
import { ResponsivePie } from '@nivo/pie';
import NuggetSpinner from '../components/NuggetSpinner';
import { formatCalendarDate } from '../utils/dateUtils';
import PageContainer from '../components/PageContainer';
import { formatMoney, budgetItemStatus } from '@nuggets/shared';
import { centsOf, centsToAmount, toCents } from '../utils/currency';
import { moneyAxis, type MoneyAxis } from '../utils/moneyAxis';

interface BalanceDataPoint {
  x: string;
  y: number;
}

type TimePeriod = 'month' | '3months' | '6months' | 'year' | 'all';

const PERIOD_OPTIONS: { value: TimePeriod; label: string }[] = [
  { value: 'month', label: 'Past Month' },
  { value: '3months', label: '3 Months' },
  { value: '6months', label: '6 Months' },
  { value: 'year', label: 'Past Year' },
  { value: 'all', label: 'All Time' }
];

const getApiParamsForPeriod = (period: TimePeriod): { period: 'day' | 'week' | 'month' | 'year'; limit: number } => {
  switch (period) {
    case 'month': return { period: 'day', limit: 30 };
    case '3months': return { period: 'week', limit: 13 };
    case '6months': return { period: 'month', limit: 6 };
    case 'year': return { period: 'month', limit: 12 };
    case 'all': return { period: 'month', limit: 36 };
    default: return { period: 'month', limit: 12 };
  }
};

const getDateFormat = (period: TimePeriod): Intl.DateTimeFormatOptions => {
  switch (period) {
    case 'month':
    case '3months':
      return { month: 'short', day: 'numeric' };
    case '6months':
    case 'year':
      return { month: 'short', year: '2-digit' };
    case 'all':
      return { month: 'short', year: 'numeric' };
    default:
      return { month: 'short', year: 'numeric' };
  }
};

const GoalAnalysisPage: React.FC = () => {
  const navigate = useNavigate();
  const { uuid } = useParams<{ uuid: string }>();
  const [selectedPeriod, setSelectedPeriod] = useState<TimePeriod>('year');

  // Chart colours, from the theme.
  const chart = useChartTheme();
  const COLORS = chart.series;

  const { data: goalData, isLoading, isError } = useGoalQuery(uuid);
  const goal: Goal | null = goalData?.goal ?? null;
  const loading = isLoading;

  const { period, limit } = getApiParamsForPeriod(selectedPeriod);
  const balanceHistoryQuery = useGoalBalanceHistoryQuery(uuid ?? '', period, limit);
  const accountHistoryQuery = useGoalAccountBalanceHistoryQuery(uuid ?? '', period, limit);
  const chartsLoading = balanceHistoryQuery.isFetching || accountHistoryQuery.isFetching;

  // Redirect if the goal can't be loaded.
  useEffect(() => {
    if (isError) {
      toast.error('Failed to load goal');
      navigate('/goals');
    }
  }, [isError, navigate]);

  // Aggregate balance history (falls back to a single current-balance point).
  const balanceHistory: BalanceDataPoint[] = useMemo(() => {
    const dateFormat = getDateFormat(selectedPeriod);
    const history = balanceHistoryQuery.data?.history;
    if (history && history.length > 0) {
      return history.map((point) => ({
        x: formatCalendarDate(point.date, 'en-US', dateFormat),
        y: parseFloat(point.balance.toString()),
      }));
    }
    return [{
      x: new Date().toLocaleDateString('en-US', dateFormat),
      y: parseFloat((goal?.total_from_accounts || 0).toString()),
    }];
  }, [balanceHistoryQuery.data, goal, selectedPeriod]);

  // Per-account balance history.
  const accountBalanceData: { id: string; data: BalanceDataPoint[] }[] = useMemo(() => {
    const dateFormat = getDateFormat(selectedPeriod);
    const accountsHistory = accountHistoryQuery.data?.accounts;
    if (accountsHistory && accountsHistory.length > 0) {
      return accountsHistory.map((account) => ({
        id: account.account_name,
        data: account.history.map((point) => ({
          x: formatCalendarDate(point.date, 'en-US', dateFormat),
          y: parseFloat(point.balance.toString()),
        })),
      }));
    }
    return [];
  }, [accountHistoryQuery.data, selectedPeriod]);

  if (loading || !goal) {
    return (
      <PageContainer>
        <Flex direction="column" align="center" justify="center" minHeight="400px">
          <Text color="gray">Loading goal analysis...</Text>
        </Flex>
      </PageContainer>
    );
  }

  // Calculate progress
  const currentAmount = goal.total_from_accounts || 0;
  // A goal made as a budget item has no target: no share of it and nothing left.
  const targetAmount = goal.target_amount;
  const progress = targetAmount == null ? null : targetAmount > 0 ? (currentAmount / targetAmount) * 100 : 0;
  // What is left to save, in whole cents.
  const remainingAmount = targetAmount == null ? null : centsToAmount(Math.max(0, toCents(targetAmount) - toCents(currentAmount)));

  // Format balance history for Nivo chart
  const balanceChartData = [
    {
      id: 'Balance',
      data: balanceHistory
    }
  ];

  // Generate account breakdown data - Nivo format
  const generateAccountBreakdown = () => {
    if (!goal.associated_accounts || goal.associated_accounts.length === 0) {
      return [];
    }

    // An unavailable balance (null) is left out rather than drawn as a $0 slice.
    return goal.associated_accounts
      .filter((account) => account.calculated_balance != null)
      .map((account, index) => ({
        id: account.name,
        label: account.name,
        value: account.calculated_balance as number,
        color: COLORS[index % COLORS.length]
      }));
  };

  // Generate account subtype breakdown - Nivo format
  const generateAccountSubtypeBreakdown = () => {
    if (!goal.associated_accounts || goal.associated_accounts.length === 0) {
      return [];
    }

    // Each subtype's balances added in whole cents.
    const subtypeCents: Record<string, number> = {};

    goal.associated_accounts.forEach((account) => {
      if (account.calculated_balance == null) return; // unavailable: not a $0 share
      const subtype = account.subtype || 'Other';
      subtypeCents[subtype] = (subtypeCents[subtype] || 0) + centsOf(account.calculated_balance);
    });

    return Object.entries(subtypeCents).map(([subtype, cents], index) => ({
      id: subtype,
      label: subtype,
      value: centsToAmount(cents),
      color: COLORS[index % COLORS.length]
    }));
  };

  const accountBreakdown = generateAccountBreakdown();
  const accountSubtypeBreakdown = generateAccountSubtypeBreakdown();


  // One-line text alternatives for the charts.
  const firstPoint = balanceHistory[0];
  const lastPoint = balanceHistory[balanceHistory.length - 1];
  const balanceSummary = firstPoint && lastPoint
    ? `${formatMoney(firstPoint.y)} on ${firstPoint.x}, ${formatMoney(lastPoint.y)} on ${lastPoint.x}; ${targetAmount == null ? 'the goal has no target' : `the target is ${formatMoney(targetAmount)}`}.`
    : 'No balance history for this period.';
  const accountsSummary = `${accountBalanceData.length} ${accountBalanceData.length === 1 ? 'account' : 'accounts'} over the period.`;
  const pieSummary = (slices: { label: string; value: number }[]) => {
    const total = centsToAmount(slices.reduce((sum, slice) => sum + centsOf(slice.value), 0));
    const top = [...slices].sort((a, b) => b.value - a.value)[0];
    return top ? `${formatMoney(total)} in ${slices.length} parts; the largest, ${top.label}, ${formatMoney(top.value)}. Each is listed beside the chart.` : '';
  };

  // The goal's target date is a calendar day, not an instant.
  const formatDate = (dateString: string) => {
    return formatCalendarDate(dateString, 'en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };


  // The balance axes: round ticks, labelled as precisely as their step needs.
  const balanceAxis = moneyAxis(balanceHistory.map((point) => point.y));
  const accountsAxis = moneyAxis(accountBalanceData.flatMap((series) => series.data.map((point) => point.y)));
  const yScale = (axis: MoneyAxis) => ({ type: 'linear' as const, min: axis.min, max: axis.max, nice: false, stacked: false, reverse: false });
  const axisLeft = (axis: MoneyAxis) => ({
    tickSize: 5,
    tickPadding: 5,
    tickRotation: 0,
    tickValues: axis.tickValues,
    legend: 'Balance',
    legendOffset: -60,
    legendPosition: 'middle' as const,
    format: (value: number | string) => axis.format(Number(value)),
  });

  /** A chart's loading veil, over the chart while its period's figures load. */
  const loadingVeil = chartsLoading && (
    <Flex align="center" justify="center" position="absolute" inset="0" className="z-[1] bg-[var(--color-panel-translucent)]">
      <NuggetSpinner size={32} />
    </Flex>
  );

  /** A pie's legend: each slice's colour, name and amount. */
  const sliceLegend = (slices: { id: string; label: string; value: number; color: string | undefined }[]) => (
    <Flex direction="column" justify="center" gap="2" width={{ initial: '100%', md: '256px' }} flexShrink="0">
      {slices.map((entry) => (
        <Flex key={entry.id} align="center" justify="between" gap="2">
          <Flex align="center" gap="2">
            <Box width="12px" height="12px" flexShrink="0" className="rounded-xs" style={{ /* lint:guard colour: the chart slice's colour (useChartTheme) */ backgroundColor: entry.color }} />
            <Text size="2" color="gray">{entry.label}</Text>
          </Flex>
          <Text size="2" weight="medium">
            {formatMoney(entry.value)}
          </Text>
        </Flex>
      ))}
    </Flex>
  );

  /** A breakdown card: its pie and legend side by side from `md`, or that it has none. */
  const breakdown = (title: string, slices: ReturnType<typeof generateAccountBreakdown>) => (
    <Card size="3">
      <Heading as="h2" size="4" mb="4">{title}</Heading>
      {slices.length > 0 ? (
        <Flex direction={{ initial: 'column', md: 'row' }} gap="5">
          <Box flexGrow="1">
            <ChartFigure title={title} summary={pieSummary(slices)} columns={[]} rows={[]}>
              <Box height="400px">
                <ResponsivePie
                  data={slices}
                  margin={{ top: 40, right: 40, bottom: 40, left: 40 }}
                  innerRadius={0.5}
                  padAngle={0.7}
                  cornerRadius={3}
                  activeOuterRadiusOffset={8}
                  colors={{ datum: 'data.color' }}
                  borderWidth={2}
                  borderColor={{
                    from: 'color',
                    modifiers: [['darker', 0.2]]
                  }}
                  arcLinkLabelsSkipAngle={10}
                  arcLinkLabelsTextColor={chart.text}
                  arcLinkLabelsThickness={2}
                  arcLinkLabelsColor={{ from: 'color' }}
                  arcLabelsSkipAngle={10}
                  arcLabelsTextColor={(d) => chart.textOn(d.color)}
                  valueFormat={(value) => formatMoney(value)}
                  enableArcLinkLabels={true}
                  arcLinkLabelsTextOffset={6}
                  arcLinkLabelsDiagonalLength={16}
                  arcLinkLabelsStraightLength={24}
                  theme={chart.nivo}
                />
              </Box>
            </ChartFigure>
          </Box>
          {sliceLegend(slices)}
        </Flex>
      ) : (
        <Flex direction="column" align="center" justify="center" minHeight="300px">
          <Text size="2" color="gray">No accounts associated</Text>
        </Flex>
      )}
    </Card>
  );

  /** One figure in the details card: its icon and name, and the figure. */
  const detail = (icon: React.ReactNode, label: string, value: React.ReactNode, size: '3' | '5' = '5') => (
    <Box>
      <Flex align="center" gap="2" mb="1">
        {icon}
        <Text size="2" color="gray">{label}</Text>
      </Flex>
      <Text as="div" size={size} weight={size === '5' ? 'bold' : 'medium'}>
        {value}
      </Text>
    </Box>
  );

  return (
    <PageContainer>
      {/* Header */}
      <Flex align="center" justify="between" gap="4" wrap="wrap" mb="6">
        <Flex align="center" gap="3">
          <IconButton
            onClick={() => navigate('/goals')}
            variant="soft"
            aria-label="Back to goals"
          >
            <ArrowLeft size={20} />
          </IconButton>
          <Flex align="center" justify="center" width="40px" height="40px" flexShrink="0" className="bg-[var(--purple-3)] rounded-[var(--radius-5)]">
            <Target size={20} className="text-[var(--purple-11)]" />
          </Flex>
          <Flex direction="column">
            <Heading as="h1" size="7">{goal.name}</Heading>
            <Text size="2" color="gray">Goal Analysis</Text>
          </Flex>
        </Flex>
        <Button
          onClick={() => navigate(`/goals/${uuid}/edit`)}
        >
          <Edit size={16} />
          Edit Goal
        </Button>
      </Flex>

      {/* Time Period Selector */}
      <Card size="2" mb="5">
        <Flex justify="between" align="center" wrap="wrap" gap="4">
          <Text size="3" weight="medium">Time Period</Text>
          <Flex gap="2" wrap="wrap">
            {PERIOD_OPTIONS.map(option => (
              <Button
                key={option.value}
                variant={selectedPeriod === option.value ? 'solid' : 'soft'}
                onClick={() => setSelectedPeriod(option.value)}
                disabled={chartsLoading}
              >
                {option.label}
              </Button>
            ))}
          </Flex>
        </Flex>
      </Card>

      <Grid columns={{ initial: '1', lg: '3' }} gap="5">
        {/* Main Content - Left 2 columns */}
        <Flex direction="column" gap="5" gridColumn={{ lg: 'span 2' }} minWidth="0">
          {/* Balance Over Time Chart */}
          <Card size="3">
            <Heading as="h2" size="5" mb="5">Balance Over Time</Heading>

            <ChartFigure
              title="Balance over time"
              summary={balanceSummary}
              columns={['Date', 'Balance']}
              rows={balanceHistory.map((point) => [point.x, formatMoney(point.y)])}
            >
              <Box position="relative" height="350px">
                {loadingVeil}
                <ResponsiveLine
                  data={balanceChartData}
                  margin={{ top: 20, right: 30, bottom: 80, left: 70 }}
                  xScale={{ type: 'point' }}
                  yScale={yScale(balanceAxis)}
                  yFormat={(value) => formatMoney(Number(value))}
                  axisTop={null}
                  axisRight={null}
                  axisBottom={{
                    tickSize: 5,
                    tickPadding: 5,
                    tickRotation: -45,
                    legend: '',
                    legendOffset: 36,
                    legendPosition: 'middle'
                  }}
                  axisLeft={axisLeft(balanceAxis)}
                  gridYValues={balanceAxis.tickValues}
                  enableGridX={false}
                  colors={[chart.accent]}
                  lineWidth={3}
                  pointSize={8}
                  pointColor={{ theme: 'background' }}
                  pointBorderWidth={2}
                  pointBorderColor={{ from: 'serieColor' }}
                  pointLabelYOffset={-12}
                  useMesh={true}
                  theme={chart.nivo}
                />
              </Box>
            </ChartFigure>
          </Card>

          {/* Per-Account Balance Over Time Chart */}
          {accountBalanceData.length > 0 && (
            <Card size="3">
              <Heading as="h2" size="5" mb="2">Balance by Account</Heading>
              <Text as="p" size="2" color="gray" mb="5">
                Balance over time for each account associated with this goal
              </Text>

              <ChartFigure
                title="Balance by account"
                summary={accountsSummary}
                columns={['Account', 'Date', 'Balance']}
                rows={accountBalanceData.flatMap((series) =>
                  series.data.map((point) => [String(series.id), point.x, formatMoney(point.y)]),
                )}
              >
                <Box position="relative" height="400px">
                  {loadingVeil}
                  <ResponsiveLine
                    data={accountBalanceData}
                    margin={{ top: 20, right: 140, bottom: 80, left: 70 }}
                    xScale={{ type: 'point' }}
                    yScale={yScale(accountsAxis)}
                    yFormat={(value) => formatMoney(Number(value))}
                    curve="monotoneX"
                    axisTop={null}
                    axisRight={null}
                    axisBottom={{
                      tickSize: 5,
                      tickPadding: 5,
                      tickRotation: -45,
                      legend: '',
                      legendOffset: 36,
                      legendPosition: 'middle'
                    }}
                    axisLeft={axisLeft(accountsAxis)}
                    gridYValues={accountsAxis.tickValues}
                    enableGridX={false}
                    colors={COLORS}
                    lineWidth={3}
                    pointSize={6}
                    pointColor={{ theme: 'background' }}
                    pointBorderWidth={2}
                    pointBorderColor={{ from: 'serieColor' }}
                    pointLabelYOffset={-12}
                    useMesh={true}
                    legends={[
                      {
                        anchor: 'bottom-right',
                        direction: 'column',
                        justify: false,
                        translateX: 130,
                        translateY: 0,
                        itemsSpacing: 2,
                        itemDirection: 'left-to-right',
                        itemWidth: 120,
                        itemHeight: 20,
                        itemOpacity: 0.85,
                        symbolSize: 12,
                        symbolShape: 'circle',
                        effects: [
                          {
                            on: 'hover',
                            style: {
                              itemBackground: 'rgba(0, 0, 0, .03)',
                              itemOpacity: 1
                            }
                          }
                        ]
                      }
                    ]}
                    theme={chart.nivo}
                    tooltip={({ point }) => {
                      // @ts-expect-error - Nivo types are incorrect for serieId
                      const seriesName = point.serieId || '';
                      return (
                        <Box p="3" className="rounded-[var(--radius-4)] bg-[var(--color-panel-solid)] border border-[var(--gray-6)] text-[var(--gray-12)]">
                          <strong>{seriesName}</strong>
                          <br />
                          <span className="text-[var(--gray-11)]">Date: {point.data.xFormatted}</span>
                          <br />
                          <span>{formatMoney(Number(point.data.y))}</span>
                        </Box>
                      );
                    }}
                  />
                </Box>
              </ChartFigure>
            </Card>
          )}

          {breakdown('By Account', accountBreakdown)}
          {breakdown('By Account Subtype', accountSubtypeBreakdown)}
        </Flex>

        {/* Sidebar - Right column */}
        <Flex direction="column" gap="5" minWidth="0">
          {/* Goal Details Card */}
          <Card size="3">
            <Heading as="h2" size="4" mb="4">Goal Details</Heading>

            <Flex direction="column" gap="4">
              {/* Progress */}
              <Box>
                <Flex align="center" justify="between" mb="2">
                  <Text size="2" color="gray">Progress</Text>
                  <Text size="2" weight="bold">
                    {progress == null ? 'No target' : `${progress.toFixed(1)}%`}
                  </Text>
                </Flex>
                <Box width="100%" height="8px" className="bg-[var(--gray-3)] rounded-full">
                  {progress != null && (
                    <Box
                      height="8px"
                      className="bg-[var(--purple-9)] rounded-full transition-all duration-300"
                      style={{ width: `${Math.min(progress, 100)}%` }}
                    />
                  )}
                </Box>
              </Box>

              {detail(<DollarSign size={16} className="text-[var(--gray-11)]" />, 'Current Amount', formatMoney(currentAmount))}
              {detail(<Target size={16} className="text-[var(--gray-11)]" />, 'Target Amount', targetAmount == null ? 'None' : formatMoney(targetAmount))}
              {detail(<TrendingUp size={16} className="text-[var(--gray-11)]" />, 'Remaining', remainingAmount == null ? 'None' : formatMoney(remainingAmount))}
              {detail(<Calendar size={16} className="text-[var(--gray-11)]" />, 'Target Date', goal.target_date == null ? 'None' : formatDate(goal.target_date), '3')}

              {/* Monthly Contribution */}
              {goal.estimated_monthly_contribution && goal.estimated_monthly_contribution > 0 && (
                detail(<Wallet size={16} className="text-[var(--gray-11)]" />, 'Monthly Contribution', formatMoney(goal.estimated_monthly_contribution), '3')
              )}

              {/* Status Badge */}
              <Box>
                <Text as="p" size="2" color="gray" mb="2">Status</Text>
                <Badge highContrast
                  color={
                    goal.status === budgetItemStatus.enum.completed ? 'green' :
                    goal.status === budgetItemStatus.enum.active ? 'blue' :
                    goal.status === budgetItemStatus.enum.paused ? 'orange' : 'gray'
                  }
                  size="2"
                >
                  {goal.status.charAt(0).toUpperCase() + goal.status.slice(1)}
                </Badge>
              </Box>
            </Flex>
          </Card>

          {/* Description Card */}
          {goal.description && (
            <Card size="3">
              <Heading as="h2" size="4" mb="3">Description</Heading>
              <Text as="p" size="2" color="gray" style={{ whiteSpace: 'pre-wrap' }}>
                {goal.description}
              </Text>
            </Card>
          )}

          {/* Associated Accounts */}
          {goal.associated_accounts && goal.associated_accounts.length > 0 && (
            <Card size="3">
              <Heading as="h2" size="4" mb="3">
                Associated Accounts ({goal.associated_accounts.length})
              </Heading>
              <Flex direction="column" gap="2">
                {goal.associated_accounts.map((account) => (
                  <Flex key={account.uuid} align="center" justify="between" gap="2" p="2" className="bg-[var(--gray-2)] rounded-[var(--radius-2)]">
                    <Text size="2">{account.name}</Text>
                    <Text size="2" weight="medium" color="gray">
                      {account.calculated_balance == null ? 'Unavailable' : formatMoney(account.calculated_balance)}
                    </Text>
                  </Flex>
                ))}
              </Flex>
            </Card>
          )}
        </Flex>
      </Grid>
    </PageContainer>
  );
};

export default GoalAnalysisPage;
