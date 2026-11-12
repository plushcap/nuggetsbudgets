import React, { useState } from 'react';
import { Badge, Box, Button, Card, Flex, Heading, Table, Text } from '@radix-ui/themes';
import type { BillForecastMonth } from '@nuggets/shared';
import { formatCurrency } from '../../utils/currency';
import { DateUtils } from '../../utils/dateUtils';

const monthWords = (month: string, style: 'short' | 'long' = 'short') =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)).toLocaleDateString('en-US', {
    month: style,
    year: style === 'long' ? 'numeric' : '2-digit',
    timeZone: 'UTC',
  });

const basisWords = { expected: 'Expected', paid: 'Paid', skipped: 'Skipped' } as const;

/**
 * Expected bill spending for each of the coming months: a bar per month, and
 * the bills behind a month when it's opened.
 */
const BillForecast: React.FC<{ months: BillForecastMonth[] }> = ({ months }) => {
  const [open, setOpen] = useState<string | null>(null);
  const highest = Math.max(1, ...months.map((m) => m.total));
  const opened = months.find((m) => m.month === open);

  return (
    <Card>
      <Flex direction="column" gap="4">
        <Flex direction="column" gap="1">
          <Heading as="h2" size="4">Coming up</Heading>
          <Text size="2" color="gray">
            Expected bill spending for the next {months.length} months. Bills that vary use their last 3 payments. Choose a month to see its bills.
          </Text>
        </Flex>

        <Box overflowX="auto">
          <Flex gap="2" align="end" height="200px" style={{ minWidth: `${months.length * 64}px` }} role="list" aria-label="Expected bill spending by month">
            {months.map((m, index) => (
              <Flex key={m.month} direction="column" align="center" justify="end" gap="1" flexGrow="1" height="100%" role="listitem">
                <Text size="1" color="gray">{formatCurrency(m.total)}</Text>
                <Button
                  variant="ghost"
                  onClick={() => setOpen(open === m.month ? null : m.month)}
                  aria-pressed={open === m.month}
                  aria-label={`${monthWords(m.month, 'long')}: ${formatCurrency(m.total)} in ${m.items.length} bills`}
                  style={{ width: '100%', height: `${Math.max(4, (m.total / highest) * 140)}px`, padding: 0, margin: 0 }}
                >
                  <Box
                    width="100%"
                    height="100%"
                    className={`rounded-[var(--radius-2)] ${open === m.month || (!open && index === 0) ? 'bg-[var(--accent-9)]' : 'bg-[var(--accent-6)]'}`}
                  />
                </Button>
                <Text size="1" weight={index === 0 ? 'bold' : 'regular'}>{monthWords(m.month)}</Text>
              </Flex>
            ))}
          </Flex>
        </Box>

        {opened && (
          <Flex direction="column" gap="2">
            <Text size="2" weight="bold">{monthWords(opened.month, 'long')}: {formatCurrency(opened.total)}</Text>
            {opened.items.length === 0 ? (
              <Text size="2" color="gray">No bills are due this month.</Text>
            ) : (
              <Table.Root size="1">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell>Bill</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Due</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell justify="end">Amount</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell />
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {opened.items.map((item) => (
                    <Table.Row key={`${item.bill.uuid}-${item.due_date}`}>
                      <Table.Cell>{item.bill.name}{item.bill.varies && <Text color="gray"> (varies)</Text>}</Table.Cell>
                      <Table.Cell>{DateUtils.formatForDisplay(item.due_date)}</Table.Cell>
                      <Table.Cell justify="end">{formatCurrency(item.amount)}</Table.Cell>
                      <Table.Cell>
                        <Badge highContrast color={item.basis === 'paid' ? 'green' : 'gray'} variant="soft">{basisWords[item.basis]}</Badge>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            )}
          </Flex>
        )}
      </Flex>
    </Card>
  );
};

export default BillForecast;
