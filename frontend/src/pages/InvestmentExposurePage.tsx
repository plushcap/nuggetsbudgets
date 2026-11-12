import React from 'react';
import { Flex, Card, Text, Table, Callout, Badge } from '@radix-ui/themes';
import { Crosshair, Info } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import { useUnderlyingExposureQuery } from '../hooks/queries/investments';
import { formatMoney } from '@nuggets/shared';
import { centsOf, centsToAmount } from '../utils/currency';
import PageContainer from '../components/PageContainer';

/** An amount, or — for none (formatMoney's fallback, as this page's own format had it). */
const usd = (n: number | null | undefined) => formatMoney(n);
const pct = (n: number) => `${n.toFixed(2)}%`;
// Funds can resolve to tens of thousands of leaf securities; cap the rendered
// rows (already sorted by exposure desc) so the page stays responsive.
const EXPOSURE_DISPLAY_LIMIT = 250;

/**
 * Holdings-level look-through: every position resolved down to the
 * individual underlying securities ("all the way to stocks"), so the same stock
 * held directly and inside funds is aggregated into one true exposure figure.
 */
const InvestmentExposurePage: React.FC = () => {
  const { data, isLoading } = useUnderlyingExposureQuery();

  const unknownPct = data && data.total_value > 0 ? (data.unknown_value / data.total_value) * 100 : 0;
  // What resolved to securities: the total less the unknown, in whole cents, as the
  // API rounds its exposures to add up to the total.
  const resolvedValue = data ? centsToAmount(centsOf(data.total_value) - centsOf(data.unknown_value)) : 0;

  return (
    <PageContainer>
      <PageHeader
        title="Stock exposure (look-through)"
        subtitle="Total exposure to each underlying security across direct holdings and funds"
        icon={<Crosshair />}
        backPath="/investments"
      />
      {isLoading ? (
        <PageLoader label="Resolving holdings…" />
      ) : !data || data.exposures.length === 0 ? (
        <Card>
          <Flex direction="column" align="center" gap="2" p="6">
            <Text color="gray">No resolved underlying exposure yet.</Text>
            <Text size="1" color="gray">
              Add holdings, then populate each fund&apos;s underlying securities (your AI agent can do this via MCP) to see through to individual stocks.
            </Text>
          </Flex>
        </Card>
      ) : (
        <Flex direction="column" gap="3">
          {data.unknown_value > 0 && (
            <Callout.Root highContrast color="amber" variant="soft">
              <Callout.Icon><Info size={16} /></Callout.Icon>
              <Callout.Text>
                {usd(data.unknown_value)} ({pct(unknownPct)}) could not be resolved to individual securities — funds with no
                underlying-holdings data, unallocated cash, or composition residuals. Populate those funds&apos; holdings to reduce it.
              </Callout.Text>
            </Callout.Root>
          )}
          <Card>
            <Table.Root variant="surface">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Security</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell align="right">Exposure</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell align="right">% of portfolio</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.exposures.slice(0, EXPOSURE_DISPLAY_LIMIT).map((e) => (
                  <Table.Row key={e.security_uuid ?? e.ticker}>
                    <Table.Cell>
                      <Flex direction="column">
                        <Text weight="medium">{e.ticker}</Text>
                        {e.name && <Text size="1" color="gray">{e.name}</Text>}
                      </Flex>
                    </Table.Cell>
                    <Table.Cell align="right">{usd(e.amount)}</Table.Cell>
                    <Table.Cell align="right">{pct(e.percentage)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
            {data.exposures.length > EXPOSURE_DISPLAY_LIMIT && (
              <Text size="1" color="gray" mt="2" as="div" style={{ paddingInline: 'var(--space-2)' }}>
                Showing the top {EXPOSURE_DISPLAY_LIMIT} of {data.exposures.length} securities by exposure.
              </Text>
            )}
            {/* What resolved but isn't listed, so the table, this and the unknown add up to the total. */}
            {data.below_a_cent.securities > 0 && (
              <Text size="1" color="gray" mt="2" as="div" style={{ paddingInline: 'var(--space-2)' }}>
                And {data.below_a_cent.securities} {data.below_a_cent.securities === 1 ? 'security' : 'securities'} worth less
                than a cent each, not listed: {usd(data.below_a_cent.amount)} ({pct(data.below_a_cent.percentage)}) in all.
              </Text>
            )}
            <Flex justify="end" mt="2" px="2">
              <Badge color="gray" variant="soft">Total resolved: {usd(resolvedValue)} of {usd(data.total_value)}</Badge>
            </Flex>
          </Card>
        </Flex>
      )}
    </PageContainer>
  );
};

export default InvestmentExposurePage;
