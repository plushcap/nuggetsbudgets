import React from 'react';
import { Flex, Grid, Card, Heading, Text, Table, Badge } from '@radix-ui/themes';
import { Receipt } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import { useCostOfOwnershipQuery, useFeesSummaryQuery } from '../hooks/queries/investments';
import PageContainer from '../components/PageContainer';
import { formatMoney } from '@nuggets/shared';


const InvestmentCostsPage: React.FC = () => {
  const { data: coo, isLoading } = useCostOfOwnershipQuery();
  const { data: fees } = useFeesSummaryQuery();

  return (
    <PageContainer>
      <PageHeader title="Cost of ownership" subtitle="Explicit fees plus estimated fund expense-ratio drag" icon={<Receipt />} backPath="/investments" />
      {isLoading ? (
        <PageLoader label="Computing costs…" />
      ) : (
        <Flex direction="column" gap="3">
          <Grid columns={{ initial: '2', md: '4' }} gap="3">
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Explicit fees</Text><Heading size="6">{formatMoney(coo?.total_explicit_fees ?? 0)}</Heading></Flex></Card>
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Imputed drag (est.)</Text><Heading size="6">{formatMoney(coo?.total_imputed_drag ?? 0)}</Heading></Flex></Card>
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Total annual cost</Text><Heading size="6">{formatMoney(coo?.total_cost ?? 0)}</Heading></Flex></Card>
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Account-level fees</Text><Heading size="6">{formatMoney(coo?.account_level_fees ?? 0)}</Heading></Flex></Card>
          </Grid>

          <Card>
            <Flex direction="column" gap="2" p="2">
              <Flex align="center" gap="2"><Heading size="3">Per holding</Heading><Badge highContrast color="amber" variant="soft">drag estimated</Badge></Flex>
              <Table.Root variant="surface">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell>Security</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Avg value</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Explicit fees</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Imputed drag</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Total</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Effective %</Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {(coo?.per_holding ?? []).map((h) => (
                    <Table.Row key={h.security_id}>
                      <Table.Cell>{h.ticker}</Table.Cell>
                      <Table.Cell align="right">{formatMoney(h.average_holding_value)}</Table.Cell>
                      <Table.Cell align="right">{formatMoney(h.explicitFees)}</Table.Cell>
                      <Table.Cell align="right">{formatMoney(h.imputedDrag)}</Table.Cell>
                      <Table.Cell align="right">{formatMoney(h.totalCost)}</Table.Cell>
                      <Table.Cell align="right">{h.effectiveCostPct.toFixed(2)}%</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
              {coo?.note && <Text size="1" color="gray">{coo.note}</Text>}
            </Flex>
          </Card>

          {fees && fees.by_type.length > 0 && (
            <Card>
              <Flex direction="column" gap="2" p="2">
                <Heading size="3">Fees by type</Heading>
                <Table.Root variant="surface">
                  <Table.Header><Table.Row><Table.ColumnHeaderCell>Type</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">Count</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">Total</Table.ColumnHeaderCell></Table.Row></Table.Header>
                  <Table.Body>
                    {fees.by_type.map((f) => (
                      <Table.Row key={f.fee_type}><Table.Cell>{f.fee_type}</Table.Cell><Table.Cell align="right">{f.count}</Table.Cell><Table.Cell align="right">{formatMoney(f.total)}</Table.Cell></Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </Flex>
            </Card>
          )}
        </Flex>
      )}
    </PageContainer>
  );
};

export default InvestmentCostsPage;
