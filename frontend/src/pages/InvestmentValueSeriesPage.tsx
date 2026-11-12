import React from 'react';
import { Box, Flex, Card, Text, Callout } from '@radix-ui/themes';
import { ResponsiveLine } from '@nivo/line';
import ChartFigure from '../components/ChartFigure';
import { useChartTheme } from '../hooks/useChartTheme';
import { LineChart, Info } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import { useValueSeriesQuery } from '../hooks/queries/investments';
import PageContainer from '../components/PageContainer';
import { formatMoney } from '@nuggets/shared';


/**
 * Equity curve — the daily mark-to-market portfolio value series. Snapshots are
 * produced by the scheduled/manual price sync, so the curve is forward-only (it
 * grows from when sync was first enabled).
 */
const InvestmentValueSeriesPage: React.FC = () => {
  const { data, isLoading } = useValueSeriesQuery();
  const points = data?.series ?? [];
  // The first and last points, for the summary; both are missing when there are none.
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const chart = useChartTheme();

  const series = points.length
    ? [
        {
          id: 'Portfolio value',
          color: chart.accent,
          data: points.map((p) => ({ x: p.snapshot_date, y: p.total_value })),
        },
        {
          id: 'Cost basis',
          color: chart.axis,
          data: points.map((p) => ({ x: p.snapshot_date, y: p.cost_basis ?? 0 })),
        },
      ]
    : [];

  const staleDays = points.filter((p) => p.stale_securities > 0).length;

  return (
    <PageContainer>
      <PageHeader title="Value over time" subtitle="Daily mark-to-market portfolio value" icon={<LineChart />} backPath="/investments" />
      {isLoading ? (
        <PageLoader label="Loading value history…" />
      ) : !firstPoint || !lastPoint ? (
        <Card>
          <Flex direction="column" align="center" gap="2" p="6">
            <Text color="gray">No value history yet.</Text>
            <Text size="1" color="gray">
              Enable scheduled price sync (Organization settings) — a portfolio value snapshot is recorded each day, and the
              curve builds from there. You can also trigger a run manually to capture today.
            </Text>
          </Flex>
        </Card>
      ) : (
        <Flex direction="column" gap="3">
          {staleDays > 0 && (
            <Callout.Root highContrast color="amber" variant="soft">
              <Callout.Icon><Info size={16} /></Callout.Icon>
              <Callout.Text>
                {staleDays} day(s) include positions valued on a carried-forward (stale) close — e.g. non-trading days or
                missing prices. Those points are estimates.
              </Callout.Text>
            </Callout.Root>
          )}
          <Card>
            <ChartFigure
              title="Portfolio value over time"
              summary={`${formatMoney(firstPoint.total_value)} on ${firstPoint.snapshot_date}, ${formatMoney(lastPoint.total_value)} on ${lastPoint.snapshot_date}; ${points.length} days.`}
              columns={['Date', 'Value', 'Cost basis']}
              rows={points.map((p) => [p.snapshot_date, formatMoney(p.total_value), p.cost_basis == null ? '—' : formatMoney(p.cost_basis)])}
            >
            <Box height="420px" p="2">
              <ResponsiveLine
                data={series}
                margin={{ top: 16, right: 24, bottom: 56, left: 72 }}
                xScale={{ type: 'point' }}
                yScale={{ type: 'linear', min: 'auto', max: 'auto' }}
                colors={{ datum: 'color' }}
                axisBottom={{ tickRotation: -40 }}
                axisLeft={{ format: (v) => formatMoney(Number(v)) }}
                pointSize={4}
                enableGridX={false}
                enablePoints={points.length <= 60}
                useMesh
                theme={chart.nivo}
                legends={[{ anchor: 'top-left', direction: 'row', translateY: -8, itemWidth: 110, itemHeight: 16, symbolSize: 10, itemTextColor: chart.text }]}
              />
            </Box>
            </ChartFigure>
          </Card>
        </Flex>
      )}
    </PageContainer>
  );
};

export default InvestmentValueSeriesPage;
