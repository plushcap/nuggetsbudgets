import React from 'react';
import { Box, Callout, Flex, Text } from '@radix-ui/themes';
import { AlertTriangle, Info } from 'lucide-react';
import type { RestoreCarryOver, RestoreStatus } from '@nuggets/shared';
import { useLastRestoreQuery } from '../../hooks/queries';
import { shownInstant } from './BackupRunsCard';

/** How long a failed restore is shown for. */
const FAILED_SHOWN_MS = 24 * 60 * 60 * 1000;

/** Where a membership was removed: an organization, or a ledger. */
const placeOf = (removed: RestoreCarryOver['removedSince'][number]) =>
  `${removed.kind === 'organization' ? 'organization' : 'ledger'} “${removed.name}”`;

/** What the restore did to signing in and the server's settings, in sentences. */
export function carryOverSentences(carryOver: RestoreCarryOver): string[] {
  const sentences = ['It signed everyone out and ended every access token and pending invitation.'];
  if (carryOver.ended.notifications > 0) {
    sentences.push(`${carryOver.ended.notifications} notification(s) the backup had queued won’t be sent.`);
  }
  if (!carryOver.tookFromRunningServer) {
    sentences.push('It took nothing from the data it replaced.');
  } else if (carryOver.sameDeployment) {
    sentences.push('Locks, changed passwords, removed passkeys and removed deployment roles were kept as they were before the restore.');
    if (carryOver.lockedDeletedSince > 0) {
      sentences.push(`${carryOver.lockedDeletedSince} person(s) deleted since the backup are back, but locked.`);
    }
  }
  if (carryOver.kept.backupKeys) sentences.push('This server’s backup keys were kept.');
  if (carryOver.kept.oneDriveConnections > 0 || carryOver.kept.oneDriveRegistration) sentences.push('This server’s OneDrive connection was kept.');
  return sentences;
}

/**
 * After a restore, how it went: shown on the Backup page once its admin has signed in again
 * (a restore ends every sign-in, so the page that started it can only say to sign in), while
 * the server keeps the last restore's outcome. A finished one says what it did and lists the
 * memberships removed since the backup that the restored data still has, to remove again; a
 * failed one says why, and whether the data was replaced.
 */
const LastRestoreCallout: React.FC = () => {
  const { data, dataUpdatedAt } = useLastRestoreQuery({ meta: { suppressErrorToast: true } });
  const restore: RestoreStatus | undefined = data;
  const named = restore?.fileName ? ` (${restore.fileName})` : '';
  const when = restore?.finishedAt ? ` ${shownInstant(restore.finishedAt)}` : '';
  // A failure for a day after it (by when the status was read): the page that started it may
  // only have said to sign in.
  if (restore?.status === 'failed' && restore.finishedAt && dataUpdatedAt - Date.parse(restore.finishedAt) < FAILED_SHOWN_MS) {
    return (
      <Callout.Root mb="6" color="red" role="status">
        <Callout.Icon>
          <AlertTriangle size={16} />
        </Callout.Icon>
        <Callout.Text>
          The last restore{named} failed{when}: {(restore.error ?? 'the server log says why').replace(/\.$/, '')}.{' '}
          {restore.databaseChanged ? 'The data was replaced: see the server log.' : 'The data is as it was before it.'}
        </Callout.Text>
      </Callout.Root>
    );
  }
  if (restore?.status !== 'completed' || !restore.carryOver) return null;
  const { carryOver } = restore;
  return (
    <Callout.Root mb="6" role="status">
      <Callout.Icon>
        <Info size={16} />
      </Callout.Icon>
      <Flex direction="column" gap="2">
        <Callout.Text>
          The last restore{named} finished{when}. {carryOverSentences(carryOver).join(' ')}
        </Callout.Text>
        {carryOver.removedSince.length > 0 && (
          <>
            <Callout.Text>
              Removed since the backup, but still there in the restored data. Remove them again in the organization’s or
              ledger’s members:
            </Callout.Text>
            <Box asChild m="0" pl="5">
              <ul aria-label="Memberships to remove again">
                {carryOver.removedSince.map((removed) => (
                  <li key={`${removed.person} ${removed.kind} ${removed.name} ${removed.change}`}>
                    <Text size="2">
                      {removed.person}: {removed.change === 'admin' ? 'admin of' : 'member of'} {placeOf(removed)}
                    </Text>
                  </li>
                ))}
              </ul>
            </Box>
          </>
        )}
      </Flex>
    </Callout.Root>
  );
};

export default LastRestoreCallout;
