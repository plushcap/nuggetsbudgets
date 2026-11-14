import React, { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Flex, Text, Heading, Button, IconButton, Box, Grid, Table, Callout, ScrollArea } from '@radix-ui/themes';
import { Edit, ArrowLeft } from 'lucide-react';
import { ResponsiveBar } from '@nivo/bar';
import { ResponsivePie } from '@nivo/pie';
import { useTagQuery, useTagSummaryQuery, useTagTransactionsQuery, useTagBreakdownQuery, useTagTimeseriesQuery } from '../hooks/queries';
import { getIconByName } from '../utils/iconCatalog';
import { centsOf, centsToAmount, formatCurrency } from '../utils/currency';
import NuggetSpinner from '../components/NuggetSpinner';
import PageLoader from '../components/PageLoader';
import { useChartTheme } from '../hooks/useChartTheme';
import ChartFigure from '../components/ChartFigure';
import RadixTransactionTable from '../components/RadixTransactionTable';
import SharedPagination from '../components/SharedPagination';
import { useOpenTransactionEdit } from '../hooks/useOpenTransactionEdit';
import {
  CHART_RANGE_OPTIONS,
  getChartRangeOption,
  getRangeStartDate,
  getBucketKey,
  getBucketAxisLegend,
} from '../utils/chartRanges';
import { parseCalendarDate, toCalendarDateString } from '../utils/dateUtils';
import PageContainer from '../components/PageContainer';
import { SMALLEST_TRANSACTION_PAGE_SIZE, TRANSACTION_PAGE_SIZES, useTransactionPageSize } from '../hooks/useTransactionPageSize';
import { formatMoney } from '@nuggets/shared';

interface TagSummary {
  tag_id: number;
  tag_name: string;
  tag_uuid: string;
  hierarchy_path: string;
  transaction_count: number;
  total_amount: number;
  income_amount: number;
  expense_amount: number;
}

interface MonthlyTotal {
  month: string;
  income: number;
  expenses: number;
  [key: string]: string | number; // Index signature for Nivo
}

// One slice of the sub-tag breakdown pie chart (see /:uuid/breakdown).
interface TagBreakdownSlice {
  id: number;
  uuid: string;
  name: string;
  color: string | null;
  icon: string | null;
  is_parent: boolean;
  value: number;
  net: number;
  count: number;
}

const ViewTagPage: React.FC = () => {
  const { tagUuid } = useParams<{ tagUuid: string }>();
  const navigate = useNavigate();
  const chart = useChartTheme();
  const openTransactionEdit = useOpenTransactionEdit();

  // Bar graph time range (default: the first option, 1 month / daily bars, for a fast initial
  // load; an unknown key such as '' resolves to it too, in getChartRangeOption)
  const [chartRangeKey, setChartRangeKey] = useState<string>(CHART_RANGE_OPTIONS[0]?.key ?? '');
  const chartRange = getChartRangeOption(chartRangeKey);
  const rangeStartDate = useMemo(() => toCalendarDateString(getRangeStartDate(chartRange)), [chartRange]);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [transactionsPerPage, setTransactionsPerPage] = useTransactionPageSize();

  // Tag detail + summary.
  const { data: tag = null, isLoading, isError } = useTagQuery(tagUuid);
  const { data: summaryData } = useTagSummaryQuery(tagUuid);
  const summary = (summaryData as unknown as TagSummary | undefined) ?? null;
  const error = isError ? 'Failed to load tag data' : null;

  // Range-scoped, server-aggregated received/spent series feeds the bar chart
  // (bucketed in the database, not by pulling thousands of raw transactions).
  const chartSeriesQuery = useTagTimeseriesQuery(tagUuid, { start_date: rangeStartDate, bucket: chartRange.bucket });
  const isChartLoading = chartSeriesQuery.isLoading;
  const monthlyData = useMemo<MonthlyTotal[]>(() => {
    const series = chartSeriesQuery.data?.series ?? [];
    // Rows arrive already aggregated and sorted by bucket; reuse the shared
    // bucket-label helper so the axis labels match the old client-side output.
    return series.map(({ bucket_date, income, expenses }) => {
      // The bucket is a calendar day: parse it as a local date, not a UTC instant.
      const { label } = getBucketKey(parseCalendarDate(bucket_date), chartRange.bucket);
      return { month: label, income, expenses };
    });
  }, [chartSeriesQuery.data, chartRange]);

  // Sub-tag breakdown for the pie chart (scoped to the same selected range).
  const breakdownQuery = useTagBreakdownQuery(tagUuid, { start_date: rangeStartDate }, { meta: { suppressErrorToast: true } });

  // Paginated transaction list.
  const txListQuery = useTagTransactionsQuery(tagUuid, { limit: transactionsPerPage, offset: (currentPage - 1) * transactionsPerPage });
  const transactions = txListQuery.data?.transactions ?? [];
  const totalTransactions = txListQuery.data?.total ?? 0;

  // Shared breakdown rows for the sub-tag pie chart and the table below it, so
  // both use the same resolved color (falling back to a palette when a sub-tag
  // has no color of its own) and the table swatches line up with the slices.
  // Memoized so the map + two reduces don't re-run on every unrelated render.
  const { breakdownData, breakdownTotal, breakdownMagnitude } = useMemo(() => {
    const breakdown = (breakdownQuery.data?.breakdown as unknown as TagBreakdownSlice[]) ?? [];
    const data = breakdown.map((slice, i) => {
      const net = centsToAmount(centsOf(slice.net));
      return {
        key: slice.uuid,
        label: slice.is_parent ? `${slice.name} (direct)` : slice.name,
        // Signed net (received − spent) per sub-tag, so the breakdown total
        // reconciles with the Net Total summary card.
        value: net,
        // Magnitude drives the pie arc size and the "% of total" share, so the
        // chart renders sensibly (and percentages stay positive and sum to 100%)
        // even if a sub-tag is net-positive from refunds.
        magnitude: Math.abs(net),
        color: slice.color || chart.series[i % chart.series.length],
      };
    });
    return {
      breakdownData: data,
      // Added in whole cents: as floats, nets of -0.10, -0.20 and +0.30 came
      // to -5.6e-17, shown as ($0.00).
      breakdownTotal: centsToAmount(data.reduce((sum, d) => sum + centsOf(d.value), 0)),
      breakdownMagnitude: centsToAmount(data.reduce((sum, d) => sum + centsOf(d.magnitude), 0)),
    };
  }, [breakdownQuery.data, chart.series]);

  // The bar chart's text alternative.
  const received = centsToAmount(monthlyData.reduce((sum, row) => sum + centsOf(row.income), 0));
  const spent = centsToAmount(monthlyData.reduce((sum, row) => sum + centsOf(row.expenses), 0));
  const historySummary = monthlyData.length
    ? `${formatCurrency(received)} received and ${formatCurrency(spent)} spent across ${monthlyData.length} ${monthlyData.length === 1 ? 'period' : 'periods'}.`
    : 'No transactions in this range.';

  if (isLoading) {
    return (
      <PageContainer>
        <PageLoader label="Loading tag…" minHeight="100vh" />
      </PageContainer>
    );
  }

  if (error || !tag) {
    return (
      <PageContainer>
        <Callout.Root color="red">
          <Callout.Text>{error || 'Tag not found'}</Callout.Text>
          <Box mt="2">
            <Button variant="soft" color="red" onClick={() => navigate('/tags')}>
              <ArrowLeft size={16} />
              Back to Tags
            </Button>
          </Box>
        </Callout.Root>
      </PageContainer>
    );
  }

  const totalPages = Math.ceil(totalTransactions / transactionsPerPage);

  return (
    <PageContainer>
      <Flex direction="column" gap="4">
        {/* Custom identity header: tag icon + name + hierarchy path */}
        <Flex justify="between" align="center" wrap="wrap" gap="2">
          <Flex align="center" gap="3">
            <IconButton
              variant="soft"
              color="gray"
              aria-label="Back to tags"
              onClick={() => navigate('/tags')}
            >
              <ArrowLeft size={16} />
            </IconButton>
            <Flex align="center" gap="2">
              {tag.icon && (() => {
                const iconData = getIconByName(tag.icon);
                if (iconData) {
                  const IconComponent = iconData.component;
                  // tag.color is data-driven (a tag's own color); preserve it.
                  return <IconComponent size={32} style={{ /* lint:guard colour: the tag's own colour */ color: tag.color || 'var(--accent-11)' }} />;
                }
                return null;
              })()}
              <Box>
                <Heading as="h1" size="6">
                  {tag.name}
                </Heading>
                {tag.level > 0 && (
                  <Text as="div" size="2" color="gray" mt="1">
                    {tag.hierarchy_path}
                  </Text>
                )}
              </Box>
            </Flex>
          </Flex>
          <Button onClick={() => navigate(`/tags?edit=${tag.uuid}`)}>
            <Edit size={16} />
            Edit Tag
          </Button>
        </Flex>

        {/* Description */}
        {tag.description && (
          <Card>
            <Text size="2" color="gray">
              {tag.description}
            </Text>
          </Card>
        )}

        {/* Summary Cards */}
        <Grid columns={{ initial: '1', md: '4' }} gap="4">
          <Card>
            <Flex direction="column" gap="2">
              <Text size="2" color="gray">Total Transactions</Text>
              <Text size="6" weight="bold">
                {summary?.transaction_count || 0}
              </Text>
            </Flex>
          </Card>

          <Card>
            <Flex direction="column" gap="2">
              <Text size="2" color="gray">Total Received</Text>
              <Text size="6" weight="bold" color="green" highContrast>
                {formatCurrency(Number(summary?.income_amount ?? 0))}
              </Text>
            </Flex>
          </Card>

          <Card>
            <Flex direction="column" gap="2">
              <Text size="2" color="gray">Total Spent</Text>
              <Text size="6" weight="bold" color="red">
                {formatCurrency(Math.abs(Number(summary?.expense_amount ?? 0)))}
              </Text>
            </Flex>
          </Card>

          <Card>
            <Flex direction="column" gap="2">
              <Text size="2" color="gray">Net Total</Text>
              <Text size="6" weight="bold">
                {formatCurrency(Number(summary?.total_amount ?? 0))}
              </Text>
            </Flex>
          </Card>
        </Grid>

        {/* Transaction History Chart */}
        <Card>
          <Flex direction="column" gap="2">
            <Flex justify="between" align="center" wrap="wrap" gap="2">
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
              {isChartLoading ? (
                <Flex align="center" justify="center" height="400px">
                  <NuggetSpinner size={48} />
                </Flex>
              ) : monthlyData.length > 0 ? (
                <ChartFigure
                title={`Received and spent, last ${chartRange.label}`}
                summary={historySummary}
                columns={[getBucketAxisLegend(chartRange.bucket) || 'Period', 'Received', 'Spent']}
                rows={monthlyData.map((row) => [row.month, formatCurrency(row.income), formatCurrency(row.expenses)])}
              >
                <Box height="400px">
                  <ResponsiveBar
                  data={monthlyData}
                  keys={['income', 'expenses']}
                  indexBy="month"
                  margin={{ top: 20, right: 20, bottom: 60, left: 80 }}
                  padding={0.3}
                  valueScale={{ type: 'linear' }}
                  colors={[chart.positive, chart.negative]}
                  borderRadius={4}
                  valueFormat={(value) => formatCurrency(value)}
                  axisBottom={{
                    tickSize: 5,
                    tickPadding: 5,
                    tickRotation: -45,
                    legend: getBucketAxisLegend(chartRange.bucket),
                    legendPosition: 'middle',
                    legendOffset: 50
                  }}
                  axisLeft={{
                    tickSize: 5,
                    tickPadding: 5,
                    tickRotation: 0,
                    legend: 'Amount ($)',
                    legendPosition: 'middle',
                    legendOffset: -60,
                    format: (value) => formatMoney(Number(value), { wholeUnits: true })
                  }}
                  labelSkipWidth={12}
                  labelSkipHeight={12}
                  labelTextColor={(bar) => chart.textOn(bar.color)}
                  legends={[
                    {
                      dataFrom: 'keys',
                      data: [
                        { id: 'income', label: 'Received', color: chart.positive },
                        { id: 'expenses', label: 'Spent', color: chart.negative },
                      ],
                      anchor: 'top-right',
                      direction: 'row',
                      justify: false,
                      translateX: 0,
                      translateY: -20,
                      itemsSpacing: 2,
                      itemWidth: 100,
                      itemHeight: 20,
                      itemDirection: 'left-to-right',
                      itemOpacity: 0.85,
                      symbolSize: 20,
                      effects: [
                        {
                          on: 'hover',
                          style: {
                            itemOpacity: 1
                          }
                        }
                      ]
                    }
                  ]}
                  theme={chart.nivo}
                  tooltip={({ id, value, indexValue }) => (
                    <Box
                      px="3" py="2" className="rounded-[var(--radius-3)] bg-[var(--color-panel-solid)] border border-[var(--gray-6)] text-[var(--gray-12)]"
                    >
                      <strong>{indexValue}</strong>
                      <br />
                      {id === 'income' ? 'Received' : 'Spent'}: {formatMoney(value)}
                    </Box>
                  )}
                />
                </Box>
                </ChartFigure>
              ) : (
                <Flex align="center" justify="center" height="400px">
                  <Text size="2" color="gray">
                    No transaction history available
                  </Text>
                </Flex>
              )}
            </Box>
          </Flex>
        </Card>

        {/* Sub-tag Breakdown Pie Chart (only when this tag has sub-tags) */}
        {(tag.child_count ?? 0) > 0 && (
          <Card>
            <Flex direction="column" gap="2">
              <Heading size="4">
                Net by Sub-Tag (Last {chartRange.label})
              </Heading>
              <Text size="1" color="gray">
                Net amount (received − spent) per sub-tag; the total reconciles with Net Total above.
                Each transaction is counted once: transactions tagged with a sub-tag
                count toward that sub-tag; those tagged only with {tag.name} count toward {tag.name}.
              </Text>
              <Box>
                {breakdownData.length > 0 ? (
                  <ChartFigure
                  title={`Net by sub-tag, last ${chartRange.label}`}
                  summary={`${breakdownData.length} ${breakdownData.length === 1 ? 'tag' : 'tags'}, net ${formatCurrency(breakdownTotal)} in all; the amounts are in the table below.`}
                  columns={[]}
                  rows={[]}
                >
                  <Box height="400px">
                    <ResponsivePie
                    data={breakdownData.map(d => ({
                      id: d.label,
                      label: d.label,
                      // Arc size by magnitude; the real signed net rides along
                      // for the labels/tooltip below.
                      value: d.magnitude,
                      net: d.value,
                      color: d.color,
                    }))}
                    margin={{ top: 40, right: 120, bottom: 40, left: 120 }}
                    innerRadius={0.5}
                    padAngle={0.7}
                    cornerRadius={3}
                    activeOuterRadiusOffset={8}
                    colors={{ datum: 'data.color' }}
                    borderWidth={1}
                    borderColor={{ from: 'color', modifiers: [['darker', 0.2]] }}
                    arcLinkLabelsSkipAngle={10}
                    arcLinkLabelsTextColor={chart.text}
                    arcLinkLabelsThickness={2}
                    arcLinkLabelsColor={{ from: 'color' }}
                    arcLabelsSkipAngle={12}
                    arcLabel={(d) => formatCurrency(Number(d.data.net))}
                    arcLabelsTextColor={(d) => chart.textOn(String(d.color))}
                    theme={chart.nivo}
                    tooltip={({ datum }) => (
                      <Box
                        px="3" py="2" className="rounded-[var(--radius-3)] bg-[var(--color-panel-solid)] border border-[var(--gray-6)] text-[var(--gray-12)]"
                      >
                        <strong>{datum.id}</strong>
                        <br />
                        {formatCurrency(Number(datum.data.net))}
                        {breakdownMagnitude > 0 && (
                          <> ({((Number(datum.value) / breakdownMagnitude) * 100).toFixed(1)}%)</>
                        )}
                      </Box>
                    )}
                  />
                  </Box>
                  </ChartFigure>
                ) : (
                  <Flex align="center" justify="center" height="400px">
                    <Text size="2" color="gray">
                      No sub-tag activity in this range
                    </Text>
                  </Flex>
                )}
              </Box>

              {/* Breakdown table: amount and % of total per sub-tag */}
              {breakdownData.length > 0 && (
                <ScrollArea scrollbars="horizontal">
                <Table.Root variant="surface" size="1">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeaderCell>Tag</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell justify="end">Amount</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell justify="end">% of total</Table.ColumnHeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {breakdownData.map(d => (
                      <Table.Row key={d.key}>
                        <Table.RowHeaderCell>
                          <Flex align="center" gap="2">
                            <Box
                              width="12px"
                              height="12px"
                              flexShrink="0"
                              style={{
                                borderRadius: 3,
                                // lint:guard colour: the slice's colour (its own, or the palette's).
                                backgroundColor: d.color,
                              }}
                            />
                            <Text size="2">{d.label}</Text>
                          </Flex>
                        </Table.RowHeaderCell>
                        <Table.Cell justify="end">
                          <Text size="2">{formatCurrency(d.value)}</Text>
                        </Table.Cell>
                        <Table.Cell justify="end">
                          <Text size="2" color="gray">
                            {breakdownMagnitude > 0 ? ((d.magnitude / breakdownMagnitude) * 100).toFixed(1) : '0.0'}%
                          </Text>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                    <Table.Row>
                      <Table.RowHeaderCell>
                        <Text size="2" weight="bold">Total</Text>
                      </Table.RowHeaderCell>
                      <Table.Cell justify="end">
                        <Text size="2" weight="bold">{formatCurrency(breakdownTotal)}</Text>
                      </Table.Cell>
                      <Table.Cell justify="end">
                        <Text size="2" weight="bold">100%</Text>
                      </Table.Cell>
                    </Table.Row>
                  </Table.Body>
                </Table.Root>
                </ScrollArea>
              )}
            </Flex>
          </Card>
        )}

        {/* Transactions Table. Zero the Card's intrinsic padding and drive it
            with a responsive Box so the per-transaction cards aren't doubly
            inset on mobile. */}
        <Card style={{ padding: 0 }}>
          <Box px={{ initial: '2', sm: '4' }} py="4">
          <Flex direction="column" gap="4">
            <Flex justify="between" align="center">
              <Text size="4" weight="bold" className="text-[var(--gray-12)]">
                Transactions
              </Text>
              <Text size="2" color="gray">
                {totalTransactions} total
              </Text>
            </Flex>

            {transactions.length > 0 ? (
              <>
                <RadixTransactionTable
                  transactions={transactions}
                  onTransactionClick={openTransactionEdit}
                  // Refresh in place instead of a full page reload. A tag change
                  // can also alter membership/chart, so reload those too.
                  onTransactionUpdated={() => {
                    // Refresh in place; keepPreviousData avoids a chart flash.
                    void txListQuery.refetch();
                    void chartSeriesQuery.refetch();
                    void breakdownQuery.refetch();
                  }}
                />

                {/* Whenever the size could change what shows, so a choice can be taken back. */}
                {totalTransactions > SMALLEST_TRANSACTION_PAGE_SIZE && (
                  <SharedPagination
                    currentPage={currentPage}
                    totalPages={totalPages}
                    totalItems={totalTransactions}
                    itemsPerPage={transactionsPerPage}
                    onPageChange={setCurrentPage}
                    itemLabel="transactions"
                    pageSizeOptions={TRANSACTION_PAGE_SIZES}
                    onItemsPerPageChange={setTransactionsPerPage}
                  />
                )}
              </>
            ) : (
              <Box p="6" className="text-center">
                <Text size="2" color="gray">
                  No transactions found for this tag
                </Text>
              </Box>
            )}
          </Flex>
          </Box>
        </Card>
      </Flex>
    </PageContainer>
  );
};

export default ViewTagPage;
