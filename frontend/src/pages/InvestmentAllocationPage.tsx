import React, { useState } from 'react';
import { Box, Flex, Card, Text, Table, Select } from '@radix-ui/themes';
import { ResponsivePie } from '@nivo/pie';
import ChartFigure from '../components/ChartFigure';
import { useChartTheme } from '../hooks/useChartTheme';
import { PieChart } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import { useLookthroughQuery } from '../hooks/queries/investments';
import PageContainer from '../components/PageContainer';
import { formatMoney } from '@nuggets/shared';

const DIMENSIONS = ['asset_class', 'sector', 'region', 'country', 'market_cap', 'style', 'credit_quality', 'rate_sensitivity'];

const InvestmentAllocationPage: React.FC = () => {
  const [dimension, setDimension] = useState('asset_class');
  const { data, isLoading } = useLookthroughQuery(dimension);
  // Slice colours from the theme, resolved, so nivo can derive the labels' colours.
  const chart = useChartTheme();

  const pieData = (data?.buckets ?? []).map((b, i) => ({ id: b.dimensionValue, label: b.dimensionValue, value: b.amount, color: chart.series[i % chart.series.length] }));
  const largest = [...pieData].sort((a, b) => b.value - a.value)[0];

  return (
    <PageContainer>
      <PageHeader
        title="Look-through allocation"
        subtitle="Where your money actually is — direct holdings plus fund pass-through"
        icon={<PieChart />}
        backPath="/investments"
        actions={
          <Select.Root value={dimension} onValueChange={setDimension}>
            <Select.Trigger aria-label="Dimension" />
            <Select.Content>{DIMENSIONS.map((d) => <Select.Item key={d} value={d}>{d.replace('_', ' ')}</Select.Item>)}</Select.Content>
          </Select.Root>
        }
      />
      {isLoading ? (
        <PageLoader label="Computing allocation…" />
      ) : !data || data.buckets.length === 0 ? (
        <Card><Flex p="6" justify="center"><Text color="gray">No allocation data for this dimension yet.</Text></Flex></Card>
      ) : (
        <Flex direction="column" gap="3">
          {data.unknownValue > 0 && (
            <Card><Text size="2" color="amber" highContrast>{formatMoney(data.unknownValue)} is in funds without composition data — refresh it via your AI agent (MCP) to resolve this.</Text></Card>
          )}
          <Card>
            <ChartFigure
              title={`Allocation by ${dimension.replace('_', ' ')}`}
              summary={largest ? `${pieData.length} parts; the largest, ${largest.label}, ${formatMoney(largest.value)}. Each is in the table below.` : ''}
              columns={[]}
              rows={[]}
            >
            <Box height="320px" p="2">
              <ResponsivePie
                data={pieData}
                margin={{ top: 16, right: 16, bottom: 16, left: 16 }}
                innerRadius={0.6}
                padAngle={0.6}
                cornerRadius={2}
                colors={{ datum: 'data.color' }}
                borderWidth={0}
                arcLinkLabelsColor={chart.text}
                arcLinkLabelsTextColor={chart.text}
                arcLabelsTextColor={(d) => chart.textOn(d.color)}
                valueFormat={(v) => formatMoney(Number(v))}
                theme={chart.nivo}
              />
            </Box>
            </ChartFigure>
          </Card>
          <Card>
            <Table.Root variant="surface">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>{dimension.replace('_', ' ')}</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell align="right">Value</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell align="right">% of portfolio</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.buckets.map((b) => (
                  <Table.Row key={b.dimensionValue}>
                    <Table.Cell>{b.dimensionValue}</Table.Cell>
                    <Table.Cell align="right">{formatMoney(b.amount)}</Table.Cell>
                    <Table.Cell align="right">{b.percentage.toFixed(1)}%</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Card>
        </Flex>
      )}
    </PageContainer>
  );
};

export default InvestmentAllocationPage;
