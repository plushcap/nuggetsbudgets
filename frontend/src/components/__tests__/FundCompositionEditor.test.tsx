import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { pinTimeZone } from '../../test/timeZone';
import { apiError, mockApi } from '../../test/apiServer';
import { compositionUpsertSchema } from '@nuggets/shared';
import { created, investmentAnswers } from '../../test/fixtures';
import FundCompositionEditor from '../FundCompositionEditor';

/**
 * A refused save says why: the server's reason when the API answered, else a
 * fallback, never an error's own text (a failed fetch's "Failed to fetch"), as
 * apiErrorMessage gives it.
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

const SECURITY = '0190a000-0002-7000-8000-000000000001';

const save = async (compositionRoute: unknown) => {
  mockApi({
    [`GET /investments/securities/:uuid/composition`]: [],
    'POST /investments/compositions': compositionRoute,
  });
  const user = userEvent.setup();
  renderWithProviders(<Theme><FundCompositionEditor securityUuid={SECURITY} isPassThrough={false} securityType="stock" /></Theme>);
  await user.type(await screen.findByRole('textbox', { name: 'Category' }), 'Equity');
  await user.click(screen.getByRole('button', { name: /Save classification/ }));
  const { default: toast } = await import('react-hot-toast');
  return toast;
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('FundCompositionEditor', () => {
  it("sends a fund's weights as typed, for the API to read exactly", async () => {
    // Number() sent them as doubles: "100.0000000000000001" arrived as 100, accepted as if typed.
    const api = mockApi({
      [`GET /investments/securities/:uuid/composition`]: [],
      'POST /investments/compositions': created(investmentAnswers.composition),
    });
    const user = userEvent.setup();
    renderWithProviders(<Theme><FundCompositionEditor securityUuid={SECURITY} isPassThrough securityType="etf" /></Theme>);
    await user.type(await screen.findByRole('textbox', { name: 'Category 1' }), 'Domestic Stock');
    await user.type(screen.getByRole('spinbutton', { name: 'Category 1 weight' }), '99.5');
    await user.click(screen.getByRole('button', { name: 'Add row' }));
    await user.type(screen.getByRole('textbox', { name: 'Category 2' }), 'Cash');
    await user.type(screen.getByRole('spinbutton', { name: 'Category 2 weight' }), '0.5');
    await user.click(screen.getByRole('button', { name: /Save classification/ }));

    await waitFor(() => expect(api.calls('POST /investments/compositions')).toHaveLength(1));
    const body = api.calls('POST /investments/compositions')[0].body;
    expect(body).toMatchObject({ dimensions: { asset_class: [{ dimension_value: 'Domestic Stock', weight_percentage: '99.5' }, { dimension_value: 'Cash', weight_percentage: '0.5' }] } });
    expect(compositionUpsertSchema.safeParse(body).success).toBe(true);
  });

  // A row added and left without a weight went out as "" (the API's refusal named no row).
  it('refuses a blank weight beside its row, sends nothing, and focuses it', async () => {
    const api = mockApi({
      [`GET /investments/securities/:uuid/composition`]: [],
      'POST /investments/compositions': created(investmentAnswers.composition),
    });
    const user = userEvent.setup();
    renderWithProviders(<Theme><FundCompositionEditor securityUuid={SECURITY} isPassThrough securityType="etf" /></Theme>);
    await user.type(await screen.findByRole('textbox', { name: 'Category 1' }), 'Domestic Stock');
    await user.type(screen.getByRole('spinbutton', { name: 'Category 1 weight' }), '100');
    await user.click(screen.getByRole('button', { name: 'Add row' }));
    await user.type(screen.getByRole('textbox', { name: 'Category 2' }), 'Cash');
    await user.click(screen.getByRole('button', { name: /Save classification/ }));

    const blank = screen.getByRole('spinbutton', { name: 'Category 2 weight' });
    expect(blank).toHaveFocus();
    expect(blank).toHaveAttribute('aria-invalid', 'true');
    expect(blank).toHaveAccessibleDescription('Enter a weight (0 for none).');
    expect(api.calls('POST /investments/compositions')).toHaveLength(0);

    await user.type(blank, '0');
    expect(blank).not.toHaveAttribute('aria-invalid');
    await user.click(screen.getByRole('button', { name: /Save classification/ }));
    await waitFor(() => expect(api.calls('POST /investments/compositions')).toHaveLength(1));
    expect(api.calls('POST /investments/compositions')[0].body).toMatchObject({
      dimensions: { asset_class: [{ dimension_value: 'Domestic Stock', weight_percentage: '100' }, { dimension_value: 'Cash', weight_percentage: '0' }] },
    });
  });

  it('starts another dimension without the refused one\'s messages', async () => {
    mockApi({ [`GET /investments/securities/:uuid/composition`]: [] });
    const user = userEvent.setup();
    renderWithProviders(<Theme><FundCompositionEditor securityUuid={SECURITY} isPassThrough securityType="etf" /></Theme>);
    await user.type(await screen.findByRole('textbox', { name: 'Category 1' }), 'Domestic Stock');
    await user.type(screen.getByRole('spinbutton', { name: 'Category 1 weight' }), '100');
    await user.click(screen.getByRole('button', { name: 'Add row' }));
    await user.type(screen.getByRole('textbox', { name: 'Category 2' }), 'Cash');
    await user.click(screen.getByRole('button', { name: /Save classification/ }));
    expect(screen.getByText('Enter a weight (0 for none).')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: /Dimension/ }));
    await user.click(screen.getByRole('option', { name: 'Region' }));
    expect(screen.queryByText('Enter a weight (0 for none).')).toBeNull();
  });

  // On react-hook-form, Save stays enabled (it was disabled until the form could go) and
  // a save it can't make says why beside the field, focusing it.
  describe('a save it refuses', () => {
    const renderEditor = (isPassThrough: boolean) => {
      const api = mockApi({
        [`GET /investments/securities/:uuid/composition`]: [],
        'POST /investments/compositions': created(investmentAnswers.composition),
      });
      renderWithProviders(<Theme><FundCompositionEditor securityUuid={SECURITY} isPassThrough={isPassThrough} securityType={isPassThrough ? 'etf' : 'stock'} /></Theme>);
      return api;
    };

    it("asks a plain security for its category", async () => {
      const api = renderEditor(false);
      const user = userEvent.setup();
      const saveButton = screen.getByRole('button', { name: /Save classification/ });
      expect(saveButton).toBeEnabled();
      const category = await screen.findByRole('textbox', { name: 'Category' });
      await user.click(saveButton);
      await waitFor(() => expect(category).toHaveFocus());
      expect(category).toHaveAccessibleDescription('Enter a category.');
      expect(api.calls('POST /investments/compositions')).toHaveLength(0);
    });

    it("asks each of a fund's rows for a category", async () => {
      const api = renderEditor(true);
      const user = userEvent.setup();
      await user.type(await screen.findByRole('spinbutton', { name: 'Category 1 weight' }), '100');
      await user.click(screen.getByRole('button', { name: /Save classification/ }));
      const category = screen.getByRole('textbox', { name: 'Category 1' });
      await waitFor(() => expect(category).toHaveFocus());
      expect(category).toHaveAccessibleDescription('Enter a category, or remove the row.');
      expect(api.calls('POST /investments/compositions')).toHaveLength(0);
    });

    it("says the weights must total about 100%, and focuses that", async () => {
      const api = renderEditor(true);
      const user = userEvent.setup();
      await user.type(await screen.findByRole('textbox', { name: 'Category 1' }), 'Domestic Stock');
      await user.type(screen.getByRole('spinbutton', { name: 'Category 1 weight' }), '80');
      const total = screen.getByText(/^Weights must total between 95% and 105%/);
      await user.click(screen.getByRole('button', { name: /Save classification/ }));
      await waitFor(() => expect(total).toHaveFocus());
      expect(api.calls('POST /investments/compositions')).toHaveLength(0);
    });

    it("refuses beside its row a weight past what the API keeps, which only the request schema knows", async () => {
      const api = renderEditor(true);
      const user = userEvent.setup();
      await user.type(await screen.findByRole('textbox', { name: 'Category 1' }), 'Domestic Stock');
      const weight = screen.getByRole('spinbutton', { name: 'Category 1 weight' });
      await user.type(weight, '99.1234567');
      await user.click(screen.getByRole('button', { name: 'Add row' }));
      await user.type(screen.getByRole('textbox', { name: 'Category 2' }), 'Cash');
      await user.type(screen.getByRole('spinbutton', { name: 'Category 2 weight' }), '0.8');
      await user.click(screen.getByRole('button', { name: /Save classification/ }));
      await waitFor(() => expect(weight).toHaveFocus());
      expect(weight).toHaveAttribute('aria-invalid', 'true');
      expect(weight).toHaveAccessibleDescription(/6 decimal places/);
      expect(api.calls('POST /investments/compositions')).toHaveLength(0);
    });
  });

  it('toasts the server\'s reason when the API refuses the save', async () => {
    const toast = await save(apiError(400, 'error: composition weights sum to 80%, must be within 95-105%', 'INVALID_REQUEST'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('error: composition weights sum to 80%, must be within 95-105%'));
  });

  it('toasts a fallback, not the error\'s own text, when the request fails', async () => {
    const toast = await save(() => { throw new TypeError('Failed to fetch'); });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to save classification'));
    expect(toast.error).not.toHaveBeenCalledWith('Failed to fetch');
  });
});
