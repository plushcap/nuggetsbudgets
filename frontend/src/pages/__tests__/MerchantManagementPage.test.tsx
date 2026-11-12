import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { tag } from '../../test/fixtures';
import MerchantManagementPage from '../MerchantManagementPage';

const createMerchant = vi.fn().mockResolvedValue({ id: 1, uuid: 'm-new' });
const updateMerchant = vi.fn().mockResolvedValue({});
const createRule = vi.fn().mockResolvedValue({});

const merchant = {
  id: 7,
  uuid: 'm-1',
  name: 'Acme',
  merchant_website: 'https://acme.test',
  merchant_accountid: 'A-1',
  notes: 'reliable',
  instructions: '',
  merchant_image: null,
  transaction_auto_tag_id: null,
};
const emptyArr: never[] = [];
const merchantsPage = vi.hoisted(() => vi.fn());
const listed = vi.hoisted(() => ({ merchants: [] as unknown[] }));
/** The tags list as it has loaded: none until a test sets them (still loading, or failed). */
const tagList = vi.hoisted(() => ({ tags: [] as unknown[] }));

vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  const noop = () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  return {
    ...actual,
    usePaginatedMerchantsQuery: (params: unknown) => {
      merchantsPage(params);
      return {
        data: { merchants: listed.merchants.length ? listed.merchants : emptyArr, pagination: { total: listed.merchants.length, totalPages: 1 } },
        isLoading: false,
      };
    },
    useMerchantQuery: () => ({ data: merchant, isLoading: false, isError: false }),
    useMerchantRulesQuery: () => ({ data: emptyArr, isLoading: false }),
    useTagsQuery: () => ({ data: tagList.tags.length ? tagList.tags : emptyArr }),
    useCreateMerchantMutation: () => ({ mutateAsync: createMerchant, isPending: false }),
    useUpdateMerchantMutation: () => ({ mutateAsync: updateMerchant, isPending: false }),
    useDeleteMerchantMutation: noop,
    useCreateMerchantRuleMutation: () => ({ mutateAsync: createRule, isPending: false }),
    useUpdateMerchantRuleMutation: noop,
    useDeleteMerchantRuleMutation: noop,
  };
});

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const renderAt = (route: string) =>
  renderWithProviders(<Theme><MerchantManagementPage /></Theme>, { route });

describe('MerchantManagementPage list', () => {
  beforeEach(() => merchantsPage.mockClear());
  const lastPage = () =>
    merchantsPage.mock.calls[merchantsPage.mock.calls.length - 1]?.[0] as { page: number; search: string };

  it("opens on the URL's page, and goes back to page 1 when a search settles", async () => {
    renderAt('/settings/merchants?page=3');
    expect(lastPage()).toMatchObject({ page: 3, search: '' });
    await userEvent.type(screen.getByPlaceholderText('Search merchants...'), 'ac');
    await waitFor(() => expect(lastPage()).toMatchObject({ page: 1, search: 'ac' }));
  });
});

describe('MerchantManagementPage list by keyboard', () => {
  beforeEach(() => {
    listed.merchants = [merchant];
  });
  afterEach(() => {
    listed.merchants = [];
  });

  it('opens a merchant from a link in its card and its row, and names each action after it', async () => {
    renderAt('/settings/merchants');
    const links = await screen.findAllByRole('link', { name: 'Acme' });
    expect(links).toHaveLength(2); // the mobile card and the desktop row
    for (const link of links) expect(link).toHaveAttribute('href', '/settings/merchants/m-1/view');
    expect(screen.getAllByRole('button', { name: 'Edit merchant Acme' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Delete merchant Acme' })).toHaveLength(2);
  });
});

describe('MerchantManagementPage forms (react-hook-form)', () => {
  beforeEach(() => { createMerchant.mockClear(); updateMerchant.mockClear(); createRule.mockClear(); navigate.mockClear(); });

  it('creates a merchant from the add form', async () => {
    renderAt('/add');
    await userEvent.type(screen.getByPlaceholderText(/enter merchant name/i), 'New Co');
    await userEvent.click(screen.getAllByRole('button', { name: /create merchant/i })[0]);
    await waitFor(() => expect(createMerchant).toHaveBeenCalledTimes(1));
    expect(createMerchant.mock.calls[0][0].name).toBe('New Co');
    expect(navigate).toHaveBeenCalledWith('/settings/merchants');
  });

  it('picks the image through a button the keyboard reaches, and removes it', async () => {
    const opened = vi.spyOn(HTMLInputElement.prototype, 'click');
    const { container } = renderAt('/add');
    screen.getByRole('button', { name: 'Upload merchant image' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.contexts[0]).toMatchObject({ type: 'file' });
    opened.mockRestore();

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, new File(['x'], 'logo.png', { type: 'image/png' }));
    expect(await screen.findByAltText('Merchant preview')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    expect(screen.getByRole('button', { name: 'Upload merchant image' })).toBeInTheDocument();
  });

  it('blocks the add form when the name is empty', async () => {
    renderAt('/add');
    await userEvent.click(screen.getAllByRole('button', { name: /create merchant/i })[0]);
    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
    expect(createMerchant).not.toHaveBeenCalled();
  });

  it('seeds the edit form from the loaded merchant and saves edits', async () => {
    renderAt('/m-1/edit');
    const nameInput = await screen.findByDisplayValue('Acme');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Acme Inc');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateMerchant).toHaveBeenCalledTimes(1));
    const arg = updateMerchant.mock.calls[0][0];
    expect(arg.uuid).toBe('m-1');
    expect(arg.data.name).toBe('Acme Inc');
    expect(navigate).toHaveBeenCalledWith('/settings/merchants');
  });

  // The auto-tag is the form's own state, the merchant's id until the picker
  // changes it. Found in the tags list, it was none while the list loaded (or failed), and
  // saving cleared it.
  describe("the merchant's auto-tag", () => {
    const tags = [tag({ id: 5, name: 'Utilities' }), tag({ id: 6, name: 'Household' })];
    afterEach(() => {
      merchant.transaction_auto_tag_id = null;
      tagList.tags = [];
    });

    it('is kept by a save made before the tags have loaded', async () => {
      merchant.transaction_auto_tag_id = 5 as never;
      renderAt('/m-1/edit');
      await userEvent.type(await screen.findByDisplayValue('Acme'), ' Inc');
      await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(updateMerchant).toHaveBeenCalledTimes(1));
      expect(updateMerchant.mock.calls[0][0].data.transaction_auto_tag_id).toBe(5);
    });

    it('is shown once the tags have loaded, and saves the one picked', async () => {
      merchant.transaction_auto_tag_id = 5 as never;
      tagList.tags = tags;
      renderAt('/m-1/edit');
      // Shown by its name once the tags have loaded; its trigger names it as the selected tag.
      await userEvent.click(await screen.findByRole('button', { name: /Selected tag: Utilities/ }));
      await userEvent.click(await screen.findByRole('option', { name: /Household/ }));
      await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(updateMerchant).toHaveBeenCalledTimes(1));
      expect(updateMerchant.mock.calls[0][0].data.transaction_auto_tag_id).toBe(6);
    });
  });

  it('creates a matching rule from the rules form', async () => {
    renderAt('/m-1/rules');
    // Open the add-rule form via the header action.
    await userEvent.click(screen.getAllByRole('button', { name: /add rule/i })[0]);
    await userEvent.type(await screen.findByPlaceholderText(/enter text to match/i), 'SMPLMART');
    // The form's submit button is the one with type="submit" (header actions are type="button").
    const submitBtn = screen.getAllByRole('button', { name: /add rule/i })
      .find((b) => b.getAttribute('type') === 'submit');
    await userEvent.click(submitBtn!);
    await waitFor(() => expect(createRule).toHaveBeenCalledTimes(1));
    const arg = createRule.mock.calls[0][0];
    expect(arg.merchantUuid).toBe('m-1');
    expect(arg.ruleData.matching_text).toBe('SMPLMART');
  });
});
