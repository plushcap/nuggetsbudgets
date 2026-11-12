import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { pinTimeZone } from '../../test/timeZone';
import { apiError, mockApi, type ApiRequest } from '../../test/apiServer';
import { deletionPreview, deletionResult, type DeletionPreviewWire } from '../../test/fixtures';
import DataDeletionSettingsPage from '../DataDeletionSettingsPage';

/**
 * Deleting transactions by date against the API: preview first, then a
 * confirmed delete of exactly what was previewed. Only `fetch` is stubbed.
 */

vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});
// Only a deployment admin may have a backup made first; the tests below say otherwise.
const auth = vi.hoisted(() => ({ isDeploymentAdmin: true }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

// Mid-October 2026: the ranges below are in the past, so only the page's own rules decide.
pinTimeZone('UTC', '2026-10-15T12:00:00Z');

/** The preview's set: its key, 64 hex digits as the server makes them (`n` repeated). */
const setKey = (n: number) => String(n).repeat(64);

/** POST /data-management/preview-delete-transactions (fixtures.ts, from the shared schemas). */
const found = deletionPreview({
  count: 42,
  affectedAccounts: 3,
  totalIncome: 2500.5,
  totalExpenses: -1234.56,
  earliestDate: '2026-01-02',
  latestDate: '2026-01-30',
  // Names the set the preview found; the delete sends it back.
  selectionKey: setKey(1),
});
/** What the deletion answers for the preview's set. */
const deleted = (preview: DeletionPreviewWire, backup: { backupCreated: boolean; backupFileName?: string }) => {
  const { count, affectedAccounts, totalIncome, totalExpenses, earliestDate, latestDate } = preview;
  return deletionResult({ count, affectedAccounts, totalIncome, totalExpenses, earliestDate, latestDate, ...backup });
};

let api: ReturnType<typeof mockApi>;
const routes = (preview: DeletionPreviewWire = found) => ({
  'POST /data-management/preview-delete-transactions': preview,
  'POST /data-management/delete-transactions': deleted(preview, { backupCreated: true, backupFileName: 'before-delete.dump' }),
});

const setRange = (from: string, to: string) => {
  // A date input takes its value whole; typing into one isn't how jsdom fills it.
  fireEvent.change(screen.getByLabelText(/Start Date/), { target: { value: from } });
  fireEvent.change(screen.getByLabelText(/End Date/), { target: { value: to } });
};

/** The figure in the preview table's row headed `label`. */
const previewFigure = (label: string) => within(screen.getByRole('row', { name: new RegExp(`^${label}`) })).getByRole('cell').textContent;

beforeEach(() => {
  vi.clearAllMocks();
  auth.isDeploymentAdmin = true;
});
afterEach(() => vi.unstubAllGlobals());

describe('DataDeletionSettingsPage', () => {
  it('previews the range with the options chosen, and shows what the API found', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderWithProviders(<Theme><DataDeletionSettingsPage /></Theme>);

    expect(screen.getByRole('button', { name: /Delete Transactions/ })).toBeDisabled();
    setRange('2026-01-01', '2026-01-31');
    await user.click(screen.getByRole('button', { name: 'Preview Deletion' }));

    await waitFor(() => expect(api.calls('POST /data-management/preview-delete-transactions')).toHaveLength(1));
    expect(api.calls('POST /data-management/preview-delete-transactions')[0].body).toEqual({
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
      excludeBudgetPeriod: true,
    });
    await waitFor(() => expect(previewFigure('Transactions to Delete')).toBe('42'));
    expect(previewFigure('Affected Accounts')).toBe('3');
    expect(previewFigure('Total Income')).toBe('$2,500.50');
    expect(previewFigure('Total Expenses')).toBe('-$1,234.56');
    // Previewing deletes nothing.
    expect(api.calls('POST /data-management/delete-transactions')).toHaveLength(0);
  });

  it('deletes the previewed range only once the member confirms it is permanent', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderWithProviders(<Theme><DataDeletionSettingsPage /></Theme>);

    setRange('2026-01-01', '2026-01-31');
    await user.click(screen.getByRole('button', { name: 'Preview Deletion' }));
    const remove = screen.getByRole('button', { name: /Delete Transactions/ });
    await waitFor(() => expect(remove).toBeEnabled());
    await user.click(remove);

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('42 transactions');
    const confirm = within(dialog).getByRole('button', { name: 'Confirm Delete' });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: /I understand this action is permanent/ }));
    await user.click(confirm);

    await waitFor(() => expect(api.calls('POST /data-management/delete-transactions')).toHaveLength(1));
    const [request] = api.calls('POST /data-management/delete-transactions');
    expect(request.headers.get('X-CSRF-Token')).toBeTruthy();
    expect(request.body).toEqual({
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
      excludeBudgetPeriod: true,
      // A backup first, unless the member turned it off.
      createBackup: true,
      // The set the preview found, so the server deletes exactly that.
      selectionKey: setKey(1),
    });
  });

  it('offers nothing to delete when the preview finds nothing', async () => {
    api = mockApi(routes(deletionPreview({ ...found, count: 0, affectedAccounts: 0, totalIncome: 0, totalExpenses: 0 })));
    const user = userEvent.setup();
    renderWithProviders(<Theme><DataDeletionSettingsPage /></Theme>);

    setRange('2025-01-01', '2025-01-31');
    await user.click(screen.getByRole('button', { name: 'Preview Deletion' }));

    expect(await screen.findByText('No Transactions Found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete Transactions/ })).toBeDisabled();
  });

  it('refuses a range that reaches into the future, without asking the API', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderWithProviders(<Theme><DataDeletionSettingsPage /></Theme>);

    setRange('2026-01-01', '2099-12-31');
    await user.click(screen.getByRole('button', { name: 'Preview Deletion' }));

    const { default: toast } = await import('react-hot-toast');
    expect(toast.error).toHaveBeenCalledWith('Cannot delete transactions in the future');
    expect(api.requests).toHaveLength(0);
  });

  // Found writing these tests, and fixed: a range changed after the
  // preview used to stay deletable, and the delete sent the new range while the dialog
  // showed the old count. Now a changed range takes the preview away.
  it('takes the preview away when the range changes, so nothing unpreviewed can be deleted', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderWithProviders(<Theme><DataDeletionSettingsPage /></Theme>);

    setRange('2026-01-01', '2026-01-31');
    await user.click(screen.getByRole('button', { name: 'Preview Deletion' }));
    await waitFor(() => expect(previewFigure('Transactions to Delete')).toBe('42'));

    setRange('2026-01-01', '2026-02-28');

    await waitFor(() => expect(screen.getByRole('button', { name: /Delete Transactions/ })).toBeDisabled());
    expect(screen.queryByRole('row', { name: /^Transactions to Delete/ })).toBeNull();
    expect(api.calls('POST /data-management/delete-transactions')).toHaveLength(0);
  });

  it('deletes nothing when the range changed on the server since the preview, and offers a new preview', async () => {
    const outdated = 'The transactions in this range have changed since the preview, so nothing was deleted.';
    let previews = 0;
    api = mockApi({
      'POST /data-management/preview-delete-transactions': () => ({ ...found, selectionKey: setKey(++previews) }),
      // The first delete finds the range changed on the server; the one after a new preview goes through.
      'POST /data-management/delete-transactions': ({ body }: ApiRequest) =>
        (body as { selectionKey: string }).selectionKey === setKey(1)
          ? apiError(409, outdated, 'PREVIEW_OUTDATED')
          : deleted(found, { backupCreated: true }),
    });
    const user = userEvent.setup();
    renderWithProviders(<Theme><DataDeletionSettingsPage /></Theme>);

    setRange('2026-01-01', '2026-01-31');
    await user.click(screen.getByRole('button', { name: 'Preview Deletion' }));
    const remove = screen.getByRole('button', { name: /Delete Transactions/ });
    await waitFor(() => expect(remove).toBeEnabled());
    await user.click(remove);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /I understand this action is permanent/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm Delete' }));

    // The old counts go; the reason and a way forward show.
    expect(await screen.findByText(outdated)).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('row', { name: /^Transactions to Delete/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Delete Transactions/ })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Preview again' }));
    await waitFor(() => expect(previewFigure('Transactions to Delete')).toBe('42'));
    expect(api.calls('POST /data-management/preview-delete-transactions')).toHaveLength(2);
    expect(api.calls('POST /data-management/preview-delete-transactions')[1].body).toEqual({
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
      excludeBudgetPeriod: true,
    });

    // The next delete sends the new preview's key, not the refused one.
    const again = screen.getByRole('button', { name: /Delete Transactions/ });
    await waitFor(() => expect(again).toBeEnabled());
    await user.click(again);
    const second = await screen.findByRole('alertdialog');
    await user.click(within(second).getByRole('checkbox', { name: /I understand this action is permanent/ }));
    await user.click(within(second).getByRole('button', { name: 'Confirm Delete' }));
    await waitFor(() => expect(api.calls('POST /data-management/delete-transactions')).toHaveLength(2));
    expect(api.calls('POST /data-management/delete-transactions').map((c) => (c.body as { selectionKey: string }).selectionKey))
      .toEqual([setKey(1), setKey(2)]);
  });

  // A backup holds every ledger on the server, and a ledger admin could start one from
  // here. Only a deployment admin is offered it now, and the server refuses others.
  describe('the backup first', () => {
    const backupOption = () => screen.queryByRole('checkbox', { name: /Create automatic backup before deletion/ });
    const deletePreviewed = async (user: ReturnType<typeof userEvent.setup>) => {
      setRange('2026-01-01', '2026-01-31');
      await user.click(screen.getByRole('button', { name: 'Preview Deletion' }));
      const remove = screen.getByRole('button', { name: /Delete Transactions/ });
      await waitFor(() => expect(remove).toBeEnabled());
      await user.click(remove);
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('checkbox', { name: /I understand this action is permanent/ }));
      await user.click(within(dialog).getByRole('button', { name: 'Confirm Delete' }));
      return dialog;
    };

    it('is offered to a deployment admin, on by default', async () => {
      api = mockApi(routes());
      renderWithProviders(<Theme><DataDeletionSettingsPage /></Theme>);
      expect(backupOption()).toBeChecked();
      expect(screen.queryByText(/only a deployment admin can create one/)).toBeNull();
    });

    it('is not offered to a ledger admin, who deletes without one', async () => {
      auth.isDeploymentAdmin = false;
      api = mockApi(routes());
      const user = userEvent.setup();
      renderWithProviders(<Theme><DataDeletionSettingsPage /></Theme>);
      expect(backupOption()).toBeNull();
      expect(screen.getByText(/a backup holds every ledger on this server, so only a deployment admin can create one/)).toBeInTheDocument();

      const dialog = await deletePreviewed(user);
      expect(dialog).not.toHaveTextContent('Backup will be created');
      await waitFor(() => expect(api.calls('POST /data-management/delete-transactions')).toHaveLength(1));
      expect(api.calls('POST /data-management/delete-transactions')[0].body).toMatchObject({ createBackup: false });
    });

    it("says why when the server refuses the backup, and that nothing was deleted", async () => {
      const refused = 'Only a deployment admin can create a backup: it holds every tenant on this server. Delete without one, or ask a deployment admin to back up first.';
      api = mockApi({
        ...routes(),
        'POST /data-management/delete-transactions': apiError(403, refused, 'BACKUP_REQUIRES_DEPLOYMENT_ADMIN'),
      });
      const user = userEvent.setup();
      renderWithProviders(<Theme><DataDeletionSettingsPage /></Theme>);
      await deletePreviewed(user);

      const { default: toast } = await import('react-hot-toast');
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'Only a deployment admin can create a backup: it holds every ledger on this server. Delete without one, or ask a deployment admin to back up first.',
          { duration: 6000 },
        ),
      );
      expect(api.calls('POST /data-management/delete-transactions')[0].body).toMatchObject({ createBackup: true });
    });
  });
});
