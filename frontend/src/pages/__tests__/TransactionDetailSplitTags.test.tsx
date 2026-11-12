import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { mockApi, type ApiRequest } from '../../test/apiServer';
import TransactionDetailPage from '../TransactionDetailPage';

/**
 * GET /api/transactions/:uuid listed the splits without their tags, so re-editing them
 * sent `tag_ids: []`, and the re-split replaced them with untagged ones. Now the answer has
 * them and the editor sends them back; a split whose tags the page doesn't have (an answer a
 * production build kept although it didn't match its schema) isn't re-split at all.
 */

const splitTransaction = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const PARENT_UUID = '0190a000-0000-7000-8000-0000000000a1';

const tag = (id: number, name: string) => ({ id, uuid: `0190a000-0000-7000-8000-00000000${String(id).padStart(4, '0')}`, name, color: '#2563eb', icon: null });
const trip = tag(1, 'Trip');
const kids = tag(2, 'Kids');

const child = (id: number, amount: number, tags: ReturnType<typeof tag>[] | undefined) => ({
  id,
  uuid: `0190a000-0000-7000-8000-0000000001${String(id).padStart(2, '0')}`,
  amount,
  description: 'Shop',
  budget_item_id: null,
  budget_period_id: null,
  budget_period_item_id: null,
  budget_item_name: null,
  budget_item_uuid: null,
  status: 'cleared',
  transaction_date: '2026-06-12',
  type: 'expense',
  ...(tags === undefined ? {} : { tags }),
});

let splitChildren: ReturnType<typeof child>[] = [];
const transaction = () => ({
  id: 7,
  uuid: PARENT_UUID,
  amount: -40,
  transaction_date: '2026-06-12',
  type: 'expense',
  status: 'cleared',
  review_status: 'reviewed',
  account_id: 3,
  budget_item_id: null,
  merchant_id: null,
  budget_period_id: null,
  assigned_to: null,
  notes: '',
  description: 'Shop',
  merchant_name: 'Corner Store',
  parent_transaction_id: null,
  parent_transaction_uuid: null,
  is_split_parent: true,
  account_class: 'Asset',
  tags: [],
  split_children: splitChildren,
});
let current = transaction();

vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  const noop = () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  const empty: never[] = [];
  return {
    ...actual,
    useTransactionQuery: () => ({ data: current, isLoading: false }),
    useBudgetItemsQuery: () => ({ data: empty }),
    useBudgetPeriodsQuery: () => ({ data: empty }),
    useMerchantsQuery: () => ({ data: empty }),
    useUsersQuery: () => ({ data: empty }),
    useTagsQuery: () => ({ data: [trip, kids] }),
    useTransactionTagsQuery: () => ({ data: empty }),
    useTransactionAttachmentsQuery: () => ({ data: { attachments: empty } }),
    useUploadAttachmentsMutation: noop,
    useDeleteAttachmentMutation: noop,
    useUpdateTransactionMutation: noop,
    useDeleteTransactionMutation: noop,
    useSplitTransactionMutation: () => ({ mutateAsync: splitTransaction, isPending: false }),
    useUnsplitTransactionMutation: noop,
    useCreateMerchantMutation: noop,
  };
});

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => vi.fn(), useParams: () => ({ uuid: PARENT_UUID }) };
});
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
import toast from 'react-hot-toast';

const renderPage = () => renderWithProviders(<Theme><TransactionDetailPage /></Theme>, { route: '/' });

describe("TransactionDetailPage: a split's tags", () => {
  // The hooks above are stubbed; the activity still fetches, so the API stand-in answers it,
  // and a request it doesn't answer fails the test.
  let api: ReturnType<typeof mockApi>;
  beforeEach(() => {
    splitTransaction.mockClear();
    vi.mocked(toast.error).mockClear();
    api = mockApi({
      'GET /annotations': (req: ApiRequest) => ({ subject_type: req.query.get('subject_type'), subject_uuid: req.query.get('subject_uuid'), annotations: [] }),
    });
  });
  afterEach(() => {
    splitChildren = [];
    current = transaction();
    expect(api.unhandled).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('shows each split with its tags, and sends them back when the splits are re-edited', async () => {
    splitChildren = [child(11, -25, [trip, kids]), child(12, -15, [])];
    current = transaction();
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('Trip')).toBeInTheDocument();
    expect(screen.getByText('Kids')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /edit splits/i }));
    await user.click(screen.getByRole('button', { name: /update split/i }));
    await waitFor(() => expect(splitTransaction).toHaveBeenCalledTimes(1));
    const [uuid, splits] = splitTransaction.mock.calls[0]![0] as [string, { amount: number; tag_ids?: number[] }[]];
    expect(uuid).toBe(PARENT_UUID);
    expect(splits.map((s) => [s.amount, s.tag_ids])).toEqual([[-25, [1, 2]], [-15, []]]);
  });

  it("doesn't re-split splits whose tags it doesn't have, which would lose them", async () => {
    splitChildren = [child(11, -25, undefined), child(12, -15, [trip])];
    current = transaction();
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /edit splits/i }));
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/without their tags/));
    expect(screen.queryByRole('button', { name: /update split/i })).not.toBeInTheDocument();
    expect(splitTransaction).not.toHaveBeenCalled();
  });
});
