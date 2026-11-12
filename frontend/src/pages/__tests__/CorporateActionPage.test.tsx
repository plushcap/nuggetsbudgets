import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { Route, Routes } from 'react-router-dom';
import { mergerCashSchema, returnOfCapitalSchema, spinoffActionSchema, splitActionSchema } from '@nuggets/shared';
import { renderWithProviders } from '../../test/renderWithProviders';
import { pinTimeZone } from '../../test/timeZone';
import { apiError, mockApi } from '../../test/apiServer';
import { created, investmentAnswers, security } from '../../test/fixtures';
import CorporateActionPage from '../CorporateActionPage';

/**
 * Applying a corporate action: the figures go as the exact text the API reads to 6
 * places. A spinoff's basis share was Number(percent) / 100, a float: 14.3% went as
 * 0.14300000000000002, which the API refused, and the page said only "Failed to apply
 * corporate action" (2,760 of the 10,001 two-decimal percentages from 0 to 100 failed).
 */

Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
});

vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});

pinTimeZone('UTC', '2026-10-15T12:00:00Z');

const parent = security({ id: 1, ticker: 'PRNT', name: 'Parent Co' });
const child = security({ id: 2, ticker: 'CHLD', name: 'Spun-off Co' });

const routes = (overrides: Parameters<typeof mockApi>[0] = {}) => ({
  'GET /investments/securities': [parent, child],
  'POST /investments/corporate-actions/spinoff': created(investmentAnswers.spinoff),
  'POST /investments/corporate-actions/split': created(investmentAnswers.split),
  'POST /investments/corporate-actions/return-of-capital': created(investmentAnswers.returnOfCapital),
  'POST /investments/corporate-actions/merger-cash': created(investmentAnswers.mergerCash),
  'POST /investments/corporate-actions/merger-stock': created(investmentAnswers.mergerStock),
  ...overrides,
});

const renderPage = () =>
  renderWithProviders(
    <Theme>
      <Routes>
        <Route path="/investments/corporate-action" element={<CorporateActionPage />} />
        <Route path="/investments" element={<p>Investments overview</p>} />
      </Routes>
    </Theme>,
    { route: '/investments/corporate-action' },
  );

const choose = async (user: ReturnType<typeof userEvent.setup>, field: RegExp, option: RegExp) => {
  await user.click(await screen.findByRole('combobox', { name: field }));
  await user.click(await screen.findByRole('option', { name: option }));
};

const fillSpinoff = async (user: ReturnType<typeof userEvent.setup>, percent: string) => {
  await choose(user, /^Security/, /PRNT/);
  await choose(user, /^Action/, /^Spinoff$/);
  await choose(user, /New \(spun-off\) security/, /CHLD/);
  const allocation = screen.getByRole('spinbutton', { name: /Basis allocated/ });
  await user.clear(allocation);
  await user.type(allocation, percent);
  const ratio = screen.getByRole('spinbutton', { name: /New shares per source share/ });
  await user.clear(ratio);
  await user.type(ratio, '0.333333');
};

let api: ReturnType<typeof mockApi>;
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('CorporateActionPage', () => {
  it.each([
    ['14.3', '0.143'],
    ['33.3', '0.333'],
    ['57.9', '0.579'],
    ['0.5', '0.005'],
    ['12.3456', '0.123456'],
    ['100', '1'],
  ])('sends a spinoff of %s percent as the fraction %s, exactly', async (percent, fraction) => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    await fillSpinoff(user, percent);
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(api.calls('POST /investments/corporate-actions/spinoff')).toHaveLength(1));
    const body = api.calls('POST /investments/corporate-actions/spinoff')[0].body;
    expect(body).toEqual({
      source_security_uuid: parent.uuid,
      new_security_uuid: child.uuid,
      action_date: '2026-10-15',
      allocation_fraction: fraction,
      share_ratio: '0.333333',
    });
    expect(spinoffActionSchema.safeParse(body).success).toBe(true);
    expect(await screen.findByText('Investments overview')).toBeInTheDocument();
  });

  it('says a percentage with more than 4 decimal places can\'t be sent, and Apply focuses it instead of sending', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    await fillSpinoff(user, '14.33333');
    const allocation = screen.getByRole('spinbutton', { name: /Basis allocated/ });
    expect(allocation).toHaveAttribute('aria-invalid', 'true');
    expect(allocation).toHaveAccessibleDescription('Enter at most 4 decimal places.');
    // The button stays enabled (CLAUDE.md's form rules): pressing it lands on what to fix.
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(allocation).toHaveFocus());

    await user.clear(allocation);
    await user.type(allocation, '120');
    expect(allocation).toHaveAccessibleDescription('Enter a percentage from 0 to 100.');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(allocation).toHaveFocus());
    expect(api.calls('POST /investments/corporate-actions/spinoff')).toHaveLength(0);
  });

  it.each([
    ['a split\'s new shares', 'split', 'New shares', 'split'],
    ['a split\'s old shares', 'split', 'Old shares', 'split'],
    ['a spinoff\'s share ratio', 'spinoff', /New shares per source share/, 'spinoff'],
    ['a stock merger\'s exchange ratio', 'merger_stock', /Exchange ratio/, 'merger-stock'],
  ] as const)('refuses %s written with an exponent, beside the field, and sends nothing', async (_label, action, field, route) => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    await choose(user, /^Security/, /PRNT/);
    if (action === 'spinoff') await fillSpinoff(user, '20');
    if (action === 'merger_stock') {
      await choose(user, /^Action/, /^Merger \(stock\)$/);
      await choose(user, /Acquirer security/, /CHLD/);
    }
    const input = screen.getByRole('spinbutton', { name: field });
    // What a browser's number field holds when 1e2 is typed (user-event's typing makes it 100).
    fireEvent.change(input, { target: { value: '1e2' } });
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter a plain number, like 12.5, without an exponent or a sign.');
    expect(api.calls(`POST /investments/corporate-actions/${route}`)).toHaveLength(0);
  });

  it('says what is missing when Apply is pressed too soon, on the field', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Apply' }));
    const securityField = screen.getByRole('combobox', { name: /^Security/ });
    await waitFor(() => expect(securityField).toHaveFocus());
    expect(securityField).toHaveAccessibleDescription('Choose a security.');
  });

  it.each([
    ['Return of capital', 'return-of-capital', 'Return of capital per share', 'amount_per_share', returnOfCapitalSchema],
    ['Merger (cash)', 'merger-cash', 'Cash per share', 'cash_per_share', mergerCashSchema],
  ] as const)('takes a %s amount per share to four decimal places', async (actionName, route, field, key, schema) => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    await choose(user, /^Security/, /PRNT/);
    await choose(user, /^Action/, new RegExp(`^${actionName.replace(/[()]/g, '\\$&')}$`));
    await user.type(screen.getByRole('textbox', { name: field }), '0.1234');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(api.calls(`POST /investments/corporate-actions/${route}`)).toHaveLength(1));
    const body = api.calls(`POST /investments/corporate-actions/${route}`)[0].body as Record<string, unknown>;
    expect(body[key]).toBe(0.1234);
    expect(schema.safeParse(body).success).toBe(true);
  });

  it('sends a split\'s ratio as typed', async () => {
    api = mockApi(routes());
    const user = userEvent.setup();
    renderPage();

    await choose(user, /^Security/, /PRNT/);
    const [newShares, oldShares] = [screen.getByRole('spinbutton', { name: 'New shares' }), screen.getByRole('spinbutton', { name: 'Old shares' })];
    await user.clear(newShares);
    await user.type(newShares, '1.000001');
    await user.clear(oldShares);
    await user.type(oldShares, '3');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(api.calls('POST /investments/corporate-actions/split')).toHaveLength(1));
    const body = api.calls('POST /investments/corporate-actions/split')[0].body;
    expect(body).toMatchObject({ security_uuid: parent.uuid, numerator: '1.000001', denominator: '3', reverse: false, dry_run: false });
    expect(splitActionSchema.safeParse(body).success).toBe(true);
  });

  it('stays on the form and gives the server\'s reason when the API refuses', async () => {
    api = mockApi(routes({
      'POST /investments/corporate-actions/spinoff': apiError(409, 'A spinoff of this security on 2026-10-15 is already recorded.', 'CORPORATE_ACTION_ALREADY_RECORDED'),
    }));
    const user = userEvent.setup();
    renderPage();

    await fillSpinoff(user, '20');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    const { default: toast } = await import('react-hot-toast');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A spinoff of this security on 2026-10-15 is already recorded.'));
    expect(screen.queryByText('Investments overview')).toBeNull();
  });
});
