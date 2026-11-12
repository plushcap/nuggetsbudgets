import React, { useMemo, useState } from 'react';
import { Dialog, Flex, Box, Text, Button, ScrollArea, Table, Callout, SegmentedControl, IconButton } from '@radix-ui/themes';
import { RefreshCw, AlertTriangle, Copy, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useSimpleFinAccountTransactionsQuery } from '../hooks/queries';
import type { SimpleFinRawTransaction } from '../services/api/simplefin';

interface SimpleFinAccountDetailDialogProps {
  accountId: string | null;
  accountName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Columns we know about go first, in this order; everything else (incl. flattened
// `extra.*`) is appended so the table faithfully shows ALL fields SimpleFin returns.
const PREFERRED_ORDER = ['posted', 'transacted_at', 'amount', 'description', 'payee', 'memo', 'pending', 'id'];
const DATE_COLUMNS = new Set(['posted', 'transacted_at']);

// Flatten a raw transaction: lift `extra` object keys to `extra.<k>` columns.
const flattenTxn = (t: SimpleFinRawTransaction): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) {
    if (k === 'extra' && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [ek, ev] of Object.entries(v as Record<string, unknown>)) out[`extra.${ek}`] = ev;
    } else {
      out[k] = v;
    }
  }
  return out;
};

const formatCell = (col: string, v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (DATE_COLUMNS.has(col) && typeof v === 'number') return new Date(v * 1000).toLocaleString();
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

export const SimpleFinAccountDetailDialog: React.FC<SimpleFinAccountDetailDialogProps> = ({
  accountId,
  accountName,
  open,
  onOpenChange,
}) => {
  const [days, setDays] = useState(60);
  const { data, isLoading, isError, error } = useSimpleFinAccountTransactionsQuery(open ? accountId : null, days, {
    meta: { suppressErrorToast: true },
  });

  const transactions = useMemo(() => data?.transactions ?? [], [data]);
  const rows = useMemo(() => transactions.map(flattenTxn), [transactions]);

  // Build the column list: preferred (present) first, then the rest, extra.* last.
  const columns = useMemo(() => {
    const present = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r)) present.add(k);
    const ordered = PREFERRED_ORDER.filter((c) => present.has(c));
    const rest = [...present].filter((c) => !ordered.includes(c));
    const nonExtra = rest.filter((c) => !c.startsWith('extra.')).sort();
    const extra = rest.filter((c) => c.startsWith('extra.')).sort();
    return [...ordered, ...nonExtra, ...extra];
  }, [rows]);

  const copyJson = () => {
    void navigator.clipboard.writeText(JSON.stringify(transactions, null, 2)).then(
      () => toast.success('Copied JSON to clipboard'),
      () => toast.error('Could not copy'),
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="95vw" width="1100px">
        <Flex align="start" justify="between" gap="3" mb="2">
          <Box>
            <Dialog.Title mb="1">{accountName}</Dialog.Title>
            <Dialog.Description size="2" color="gray">
              Live from SimpleFin · last {days} days · {transactions.length} transaction{transactions.length !== 1 ? 's' : ''} ·
              not stored (research only)
            </Dialog.Description>
          </Box>
          <Dialog.Close>
            <IconButton variant="ghost" color="gray" aria-label="Close"><X size={16} /></IconButton>
          </Dialog.Close>
        </Flex>

        <Flex align="center" justify="between" gap="3" mb="3" wrap="wrap">
          <SegmentedControl.Root aria-label="Days of history" value={String(days)} onValueChange={(v) => setDays(Number(v))} size="1">
            <SegmentedControl.Item value="30">30d</SegmentedControl.Item>
            <SegmentedControl.Item value="60">60d</SegmentedControl.Item>
            <SegmentedControl.Item value="90">90d</SegmentedControl.Item>
          </SegmentedControl.Root>
          <Button variant="soft" color="gray" size="1" onClick={copyJson} disabled={transactions.length === 0}>
            <Copy size={12} />
            Copy JSON
          </Button>
        </Flex>

        {data?.errors && data.errors.length > 0 && (
          <Callout.Root highContrast color="amber" size="1" mb="3">
            <Callout.Icon><AlertTriangle size={16} /></Callout.Icon>
            <Callout.Text>{data.errors.map((e) => e.msg).join(' · ')}</Callout.Text>
          </Callout.Root>
        )}

        {isLoading ? (
          <Flex align="center" justify="center" gap="2" py="8">
            <RefreshCw size={20} className="animate-spin text-[var(--accent-11)]" />
            <Text size="2" color="gray">Pulling live data from SimpleFin…</Text>
          </Flex>
        ) : isError ? (
          <Callout.Root color="red">
            <Callout.Icon><AlertTriangle size={16} /></Callout.Icon>
            <Callout.Text>{(error as Error)?.message || 'Failed to load account detail'}</Callout.Text>
          </Callout.Root>
        ) : transactions.length === 0 ? (
          <Flex align="center" justify="center" py="8">
            <Text size="2" color="gray">No transactions in the last {days} days.</Text>
          </Flex>
        ) : (
          <ScrollArea scrollbars="both" style={{ maxHeight: '60vh' }}>
            <Table.Root variant="surface" size="1" style={{ minWidth: `${Math.max(columns.length * 140, 600)}px` }}>
              <Table.Header>
                <Table.Row>
                  {columns.map((c) => (
                    <Table.ColumnHeaderCell key={c} className="whitespace-nowrap">{c}</Table.ColumnHeaderCell>
                  ))}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((r, i) => (
                  <Table.Row key={(r.id as string) ?? i}>
                    {columns.map((c) => (
                      <Table.Cell key={c} className="whitespace-nowrap">
                        <Text size="1" className="font-mono">{formatCell(c, r[c])}</Text>
                      </Table.Cell>
                    ))}
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </ScrollArea>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default SimpleFinAccountDetailDialog;
