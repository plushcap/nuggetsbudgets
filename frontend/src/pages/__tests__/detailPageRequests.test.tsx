import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Theme } from '@radix-ui/themes';
import ViewBudgetItemPage from '../ViewBudgetItemPage';
import ViewMerchantPage from '../ViewMerchantPage';
import EditExpensePage from '../EditExpensePage';
import EditIncomePage from '../EditIncomePage';
import EditBillsPage from '../EditBillsPage';
import { budgetItem, budgetPeriod, budgetPeriodItem, merchant, merchantLite, type BudgetItemWire } from '../../test/fixtures';

/**
 * How many requests each detail page sends when it opens, with the real query
 * hooks and API functions and a stubbed fetch. The envelope page sent about 25 (one per
 * period) and the edit pages one per period for a rollover item; the merchant page and the
 * edit pages fetched every one of the item's transactions to show one page of them.
 */

vi.mock('@nivo/bar', () => ({ ResponsiveBar: () => null }));
vi.mock('@nivo/treemap', () => ({ ResponsiveTreeMap: () => null }));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

const ITEM_UUID = '0190a000-0000-7000-8000-0000000000b1';
const MERCHANT_UUID = '0190a000-0000-7000-8000-0000000000c1';

// Rows as the API sends them (the api modules parse them with the shared schemas).
const item = (over: Partial<BudgetItemWire>) =>
  budgetItem({
    id: 1,
    uuid: ITEM_UUID,
    name: 'Car repairs',
    type: 'Envelope',
    expense_type: 'Expense',
    rollover: true,
    rollover_target_amount: '500.00',
    isbill: false,
    status: 'active',
    ...over,
  });

/** Thirty monthly periods, as GET /budgets/periods answers. */
const periods = Array.from({ length: 30 }, (_, i) => {
  const month = (i % 12) + 1;
  const year = 2024 + Math.floor(i / 12);
  const mm = String(month).padStart(2, '0');
  return budgetPeriod(year, month, {
    id: i + 1,
    uuid: `0190a000-0000-7000-8000-${String(i + 1).padStart(12, '0')}`,
    name: `${year}-${mm}`,
    month: `M${month}`,
    end_date: `${year}-${mm}-28`,
    status: 'closed',
  });
});

const figures = { budget: '100.00', actual: '-20.00', transfers: '0.00', remaining: '80.00' };
const periodItem = budgetPeriodItem(periods[29], {
  id: 1,
  budget_item_id: 1,
  budget_item_name: 'Car repairs',
  budget_item_uuid: ITEM_UUID,
  calculated_budget: '100.00',
  calculated_actual: '-20.00',
  calculated_transfers: '0.00',
  calculated_remaining: '80.00',
});

let currentItem = item({});
const requests: string[] = [];
/** Paths (no query) answered 500, to show each page's error state. */
let failing: RegExp | null = null;

function respond(url: string): unknown {
  const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (path === '/api/budgets/items') return [currentItem];
  if (path === '/api/budgets/periods') return periods;
  if (/^\/api\/budgets\/periods\/[^/]+\/items$/.test(path)) return { success: true, data: [periodItem] };
  if (path === `/api/budget-items/${ITEM_UUID}/history`) {
    return {
      budget_item_uuid: ITEM_UUID,
      periods: periods.slice(-24).map((p) => ({ period_uuid: p.uuid, period_name: p.name, ...p, ...figures })),
      current: { period_uuid: periods[29].uuid, ...periods[29], ...figures },
    };
  }
  if (path === '/api/transactions/paginated') return { transactions: [], pagination: { total: 0, totalPages: 0, page: 1, limit: 25 } };
  if (path === `/api/merchants/${MERCHANT_UUID}`) return merchant({ id: 7, uuid: MERCHANT_UUID, name: 'Corner Garage' });
  if (path === '/api/merchants') {
    return url.includes('fields=lite')
      ? [merchantLite({ id: 7, uuid: MERCHANT_UUID, name: 'Corner Garage' })]
      : [merchant({ id: 7, uuid: MERCHANT_UUID, name: 'Corner Garage', transaction_count: 0, rule_count: 0 })];
  }
  if (path === `/api/merchant-spending/${MERCHANT_UUID}`) {
    return { merchant_uuid: MERCHANT_UUID, since: '2024-11-02', transaction_count: 0, rule_count: 0, monthly: [], by_budget_item: [] };
  }
  if (path.startsWith('/api/budget-event-history') || path.includes('/history')) return { success: true, data: [] };
  return [];
}

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(url.replace(/^https?:\/\/[^/]+/, ''));
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (failing?.test(path)) {
      return new Response(JSON.stringify({ error: 'boom', code: 'INTERNAL_ERROR' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify(respond(url)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => {
  failing = null;
  vi.unstubAllGlobals();
});

/**
 * The app's query client settings that decide what is fetched (queries/queryClient.ts): data
 * stays fresh for 30 s. The tests' usual client (staleTime 0) refetches for every component
 * that mounts after a query answered: the edit pages' Archive dialog, which reads the budget
 * items the page already has, then counted a second GET /budgets/items the app never sends.
 */
const appLikeClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: Infinity }, mutations: { retry: false } } });

/** Render a page at a route, wait until every query has settled, and return the requests it sent. */
async function requestsOf(path: string, route: string, page: ReactElement): Promise<string[]> {
  const client = appLikeClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Theme>
          <Routes>
            <Route path={path} element={page} />
          </Routes>
        </Theme>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  // Settled: nothing fetching, and still nothing a moment later (a query enabled by
  // another's answer starts after it).
  await waitFor(async () => {
    expect(client.isFetching()).toBe(0);
    const before = requests.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.isFetching()).toBe(0);
    expect(requests.length).toBe(before);
  });
  const sent = [...requests].sort();
  if (process.env.PRINT_REQUEST_COUNTS) process.stdout.write(`${route}: ${sent.length}\n  ${sent.join('\n  ')}\n`);
  return sent;
}

const isPeriodItems = (u: string) => /^\/api\/budgets\/periods\/[^/]+\/items/.test(u);
const isBudgetItems = (u: string) => u === '/api/budgets/items';
const isAllTransactions = (u: string) => /^\/api\/transactions\?/.test(u) || u === '/api/transactions';

describe('detail-page requests', () => {
  it('ViewBudgetItemPage: one history request, no per-period calls', async () => {
    currentItem = item({});
    const sent = await requestsOf('/b/:budgetItemUuid', `/b/${ITEM_UUID}`, <ViewBudgetItemPage />);
    expect(sent.filter(isPeriodItems)).toEqual([]);
    expect(sent.filter((u) => u.startsWith('/api/budgets/periods'))).toEqual([]);
    expect(sent.filter((u) => u.startsWith(`/api/budget-items/${ITEM_UUID}/history`))).toEqual([
      `/api/budget-items/${ITEM_UUID}/history?periods=24`,
    ]);
    expect(sent).toHaveLength(5); // items, categories, merchants (lite), transactions in the chart window, history
  });

  it('ViewMerchantPage: the merchant by uuid, one summary, one page of transactions', async () => {
    const sent = await requestsOf('/m/:merchantUuid', `/m/${MERCHANT_UUID}`, <ViewMerchantPage />);
    expect(sent).toContain(`/api/merchants/${MERCHANT_UUID}`);
    expect(sent).toContain('/api/merchants?fields=lite');
    expect(sent).not.toContain('/api/merchants'); // the full list, with per-merchant counts
    expect(sent.filter(isAllTransactions)).toEqual([]);
    expect(sent.filter((u) => u.startsWith('/api/transactions/paginated'))).toHaveLength(1);
    expect(sent.find((u) => u.startsWith('/api/transactions/paginated'))).toMatch(/limit=25/);
    expect(sent).toHaveLength(5); // merchant, lite names, budget items, spending, one page
  });

  it('EditExpensePage (rollover): one history request and one page of transactions', async () => {
    currentItem = item({});
    const sent = await requestsOf('/e/:uuid', `/e/${ITEM_UUID}`, <EditExpensePage />);
    expect(sent.filter(isPeriodItems)).toEqual([]);
    expect(sent).not.toContain('/api/budgets/periods');
    expect(sent.filter(isAllTransactions)).toEqual([]);
    expect(sent.filter((u) => u.startsWith('/api/transactions/paginated'))).toHaveLength(1);
    expect(sent.filter((u) => u.includes('/history?periods=1'))).toHaveLength(1);
    expect(sent.filter(isBudgetItems)).toHaveLength(1);
    // Its usage: whether its history fixes its rolling over.
    expect(sent.filter((u) => u.endsWith(`/api/budgets/items/${ITEM_UUID}/usage`))).toHaveLength(1);
    expect(sent).toHaveLength(8); // was 6 + one per period up to today's (30 with 30 periods), then the usage
  });

  it('EditIncomePage: one page of transactions', async () => {
    currentItem = item({ type: 'Income', expense_type: 'Income', rollover: false });
    const sent = await requestsOf('/i/:uuid', `/i/${ITEM_UUID}`, <EditIncomePage />);
    expect(sent.filter(isAllTransactions)).toEqual([]);
    expect(sent.filter((u) => u.startsWith('/api/transactions/paginated'))).toHaveLength(1);
    expect(sent.filter(isBudgetItems)).toHaveLength(1);
    expect(sent).toHaveLength(5);
  });

  it('EditBillsPage: one history request and the ten newest transactions', async () => {
    currentItem = item({ type: 'Bill', isbill: true, rollover: true });
    const sent = await requestsOf('/x/:uuid', `/x/${ITEM_UUID}`, <EditBillsPage />);
    expect(sent.filter(isPeriodItems)).toEqual([]);
    expect(sent).not.toContain('/api/budgets/periods');
    expect(sent.filter(isAllTransactions)).toEqual([]);
    expect(sent.find((u) => u.startsWith('/api/transactions/paginated'))).toMatch(/limit=10/);
    expect(sent.filter(isBudgetItems)).toHaveLength(1);
    expect(sent.filter((u) => u.endsWith(`/api/budgets/items/${ITEM_UUID}/usage`))).toHaveLength(1);
    expect(sent).toHaveLength(10); // with its usage
  });
});

describe('detail-page error states', () => {
  it('ViewBudgetItemPage shows a failed history request instead of an empty envelope chart', async () => {
    currentItem = item({});
    failing = /\/history$/;
    await requestsOf('/b/:budgetItemUuid', `/b/${ITEM_UUID}`, <ViewBudgetItemPage />);
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent).join(' ')).toMatch(/boom/);
  });

  it('ViewBudgetItemPage shows a failed transaction request instead of an empty chart', async () => {
    currentItem = item({ type: 'Monthly', rollover: false });
    failing = /^\/api\/transactions$/;
    await requestsOf('/b/:budgetItemUuid', `/b/${ITEM_UUID}`, <ViewBudgetItemPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });

  it('EditExpensePage shows a failed history request, not "Loading" forever', async () => {
    currentItem = item({});
    failing = /\/history$/;
    await requestsOf('/e/:uuid', `/e/${ITEM_UUID}`, <EditExpensePage />);
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent).join(' ')).toMatch(/boom/);
    expect(screen.queryByText(/loading budget data/i)).not.toBeInTheDocument();
  });

  it('EditBillsPage shows a failed history request', async () => {
    currentItem = item({ type: 'Bill', isbill: true, rollover: true });
    failing = /\/history$/;
    await requestsOf('/x/:uuid', `/x/${ITEM_UUID}`, <EditBillsPage />);
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent).join(' ')).toMatch(/boom/);
  });

  it('ViewMerchantPage shows failed spending and transaction requests', async () => {
    failing = /^\/api\/(merchant-spending\/.*|transactions\/paginated)$/;
    await requestsOf('/m/:merchantUuid', `/m/${MERCHANT_UUID}`, <ViewMerchantPage />);
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThanOrEqual(3); // two charts and the table
  });
});
