import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { pinTimeZone } from '../../test/timeZone';
import { mockApi } from '../../test/apiServer';
import { account, accountsResponse, created, investmentAnswers, noConcentration, noTaxLossHarvest, security } from '../../test/fixtures';
import InvestmentPlanningPage from '../InvestmentPlanningPage';
import FundCompositionEditor from '../../components/FundCompositionEditor';
import TagsPage from '../TagsPage';
import ProfilePage from '../ProfilePage';

/**
 * The forms moved onto react-hook-form send what they sent on their
 * useState forms: every request below is what the page sent before the move (this file ran
 * green against those pages first).
 */

Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});

vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});

const tags = vi.hoisted(() => ({
  list: [] as unknown[],
  create: vi.fn(),
  update: vi.fn(),
  reportRoot: vi.fn(),
}));
const profile = vi.hoisted(() => ({
  user: {
    id: 1, uuid: 'u-1', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace',
    default_color: '#3B82F6', icon: 'User', profile_image: 'ada.png', created_at: '2026-01-01T00:00:00Z',
  } as Record<string, unknown>,
  setUser: vi.fn(),
  forgetSession: vi.fn(),
  updateProfile: vi.fn(),
  changePassword: vi.fn(),
  registerPasskey: vi.fn(),
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: profile.user, setUser: profile.setUser, forgetSession: profile.forgetSession }),
}));
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  updateProfile: profile.updateProfile,
  changePassword: profile.changePassword,
  registerPasskey: profile.registerPasskey,
  isPasskeySupported: () => true,
}));
vi.mock('../../hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/queries')>()),
  useTagsQuery: () => ({ data: tags.list, isLoading: false }),
  useCreateTagMutation: () => ({ mutateAsync: tags.create, isPending: false }),
  useUpdateTagMutation: () => ({ mutateAsync: tags.update, isPending: false }),
  useDeleteTagMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateTagReportRootMutation: () => ({ mutateAsync: tags.reportRoot, isPending: false }),
  useUserPasskeysQuery: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
  usePasswordPolicy: () => ({ minLength: 12, maxBytes: 72, requireComplexity: false }),
}));
vi.mock('../../components/PushNotificationsCard', () => ({ PushNotificationsCard: () => null }));
vi.mock('../../components/NotificationChoicesCard', () => ({ NotificationChoicesCard: () => null }));
vi.mock('../../hooks/useReauth', () => ({
  useReauth: () => ({ withReauth: <T,>(run: () => Promise<T>) => run(), dialogProps: { open: false, onOpenChange: () => {} } }),
  isReauthCancelledError: () => false,
}));
vi.mock('../../components/ReauthDialog', () => ({ default: () => null }));

pinTimeZone('UTC', '2026-10-15T12:00:00Z');

type User = ReturnType<typeof userEvent.setup>;
const choose = async (user: User, field: RegExp | string, option: RegExp | string) => {
  await user.click(await screen.findByRole('combobox', { name: field }));
  await user.click(await screen.findByRole('option', { name: option }));
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('the sell-tax calculator', () => {
  const brokerage = account({ id: 1, name: 'Brokerage', account_type: 'investment', account_group: 'investments' });
  const stockFund = security({ id: 1, ticker: 'STKIDX', name: 'Total Stock Market' });

  it('asks for the sale as the page asked before', async () => {
    const api = mockApi({
      'GET /accounts': accountsResponse([brokerage]),
      'GET /investments/securities': [stockFund],
      'GET /investments/reports/tax-loss-harvest': noTaxLossHarvest,
      'GET /investments/reports/concentration': noConcentration,
      'GET /investments/reports/sell-tax-impact': { status: 400, body: { error: 'no price', code: 'INVALID_REQUEST', requestId: 'r' } },
    });
    const user = userEvent.setup();
    renderWithProviders(<Theme><InvestmentPlanningPage /></Theme>);
    await choose(user, 'Account', 'Brokerage');
    await choose(user, 'Security', 'STKIDX');
    await user.type(screen.getByRole('spinbutton', { name: 'Shares' }), '12.5');
    await choose(user, 'Method', /HIFO/);
    // The rates start empty: the page asks for them.
    await user.type(screen.getByRole('spinbutton', { name: 'Short-term rate' }), '0.32');
    await user.type(screen.getByRole('spinbutton', { name: 'Long-term rate' }), '0.15');
    await user.click(screen.getByRole('button', { name: 'Calculate' }));

    await waitFor(() => expect(api.calls('GET /investments/reports/sell-tax-impact')).toHaveLength(1));
    expect(Object.fromEntries(api.calls('GET /investments/reports/sell-tax-impact')[0]!.query)).toEqual({
      account: brokerage.uuid, security: stockFund.uuid, shares: '12.5', method: 'hifo', st_rate: '0.32', lt_rate: '0.15',
    });
  });
});

describe("a plain security's classification", () => {
  it('sends its one category at 100%', async () => {
    const api = mockApi({
      'GET /investments/securities/:uuid/composition': [],
      'POST /investments/compositions': created(investmentAnswers.composition),
    });
    const user = userEvent.setup();
    renderWithProviders(<Theme><FundCompositionEditor securityUuid="0190a000-0002-7000-8000-000000000001" isPassThrough={false} securityType="stock" /></Theme>);
    await user.type(await screen.findByRole('textbox', { name: 'Category' }), '  Domestic Stock ');
    await user.click(screen.getByRole('button', { name: /Save classification/ }));

    await waitFor(() => expect(api.calls('POST /investments/compositions')).toHaveLength(1));
    expect(api.calls('POST /investments/compositions')[0]!.body).toEqual({
      security_uuid: '0190a000-0002-7000-8000-000000000001',
      snapshot_date: '2026-10-15',
      dimensions: { asset_class: [{ dimension_value: 'Domestic Stock', weight_percentage: 100 }] },
      source: 'manual',
    });
  });
});

describe('the tag dialogs', () => {
  const groceries = {
    id: 5, uuid: 'tag-5', name: 'Groceries', color: '#2563eb', icon: 'Tag', description: 'food', parent_id: null,
    level: 0, sort_order: 0, is_active: true, hierarchy_path: 'Groceries', is_report_root: false,
  };
  beforeEach(() => {
    sessionStorage.clear();
    tags.list = [groceries];
    tags.create.mockResolvedValue({});
    tags.update.mockResolvedValue({});
    tags.reportRoot.mockResolvedValue({});
  });

  it('creates a sub-tag with the whole form', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Theme><TagsPage /></Theme>, { route: '/tags' });
    const row = (await screen.findByText('Groceries')).closest('[draggable]') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Tag actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /add sub-tag/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Add New Tag' });
    await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), ' Produce ');
    await user.type(within(dialog).getByRole('textbox', { name: /Description/ }), 'fruit and veg');
    await user.click(within(dialog).getByRole('checkbox', { name: /Active/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create Tag' }));

    await waitFor(() => expect(tags.create).toHaveBeenCalledTimes(1));
    expect(tags.create.mock.calls[0]![0]).toEqual({
      name: ' Produce ', color: '#3B82F6', icon: 'Tag', description: 'fruit and veg', parent_id: 5, is_active: false,
      is_report_root: false, report_flow_measure: 'effective',
    });
  });

  // The name's problem shows beside it (it was a toast), and each dialog starts
  // from its own tag (Add after an Edit showed the edited tag's values).
  it('refuses a tag without a name beside the field, and starts each dialog over', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Theme><TagsPage /></Theme>, { route: '/tags?edit=tag-5' });
    const edit = await screen.findByRole('dialog', { name: 'Edit Tag' });
    const editName = within(edit).getByRole('textbox', { name: /Name/ });
    await user.clear(editName);
    await user.click(within(edit).getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(editName).toHaveFocus());
    expect(editName).toHaveAccessibleDescription('Name is required');
    expect(tags.update).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: /Add/ }));
    const add = await screen.findByRole('dialog', { name: 'Add New Tag' });
    const addName = within(add).getByRole('textbox', { name: /Name/ });
    expect(addName).toHaveValue('');
    expect(addName).not.toHaveAttribute('aria-invalid');
    await user.type(addName, '   ');
    await user.click(within(add).getByRole('button', { name: 'Create Tag' }));
    await waitFor(() => expect(addName).toHaveAccessibleDescription('Name is required'));
    expect(tags.create).not.toHaveBeenCalled();
  });

  it('saves an edit, then the namespace flag on its own', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Theme><TagsPage /></Theme>, { route: '/tags?edit=tag-5' });
    const dialog = await screen.findByRole('dialog', { name: 'Edit Tag' });
    const name = within(dialog).getByRole('textbox', { name: /Name/ });
    await user.clear(name);
    await user.type(name, 'Food');
    await user.click(within(dialog).getByRole('checkbox', { name: /report namespace/ }));
    await user.click(within(dialog).getByRole('radio', { name: /Actual/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(tags.reportRoot).toHaveBeenCalledTimes(1));
    expect(tags.update.mock.calls[0]![0]).toEqual({
      uuid: 'tag-5',
      data: { name: 'Food', color: '#2563eb', icon: 'Tag', description: 'food', parent_id: null, is_active: true },
    });
    expect(tags.reportRoot.mock.calls[0]![0]).toEqual({ uuid: 'tag-5', data: { is_report_root: true, report_flow_measure: 'actual' } });
  });
});

describe('the profile forms', () => {
  const entries = (form: unknown) => [...(form as FormData).entries()].map(([k, v]) => [k, typeof v === 'string' ? v : (v as File).name]);
  beforeEach(() => {
    profile.updateProfile.mockResolvedValue({ ...profile.user, profile_image: 'new.png' });
    profile.changePassword.mockResolvedValue({ success: true });
    profile.registerPasskey.mockResolvedValue({});
  });

  it('saves the profile as multipart, with a new picture', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Theme><ProfilePage /></Theme>, { route: '/profile' });
    const first = await screen.findByRole('textbox', { name: /First Name/ });
    await user.clear(first);
    await user.type(first, 'Augusta');
    const picture = new File(['png'], 'face.png', { type: 'image/png' });
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, picture);
    await user.click(screen.getByRole('button', { name: /Save Changes/ }));

    await waitFor(() => expect(profile.updateProfile).toHaveBeenCalledTimes(1));
    expect(entries(profile.updateProfile.mock.calls[0]![0])).toEqual([
      ['first_name', 'Augusta'], ['last_name', 'Lovelace'], ['default_color', '#3B82F6'], ['icon', 'User'], ['profile_image', 'face.png'],
    ]);
  });

  it('saves the profile with the picture removed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Theme><ProfilePage /></Theme>, { route: '/profile' });
    await user.click(await screen.findByRole('button', { name: 'Remove image' }));
    await user.click(screen.getByRole('button', { name: /Save Changes/ }));

    await waitFor(() => expect(profile.updateProfile).toHaveBeenCalledTimes(1));
    expect(entries(profile.updateProfile.mock.calls[0]![0])).toEqual([
      ['first_name', 'Ada'], ['last_name', 'Lovelace'], ['default_color', '#3B82F6'], ['icon', 'User'], ['remove_profile_image', 'true'],
    ]);
  });

  it('changes the password with the current one', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Theme><ProfilePage /></Theme>, { route: '/profile' });
    await user.click(await screen.findByRole('button', { name: /Change Password/ }));
    await user.type(screen.getByLabelText(/Current Password/), 'old secret words');
    await user.type(screen.getByLabelText(/^New Password/), 'a much longer passphrase');
    await user.type(screen.getByLabelText(/Confirm New Password/), 'a much longer passphrase');
    const changeButtons = screen.getAllByRole('button', { name: /Change Password/ });
    await user.click(changeButtons[changeButtons.length - 1]!);

    await waitFor(() => expect(profile.changePassword).toHaveBeenCalledTimes(1));
    expect(profile.changePassword.mock.calls[0]![0]).toEqual({ currentPassword: 'old secret words', newPassword: 'a much longer passphrase' });
    expect(profile.forgetSession).toHaveBeenCalled();
  });

  it('names a new passkey', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Theme><ProfilePage /></Theme>, { route: '/profile' });
    await user.click(await screen.findByRole('button', { name: /Add Passkey/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add New Passkey' });
    await user.type(within(dialog).getByLabelText('Device Name'), 'Work laptop');
    await user.click(within(dialog).getByRole('button', { name: /Add Passkey/ }));

    await waitFor(() => expect(profile.registerPasskey).toHaveBeenCalledWith('Work laptop'));
  });
});
