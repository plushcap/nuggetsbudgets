import React from 'react';
import { Flex, Card, Heading, Text, Table, Badge, Button } from '@radix-ui/themes';
import { FileText, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import { useRealizedGainLossQuery, useWashSalesQuery, useDividendHistoryQuery } from '../hooks/queries/investments';
import { downloadCsv } from '../services/api/investments';
import { textColorProps } from '../utils/textColor';
import { logger } from '../utils/logger';
import PageContainer from '../components/PageContainer';
import { formatMoney } from '@nuggets/shared';

const glColor = (n: number): 'gray' | 'green' | 'red' => (n === 0 ? 'gray' : n > 0 ? 'green' : 'red');

const InvestmentTaxPage: React.FC = () => {
  const { data: realized = [], isLoading } = useRealizedGainLossQuery();
  const { data: washSales = [] } = useWashSalesQuery();
  const { data: dividends } = useDividendHistoryQuery();

  const exportCsv = async (endpoint: string, filename: string) => {
    try { await downloadCsv(endpoint, filename); } catch (err) { logger.error({ err }, 'CSV export failed'); toast.error('Export failed'); }
  };

  const totalRealized = realized.reduce((s, r) => s + r.realized_gain_loss, 0);
  const longTerm = realized.filter((r) => r.is_long_term).reduce((s, r) => s + r.realized_gain_loss, 0);
  const shortTerm = totalRealized - longTerm;

  return (
    <PageContainer>
      <PageHeader
        title="Realized gains & wash sales"
        subtitle="Tax-prep view (Schedule D / Form 8949 inputs)"
        icon={<FileText />}
        backPath="/investments"
        actions={
          <Flex gap="2" wrap="wrap">
            <Button variant="soft" onClick={() => exportCsv('/investments/export/realized-gain-loss.csv', 'realized-gain-loss.csv')}><Download size={16} /> Realized G/L CSV</Button>
            <Button variant="soft" onClick={() => exportCsv('/investments/export/dividends.csv', 'dividends.csv')}><Download size={16} /> Dividends CSV</Button>
          </Flex>
        }
      />
      {isLoading ? (
        <PageLoader label="Loading realized gains…" />
      ) : (
        <Flex direction="column" gap="3">
          <Flex gap="3" wrap="wrap">
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Total realized</Text><Heading size="6" {...textColorProps(glColor(totalRealized))}>{formatMoney(totalRealized)}</Heading></Flex></Card>
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Long-term</Text><Heading size="6" {...textColorProps(glColor(longTerm))}>{formatMoney(longTerm)}</Heading></Flex></Card>
            <Card><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Short-term</Text><Heading size="6" {...textColorProps(glColor(shortTerm))}>{formatMoney(shortTerm)}</Heading></Flex></Card>
          </Flex>

          <Card>
            <Flex direction="column" gap="2" p="2">
              <Heading size="3">Realized gain/loss</Heading>
              {realized.length === 0 ? <Text size="2" color="gray">No realized gains in range.</Text> : (
                <Table.Root variant="surface">
                  <Table.Header><Table.Row>
                    <Table.ColumnHeaderCell>Security</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Sell date</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Proceeds</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Basis</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Gain/loss</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Term</Table.ColumnHeaderCell>
                  </Table.Row></Table.Header>
                  <Table.Body>
                    {realized.map((r, i) => (
                      <Table.Row key={i}>
                        <Table.Cell>{r.ticker}</Table.Cell>
                        <Table.Cell>{r.sell_date}</Table.Cell>
                        <Table.Cell align="right">{formatMoney(r.proceeds)}</Table.Cell>
                        <Table.Cell align="right">{formatMoney(r.basis_consumed)}</Table.Cell>
                        <Table.Cell align="right"><Text {...textColorProps(glColor(r.realized_gain_loss))}>{formatMoney(r.realized_gain_loss)}</Text></Table.Cell>
                        <Table.Cell><Flex gap="1">{r.is_long_term ? 'LT' : 'ST'}{r.is_wash_sale && <Badge highContrast color="amber" variant="soft">wash</Badge>}</Flex></Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              )}
            </Flex>
          </Card>

          {dividends && dividends.records.length > 0 && (
            <Card>
              <Flex direction="column" gap="2" p="2">
                <Flex align="center" gap="3" wrap="wrap">
                  <Heading size="3">Dividend income</Heading>
                  <Badge highContrast color="green" variant="soft">Total {formatMoney(dividends.total)}</Badge>
                  <Badge color="gray" variant="soft">Qualified {formatMoney(dividends.qualified)}</Badge>
                  <Badge color="gray" variant="soft">Ordinary {formatMoney(dividends.ordinary)}</Badge>
                </Flex>
                <Table.Root variant="surface">
                  <Table.Header><Table.Row>
                    <Table.ColumnHeaderCell>Security</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Pay date</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Amount</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Class</Table.ColumnHeaderCell>
                  </Table.Row></Table.Header>
                  <Table.Body>
                    {dividends.records.map((d, i) => (
                      <Table.Row key={i}>
                        <Table.Cell>{d.ticker}</Table.Cell>
                        <Table.Cell>{d.pay_date}</Table.Cell>
                        <Table.Cell align="right">{formatMoney(d.total_amount)}</Table.Cell>
                        <Table.Cell><Flex gap="1">{d.is_qualified ? 'Qualified' : 'Ordinary'}{d.is_reinvested && <Badge color="blue" variant="soft">DRIP</Badge>}</Flex></Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </Flex>
            </Card>
          )}

          {washSales.length > 0 && (
            <Card>
              <Flex direction="column" gap="2" p="2">
                <Heading size="3">Wash sales (disallowed losses)</Heading>
                <Table.Root variant="surface">
                  <Table.Header><Table.Row><Table.ColumnHeaderCell>Security</Table.ColumnHeaderCell><Table.ColumnHeaderCell>Sell date</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">Disallowed</Table.ColumnHeaderCell></Table.Row></Table.Header>
                  <Table.Body>
                    {washSales.map((w, i) => (
                      <Table.Row key={i}><Table.Cell>{w.ticker}</Table.Cell><Table.Cell>{w.sell_date}</Table.Cell><Table.Cell align="right">{formatMoney(w.disallowed_loss)}</Table.Cell></Table.Row>
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

export default InvestmentTaxPage;
