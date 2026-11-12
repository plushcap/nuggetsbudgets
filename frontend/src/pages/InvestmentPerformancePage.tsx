import React from 'react';
import { Box, Flex, Grid, Card, Heading, Text } from '@radix-ui/themes';
import { ResponsiveLine } from '@nivo/line';
import ChartFigure from '../components/ChartFigure';
import { useChartTheme } from '../hooks/useChartTheme';
import { LineChart } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import { textColorProps } from '../utils/textColor';
import { usePerformanceQuery } from '../hooks/queries/investments';
import PageContainer from '../components/PageContainer';
import { formatMoney } from '@nuggets/shared';

const pct = (n: number | null) => (n == null ? '—' : `${(n * 100).toFixed(2)}%`);
const pctColor = (n: number | null): 'gray' | 'green' | 'red' => (n == null || n === 0 ? 'gray' : n > 0 ? 'green' : 'red');

const InvestmentPerformancePage: React.FC = () => {
  const { data, isLoading } = usePerformanceQuery();
  const chart = useChartTheme();

  const series = data
    ? [
        {
          id: 'Net invested',
          color: chart.accent,
          data: [
            ...data.timeline.map((t) => ({ x: t.date, y: t.net_invested })),
            { x: data.end_date, y: data.net_invested },
          ],
        },
        {
          id: 'Current value',
          color: chart.positive,
          data: [{ x: data.timeline[0]?.date ?? data.start_date, y: data.net_invested }, { x: data.end_date, y: data.current_value }],
        },
      ]
    : [];

  return (
    <PageContainer>
      <PageHeader title="Performance" subtitle="Money-weighted (IRR) and time-weighted (TWR) returns" icon={<LineChart />} backPath="/investments" />
      {isLoading ? (
        <PageLoader label="Computing performance…" />
      ) : !data ? (
        <Card><Flex p="6" justify="center"><Text color="gray">No performance data.</Text></Flex></Card>
      ) : (
        <Flex direction="column" gap="3">
          <Grid columns={{ initial: '2', md: '5' }} gap="3">
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Current value</Text><Heading size="5">{formatMoney(data.current_value)}</Heading></Flex></Card>
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Net invested</Text><Heading size="5">{formatMoney(data.net_invested)}</Heading></Flex></Card>
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Total return</Text><Heading size="5" {...textColorProps(pctColor(data.total_return))}>{pct(data.total_return)}</Heading></Flex></Card>
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">IRR (money-wtd)</Text><Heading size="5" {...textColorProps(pctColor(data.irr))}>{pct(data.irr)}</Heading></Flex></Card>
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">TWR (time-wtd)</Text><Heading size="5" {...textColorProps(pctColor(data.twr))}>{pct(data.twr)}</Heading></Flex></Card>
          </Grid>

          <Card>
            <Flex direction="column" gap="2" p="2">
              <Heading size="3">Invested vs current value</Heading>
              {data.timeline.length === 0 ? (
                <Text size="2" color="gray">No contributions recorded yet.</Text>
              ) : (
                <ChartFigure
                  title="Invested vs current value"
                  summary={`${formatMoney(data.net_invested)} invested; worth ${formatMoney(data.current_value)} on ${data.end_date}.`}
                  columns={['Series', 'Date', 'Value']}
                  rows={series.flatMap((line) => line.data.map((point) => [line.id, point.x, formatMoney(point.y)]))}
                >
                <Box height="320px">
                  <ResponsiveLine
                    data={series}
                    margin={{ top: 16, right: 24, bottom: 48, left: 64 }}
                    xScale={{ type: 'point' }}
                    yScale={{ type: 'linear', min: 0, max: 'auto' }}
                    colors={{ datum: 'color' }}
                    axisBottom={{ tickRotation: -40 }}
                    axisLeft={{ format: (v) => formatMoney(Number(v)) }}
                    pointSize={6}
                    enableGridX={false}
                    useMesh
                    theme={chart.nivo}
                    legends={[{ anchor: 'top-left', direction: 'row', translateY: -8, itemWidth: 110, itemHeight: 16, symbolSize: 10, itemTextColor: chart.text }]}
                  />
                </Box>
                </ChartFigure>
              )}
              <Text size="1" color="gray">{data.note}</Text>
            </Flex>
          </Card>
        </Flex>
      )}
    </PageContainer>
  );
};

export default InvestmentPerformancePage;
