import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'react-hot-toast';
import { ChevronLeft, ChevronRight, MoreHorizontal, Receipt } from 'lucide-react';
import { Box, Button, Callout, Card, DropdownMenu, Flex, Grid, Heading, IconButton, Table, Text } from '@radix-ui/themes';
import { billMonth, type BillOccurrence, type UnplacedBillPayment, billResolution } from '@nuggets/shared';
import { useBillForecastQuery, useBillMonthQuery, useResolveBillOccurrenceMutation, useUnlinkBillPaymentMutation } from '../hooks/queries';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import BillForecast from '../components/bills/BillForecast';
import { LinkPaymentDialog, MarkPaidDialog, PlacePaymentDialog, SkipDialog, StatusBadge } from '../components/bills/BillDialogs';
import { formatCurrency } from '../utils/currency';
import { DateUtils, todayLocal } from '../utils/dateUtils';
import PageContainer from '../components/PageContainer';

/** 'YYYY-MM' moved by `count` months. */
const shiftMonth = (month: string, count: number) => {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
};

const thisMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const monthTitle = (month: string) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1))
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

type Dialog =
  | { kind: 'link' | 'paid' | 'skip'; occurrence: BillOccurrence }
  | { kind: 'place'; payment: UnplacedBillPayment }
  | null;

/** What's paid, in words: "$92.50 on Nov 3", "$40 of $90 so far", or the note. */
const paidWords = (occurrence: BillOccurrence) => {
  if (occurrence.status === 'skipped') return occurrence.note ? `Skipped: ${occurrence.note}` : 'Skipped this time';
  if (occurrence.status === 'paid') {
    const how = occurrence.resolution === billResolution.enum.paid_manually ? ' (by hand)' : '';
    return `${formatCurrency(occurrence.paid)} on ${DateUtils.formatForDisplay(occurrence.paid_date ?? occurrence.due_date)}${how}`;
  }
  if (occurrence.paid > 0) return `${formatCurrency(occurrence.paid)} of ${formatCurrency(occurrence.expected)} so far`;
  return '—';
};

const BillsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('month');
  const month = requested && billMonth.safeParse(requested).success ? requested : thisMonth();
  const view = useBillMonthQuery(month);
  const forecast = useBillForecastQuery(12);
  const unlink = useUnlinkBillPaymentMutation();
  const resolve = useResolveBillOccurrenceMutation();
  const [dialog, setDialog] = useState<Dialog>(null);

  const goTo = (next: string) => setSearchParams(next === thisMonth() ? {} : { month: next });

  const undo = async (occurrence: BillOccurrence) => {
    try {
      await resolve.mutateAsync({ occurrenceUuid: occurrence.uuid, body: { resolution: null } });
      toast.success(occurrence.resolution === billResolution.enum.skipped ? 'No longer skipped' : 'No longer marked paid by hand');
    } catch {
      toast.error('Couldn’t undo that');
    }
  };

  const unlinkPayment = async (occurrence: BillOccurrence, transactionUuid: string) => {
    try {
      await unlink.mutateAsync({ occurrenceUuid: occurrence.uuid, transactionUuid });
      toast.success(`Unlinked from ${occurrence.bill.name}`);
    } catch {
      toast.error('Couldn’t unlink that payment');
    }
  };

  const actions = (occurrence: BillOccurrence) => (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <IconButton variant="ghost" color="gray" aria-label={`Actions for ${occurrence.bill.name}, due ${DateUtils.formatForDisplay(occurrence.due_date)}`}>
          <MoreHorizontal size={16} />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <DropdownMenu.Item onSelect={() => setDialog({ kind: 'link', occurrence })}>Link a payment…</DropdownMenu.Item>
        {occurrence.resolution === null ? (
          <>
            <DropdownMenu.Item onSelect={() => setDialog({ kind: 'paid', occurrence })}>Mark paid by hand…</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => setDialog({ kind: 'skip', occurrence })}>Skip this time…</DropdownMenu.Item>
          </>
        ) : (
          <DropdownMenu.Item onSelect={() => undo(occurrence)}>
            {occurrence.resolution === billResolution.enum.skipped ? 'Undo skip' : 'Undo paid by hand'}
          </DropdownMenu.Item>
        )}
        {occurrence.payments.length > 0 && <DropdownMenu.Separator />}
        {occurrence.payments.map((payment) => (
          <DropdownMenu.Item key={payment.transaction_uuid} onSelect={() => unlinkPayment(occurrence, payment.transaction_uuid)}>
            Unlink {formatCurrency(payment.amount)} on {DateUtils.formatForDisplay(payment.date)}
          </DropdownMenu.Item>
        ))}
        <DropdownMenu.Separator />
        <DropdownMenu.Item asChild>
          <Link to={`/budget-items/${occurrence.bill.uuid}/view`}>Open the bill</Link>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );

  const paymentLinks = (occurrence: BillOccurrence) =>
    occurrence.payments.map((payment) => (
      <Text key={payment.transaction_uuid} as="div" size="1">
        <Link to={`/transactions/${payment.transaction_uuid}`} className="text-[var(--accent-11)] hover:underline">
          {payment.description ?? 'Transaction'}
        </Link>
        <Text color="gray"> · {formatCurrency(payment.amount)}{payment.account ? ` · ${payment.account}` : ''}</Text>
      </Text>
    ));

  return (
    <PageContainer>
      <PageHeader
        title="Bills"
        subtitle="What’s due each month, and whether it’s paid"
        icon={<Receipt size={20} />}
        actions={(
          <Flex align="center" gap="2">
            <IconButton variant="soft" aria-label="Previous month" onClick={() => goTo(shiftMonth(month, -1))}>
              <ChevronLeft size={16} />
            </IconButton>
            <Text weight="bold" align="center" style={{ minWidth: '9rem' }} aria-live="polite">{monthTitle(month)}</Text>
            <IconButton variant="soft" aria-label="Next month" onClick={() => goTo(shiftMonth(month, 1))}>
              <ChevronRight size={16} />
            </IconButton>
            {month !== thisMonth() && <Button variant="ghost" onClick={() => goTo(thisMonth())}>This month</Button>}
          </Flex>
        )}
      />

      {view.isPending ? (
        <PageLoader label="Loading bills…" />
      ) : view.isError ? (
        <Callout.Root color="red" mb="6"><Callout.Text>Couldn’t load the bills. Try again in a moment.</Callout.Text></Callout.Root>
      ) : (
        <Flex direction="column" gap="6" mb="6">
          <Grid columns={{ initial: '1', sm: '3' }} gap="4">
            {([
              ['Expected', view.data.totals.expected],
              ['Paid', view.data.totals.paid],
              ['Still to pay', view.data.totals.remaining],
            ] as const).map(([label, amount]) => (
              <Card key={label}>
                <Text as="div" size="2" color="gray">{label}</Text>
                <Text as="div" size="6" weight="bold">{formatCurrency(amount)}</Text>
              </Card>
            ))}
          </Grid>

          <Card>
            {view.data.occurrences.length === 0 ? (
              <Flex direction="column" gap="2" p="4" align="center">
                <Text weight="medium">No bills due in {monthTitle(month)}.</Text>
                <Text size="2" color="gray" align="center">
                  Bills are budget items marked as bills, with an amount, how often they’re due, and a due date.
                  {month < view.data.today.slice(0, 7) && ' Months before bill tracking started have no due dates.'}
                </Text>
              </Flex>
            ) : (
              <>
                <Box display={{ initial: 'none', md: 'block' }}>
                  <Table.Root>
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeaderCell>Bill</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Due</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell justify="end">Expected</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Paid</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell><Text className="sr-only">Actions</Text></Table.ColumnHeaderCell>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {view.data.occurrences.map((occurrence) => (
                        <Table.Row key={occurrence.uuid} align="center">
                          <Table.RowHeaderCell>
                            <Link to={`/budget-items/${occurrence.bill.uuid}/view`} className="text-[var(--gray-12)] hover:underline">
                              {occurrence.bill.name}
                            </Link>
                            {occurrence.bill.varies && <Text size="1" color="gray"> (varies)</Text>}
                          </Table.RowHeaderCell>
                          <Table.Cell>{DateUtils.formatForDisplay(occurrence.due_date)}</Table.Cell>
                          <Table.Cell justify="end">{formatCurrency(occurrence.expected)}</Table.Cell>
                          <Table.Cell><StatusBadge status={occurrence.status} /></Table.Cell>
                          <Table.Cell>
                            <Text as="div" size="2">{paidWords(occurrence)}</Text>
                            {paymentLinks(occurrence)}
                          </Table.Cell>
                          <Table.Cell justify="end">{actions(occurrence)}</Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Root>
                </Box>

                <Flex direction="column" gap="3" display={{ initial: 'flex', md: 'none' }}>
                  {view.data.occurrences.map((occurrence) => (
                    <Card key={occurrence.uuid} variant="surface">
                      <Flex justify="between" align="start" gap="2">
                        <Flex direction="column" gap="1">
                          <StatusBadge status={occurrence.status} />
                          <Text weight="bold">{occurrence.bill.name}</Text>
                          <Text size="2" color="gray">
                            Due {DateUtils.formatForDisplay(occurrence.due_date)} · {formatCurrency(occurrence.expected)}
                          </Text>
                          <Text size="2">{paidWords(occurrence)}</Text>
                          {paymentLinks(occurrence)}
                        </Flex>
                        {actions(occurrence)}
                      </Flex>
                    </Card>
                  ))}
                </Flex>
              </>
            )}
          </Card>

          {view.data.unplaced.length > 0 && (
            <Card>
              <Flex direction="column" gap="3">
                <Flex direction="column" gap="1">
                  <Heading as="h2" size="4">Payments with no due date</Heading>
                  <Text size="2" color="gray">
                    Transactions in a bill this month that weren’t within 10 days of one of its due dates. Place each on the due date it pays.
                  </Text>
                </Flex>
                {view.data.unplaced.map((payment) => (
                  <Flex key={payment.transaction_uuid} justify="between" align="center" gap="3" wrap="wrap">
                    <Box>
                      <Text as="div" weight="medium">{payment.bill.name}</Text>
                      <Text as="div" size="2" color="gray">
                        {DateUtils.formatForDisplay(payment.date)} · {formatCurrency(payment.amount)}
                        {payment.description ? ` · ${payment.description}` : ''}
                      </Text>
                    </Box>
                    <Button variant="soft" onClick={() => setDialog({ kind: 'place', payment })}>Place it…</Button>
                  </Flex>
                ))}
              </Flex>
            </Card>
          )}
        </Flex>
      )}

      {forecast.data && <Box mb="6"><BillForecast months={forecast.data} /></Box>}

      <LinkPaymentDialog occurrence={dialog?.kind === 'link' ? dialog.occurrence : null} onClose={() => setDialog(null)} />
      <MarkPaidDialog
        occurrence={dialog?.kind === 'paid' ? dialog.occurrence : null}
        onClose={() => setDialog(null)}
        today={view.data?.today ?? todayLocal()}
      />
      <SkipDialog occurrence={dialog?.kind === 'skip' ? dialog.occurrence : null} onClose={() => setDialog(null)} />
      <PlacePaymentDialog payment={dialog?.kind === 'place' ? dialog.payment : null} onClose={() => setDialog(null)} />
    </PageContainer>
  );
};

export default BillsPage;
