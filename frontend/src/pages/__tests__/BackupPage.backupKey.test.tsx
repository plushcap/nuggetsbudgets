import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { mockApi } from '../../test/apiServer';
import { backupList, backupStarted, backupStatus, oneDriveNotConfigured } from '../../test/fixtures';
import type { BackupCreateStatus, BackupKeyStatus } from '../../services/api/backup';
import BackupPage from '../BackupPage';

/**
 * Backups need a backup key: without one the page says so and won't start a
 * backup; with one, Create Backup asks the API for one. Only `fetch` is stubbed.
 */

vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});
// The OneDrive panel has its own requests and isn't what these tests are about.
vi.mock('../../components/OneDriveSync', () => ({ default: () => null }));

/** The backup answers, from the shared schemas (fixtures.ts). */
const routes = (key: BackupKeyStatus) => ({
  'GET /backup/key/status': key,
  'GET /backup/list': backupList(),
  'GET /backup/settings': { settings: {} },
  'GET /backup/status': backupStatus(),
  'GET /onedrive/status': oneDriveNotConfigured(),
  'GET /admin/deployment-settings': { settings: { application_timezone: 'UTC' } },
  'GET /settings/timezones': [{ value: 'UTC', label: 'UTC', offset: 'UTC+0' }],
  'POST /backup/check-onedrive-status': { success: true, status: {} },
  'POST /backup/create': { status: 202, body: backupStarted() },
  'GET /backup/create-status': { status: 'completed', fileName: 'nuggets-backup.dump' } satisfies BackupCreateStatus,
});

const renderPage = () => renderWithProviders(<Theme><BackupPage /></Theme>, { route: '/settings/backup' });

let api: ReturnType<typeof mockApi>;
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('BackupPage backup key', () => {
  it('without a key, says to generate one and starts no backup', async () => {
    api = mockApi(routes({ exists: false, downloaded: false }));
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText(/No backup key yet/)).toBeInTheDocument();
    expect(screen.getByText('Generate a backup key above before creating a backup.')).toBeInTheDocument();
    const create = screen.getByRole('button', { name: 'Create Backup' });
    expect(create).toBeDisabled();
    await user.click(create);
    expect(api.calls('POST /backup/create')).toHaveLength(0);
  });

  it('warns when the key was never downloaded, since the backups could not be restored', async () => {
    api = mockApi(routes({ exists: true, downloaded: false }));
    renderPage();

    expect(await screen.findByText(/You haven't downloaded your backup key/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download Key' })).toBeInTheDocument();
  });

  it('with a key, Create Backup asks the API for a backup', async () => {
    api = mockApi(routes({ exists: true, downloaded: true }));
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Backup key is set and has been downloaded.')).toBeInTheDocument();
    const create = screen.getByRole('button', { name: 'Create Backup' });
    await waitFor(() => expect(create).toBeEnabled());
    await user.click(create);

    await waitFor(() => expect(api.calls('POST /backup/create')).toHaveLength(1));
    // The page polls for the backup to finish (after 2 s); wait for it, so no poll
    // outlives this test, and see it report the backup done.
    const { default: toast } = await import('react-hot-toast');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Backup created successfully!'));
    expect(api.calls('GET /backup/create-status')).toHaveLength(1);
    expect(api.unhandled).toEqual([]);
  });
});

// The page revoked the key file's object URL straight after the click, which can
// cancel the save in a browser that starts it after click() returns (older WebKit).
describe('BackupPage key download', () => {
  afterEach(() => vi.restoreAllMocks());

  it('saves the key under its name and keeps the URL until the save has started', async () => {
    api = mockApi({ ...routes({ exists: true, downloaded: false }), 'GET /backup/key/download': 'the-key' });
    const saved: string[] = [];
    URL.createObjectURL = vi.fn(() => 'blob:key');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Download Key' }));
    await waitFor(() => expect(saved).toEqual(['nuggets-backup-key.txt']));
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
});
