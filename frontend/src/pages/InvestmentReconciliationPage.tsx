import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Flex, Card, Text, Table, Badge, Button, Tooltip } from '@radix-ui/themes';
import { Scale } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import { useReconciliationQuery } from '../hooks/queries/investments';
import PageContainer from '../components/PageContainer';
import { formatMoney } from '@nuggets/shared';


const InvestmentReconciliationPage: React.FC = () => {
  const navigate = useNavigate();
  const { data, isLoading } = useReconciliationQuery();

  return (
    <PageContainer>
      <PageHeader title="Reconciliation" subtitle="Holdings plus cash vs the broker's imported balance" icon={<Scale />} backPath="/investments" />
      {isLoading ? (
        <PageLoader label="Reconciling…" />
      ) : !data || data.accounts.length === 0 ? (
        <Card><Flex p="6" justify="center"><Text color="gray">No investment accounts to reconcile.</Text></Flex></Card>
      ) : (
        <Flex direction="column" gap="3">
          {data.flagged_count > 0 && (
            <Card><Text size="2" color="amber" highContrast>{data.flagged_count} account(s) differ from the imported balance beyond the threshold. Resolve by recording the missing event, adding a lot, or updating prices.</Text></Card>
          )}
          <Card>
            <Table.Root variant="surface">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Account</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell align="right">Calculated</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell align="right">Imported</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell align="right">Difference</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell></Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.accounts.map((a) => (
                  <Table.Row key={a.account_uuid}>
                    <Table.Cell>{a.account_name}</Table.Cell>
                    <Table.Cell align="right">{formatMoney(a.calculated_value)}</Table.Cell>
                    <Table.Cell align="right">{formatMoney(a.imported_balance)}</Table.Cell>
                    <Table.Cell align="right"><Text color={a.difference === 0 ? 'gray' : a.flagged ? 'red' : 'gray'}>{formatMoney(a.difference)}{a.pctDifference != null ? ` (${a.pctDifference}%)` : ''}</Text></Table.Cell>
                    <Table.Cell>
                      {a.imported_balance == null ? <Badge color="gray" variant="soft">no import</Badge>
                        : a.calculated_value == null ? <Tooltip content={a.reason ?? ''}><Badge color="gray" variant="soft">not compared</Badge></Tooltip>
                          : a.flagged ? <Badge highContrast color="amber" variant="soft">review</Badge> : <Badge highContrast color="green" variant="soft">matched</Badge>}
                    </Table.Cell>
                    <Table.Cell>{a.flagged && <Button size="1" variant="soft" onClick={() => navigate('/investments/buy')}>Record event</Button>}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
            <Text size="1" color="gray" mt="2" as="div" style={{ paddingInline: 'var(--space-2)' }}>{data.note}</Text>
          </Card>
        </Flex>
      )}
    </PageContainer>
  );
};

export default InvestmentReconciliationPage;
