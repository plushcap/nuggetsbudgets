import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { toast } from 'react-hot-toast';
import type { Account, Institution } from '../../services/api';
import EditAccountPage from '../EditAccountPage';

/**
 * The edit page loaded Financial Institution, Account Group, Account Type and
 * Account Subtype blank, and Update then refused ("Please fix: ..."). Inside a <form>,
 * Radix Select keeps a hidden native <select> (SelectBubbleInput). When a controlled
 * value changed after mount and its <option> wasn't registered yet, Radix read the
 * native select back as '' and reported it through onValueChange, so the field became
 * '' (or NaN for the institution). These run the real query hooks over deferred API
 * calls, so the account and the institutions can arrive in either order.
 */

const auth = vi.hoisted(() => ({ orgRole: 'admin' as string | null, isDeploymentAdmin: false }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const api = vi.hoisted(() => ({
  getAccount: vi.fn(),
  getInstitutions: vi.fn(),
  getAccounts: vi.fn(),
  getUsers: vi.fn(),
  updateAccountWithImage: vi.fn(),
}));
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  ...api,
}));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
  useParams: () => ({ uuid: 'account-1' }),
}));
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const institutions = [
  { id: 3, uuid: 'inst-3', name: 'First Bank' },
  { id: 7, uuid: 'inst-7', name: 'Example Brokerage' },
] as Institution[];

const makeAccount = (overrides: Partial<Account> = {}): Account =>
  ({
    id: 5,
    uuid: 'account-1',
    name: 'Retirement',
    type: 'Asset',
    account_type: 'investment',
    account_group: 'investments',
    institution_id: 7,
    account_number: '',
    routing_number: '',
    calculated_balance: 1000,
    close_account: false,
    notes: '',
    instructions: '',
    account_image: null,
    icon: 'PiggyBank',
    custom_sort: null,
    subtype: 'Roth IRA',
    hide_transactions: false,
    hide_account: false,
    exclude_account_balance: false,
    is_envelope_account: false,
    require_zero_balance: false,
    import_account_id: null,
    import_enabled: false,
    import_account_rebalance: false,
    ...overrides,
  }) as unknown as Account;

let accountCall: Deferred<Account>;
let institutionsCall: Deferred<Institution[]>;

beforeEach(() => {
  vi.clearAllMocks();
  accountCall = deferred<Account>();
  institutionsCall = deferred<Institution[]>();
  api.getAccount.mockReturnValue(accountCall.promise);
  api.getInstitutions.mockReturnValue(institutionsCall.promise);
  api.getAccounts.mockResolvedValue([]);
  api.getUsers.mockResolvedValue([]);
  api.updateAccountWithImage.mockResolvedValue({});
});

const renderPage = () => renderWithProviders(<Theme><EditAccountPage /></Theme>);

/** The trigger of the Select labelled `label` (a required field's label ends in " *"). */
const select = (label: string) => screen.getByRole('combobox', { name: new RegExp(`^${label}( \\*)?$`) });

const expectShown = async (shown: Record<string, string>) => {
  await screen.findByDisplayValue('Retirement');
  await waitFor(() => {
    for (const [label, text] of Object.entries(shown)) {
      expect(select(label)).toHaveTextContent(text);
    }
  });
};

const savedBody = async () => {
  await userEvent.click(screen.getByRole('button', { name: /update account/i }));
  await waitFor(() => expect(api.updateAccountWithImage).toHaveBeenCalledTimes(1));
  expect(toast.error).not.toHaveBeenCalled();
  const [uuid, formData] = api.updateAccountWithImage.mock.calls[0] as [string, FormData];
  expect(uuid).toBe('account-1');
  return formData;
};

const storedValuesShown = {
  'Financial Institution': 'Example Brokerage',
  'Account Group': 'Investments',
  'Account Category': 'Asset',
  'Account Type': 'Investment Account',
  'Account Subtype': 'Roth IRA',
};

describe('EditAccountPage selects', () => {
  it('shows every stored value and saves them untouched when the account arrives first', async () => {
    renderPage();
    await act(async () => accountCall.resolve(makeAccount()));
    await act(async () => institutionsCall.resolve(institutions));

    await expectShown(storedValuesShown);
    const body = await savedBody();
    expect(body.get('institution_id')).toBe('7');
    expect(body.get('account_group')).toBe('investments');
    expect(body.get('type')).toBe('Asset');
    expect(body.get('account_type')).toBe('investment');
    expect(body.get('subtype')).toBe('Roth IRA');
  });

  it('shows every stored value and saves them untouched when the institutions arrive first', async () => {
    renderPage();
    await act(async () => institutionsCall.resolve(institutions));
    await act(async () => accountCall.resolve(makeAccount()));

    await expectShown(storedValuesShown);
    const body = await savedBody();
    expect(body.get('institution_id')).toBe('7');
    expect(body.get('account_group')).toBe('investments');
    expect(body.get('account_type')).toBe('investment');
    expect(body.get('subtype')).toBe('Roth IRA');
  });

  it('keeps a liability account’s category and type', async () => {
    renderPage();
    await act(async () =>
      accountCall.resolve(
        makeAccount({ type: 'Liability', account_type: 'credit_card', account_group: 'credit_cards', subtype: '' }),
      ),
    );
    await act(async () => institutionsCall.resolve(institutions));

    await expectShown({ 'Account Category': 'Liability', 'Account Type': 'Credit Card', 'Account Group': 'Credit Cards' });
    const body = await savedBody();
    expect(body.get('type')).toBe('Liability');
    expect(body.get('account_type')).toBe('credit_card');
    expect(body.get('account_group')).toBe('credit_cards');
  });

  // An account with no category is an asset to the Accounts list and net worth, but
  // the page inferred one from its account_type and showed a credit card as a Liability, and
  // saving any edit wrote that. Its type is a known one, shown by its label, not as
  // "credit_card (legacy value)".
  it.each([null, ''])('shows an account with no category (%j) as the asset it is counted as, and saves it so', async (type) => {
    renderPage();
    await act(async () =>
      accountCall.resolve(
        makeAccount({ type: type as unknown as Account['type'], account_type: 'credit_card', account_group: 'credit_cards', subtype: '' }),
      ),
    );
    await act(async () => institutionsCall.resolve(institutions));

    await expectShown({ 'Account Category': 'Asset', 'Account Type': 'Credit Card' });
    const body = await savedBody();
    expect(body.get('type')).toBe('Asset');
    expect(body.get('account_type')).toBe('credit_card');
  });

  it('saves an account whose legacy classification is unchanged', async () => {
    renderPage();
    await act(async () =>
      accountCall.resolve(makeAccount({ account_type: 'Checking', account_group: 'Banking', subtype: '' })),
    );
    await act(async () => institutionsCall.resolve(institutions));

    await expectShown({
      'Account Group': 'Banking (legacy value)',
      'Account Type': 'Checking (legacy value)',
    });
    const body = await savedBody();
    expect(body.get('account_group')).toBe('Banking');
    expect(body.get('account_type')).toBe('Checking');
  });
});
