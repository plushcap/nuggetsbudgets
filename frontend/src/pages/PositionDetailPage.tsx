import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Flex, Card, Heading, Text, Table, Badge, Button } from '@radix-ui/themes';
import { Layers, Pencil } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import { useLotsQuery, useSecuritiesQuery, useFundCompositionQuery, useHoldingEventsQuery, useUnderlyingHoldingsQuery } from '../hooks/queries/investments';
import PageContainer from '../components/PageContainer';
import { formatMoney, dataQuality } from '@nuggets/shared';

const UNDERLYING_DISPLAY_LIMIT = 200;

const PositionDetailPage: React.FC = () => {
  const { securityUuid } = useParams<{ securityUuid: string }>();
  const navigate = useNavigate();
  const { data: securities = [] } = useSecuritiesQuery(true);
  const { data: lots = [], isLoading } = useLotsQuery(securityUuid);
  const security = securities.find((s) => s.uuid === securityUuid);
  const { data: composition = [] } = useFundCompositionQuery(security?.is_pass_through ? securityUuid : undefined);
  const { data: underlying = [] } = useUnderlyingHoldingsQuery(security?.is_pass_through ? securityUuid : undefined);
  const { data: eventsPage } = useHoldingEventsQuery({ ...(securityUuid ? { security: securityUuid } : {}), limit: 100 });
  const events = eventsPage?.data ?? [];

  const openLots = lots.filter((l) => l.is_open);

  return (
    <PageContainer>
      <PageHeader
        title={security ? `${security.ticker} — ${security.name}` : 'Position'}
        subtitle="Open tax lots and fund composition"
        icon={<Layers />}
        backPath="/investments"
        actions={<Flex gap="2">{securityUuid && <Button variant="soft" onClick={() => navigate(`/investments/securities/${securityUuid}/edit`)}><Pencil size={16} /> Edit</Button>}<Button variant="soft" onClick={() => navigate('/investments/sell')}>Sell</Button><Button variant="soft" onClick={() => navigate('/investments/dividend')}>Dividend</Button></Flex>}
      />
      {isLoading ? (
        <PageLoader label="Loading lots…" />
      ) : (
        <Flex direction="column" gap="3">
          <Card>
            <Flex direction="column" gap="2" p="2">
              <Heading size="3">Open lots</Heading>
              {openLots.length === 0 ? <Text size="2" color="gray">No open lots.</Text> : (
                <Table.Root variant="surface">
                  <Table.Header><Table.Row>
                    <Table.ColumnHeaderCell>Acquired</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Method</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Shares</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Cost/share</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Total basis</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Quality</Table.ColumnHeaderCell>
                  </Table.Row></Table.Header>
                  <Table.Body>
                    {openLots.map((l) => (
                      <Table.Row key={l.uuid}>
                        <Table.Cell>{String(l.acquisition_date).slice(0, 10)}</Table.Cell>
                        <Table.Cell>{l.acquisition_method}</Table.Cell>
                        <Table.Cell align="right">{l.shares_remaining}</Table.Cell>
                        <Table.Cell align="right">{formatMoney(l.cost_basis_per_share)}</Table.Cell>
                        <Table.Cell align="right">{formatMoney(l.total_cost_basis)}</Table.Cell>
                        <Table.Cell>{l.data_quality === dataQuality.enum.complete ? <Text size="1" color="gray">complete</Text> : <Badge highContrast color="amber" variant="soft">{l.data_quality}</Badge>}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              )}
            </Flex>
          </Card>

          <Card>
            <Flex direction="column" gap="2" p="2">
              <Heading size="3">Event history</Heading>
              {events.length === 0 ? <Text size="2" color="gray">No events.</Text> : (
                <Table.Root variant="surface">
                  <Table.Header><Table.Row>
                    <Table.ColumnHeaderCell>Date</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Type</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Shares</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Price</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell align="right">Amount</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Source</Table.ColumnHeaderCell>
                  </Table.Row></Table.Header>
                  <Table.Body>
                    {events.map((e) => (
                      <Table.Row key={e.uuid}>
                        <Table.Cell>{String(e.event_date).slice(0, 10)}</Table.Cell>
                        <Table.Cell><Badge color="gray" variant="soft">{e.fee_type ?? e.event_type}</Badge></Table.Cell>
                        <Table.Cell align="right">{e.shares == null ? '—' : String(Number(e.shares))}</Table.Cell>
                        <Table.Cell align="right">{formatMoney(e.price_per_share)}</Table.Cell>
                        <Table.Cell align="right">{formatMoney(e.total_amount)}</Table.Cell>
                        <Table.Cell><Text size="1" color="gray">{e.source}</Text></Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              )}
            </Flex>
          </Card>

          {security?.is_pass_through && underlying.length > 0 && (
            <Card>
              <Flex direction="column" gap="2" p="2">
                <Heading size="3">Underlying holdings</Heading>
                {/* Funds can have tens of thousands of holdings; render only the
                    largest by weight to keep the page responsive. */}
                {underlying.length > UNDERLYING_DISPLAY_LIMIT && (
                  <Text size="1" color="gray">Showing the top {UNDERLYING_DISPLAY_LIMIT} of {underlying.length} holdings by weight.</Text>
                )}
                <Table.Root variant="surface">
                  <Table.Header><Table.Row><Table.ColumnHeaderCell>Security</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">Weight</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">Shares</Table.ColumnHeaderCell></Table.Row></Table.Header>
                  <Table.Body>
                    {underlying.slice(0, UNDERLYING_DISPLAY_LIMIT).map((u) => (
                      <Table.Row key={u.underlying_uuid}>
                        <Table.Cell><Flex direction="column"><Text weight="medium">{u.ticker}</Text><Text size="1" color="gray">{u.name}</Text></Flex></Table.Cell>
                        <Table.Cell align="right">{u.weight_percentage.toFixed(2)}%</Table.Cell>
                        <Table.Cell align="right">{u.shares == null ? '—' : String(u.shares)}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </Flex>
            </Card>
          )}

          {security?.is_pass_through && composition.length > 0 && (
            <Card>
              <Flex direction="column" gap="2" p="2">
                <Heading size="3">Fund composition</Heading>
                <Table.Root variant="surface">
                  <Table.Header><Table.Row><Table.ColumnHeaderCell>Dimension</Table.ColumnHeaderCell><Table.ColumnHeaderCell>Value</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">Weight</Table.ColumnHeaderCell></Table.Row></Table.Header>
                  <Table.Body>
                    {composition.map((c, i) => (
                      <Table.Row key={i}><Table.Cell>{c.dimension}</Table.Cell><Table.Cell>{c.dimension_value}</Table.Cell><Table.Cell align="right">{c.weight_percentage.toFixed(2)}%</Table.Cell></Table.Row>
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

export default PositionDetailPage;
