import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { rowClick } from '../components/StretchedLink';
import { Box, Flex, Grid, Card, Heading, Text, Table, Button, Badge } from '@radix-ui/themes';
import { ResponsivePie } from '@nivo/pie';
import ChartFigure from '../components/ChartFigure';
import { useChartTheme } from '../hooks/useChartTheme';
import { TrendingUp, Plus, Layers, PieChart, Receipt, FileText, Activity, RefreshCw, Calculator, LineChart, Scale, Download, Crosshair } from 'lucide-react';
import toast from 'react-hot-toast';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import { useHoldingsQuery, useLookthroughQuery, useDataFreshnessQuery } from '../hooks/queries/investments';
import { downloadCsv } from '../services/api/investments';
import { textColorProps } from '../utils/textColor';
import { logger } from '../utils/logger';
import PageContainer from '../components/PageContainer';
import { formatMoney } from '@nuggets/shared';
import { centsOf, centsToAmount } from '../utils/currency';

/** A gain green, a loss red, by its cents: -0.004 is $0.00, in gray. */
const glColor = (n: number | null | undefined): 'gray' | 'green' | 'red' => {
  const cents = centsOf(n);
  return cents === 0 ? 'gray' : cents > 0 ? 'green' : 'red';
};

/** A total in whole cents: each amount as it shows, to the cent, then added. */
const sumMoney = (amounts: Array<number | null | undefined>): number =>
  centsToAmount(amounts.reduce<number>((sum, amount) => sum + centsOf(amount), 0));


const InvestmentsPage: React.FC = () => {
  const navigate = useNavigate();
  // Slice colours from the theme, resolved, so nivo can derive the labels' colours.
  const chart = useChartTheme();
  const { data: holdings = [], isLoading } = useHoldingsQuery();
  const { data: allocation } = useLookthroughQuery('asset_class');
  const { data: freshness } = useDataFreshnessQuery();

  const totalValue = sumMoney(holdings.map((h) => h.market_value));
  const totalCost = sumMoney(holdings.map((h) => h.total_cost_basis));
  const totalUnrealized = sumMoney(holdings.map((h) => h.unrealized_gain_loss));

  const pieData = (allocation?.buckets ?? []).map((b, i) => ({
    id: b.dimensionValue,
    label: b.dimensionValue,
    value: b.amount,
    color: chart.series[i % chart.series.length],
  }));

  const allocationTotal = sumMoney(pieData.map((slice) => slice.value));
  const largestSlice = [...pieData].sort((a, b) => b.value - a.value)[0];
  const allocationSummary = largestSlice
    ? `${formatMoney(allocationTotal)} in ${pieData.length} asset ${pieData.length === 1 ? 'class' : 'classes'}; the largest, ${largestSlice.label}, ${formatMoney(largestSlice.value)}.`
    : '';

  const staleCount =
    (freshness?.summary.stale_price_count ?? 0) +
    (freshness?.summary.stale_composition_count ?? 0) +
    (freshness?.summary.missing_expense_ratio_count ?? 0);

  return (
    <PageContainer>
      <PageHeader
        title="Investments"
        subtitle="Portfolio overview"
        icon={<TrendingUp />}
        actions={
          <Flex gap="2" wrap="wrap">
            <Button variant="soft" color="gray" onClick={async () => { try { await downloadCsv('/investments/export/holdings.csv', 'holdings.csv'); } catch (err) { logger.error({ err }, 'CSV export failed'); toast.error('Export failed'); } }}><Download size={16} /> Export</Button>
            <Button variant="soft" onClick={() => navigate('/investments/securities')}><Layers size={16} /> Securities</Button>
            <Button onClick={() => navigate('/investments/buy')}><Plus size={16} /> Record buy</Button>
          </Flex>
        }
      />

      {isLoading ? (
        <PageLoader label="Loading portfolio…" />
      ) : (
        <Flex direction="column" gap="4">
          {/* Summary cards */}
          <Grid columns={{ initial: '2', md: '4' }} gap="3">
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Market value</Text><Heading size="6">{formatMoney(totalValue)}</Heading></Flex></Card>
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Cost basis</Text><Heading size="6">{formatMoney(totalCost)}</Heading></Flex></Card>
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Unrealized G/L</Text><Heading size="6" {...textColorProps(glColor(totalUnrealized))}>{formatMoney(totalUnrealized)}</Heading></Flex></Card>
            <Card>
              <Flex direction="column" gap="1" p="2">
                <Text size="1" color="gray">Data freshness</Text>
                {staleCount === 0
                  ? <Heading size="6" color="green" highContrast>Up to date</Heading>
                  : <Flex align="center" gap="2"><Heading size="6" color="amber" highContrast>{staleCount}</Heading><Text size="1" color="gray">need refresh</Text></Flex>}
              </Flex>
            </Card>
          </Grid>

          {/* Allocation + quick links */}
          <Grid columns={{ initial: '1', md: '2' }} gap="3">
            <Card>
              <Flex direction="column" gap="2" p="2">
                <Heading size="3">Asset allocation (look-through)</Heading>
                {pieData.length === 0 ? (
                  <Text size="2" color="gray">No allocation data yet.</Text>
                ) : (
                  <ChartFigure
                    title="Asset allocation"
                    summary={allocationSummary}
                    columns={['Asset class', 'Value']}
                    rows={pieData.map((slice) => [slice.label, formatMoney(slice.value)])}
                  >
                  <Box height="260px">
                    <ResponsivePie
                      data={pieData}
                      margin={{ top: 12, right: 12, bottom: 12, left: 12 }}
                      innerRadius={0.6}
                      padAngle={0.6}
                      cornerRadius={2}
                      colors={{ datum: 'data.color' }}
                      borderWidth={0}
                      enableArcLinkLabels={false}
                      arcLabelsSkipAngle={12}
                      valueFormat={(v) => formatMoney(Number(v))}
                      arcLabelsTextColor={(d) => chart.textOn(d.color)}
                      theme={chart.nivo}
                    />
                  </Box>
                  </ChartFigure>
                )}
                <Button variant="ghost" onClick={() => navigate('/investments/allocation')}><PieChart size={16} /> Full allocation report</Button>
              </Flex>
            </Card>

            <Card>
              <Flex direction="column" gap="3" p="2">
                <Heading size="3">Reports</Heading>
                <Button variant="soft" onClick={() => navigate('/investments/performance')}><LineChart size={16} /> Performance (TWR / IRR)</Button>
                <Button variant="soft" onClick={() => navigate('/investments/value-series')}><LineChart size={16} /> Value over time</Button>
                <Button variant="soft" onClick={() => navigate('/investments/allocation')}><PieChart size={16} /> Look-through allocation</Button>
                <Button variant="soft" onClick={() => navigate('/investments/exposure')}><Crosshair size={16} /> Stock exposure (look-through)</Button>
                <Button variant="soft" onClick={() => navigate('/investments/costs')}><Receipt size={16} /> Cost of ownership</Button>
                <Button variant="soft" onClick={() => navigate('/investments/tax')}><FileText size={16} /> Realized gains &amp; wash sales</Button>
                <Button variant="soft" onClick={() => navigate('/investments/planning')}><Calculator size={16} /> Tax planning</Button>
                <Button variant="soft" onClick={() => navigate('/investments/activity')}><Activity size={16} /> All transactions</Button>
                <Button variant="soft" onClick={() => navigate('/investments/reconciliation')}><Scale size={16} /> Reconciliation</Button>
                <Button variant="soft" onClick={() => navigate('/investments/freshness')}><RefreshCw size={16} /> Data freshness</Button>
                <Flex gap="2" wrap="wrap" mt="2">
                  <Button size="1" variant="outline" onClick={() => navigate('/investments/sell')}>Record sell</Button>
                  <Button size="1" variant="outline" onClick={() => navigate('/investments/dividend')}>Record dividend</Button>
                  <Button size="1" variant="outline" onClick={() => navigate('/investments/fee')}>Record fee</Button>
                  <Button size="1" variant="outline" onClick={() => navigate('/investments/corporate-action')}>Corporate action</Button>
                  <Button size="1" variant="outline" onClick={() => navigate('/investments/settings')}>Cost-basis settings</Button>
                </Flex>
              </Flex>
            </Card>
          </Grid>

          {/* Holdings */}
          {holdings.length === 0 ? (
            <Card><Flex direction="column" align="center" gap="2" p="6"><Text color="gray">No holdings yet.</Text><Button onClick={() => navigate('/investments/buy')}>Record your first buy</Button></Flex></Card>
          ) : (
            <Card>
              <Table.Root variant="surface">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell>Security</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Shares</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Avg cost</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Price</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Market value</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Unrealized G/L</Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {holdings.map((h) => (
                    <Table.Row key={`${h.account_id}-${h.security_uuid}`} onClick={rowClick(() => navigate(`/investments/positions/${h.security_uuid}`))} style={{ cursor: 'pointer' }}>
                      <Table.Cell>
                        <Flex direction="column">
                          <Flex align="center" gap="2">
                            <Text weight="medium" asChild>
                              <Link to={`/investments/positions/${h.security_uuid}`} className="hover:underline">{h.ticker}</Link>
                            </Text>
                          </Flex>
                          <Text size="1" color="gray">{h.name}</Text>
                        </Flex>
                      </Table.Cell>
                      <Table.Cell align="right">{h.total_shares}</Table.Cell>
                      <Table.Cell align="right">{formatMoney(h.average_cost_per_share)}</Table.Cell>
                      <Table.Cell align="right">{formatMoney(h.latest_price)}</Table.Cell>
                      <Table.Cell align="right">{formatMoney(h.market_value)}</Table.Cell>
                      <Table.Cell align="right"><Text {...textColorProps(glColor(h.unrealized_gain_loss))}>{formatMoney(h.unrealized_gain_loss)}</Text></Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Card>
          )}
          <Box display={{ initial: 'none', sm: 'block' }}><Badge color="gray" variant="soft">Tip: bulk imports &amp; data refresh are handled by your AI agent via MCP</Badge></Box>
        </Flex>
      )}
    </PageContainer>
  );
};

export default InvestmentsPage;
