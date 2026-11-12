import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import BackupPage from '../BackupPage';
import { SessionExpiredError } from '../../services/api/base';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ toast, default: toast }));
vi.mock('../../components/OneDriveSync', () => ({ default: () => null }));

const api = vi.hoisted(() => ({
  schedulerStatus: vi.fn(),
  createStatus: vi.fn(),
  backups: vi.fn(),
  onedriveStatus: vi.fn(),
  uploadStatus: vi.fn(),
  restoreFromServer: vi.fn(),
  restoreStatus: vi.fn(),
}));
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    getBackupSchedulerStatus: () => api.schedulerStatus(),
    getBackupSettings: async () => ({ settings: {} }),
    getDeploymentSettings: async () => ({ settings: { application_timezone: 'UTC' } }),
    getAvailableTimezones: async () => [{ value: 'UTC', label: 'UTC', offset: 'UTC+0' }],
    getBackups: () => api.backups(),
    getOneDriveStatus: () => api.onedriveStatus(),
    checkBackupOneDriveStatus: (fileNames: string[]) => api.uploadStatus(fileNames),
    getBackupKeyStatus: async () => ({ exists: true, downloaded: true }),
    createBackup: async () => ({ success: true, started: true }),
    getBackupCreateStatus: () => api.createStatus(),
    restoreBackupFromServer: (fileName: string, key?: string) => api.restoreFromServer(fileName, key),
    getRestoreStatus: () => api.restoreStatus(),
  };
});

const renderPage = () => renderWithProviders(<Theme><BackupPage /></Theme>, { route: '/settings/backup' });

const scheduler = (overrides: Record<string, unknown>) => ({
  configured: true,
  enabled: true,
  scheduler: { running: true, nextBackupTime: '2026-01-17T03:00:00.000Z', lastRunOutcome: null, lastRunFinishedAt: null, ...overrides },
});

describe('BackupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.schedulerStatus.mockResolvedValue(scheduler({}));
    api.backups.mockResolvedValue({ backups: [] });
    api.onedriveStatus.mockResolvedValue({ configured: false, connected: false });
    api.uploadStatus.mockResolvedValue({ status: {} });
  });

  it("checks the OneDrive copies of the first page's backups, and of each page it goes to", async () => {
    const names = Array.from({ length: 7 }, (_, i) => `nuggets-backup-${i}.enc`);
    api.backups.mockResolvedValue({
      backups: names.map((fileName) => ({ fileName, size: 1, sizeFormatted: '1 B', created: '2026-01-01T00:00:00.000Z' })),
    });
    api.onedriveStatus.mockResolvedValue({ configured: true, connected: true });
    renderPage();
    await waitFor(() => expect(api.uploadStatus).toHaveBeenCalledWith(names.slice(0, 5)));

    await userEvent.click(await screen.findByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('nuggets-backup-6.enc')).toBeInTheDocument();
    await waitFor(() => expect(api.uploadStatus).toHaveBeenLastCalledWith(names.slice(5)));
    expect(api.onedriveStatus).toHaveBeenCalledTimes(1);
  });

  it('tells the admin when the last automatic backup failed', async () => {
    api.schedulerStatus.mockResolvedValue(scheduler({ lastRunOutcome: 'failed', lastRunFinishedAt: '2026-01-10T12:00:10.000Z' }));
    renderPage();
    expect(await screen.findByText(/The last automatic backup failed/)).toBeInTheDocument();
  });

  it('says automatic backups wait for a backup key, and keeps their switch on', async () => {
    api.schedulerStatus.mockResolvedValue(scheduler({ running: false, waitingForBackupKey: true, nextBackupTime: undefined }));
    renderPage();
    expect(await screen.findByText('Waiting for a backup key')).toBeInTheDocument();
    expect(screen.getByText(/They start once you generate one/)).toBeInTheDocument();
    expect(await screen.findByRole('switch', { name: 'Enable automatic backups' })).toBeChecked();
  });

  it('says nothing about a last run that succeeded', async () => {
    api.schedulerStatus.mockResolvedValue(scheduler({ lastRunOutcome: 'success', lastRunFinishedAt: '2026-01-10T12:00:10.000Z' }));
    renderPage();
    expect(await screen.findByText(/Next automatic backup/)).toBeInTheDocument();
    expect(screen.queryByText(/The last automatic backup failed/)).not.toBeInTheDocument();
  });

  it('stops waiting for a manual backup once the server has restarted', async () => {
    // The server forgets a manual backup when it restarts, and reports 'idle'.
    api.createStatus.mockResolvedValue({ status: 'idle' });
    renderPage();
    const create = await screen.findByRole('button', { name: 'Create Backup' });
    await waitFor(() => expect(create).toBeEnabled());
    await userEvent.click(create);

    await waitFor(
      () => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/server restarted before the backup finished/)),
      { timeout: 6000 }
    );
    expect(api.createStatus).toHaveBeenCalledTimes(1);
  });

  // The file to restore was a raw, hand-styled file input; it is a button the theme
  // draws (FilePickerButton), described by the field's caption, and the file shows below it.
  it('chooses the backup file to restore from a button, and shows it', async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderPage();
    const choose = await screen.findByRole('button', { name: 'Choose backup file' });
    expect(choose).toHaveAccessibleDescription('Backup File (.enc)');
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input).toHaveAttribute('tabindex', '-1');
    expect(input.accept).toBe('.enc');
    await user.upload(input, new File(['x'], 'notes.txt', { type: 'text/plain' }));
    expect(toast.error).toHaveBeenCalledWith('Please select a .enc backup file');
    await user.upload(input, new File(['x'], 'nuggets_backup.enc', { type: 'application/octet-stream' }));
    expect(screen.getByText('nuggets_backup.enc')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose another backup file' })).toBeInTheDocument();
  });

  describe('restoring a backup on the server', () => {
    const listed = { fileName: 'nuggets_backup_20261101_030000_000.enc', size: 1, sizeFormatted: '1 B', created: '2026-11-01T03:00:00.000Z' };

    async function restoreListed() {
      api.backups.mockResolvedValue({ backups: [listed] });
      api.restoreFromServer.mockResolvedValue({ success: true, started: true });
      renderPage();
      await userEvent.click(await screen.findByRole('button', { name: 'Restore this backup' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Restore Database' }));
    }

    it("follows the restore the server runs, with this server's key when none is typed", async () => {
      api.restoreStatus
        .mockResolvedValueOnce({ status: 'running', phase: 'migrating' })
        .mockResolvedValue({ status: 'completed', databaseChanged: true });
      const reload = vi.fn();
      vi.stubGlobal('location', { ...window.location, reload });
      try {
        await restoreListed();
        expect(api.restoreFromServer).toHaveBeenCalledWith(listed.fileName, undefined);
        expect(await screen.findByText(/Bringing it up to this version/)).toBeInTheDocument();
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/Backup restored/)), { timeout: 6000 });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("shows why the server refused it", async () => {
      api.restoreStatus.mockResolvedValue({ status: 'failed', databaseChanged: false, error: "This backup can't be restored here because it is not signed by this server" });
      await restoreListed();
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/not signed by this server/)), { timeout: 6000 });
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('says to sign in again when the restored data no longer has this sign-in', async () => {
      api.restoreStatus.mockRejectedValue(new SessionExpiredError());
      await restoreListed();
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/sign in again/)), { timeout: 6000 });
      expect(toast.error).not.toHaveBeenCalled();
    });
  });
});
