import React from 'react';
import { Flex, Grid, Card, Heading, Text, Table, Badge, Button } from '@radix-ui/themes';
import { RefreshCw, Copy } from 'lucide-react';
import toast from 'react-hot-toast';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import { textColorProps } from '../utils/textColor';
import { useDataFreshnessQuery } from '../hooks/queries/investments';
import PageContainer from '../components/PageContainer';
import { formatMoney } from '@nuggets/shared';


const DataFreshnessPage: React.FC = () => {
  const { data, isLoading } = useDataFreshnessQuery();

  const buildPrompt = (): string => {
    if (!data) return '';
    const lines: string[] = ['Please refresh stale Nuggets investment data via the MCP tools:'];
    if (data.stale_prices.length) lines.push(`- Prices (${data.stale_prices.length}): ${data.stale_prices.map((p) => p.ticker).join(', ')}`);
    if (data.stale_compositions.length) lines.push(`- Fund composition (${data.stale_compositions.length}): ${data.stale_compositions.map((c) => c.ticker).join(', ')}`);
    if (data.missing_expense_ratios.length) lines.push(`- Expense ratios (${data.missing_expense_ratios.length}): ${data.missing_expense_ratios.map((e) => e.ticker).join(', ')}`);
    return lines.join('\n');
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(buildPrompt());
      toast.success('Refresh prompt copied — paste it to your AI agent');
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  const totalStale = (data?.summary.stale_price_count ?? 0) + (data?.summary.stale_composition_count ?? 0) + (data?.summary.missing_expense_ratio_count ?? 0);

  return (
    <PageContainer>
      <PageHeader
        title="Data freshness"
        subtitle="Stale or missing reference data — refresh via your AI agent (MCP)"
        icon={<RefreshCw />}
        backPath="/investments"
        actions={totalStale > 0 ? <Button onClick={copyPrompt}><Copy size={16} /> Copy refresh prompt</Button> : undefined}
      />
      {isLoading ? (
        <PageLoader label="Checking freshness…" />
      ) : totalStale === 0 ? (
        <Card><Flex p="6" justify="center"><Text color="green" highContrast>All reference data is up to date.</Text></Flex></Card>
      ) : (
        <Flex direction="column" gap="3">
          <Grid columns={{ initial: '1', sm: '3' }} gap="3">
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Stale prices</Text><Heading size="6" {...textColorProps(data!.summary.stale_price_count ? 'amber' : 'gray')}>{data!.summary.stale_price_count}</Heading></Flex></Card>
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Stale compositions</Text><Heading size="6" {...textColorProps(data!.summary.stale_composition_count ? 'amber' : 'gray')}>{data!.summary.stale_composition_count}</Heading></Flex></Card>
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Missing expense ratios</Text><Heading size="6" {...textColorProps(data!.summary.missing_expense_ratio_count ? 'amber' : 'gray')}>{data!.summary.missing_expense_ratio_count}</Heading></Flex></Card>
          </Grid>

          {data!.stale_prices.length > 0 && (
            <Card>
              <Flex direction="column" gap="2" p="2">
                <Heading size="3">Prices needing refresh</Heading>
                <Table.Root variant="surface">
                  <Table.Header><Table.Row><Table.ColumnHeaderCell>Security</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">Holding value</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">Age (days)</Table.ColumnHeaderCell><Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell></Table.Row></Table.Header>
                  <Table.Body>
                    {data!.stale_prices.map((p) => (
                      <Table.Row key={p.security_uuid}>
                        <Table.Cell><Flex align="center" gap="2">{p.ticker}{p.is_held && <Badge color="blue" variant="soft">held</Badge>}</Flex></Table.Cell>
                        <Table.Cell align="right">{formatMoney(p.market_value)}</Table.Cell>
                        <Table.Cell align="right">{p.price_age_days ?? '—'}</Table.Cell>
                        <Table.Cell>{p.never_recorded ? <Badge highContrast color="red" variant="soft">never recorded</Badge> : <Badge highContrast color="amber" variant="soft">stale</Badge>}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </Flex>
            </Card>
          )}

          {data!.stale_compositions.length > 0 && (
            <Card>
              <Flex direction="column" gap="2" p="2">
                <Heading size="3">Fund composition needing refresh</Heading>
                <Table.Root variant="surface">
                  <Table.Header><Table.Row><Table.ColumnHeaderCell>Fund</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">Age (days)</Table.ColumnHeaderCell><Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell></Table.Row></Table.Header>
                  <Table.Body>
                    {data!.stale_compositions.map((c) => (
                      <Table.Row key={c.security_uuid}>
                        <Table.Cell>{c.ticker}</Table.Cell>
                        <Table.Cell align="right">{c.composition_age_days ?? '—'}</Table.Cell>
                        <Table.Cell>{c.never_recorded ? <Badge highContrast color="red" variant="soft">never recorded</Badge> : <Badge highContrast color="amber" variant="soft">stale</Badge>}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </Flex>
            </Card>
          )}

          {data!.missing_expense_ratios.length > 0 && (
            <Card>
              <Flex direction="column" gap="2" p="2">
                <Heading size="3">Missing expense ratios</Heading>
                <Flex gap="2" wrap="wrap">{data!.missing_expense_ratios.map((e) => <Badge key={e.security_uuid} variant="soft">{e.ticker}</Badge>)}</Flex>
              </Flex>
            </Card>
          )}
        </Flex>
      )}
    </PageContainer>
  );
};

export default DataFreshnessPage;
