import React, { useId } from 'react';
import { Card, Flex, Box, Text, Button, TextField, Heading, Badge, Switch, Table } from '@radix-ui/themes';
import { TrendingUp, Play } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  usePriceSyncSettingsQuery,
  usePriceSyncRunsQuery,
  useUpdatePriceSyncSettingsMutation,
  useRunPriceSyncMutation,
} from '../hooks/queries/organizations';
import { useSeededState } from '../hooks/useSeededState';

const statusColor = (s: string): 'green' | 'amber' | 'red' | 'gray' =>
  s === 'success' ? 'green' : s === 'partial' ? 'amber' : s === 'error' ? 'red' : 'gray';

const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

/**
 * Org-admin control of scheduled EOD price syncing: on/off switch, daily
 * schedule, a manual "Run now", and the run-results log. Prices are fetched
 * server-side (Stooq) into each ledger and a portfolio value snapshot is taken,
 * powering the investment equity curve.
 */
const PriceSyncCard: React.FC<{ orgUuid: string }> = ({ orgUuid }) => {
  const fieldId = useId();
  const { data: settings, isLoading } = usePriceSyncSettingsQuery(orgUuid);
  const { data: runsPage } = usePriceSyncRunsQuery(orgUuid);
  const update = useUpdatePriceSyncSettingsMutation();
  const run = useRunPriceSyncMutation();

  // The schedule fields, seeded from the saved settings each time they load. The defaults
  // are the server's: 17:00 US Eastern, just after the US markets close (deliberately the
  // exchanges' clock, not the household's zone; PriceSyncService.ts).
  const [time, setTime] = useSeededState<string>((current) => settings?.schedule_time ?? current ?? '17:00', [settings]);
  const [timezone, setTimezone] = useSeededState<string>(
    (current) => settings?.timezone ?? current ?? 'America/New_York',
    [settings],
  );

  const toggleEnabled = async (enabled: boolean) => {
    try {
      await update.mutateAsync({ uuid: orgUuid, input: { enabled } });
      toast.success(enabled ? 'Price sync enabled' : 'Price sync disabled');
    } catch {
      toast.error('Failed to update price sync');
    }
  };

  const saveSchedule = async () => {
    try {
      await update.mutateAsync({ uuid: orgUuid, input: { schedule_time: time, timezone } });
      toast.success('Schedule saved');
    } catch {
      toast.error('Failed to save schedule');
    }
  };

  const runNow = async () => {
    try {
      const res = await run.mutateAsync(orgUuid);
      toast.success(`Sync ${res.status}: ${res.prices_updated} prices updated`);
    } catch {
      toast.error('Manual sync failed');
    }
  };

  const runs = runsPage?.runs ?? [];

  return (
    <Card>
      <Flex direction="column" gap="3" p="2">
        <Flex align="center" justify="between" wrap="wrap" gap="2">
          <Flex align="center" gap="2">
            <TrendingUp size={18} />
            <Heading size="3" id={`${fieldId}-title`}>Investment price sync</Heading>
          </Flex>
          <Flex align="center" gap="2">
            <Text size="2" color="gray">{settings?.enabled ? 'On' : 'Off'}</Text>
            <Switch
              aria-labelledby={`${fieldId}-title`}
              checked={!!settings?.enabled}
              onCheckedChange={toggleEnabled}
              disabled={isLoading || update.isPending}
            />
          </Flex>
        </Flex>

        <Text size="2" color="gray">
          Fetches end-of-day closing prices (via Stooq) on a daily schedule and snapshots your portfolio value, building the
          investment equity curve. Runs across all ledgers in this organization.
        </Text>

        <Flex gap="3" wrap="wrap" align="end">
          <Box>
            <Text as="label" htmlFor={`${fieldId}-time`} size="1" color="gray" mb="1" style={{ display: 'block' }}>Daily run time</Text>
            <TextField.Root id={`${fieldId}-time`} type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ width: 130 }} />
          </Box>
          <Box>
            <Text as="label" htmlFor={`${fieldId}-timezone`} size="1" color="gray" mb="1" style={{ display: 'block' }}>Timezone (IANA)</Text>
            <TextField.Root id={`${fieldId}-timezone`} value={timezone} onChange={(e) => setTimezone(e.target.value)} style={{ width: 220 }} />
          </Box>
          <Button variant="soft" onClick={saveSchedule} loading={update.isPending}>Save schedule</Button>
          <Button onClick={runNow} loading={run.isPending}><Play size={16} /> Run now</Button>
        </Flex>

        {settings?.last_run_at && (
          <Text size="1" color="gray">Last run: {fmtTime(settings.last_run_at)}</Text>
        )}

        <Box>
          <Heading size="2" mb="2">Recent runs</Heading>
          {runs.length === 0 ? (
            <Text size="2" color="gray">No runs yet.</Text>
          ) : (
            <Table.Root variant="surface" size="1">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Started</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Trigger</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell align="right">Prices</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell align="right">Snapshots</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Notes</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {runs.map((r) => (
                  <Table.Row key={r.uuid}>
                    <Table.Cell>{fmtTime(r.started_at)}</Table.Cell>
                    <Table.Cell><Badge color={statusColor(r.run_status)} variant="soft">{r.run_status}</Badge></Table.Cell>
                    <Table.Cell><Text size="1" color="gray">{r.run_trigger}</Text></Table.Cell>
                    <Table.Cell align="right">{r.prices_updated}{r.prices_failed ? ` (${r.prices_failed} failed)` : ''}</Table.Cell>
                    <Table.Cell align="right">{r.snapshots_written}</Table.Cell>
                    <Table.Cell><Text size="1" color={r.error_message ? 'red' : 'gray'}>{r.error_message ?? '—'}</Text></Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          )}
        </Box>
      </Flex>
    </Card>
  );
};

export default PriceSyncCard;
