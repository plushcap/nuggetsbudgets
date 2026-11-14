import React from 'react';
import { Badge, Callout, Card, Flex, Text } from '@radix-ui/themes';
import { AlertTriangle, History, ShieldCheck } from 'lucide-react';
import { backupRunOutcome, backupVerifyOutcome } from '@nuggets/shared';
import type { BackupRun } from '../../services/api';
import { useBackupRunsQuery } from '../../hooks/queries';
import { formatInstantDate } from '../../utils/dateUtils';

/** What started a run, as the record says it. */
const TRIGGERS: Record<BackupRun['trigger'], string> = {
  manual: 'Started on this page',
  scheduled: 'Automatic',
  'before-deletion': 'Before deleting transactions',
};

/** A file's size, for people. */
function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

/** An instant, its day and time in this browser's zone and way of writing them. */
export const shownInstant = (instant: string) =>
  formatInstantDate(instant, undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * When a backup was last verified, and how it went: "Verified …", "Verify failed … (last
 * passed …)", "Never verified". Who, when the record says (the restore command's, or someone
 * since deleted, names no one).
 */
export function verifiedText(run: Pick<BackupRun, 'verifiedAt' | 'verifiedBy' | 'verifyOutcome' | 'passedVerifyAt'>): string {
  if (!run.verifiedAt) return 'Never verified';
  const by = run.verifiedBy ? ` by ${run.verifiedBy}` : '';
  if (run.verifyOutcome === backupVerifyOutcome.enum.passed) return `Verified ${shownInstant(run.verifiedAt)}${by}`;
  const lastPassed = run.passedVerifyAt ? ` (last passed ${shownInstant(run.passedVerifyAt)})` : '';
  return `Verify failed ${shownInstant(run.verifiedAt)}${by}${lastPassed}`;
}

/** A listed backup's last verify, from the record (nothing for a file the record doesn't have). */
export const VerifiedLine: React.FC<{ run: BackupRun | undefined }> = ({ run }) =>
  run ? (
    <Flex align="center" gap="1" mt="1">
      <ShieldCheck size={12} className="text-[var(--gray-11)]" aria-hidden />
      <Text size="1" color={run.verifyOutcome === backupVerifyOutcome.enum.failed ? 'red' : 'gray'}>
        {verifiedText(run)}
      </Text>
    </Flex>
  ) : null;

/**
 * The record of backups: every run this server made or tried, failures too, with when each
 * was last verified; and a notice when no backup has passed a verify for 90 days.
 */
const BackupRunsCard: React.FC = () => {
  const runsQuery = useBackupRunsQuery();
  const runs = runsQuery.data?.runs ?? [];
  return (
    <Card mt="8">
      <Flex direction="column" gap="4">
        <Flex align="center" gap="2" pb="4" className="border-b border-[var(--gray-4)]">
          <History size={24} className="text-[var(--gray-11)]" />
          <Text as="p" size="5" weight="bold">
            Backup runs
          </Text>
        </Flex>
        <Text size="2" color="gray">
          Every backup this server made or tried, failures too, and when each was last verified.
        </Text>
        {runsQuery.data?.verifyOverdue && (
          <Callout.Root color="amber" highContrast>
            <Callout.Icon>
              <AlertTriangle size={16} />
            </Callout.Icon>
            <Callout.Text>
              No backup has been verified in the last 90 days. Verify one to be sure it restores: it is restored into a
              scratch database and checked, and nothing is changed.
            </Callout.Text>
          </Callout.Root>
        )}
        {runsQuery.isError ? (
          <Text size="2" color="red">
            The record of backups couldn’t be loaded.
          </Text>
        ) : runs.length === 0 ? (
          <Text size="2" color="gray">
            {runsQuery.isLoading ? 'Loading…' : 'No backup has run yet.'}
          </Text>
        ) : (
          <Flex direction="column" gap="2" asChild>
            <ul aria-label="Backup runs">
              {runs.map((run) => (
                <li key={run.uuid} className="list-none">
                  <Card className="[--card-background-color:var(--gray-2)]">
                    <Flex direction={{ initial: 'column', sm: 'row' }} justify="between" gap="2">
                      <Flex direction="column" gap="1" minWidth="0">
                        <Flex align="center" gap="2" wrap="wrap">
                          {run.outcome === backupRunOutcome.enum.succeeded ? (
                            <Badge color="green" highContrast variant="soft">
                              Succeeded
                            </Badge>
                          ) : (
                            <Badge color="red" variant="soft">
                              Failed
                            </Badge>
                          )}
                          <Text size="2" weight="medium">
                            {shownInstant(run.startedAt)}
                          </Text>
                          <Text size="2" color="gray">
                            {TRIGGERS[run.trigger]}
                            {run.startedBy ? ` by ${run.startedBy}` : ''}
                          </Text>
                        </Flex>
                        {run.fileName && (
                          <Text size="1" color="gray" className="break-all">
                            {run.fileName}
                            {run.fileSize !== null ? ` · ${sizeOf(run.fileSize)}` : ''}
                          </Text>
                        )}
                        {run.message && (
                          <Text size="1" color="red">
                            {run.message}
                          </Text>
                        )}
                      </Flex>
                      {run.outcome === backupRunOutcome.enum.succeeded && (
                        <Flex align="center" gap="1" flexShrink="0">
                          <ShieldCheck size={14} className="text-[var(--gray-11)]" aria-hidden />
                          <Text size="1" color={run.verifyOutcome === backupVerifyOutcome.enum.failed ? 'red' : 'gray'}>
                            {verifiedText(run)}
                          </Text>
                        </Flex>
                      )}
                    </Flex>
                    {run.verifyOutcome === backupVerifyOutcome.enum.failed && run.verifyMessage && (
                      <Text as="p" size="1" color="red" mt="1">
                        {run.verifyMessage}
                      </Text>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          </Flex>
        )}
      </Flex>
    </Card>
  );
};

export default BackupRunsCard;
