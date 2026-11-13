import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import BackupRunsCard from '../backup/BackupRunsCard';
import LastRestoreCallout, { carryOverSentences } from '../backup/LastRestoreCallout';
import type { BackupRun, RestoreCarryOver, RestoreStatus } from '@nuggets/shared';

const api = vi.hoisted(() => ({ runs: vi.fn(), restoreStatus: vi.fn() }));
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  getBackupRuns: () => api.runs(),
  getRestoreStatus: () => api.restoreStatus(),
}));

const run = (overrides: Partial<BackupRun> = {}): BackupRun => ({
  uuid: crypto.randomUUID(),
  startedAt: '2026-11-10T03:00:00.000Z',
  finishedAt: '2026-11-10T03:01:00.000Z',
  trigger: 'scheduled',
  outcome: 'succeeded',
  message: null,
  fileName: 'nuggets_backup_20261110_030000_000.tar.age',
  fileSize: 3 * 1024 * 1024,
  sha256: 'ab'.repeat(32),
  recipients: [],
  startedBy: null,
  verifiedAt: null,
  verifiedBy: null,
  verifyOutcome: null,
  verifyMessage: null,
  ...overrides,
});

const carryOver = (overrides: Partial<RestoreCarryOver> = {}): RestoreCarryOver => ({
  tookFromRunningServer: true,
  sameDeployment: true,
  ended: { sessions: 3, challenges: 0, tokens: 1, invitations: 0, notifications: 2 },
  taken: { locks: 1, passwords: 0, passkeysRemoved: 0, passkeyCounters: 0, deploymentRoles: 0, loginThrottles: 0, deliveries: 0 },
  lockedDeletedSince: 1,
  kept: { backupKeys: true, oneDriveRegistration: false, oneDriveConnections: 1, backupRuns: true, automaticBackupsKeptOn: false },
  removedSince: [],
  ...overrides,
});

describe('BackupRunsCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists every run, failures too, with what started it and its last verify', async () => {
    api.runs.mockResolvedValue({
      runs: [
        run({ trigger: 'manual', startedBy: 'Ada Admin', verifiedAt: '2026-11-11T10:00:00.000Z', verifiedBy: 'Ada Admin', verifyOutcome: 'passed' }),
        run({ outcome: 'failed', message: 'No backup key has been set up.', fileName: null, fileSize: null }),
        run({ verifiedAt: '2026-11-11T10:00:00.000Z', verifyOutcome: 'failed', verifyMessage: 'The backup is damaged' }),
      ],
      lastVerifiedAt: '2026-11-11T10:00:00.000Z',
      verifyOverdue: false,
    });
    renderWithProviders(<Theme><BackupRunsCard /></Theme>);
    const items = within(await screen.findByRole('list', { name: 'Backup runs' })).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent(/Succeeded.*Started on this page by Ada Admin/);
    expect(items[0]).toHaveTextContent('3.0 MB');
    expect(items[0]).toHaveTextContent(/Verified .* by Ada Admin/);
    expect(items[1]).toHaveTextContent(/Failed.*Automatic/);
    expect(items[1]).toHaveTextContent('No backup key has been set up.');
    expect(items[1]).not.toHaveTextContent(/verified/i);
    expect(items[2]).toHaveTextContent(/Verify failed .* with the restore command/);
    expect(items[2]).toHaveTextContent('The backup is damaged');
    expect(screen.queryByText(/No backup has been verified/)).not.toBeInTheDocument();
  });

  it('says when no backup has been verified for 90 days', async () => {
    api.runs.mockResolvedValue({ runs: [run()], lastVerifiedAt: null, verifyOverdue: true });
    renderWithProviders(<Theme><BackupRunsCard /></Theme>);
    expect(await screen.findByText(/No backup has been verified in the last 90 days/)).toBeInTheDocument();
    expect(screen.getByText('Never verified')).toBeInTheDocument();
  });
});

describe('LastRestoreCallout', () => {
  beforeEach(() => vi.clearAllMocks());

  const completed = (over: Partial<RestoreStatus> = {}): RestoreStatus => ({
    status: 'completed',
    fileName: 'nuggets_backup_20261101_030000_000.tar.age',
    finishedAt: '2026-11-13T20:00:00.000Z',
    databaseChanged: true,
    carryOver: carryOver(),
    ...over,
  });

  it('says what the last restore did, and lists the memberships to remove again, in ledger words', async () => {
    api.restoreStatus.mockResolvedValue(
      completed({
        carryOver: carryOver({
          removedSince: [
            { person: 'c@example.com', kind: 'organization', name: 'The Smiths', change: 'member' },
            { person: 'c@example.com', kind: 'tenant', name: 'Household', change: 'admin' },
          ],
        }),
      })
    );
    renderWithProviders(<Theme><LastRestoreCallout /></Theme>);
    expect(await screen.findByText(/The last restore \(nuggets_backup_20261101_030000_000\.tar\.age\) finished/)).toBeInTheDocument();
    expect(screen.getByText(/signed everyone out/)).toBeInTheDocument();
    const items = within(screen.getByRole('list', { name: 'Memberships to remove again' })).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'c@example.com: member of organization “The Smiths”',
      'c@example.com: admin of ledger “Household”',
    ]);
  });

  it('shows nothing before a restore, while one runs, or after one failed', async () => {
    for (const status of [{ status: 'idle' }, { status: 'running', phase: 'migrating' }, { status: 'failed', error: 'refused' }] as RestoreStatus[]) {
      api.restoreStatus.mockResolvedValue(status);
      const { unmount } = renderWithProviders(<Theme><LastRestoreCallout /></Theme>);
      await vi.waitFor(() => expect(api.restoreStatus).toHaveBeenCalled());
      expect(screen.queryByText(/The last restore/)).not.toBeInTheDocument();
      unmount();
      api.restoreStatus.mockClear();
    }
  });

  it('puts what it took and kept in sentences', () => {
    expect(carryOverSentences(carryOver())).toEqual([
      'It signed everyone out and ended every access token and pending invitation.',
      '2 notification(s) the backup had queued won’t be sent.',
      'Locks, changed passwords, removed passkeys and removed deployment roles were kept as they were before the restore.',
      '1 person(s) deleted since the backup are back, but locked.',
      'This server’s backup keys were kept.',
      'This server’s OneDrive connection was kept.',
    ]);
    expect(carryOverSentences(carryOver({ tookFromRunningServer: false, sameDeployment: false, kept: { ...carryOver().kept, backupKeys: false, oneDriveConnections: 0 } }))).toEqual([
      'It signed everyone out and ended every access token and pending invitation.',
      '2 notification(s) the backup had queued won’t be sent.',
      'It took nothing from the data it replaced.',
    ]);
  });
});
