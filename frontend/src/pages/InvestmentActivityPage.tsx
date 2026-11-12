import React, { useState } from 'react';
import { Flex, Card, Text, Table, Select, Badge } from '@radix-ui/themes';
import { Activity } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import SharedPagination from '../components/SharedPagination';
import { useHoldingEventsQuery, useSecuritiesQuery } from '../hooks/queries/investments';
import { HOLDING_EVENT_TYPES, HOLDING_EVENT_TYPE_LABELS, type HoldingEventType, formatMoney } from '@nuggets/shared';
import { oneOf } from '../utils/vocabularyOptions';
import PageContainer from '../components/PageContainer';

const num = (n: number | null) => (n == null ? '—' : String(n));

/** The filter's choices: every event type (the server's values), or all. */
const EVENT_TYPE_FILTERS: (HoldingEventType | 'all')[] = ['all', ...HOLDING_EVENT_TYPES];

const typeColor = (t: string): 'green' | 'red' | 'blue' | 'amber' | 'gray' =>
  t === 'buy' || t === 'dividend_reinvest' || t === 'transfer_in' ? 'green'
    : t === 'sell' || t === 'transfer_out' ? 'red'
    : t === 'dividend' ? 'blue'
    : t === 'fee' ? 'amber'
    : 'gray';

const InvestmentActivityPage: React.FC = () => {
  const [eventType, setEventType] = useState<HoldingEventType | 'all'>('all');
  const [security, setSecurity] = useState('all');
  const [page, setPage] = useState(1);
  const limit = 50;

  const { data: securities = [] } = useSecuritiesQuery(true);
  const { data, isLoading } = useHoldingEventsQuery({
    page,
    limit,
    ...(eventType === 'all' ? {} : { event_type: eventType }),
    ...(security === 'all' ? {} : { security }),
  });

  const events = data?.data ?? [];
  const pg = data?.pagination;

  return (
    <PageContainer>
      <PageHeader
        title="Transactions"
        subtitle="Full investment event ledger"
        icon={<Activity />}
        backPath="/investments"
        actions={
          <Flex gap="2" wrap="wrap">
            <Select.Root value={eventType} onValueChange={(v) => { setEventType(oneOf(EVENT_TYPE_FILTERS, v) ?? 'all'); setPage(1); }}>
              <Select.Trigger aria-label="Event type" placeholder="Type" />
              <Select.Content>{EVENT_TYPE_FILTERS.map((t) => <Select.Item key={t} value={t}>{t === 'all' ? 'All types' : HOLDING_EVENT_TYPE_LABELS[t]}</Select.Item>)}</Select.Content>
            </Select.Root>
            <Select.Root value={security} onValueChange={(v) => { setSecurity(v); setPage(1); }}>
              <Select.Trigger aria-label="Security" placeholder="Security" />
              <Select.Content>
                <Select.Item value="all">All securities</Select.Item>
                {securities.map((s) => <Select.Item key={s.uuid} value={s.uuid}>{s.ticker}</Select.Item>)}
              </Select.Content>
            </Select.Root>
          </Flex>
        }
      />
      {isLoading ? (
        <PageLoader label="Loading transactions…" />
      ) : events.length === 0 ? (
        <Card><Flex p="6" justify="center"><Text color="gray">No transactions match these filters.</Text></Flex></Card>
      ) : (
        <Flex direction="column" gap="3">
          <Card>
            <Table.Root variant="surface">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Date</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Type</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Security</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Account</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell align="right">Shares</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell align="right">Price</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell align="right">Amount</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Source</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {events.map((e) => (
                  <Table.Row key={e.uuid}>
                    <Table.Cell>{String(e.event_date).slice(0, 10)}</Table.Cell>
                    <Table.Cell><Badge color={typeColor(e.event_type)} variant="soft">{e.fee_type ?? e.event_type}</Badge></Table.Cell>
                    <Table.Cell>{e.ticker ?? '—'}</Table.Cell>
                    <Table.Cell>{e.account_name}</Table.Cell>
                    <Table.Cell align="right">{num(e.shares)}</Table.Cell>
                    <Table.Cell align="right">{formatMoney(e.price_per_share)}</Table.Cell>
                    <Table.Cell align="right">{formatMoney(e.total_amount)}</Table.Cell>
                    <Table.Cell><Text size="1" color="gray">{e.source}</Text></Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Card>
          {pg && pg.totalPages > 1 && (
            <SharedPagination currentPage={pg.page} totalPages={pg.totalPages} totalItems={pg.total} itemsPerPage={pg.limit} onPageChange={setPage} />
          )}
        </Flex>
      )}
    </PageContainer>
  );
};

export default InvestmentActivityPage;
