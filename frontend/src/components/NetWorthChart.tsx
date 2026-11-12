import React, { useMemo } from 'react';
import { ResponsiveLine } from '@nivo/line';
import { Box, Button, Flex, Text } from '@radix-ui/themes';
import { useCurrentNetWorthQuery, useNetWorthHistoryQuery } from '../hooks/queries';
import NuggetSpinner from './NuggetSpinner';
import { useChartTheme } from '../hooks/useChartTheme';
import ChartFigure from './ChartFigure';
import { parseCalendarDate } from '../utils/dateUtils';
import { formatMoney } from '@nuggets/shared';

interface NetWorthDataPoint {
  x: string;
  y: number;
}

interface NetWorthHistoryPoint {
  snapshot_date: string;
  net_worth: string | number;
}

type NetWorthPeriod = 'day' | 'week' | 'month' | 'year';

interface NetWorthChartProps {
  height?: number;
  period?: NetWorthPeriod;
  limit?: number;
}

// A line needs two points: with none nivo renders <path d="null"> (a console
// error per path), with one a zero-length line.
const MIN_CHART_POINTS = 2;

const PERIOD_PLURALS: Record<NetWorthPeriod, string> = {
  day: 'days',
  week: 'weeks',
  month: 'months',
  year: 'years',
};

const NetWorthChart: React.FC<NetWorthChartProps> = ({
  height = 400,
  period = 'month',
  limit = 90
}) => {
  const chart = useChartTheme();

  // Inline error UI below handles failures, so suppress the global error toast.
  const currentQuery = useCurrentNetWorthQuery({ meta: { suppressErrorToast: true } });
  const historyQuery = useNetWorthHistoryQuery(period, limit, true, { meta: { suppressErrorToast: true } });

  const loading = currentQuery.isLoading || historyQuery.isLoading;
  const error = currentQuery.isError || historyQuery.isError ? 'Failed to load net worth data' : null;

  const currentNetWorth = useMemo(() => {
    const netWorthValue = currentQuery.data?.current_net_worth?.net_worth ?? 0;
    return typeof netWorthValue === 'string' ? parseFloat(netWorthValue) : netWorthValue;
  }, [currentQuery.data]);

  const data = useMemo<NetWorthDataPoint[]>(() => {
    const history = historyQuery.data?.history;
    if (history && Array.isArray(history)) {
      return history
        .map((point: NetWorthHistoryPoint) => {
          // snapshot_date is a calendar day: local midnight, not midnight UTC.
          const date = parseCalendarDate(point.snapshot_date);
          let dateLabel: string;

          // Format date labels based on period
          switch (period) {
                case 'day':
                  if (limit <= 30) {
                    // For 1 month: show "Jan 15"
                    dateLabel = date.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric'
                    });
                  } else {
                    // For 3 months: show "Jan 15" or "1/15" for space
                    dateLabel = date.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric'
                    });
                  }
                  break;
                case 'week':
                  // For weekly view: show week-specific format
                  if (limit <= 15) {
                    // For 3 months of weekly data: show "Week of Jan 15" or "Jan 15"
                    dateLabel = date.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric'
                    });
                  } else {
                    // For longer weekly periods: show "Jan 2024"
                    dateLabel = date.toLocaleDateString('en-US', {
                      month: 'short',
                      year: 'numeric'
                    });
                  }
                  break;
                case 'month':
                  // For monthly view (past year and all-time): show appropriate format
                  if (limit <= 12) {
                    // For past year (12 months): show "Jan 2024"
                    dateLabel = date.toLocaleDateString('en-US', {
                      month: 'short',
                      year: 'numeric'
                    });
                  } else {
                    // For all-time view: show "Jan 2024"
                    dateLabel = date.toLocaleDateString('en-US', {
                      month: 'short',
                      year: 'numeric'
                    });
                  }
                  break;
                case 'year':
                  // For very long periods: show "2024"
                  dateLabel = date.getFullYear().toString();
                  break;
                default:
                  dateLabel = date.toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric'
                  });
              }
              
          return {
            x: dateLabel,
            y: typeof point.net_worth === 'number' ? point.net_worth : (parseFloat(point.net_worth) || 0),
          };
        })
        .reverse(); // Reverse to show chronological order
    }
    return [];
  }, [historyQuery.data, period, limit]);


  // Calculate trend
  const trend = data.length >= 2 ? 
    ((data[data.length - 1]?.y || 0) - (data[0]?.y || 0)) / Math.abs(data[0]?.y || 1) * 100 : 0;

  // Get period label for trend display
  const getTrendPeriodLabel = (): string => {
    if (limit <= 12 && period === 'month') return 'past year';
    if (limit <= 30) return 'past month';
    if (limit <= 90) return 'past 3 months';
    if (limit <= 365) return 'past year';
    return 'all time';
  };

  if (loading) {
    return (
      <Flex align="center" justify="center" style={{ height }}>
        <NuggetSpinner size={32} />
        <Box as="span" display="inline" ml="3" className="text-[var(--gray-11)]">Loading net worth data...</Box>
      </Flex>
    );
  }

  if (error) {
    return (
      <Flex align="center" justify="center" style={{ height }}>
        <Box className="text-center">
          <Box mb="2" className="text-[var(--red-11)]">⚠️ {error}</Box>
          <Button
            variant="ghost"
            size="2"
            onClick={() => {
              void currentQuery.refetch();
              void historyQuery.refetch();
            }}
          >
            Try again
          </Button>
        </Box>
      </Flex>
    );
  }

  // Header with current net worth
  const header = (
    <Box mb="5" className="text-center">
      <Box mb="2" className="text-4xl font-bold text-[var(--gray-12)]">
        {formatMoney(currentNetWorth, { wholeUnits: true })}
      </Box>
      <Flex align="center" justify="center" className="space-x-2">
        <span className="text-[var(--gray-11)]">Net Worth</span>
        {trend !== 0 && (
          <>
            <span className="text-[var(--gray-11)]">•</span>
            <span className={`text-sm font-medium ${trend > 0 ? 'text-[var(--green-12)]' : 'text-[var(--red-11)]'}`}>
              {trend > 0 ? '+' : ''}{trend.toFixed(1)}% {getTrendPeriodLabel()}
            </span>
          </>
        )}
      </Flex>
    </Box>
  );

  const first = data[0];
  const last = data[data.length - 1];
  if (data.length < MIN_CHART_POINTS || !first || !last) {
    return (
      <Box width="100%">
        {header}
        <Flex direction="column" align="center" justify="center" gap="2" p="6" height={`${height}px`}>
          <Text color="gray" align="center">Not enough history to chart yet.</Text>
          <Text size="1" color="gray" align="center">
            This view needs net worth from at least two different {PERIOD_PLURALS[period]}. Net worth
            is recorded each day your balances change.
          </Text>
        </Flex>
      </Box>
    );
  }

  return (
    <Box width="100%">
      {header}

      <ChartFigure
        title="Net worth over time"
        summary={`${formatMoney(first.y, { wholeUnits: true })} on ${first.x}, ${formatMoney(last.y, { wholeUnits: true })} on ${last.x}; ${data.length} points.`}
        columns={['Date', 'Net worth']}
        rows={data.map((point) => [point.x, formatMoney(point.y, { wholeUnits: true })])}
      >
      <div style={{ height }}>
        <ResponsiveLine
          data={[{
            id: 'net-worth',
            data: data,
          }]}
          margin={{ top: 20, right: 40, bottom: 60, left: 80 }}
          xScale={{ type: 'point' }}
          yScale={{
            type: 'linear',
            min: 'auto',
            max: 'auto',
            stacked: false,
            reverse: false
          }}
          curve="cardinal"
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
          axisLeft={{
            tickSize: 5,
            tickPadding: 5,
            tickRotation: 0,
            legend: '',
            legendOffset: -60,
            legendPosition: 'middle',
            format: (value: unknown) => {
              const numericValue = typeof value === 'number' ? value : Number(value);
              return formatMoney(Number.isFinite(numericValue) ? numericValue : 0, { wholeUnits: true });
            }
          }}
          pointSize={6}
          pointColor={chart.panel}
          pointBorderWidth={3}
          pointBorderColor={chart.accent}
          pointLabelYOffset={-12}
          enableArea={true}
          areaOpacity={0.1}
          useMesh={true}
          colors={[chart.accent]}
          lineWidth={3}
          enableGridX={false}
          enableGridY={true}
          gridYValues={5}
          theme={chart.nivo}
          tooltip={({ point }: { point: { data: { x: string; y: number | string } } }) => (
            <Box px="3" py="2" className="bg-[var(--color-panel-solid)] rounded-[var(--radius-4)] shadow-lg border border-[var(--gray-6)]">
              <Box className="text-sm font-medium text-[var(--gray-12)]">
                {formatMoney(typeof point.data.y === 'number' ? point.data.y : Number(point.data.y), { wholeUnits: true })}
              </Box>
              <Box className="text-xs text-[var(--gray-11)]">
                {point.data.x}
              </Box>
            </Box>
          )}
          // Add gradient fill
          defs={[
            {
              id: 'gradientA',
              type: 'linearGradient',
              colors: [
                { offset: 0, color: chart.accent, opacity: 0.3 },
                { offset: 100, color: chart.accent, opacity: 0.05 },
              ],
            },
          ]}
          fill={[{ match: '*', id: 'gradientA' }]}
        />
      </div>
      </ChartFigure>
    </Box>
  );
};

export default NetWorthChart;
