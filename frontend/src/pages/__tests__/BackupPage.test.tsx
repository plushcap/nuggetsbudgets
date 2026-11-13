import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import BackupPage from '../BackupPage';
import { SessionExpiredError } from '../../services/api/base';
import { backupKeys, backupRecipient } from '../../test/fixtures';

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
  restoreUpload: vi.fn(),
  restoreStatus: vi.fn(),
  reauthStatus: vi.fn(),
  reauthWithPassword: vi.fn(),
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
    getBackupKeys: async () => backupKeys({ recipients: [backupRecipient()] }),
    createBackup: async () => ({ success: true, started: true }),
    getBackupCreateStatus: () => api.createStatus(),
    restoreBackupFromServer: (fileName: string, keys: unknown) => api.restoreFromServer(fileName, keys),
    restoreBackup: (formData: FormData) => api.restoreUpload(formData),
    getRestoreStatus: () => api.restoreStatus(),
    getReauthStatus: () => api.reauthStatus(),
    reauthenticateWithPassword: (password: string) => api.reauthWithPassword(password),
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
    api.reauthStatus.mockResolvedValue({ reauthenticated: true });
    api.reauthWithPassword.mockResolvedValue({ reauthenticated: true, validForSeconds: 300 });
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
    expect(screen.getByText(/They start once you make or add one under Backup keys/)).toBeInTheDocument();
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
    expect(choose).toHaveAccessibleDescription(expect.stringMatching(/^Backup File \(\.tar\.age, or an older \.enc\) Restore and Verify ask for the private key/));
    const input = choose.parentElement!.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input).toHaveAttribute('tabindex', '-1');
    expect(input.accept).toBe('.tar.age,.age,.enc');
    await user.upload(input, new File(['x'], 'notes.txt', { type: 'text/plain' }));
    expect(toast.error).toHaveBeenCalledWith('Please select a backup file (.tar.age, or an older .enc)');
    await user.upload(input, new File(['x'], 'nuggets_backup.tar.age', { type: 'application/octet-stream' }));
    expect(screen.getByText('nuggets_backup.tar.age')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose another backup file' })).toBeInTheDocument();
  });

  describe('restoring a backup on the server', () => {
    // An older .enc backup: the prompt asks for the old key, which may be left empty.
    const listed = { fileName: 'nuggets_backup_20261101_030000_000.enc', size: 1, sizeFormatted: '1 B', created: '2026-11-01T03:00:00.000Z', format: 'legacy' };

    async function restoreListed() {
      api.backups.mockResolvedValue({ backups: [listed] });
      api.restoreFromServer.mockResolvedValue({ success: true, started: true });
      renderPage();
      await userEvent.click(await screen.findByRole('button', { name: 'Restore this backup' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Restore Database' }));
    }

    it("follows the restore the server runs, with this server's old key when none is typed", async () => {
      api.restoreStatus
        .mockResolvedValueOnce({ status: 'running', phase: 'migrating' })
        .mockResolvedValue({ status: 'completed', databaseChanged: true });
      const reload = vi.fn();
      vi.stubGlobal('location', { ...window.location, reload });
      try {
        await restoreListed();
        expect(api.restoreFromServer).toHaveBeenCalledWith(listed.fileName, {});
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

  // A restore takes step-up. The page asks before it sends anything: the server checks it
  // before it reads an upload, but a browser may send the whole file before it reads a refusal.
  describe('confirming it is you before a restore', () => {
    const listed = { fileName: 'nuggets_backup_20261101_030000_000.enc', size: 1, sizeFormatted: '1 B', created: '2026-11-01T03:00:00.000Z', format: 'legacy' };
    const reauthRequired = () =>
      Object.assign(new Error('Confirm your password or passkey to continue'), {
        status: 403,
        response: { data: { error: 'Confirm your password or passkey to continue', code: 'REAUTH_REQUIRED' } },
      });

    /**
     * A restore that was sent ends here (its status says it stopped). Awaited in each test that
     * sends one: the page reads the status 2 s later, and a toast after the test ends would
     * land in the next one's.
     */
    const restoreEnded = () =>
      waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to restore backup: stopped here'), { timeout: 6000 });

    beforeEach(() => {
      api.restoreStatus.mockResolvedValue({ status: 'failed', databaseChanged: false, error: 'stopped here' });
      api.restoreFromServer.mockResolvedValue({ success: true, started: true });
      api.restoreUpload.mockResolvedValue({ success: true, started: true });
    });

    /** Choose an older .enc backup on this computer, and ask to restore it. */
    async function restoreUpload() {
      const user = userEvent.setup({ applyAccept: false });
      renderPage();
      const choose = await screen.findByRole('button', { name: 'Choose backup file' });
      const input = choose.parentElement!.querySelector<HTMLInputElement>('input[type="file"]')!;
      await user.upload(input, new File([new Uint8Array([2, 1, 2, 3])], listed.fileName, { type: 'application/octet-stream' }));
      await user.click(screen.getByRole('button', { name: /^Restore/ }));
      await user.click(await screen.findByRole('button', { name: 'Continue' }));
      await user.click(await screen.findByRole('button', { name: 'Restore Database' }));
      return user;
    }

    it('asks for the password before uploading a backup, then uploads it once', async () => {
      api.reauthStatus.mockResolvedValue({ reauthenticated: false });
      const user = await restoreUpload();
      const prompt = await screen.findByRole('dialog', { name: /Confirm it’s you/ });
      expect(api.restoreUpload).not.toHaveBeenCalled();
      await user.type(within(prompt).getByLabelText('Password'), 'S3cret!pass');
      await user.click(within(prompt).getByRole('button', { name: 'Confirm' }));
      await waitFor(() => expect(api.restoreUpload).toHaveBeenCalledTimes(1));
      expect(api.reauthWithPassword).toHaveBeenCalledWith('S3cret!pass');
      const form = api.restoreUpload.mock.calls[0][0] as FormData;
      expect((form.get('backup') as File).name).toBe(listed.fileName);
      await restoreEnded();
    });

    it('uploads without asking when the session confirmed in the last few minutes', async () => {
      await restoreUpload();
      await waitFor(() => expect(api.restoreUpload).toHaveBeenCalledTimes(1));
      expect(api.reauthStatus).toHaveBeenCalled();
      expect(screen.queryByRole('dialog', { name: /Confirm it’s you/ })).not.toBeInTheDocument();
      expect(api.reauthWithPassword).not.toHaveBeenCalled();
      await restoreEnded();
    });

    it('sends nothing when the prompt is closed, and says nothing went wrong', async () => {
      api.reauthStatus.mockResolvedValue({ reauthenticated: false });
      const user = await restoreUpload();
      const prompt = await screen.findByRole('dialog', { name: /Confirm it’s you/ });
      await user.click(within(prompt).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /Confirm it’s you/ })).not.toBeInTheDocument());
      expect(api.restoreUpload).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('asks before restoring a backup on the server too', async () => {
      api.reauthStatus.mockResolvedValue({ reauthenticated: false });
      api.backups.mockResolvedValue({ backups: [listed] });
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Restore this backup' }));
      await user.click(await screen.findByRole('button', { name: 'Continue' }));
      await user.click(await screen.findByRole('button', { name: 'Restore Database' }));
      const prompt = await screen.findByRole('dialog', { name: /Confirm it’s you/ });
      expect(api.restoreFromServer).not.toHaveBeenCalled();
      await user.type(within(prompt).getByLabelText('Password'), 'S3cret!pass');
      await user.click(within(prompt).getByRole('button', { name: 'Confirm' }));
      await waitFor(() => expect(api.restoreFromServer).toHaveBeenCalledWith(listed.fileName, {}));
      await restoreEnded();
    });

    it('asks again when the confirmation lapsed as the restore was sent, and sends it once more', async () => {
      api.backups.mockResolvedValue({ backups: [listed] });
      api.restoreFromServer.mockRejectedValueOnce(reauthRequired()).mockResolvedValue({ success: true, started: true });
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Restore this backup' }));
      await user.click(await screen.findByRole('button', { name: 'Continue' }));
      await user.click(await screen.findByRole('button', { name: 'Restore Database' }));
      const prompt = await screen.findByRole('dialog', { name: /Confirm it’s you/ });
      expect(api.restoreFromServer).toHaveBeenCalledTimes(1);
      await user.type(within(prompt).getByLabelText('Password'), 'S3cret!pass');
      await user.click(within(prompt).getByRole('button', { name: 'Confirm' }));
      await waitFor(() => expect(api.restoreFromServer).toHaveBeenCalledTimes(2));
      await restoreEnded();
      expect(toast.error).not.toHaveBeenCalledWith(expect.stringMatching(/Confirm your password/));
    });

    it('asks again when the confirmation lapsed as the upload was sent, and uploads it once more', async () => {
      api.restoreUpload.mockRejectedValueOnce(reauthRequired()).mockResolvedValue({ success: true, started: true });
      const user = await restoreUpload();
      const prompt = await screen.findByRole('dialog', { name: /Confirm it’s you/ });
      expect(api.restoreUpload).toHaveBeenCalledTimes(1);
      await user.type(within(prompt).getByLabelText('Password'), 'S3cret!pass');
      await user.click(within(prompt).getByRole('button', { name: 'Confirm' }));
      await waitFor(() => expect(api.restoreUpload).toHaveBeenCalledTimes(2));
      expect((api.restoreUpload.mock.calls[1][0] as FormData).get('backup')).toBe(api.restoreUpload.mock.calls[0][0].get('backup'));
      await restoreEnded();
    });

    it('sends nothing more, and says nothing went wrong, when that second prompt is closed', async () => {
      api.restoreUpload.mockRejectedValue(reauthRequired());
      const user = await restoreUpload();
      const prompt = await screen.findByRole('dialog', { name: /Confirm it’s you/ });
      await user.click(within(prompt).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.getByRole('button', { name: /^Restore/ })).toBeEnabled());
      expect(api.restoreUpload).toHaveBeenCalledTimes(1);
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("says so when it can't check, and sends nothing", async () => {
      api.reauthStatus.mockRejectedValue(new Error('Network down'));
      await restoreUpload();
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Couldn’t check that it’s you'));
      expect(api.restoreUpload).not.toHaveBeenCalled();
    });
  });
});
