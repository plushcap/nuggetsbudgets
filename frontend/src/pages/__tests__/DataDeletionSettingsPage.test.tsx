import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { handleResponse } from '../../services/api/base';
import DataDeletionSettingsPage from '../DataDeletionSettingsPage';
import { accountKeys, transactionKeys } from '../../hooks/queries/keys';
import { deleteTransactions, previewDeleteTransactions } from '../../services/api/data-management';

vi.mock('../../services/api/data-management', () => ({
  previewDeleteTransactions: vi.fn(),
  deleteTransactions: vi.fn(),
}));
vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});
// A deployment admin, who is offered a backup first.
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ isDeploymentAdmin: true }) }));

const found = { success: true, count: 2, affectedAccounts: 1, totalIncome: 0, totalExpenses: -20, earliestDate: null, latestDate: null, selectionKey: 'b'.repeat(64) } as const;
const removed = { success: true, count: 2, affectedAccounts: 1, totalIncome: 0, totalExpenses: -20, earliestDate: null, latestDate: null, backupCreated: false } as const;

/** What the server answers, through the real response handling (status, code, wording). */
const answer = <T,>(status: number, body: unknown) =>
  handleResponse<T>(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

const dateInputs = () => {
  const [from, to] = document.querySelectorAll<HTMLInputElement>('input[type="date"]');
  return { from, to };
};
const setRange = (dateFrom: string, dateTo: string) => {
  const { from, to } = dateInputs();
  fireEvent.change(from, { target: { value: dateFrom } });
  fireEvent.change(to, { target: { value: dateTo } });
};
const deleteButton = () => screen.getByRole('button', { name: /Delete Transactions/ });
const preview = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Preview Deletion' }));
  await waitFor(() => expect(deleteButton()).toBeEnabled());
};
const confirmDelete = async () => {
  fireEvent.click(deleteButton());
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /I understand this action is permanent/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm Delete' }));
  await waitFor(() => expect(deleteTransactions).toHaveBeenCalled());
};

describe('DataDeletionSettingsPage', () => {
  beforeEach(() => {
    vi.mocked(previewDeleteTransactions).mockReset().mockResolvedValue(found);
    vi.mocked(deleteTransactions).mockReset().mockResolvedValue(removed);
  });

  // Delete sent the dates in the form when it was clicked, so a range changed after the
  // preview was deleted without ever being previewed.
  it('takes the preview away when the range changes, so Delete waits for a new one', async () => {
    renderWithProviders(<Theme><DataDeletionSettingsPage /></Theme>);
    setRange('2026-01-01', '2026-01-31');
    await preview();

    fireEvent.change(dateInputs().to, { target: { value: '2026-03-31' } });
    expect(deleteButton()).toBeDisabled();
    expect(screen.queryByText('Preview Results')).not.toBeInTheDocument();

    await preview();
    expect(previewDeleteTransactions).toHaveBeenLastCalledWith({ dateFrom: '2026-01-01', dateTo: '2026-03-31', excludeBudgetPeriod: true });
    await confirmDelete();
    expect(deleteTransactions).toHaveBeenCalledTimes(1);
    expect(deleteTransactions).toHaveBeenCalledWith({ dateFrom: '2026-01-01', dateTo: '2026-03-31', excludeBudgetPeriod: true, createBackup: true, selectionKey: found.selectionKey });
  });

  it('takes the preview away when whether to keep budgeted transactions changes', async () => {
    renderWithProviders(<Theme><DataDeletionSettingsPage /></Theme>);
    setRange('2026-01-01', '2026-01-31');
    await preview();

    fireEvent.click(screen.getByRole('checkbox', { name: /Exclude transactions assigned to budget periods/ }));
    expect(deleteButton()).toBeDisabled();
    await preview();
    expect(previewDeleteTransactions).toHaveBeenLastCalledWith({ dateFrom: '2026-01-01', dateTo: '2026-01-31', excludeBudgetPeriod: false });
    await confirmDelete();
    expect(deleteTransactions).toHaveBeenCalledWith({ dateFrom: '2026-01-01', dateTo: '2026-01-31', excludeBudgetPeriod: false, createBackup: true, selectionKey: found.selectionKey });
  });

  it('confirms with the previewed counts and range, and deletes exactly what was previewed', async () => {
    vi.mocked(previewDeleteTransactions).mockResolvedValue({ ...found, count: 14, affectedAccounts: 3 });
    renderWithProviders(<Theme><DataDeletionSettingsPage /></Theme>);
    setRange('2026-01-01', '2026-01-31');
    await preview();

    fireEvent.click(deleteButton());
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('14 transactions');
    expect(dialog).toHaveTextContent('Affecting 3 accounts');
    expect(dialog).toHaveTextContent('Dated January 1, 2026 to January 31, 2026');
    expect(dialog).toHaveTextContent('except those assigned to a budget period');

    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I understand this action is permanent/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm Delete' }));
    await waitFor(() =>
      expect(deleteTransactions).toHaveBeenCalledWith({ dateFrom: '2026-01-01', dateTo: '2026-01-31', excludeBudgetPeriod: true, createBackup: true, selectionKey: found.selectionKey }),
    );
  });

  // Delete re-selected the range when it ran, so a transaction a bank sync or another
  // member added after the preview was deleted too, unseen. The server now answers
  // 409 PREVIEW_OUTDATED, deleting nothing, when the set isn't the one previewed.
  it('says the transactions changed when the server refuses a stale preview, and offers a new one', async () => {
    const reason = 'The transactions in this range have changed since the preview, so nothing was deleted. Preview again to see what would be deleted now.';
    vi.mocked(deleteTransactions).mockImplementationOnce(() => answer(409, { error: reason, code: 'PREVIEW_OUTDATED' }));
    renderWithProviders(<Theme><DataDeletionSettingsPage /></Theme>);
    setRange('2026-01-01', '2026-01-31');
    await preview();
    await confirmDelete();
    expect(deleteTransactions).toHaveBeenLastCalledWith(expect.objectContaining({ selectionKey: found.selectionKey }));

    // The dialog closes, the old counts go, and Delete waits for a new preview.
    const notice = await screen.findByText(/changed since the preview, so nothing was deleted/);
    expect(notice.closest('.rt-CalloutRoot')).not.toBeNull();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Preview Results')).not.toBeInTheDocument();
    expect(deleteButton()).toBeDisabled();

    // Previewing again counts the range as it is now, and Delete sends that preview's key.
    const now = { ...found, count: 3, selectionKey: 'n'.repeat(64) };
    vi.mocked(previewDeleteTransactions).mockResolvedValueOnce(now);
    fireEvent.click(screen.getByRole('button', { name: 'Preview again' }));
    await waitFor(() => expect(deleteButton()).toBeEnabled());
    expect(previewDeleteTransactions).toHaveBeenLastCalledWith({ dateFrom: '2026-01-01', dateTo: '2026-01-31', excludeBudgetPeriod: true });
    expect(screen.queryByText(/changed since the preview/)).not.toBeInTheDocument();
    expect(screen.getByText('Preview Results')).toBeInTheDocument();

    vi.mocked(deleteTransactions).mockClear();
    await confirmDelete();
    expect(deleteTransactions).toHaveBeenCalledWith({ dateFrom: '2026-01-01', dateTo: '2026-01-31', excludeBudgetPeriod: true, createBackup: true, selectionKey: now.selectionKey });
  });

  // A deletion that met another write of the same rows and was rolled back (409
  // DELETION_CONFLICT) said only "Failed to delete transactions".
  it('says nothing was deleted and to try again when another change met the deletion, and lets it be tried again', async () => {
    const reason = 'Another change to these transactions was being saved at the same time, so nothing was deleted. Try again.';
    vi.mocked(deleteTransactions).mockImplementationOnce(() => answer(409, { error: reason, code: 'DELETION_CONFLICT' }));
    renderWithProviders(<Theme><DataDeletionSettingsPage /></Theme>);
    setRange('2026-01-01', '2026-01-31');
    await preview();
    await confirmDelete();

    const { default: toast } = await import('react-hot-toast');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(reason, { duration: 6000 }));
    // The dialog and the preview stay: Confirm Delete sends the same preview again.
    const dialog = screen.getByRole('alertdialog');
    expect(screen.getByText('Preview Results')).toBeInTheDocument();
    vi.mocked(deleteTransactions).mockClear();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm Delete' }));
    await waitFor(() =>
      expect(deleteTransactions).toHaveBeenCalledWith({ dateFrom: '2026-01-01', dateTo: '2026-01-31', excludeBudgetPeriod: true, createBackup: true, selectionKey: found.selectionKey }),
    );
  });

  // After a bulk delete, balances and lists kept the deleted rows.
  it('refreshes every transaction-derived screen after deleting', async () => {
    vi.mocked(previewDeleteTransactions).mockResolvedValue(found);
    vi.mocked(deleteTransactions).mockResolvedValue(removed);
    const { client, container } = renderWithProviders(<Theme><DataDeletionSettingsPage /></Theme>);
    client.setQueryData(accountKeys.list(false), [{ uuid: 'a1' }]);
    client.setQueryData(transactionKeys.detail('t1'), { uuid: 't1' });

    const [from, to] = container.querySelectorAll('input[type="date"]');
    fireEvent.change(from, { target: { value: '2026-01-01' } });
    fireEvent.change(to, { target: { value: '2026-01-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview Deletion' }));
    const remove = screen.getByRole('button', { name: /Delete Transactions/ });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    fireEvent.click(await screen.findByRole('checkbox', { name: /I understand this action is permanent/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Delete' }));

    await waitFor(() => expect(deleteTransactions).toHaveBeenCalled());
    await waitFor(() => expect(client.getQueryState(accountKeys.list(false))?.isInvalidated).toBe(true));
    expect(client.getQueryState(transactionKeys.detail('t1'))?.isInvalidated).toBe(true);
  });
});
