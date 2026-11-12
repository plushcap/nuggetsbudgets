import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders } from '../../test/renderWithProviders';
import { mockApi, type ApiRequest } from '../../test/apiServer';
import { budgetItem, category as categoryFixture, institution, matchingRule, merchantLite, savedMatchingRule, uuidFor, type MatchingRuleWire } from '../../test/fixtures';
import EditInstitutionPage from '../EditInstitutionPage';
import CategoriesPage from '../CategoriesPage';
import BudgetMatchingRulesPage from '../BudgetMatchingRulesPage';

/**
 * An edit form whose field is cleared sends it as none. These routes are
 * PUTs that replace the record, and the forms used to leave an empty field out of the body:
 * the request didn't say what the form showed, and a field a method hides (a rule's
 * matching text) went out with its old value.
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

afterEach(() => vi.unstubAllGlobals());

const INSTITUTION = uuidFor(7, 1);
const CATEGORY = uuidFor(8, 1);
const RULE = uuidFor(9, 1);

describe('Edit Institution', () => {
  it('sends cleared notes as null', async () => {
    const api = mockApi({
      'GET /institutions/:uuid': institution({ id: 1, uuid: INSTITUTION, name: 'Old Bank', notes: 'old notes' }),
      'PUT /institutions/:uuid': (req: ApiRequest) => institution({ id: 1, uuid: INSTITUTION, ...(req.body as { name: string }) }),
      'GET /institutions': [],
    });
    renderWithProviders(
      <Theme><Routes><Route path="/settings/institutions/:uuid/edit" element={<EditInstitutionPage />} /></Routes></Theme>,
      { route: `/settings/institutions/${INSTITUTION}/edit` },
    );
    const user = userEvent.setup();
    await user.clear(await screen.findByDisplayValue('old notes'));
    await user.click(screen.getAllByRole('button', { name: /save changes/i })[0]);

    await waitFor(() => expect(api.calls('PUT /institutions/:uuid')).toHaveLength(1));
    expect(api.calls('PUT /institutions/:uuid')[0].body).toEqual({ name: 'Old Bank', notes: null });
  });
});

describe('Edit Category', () => {
  const category = categoryFixture({
    id: 1, uuid: CATEGORY, name: 'Food', description: 'groceries', priority: 'Essential', notes: 'weekly', icon: 'Tag',
  });

  it('sends a cleared description and notes, and the Undefined priority, as null', async () => {
    const api = mockApi({
      'GET /categories': [category],
      'PUT /categories/:uuid': (req: ApiRequest) => ({ ...category, ...(req.body as object) }),
    });
    renderWithProviders(<Theme><CategoriesPage /></Theme>, { route: `/${CATEGORY}/edit` });
    const user = userEvent.setup();
    await user.clear(await screen.findByDisplayValue('groceries'));
    await user.clear(screen.getByDisplayValue('weekly'));
    await user.click(screen.getByRole('combobox', { name: /priority/i }));
    await user.click(await screen.findByRole('option', { name: /undefined/i }));
    await user.click(screen.getAllByRole('button', { name: /save changes/i })[0]);

    await waitFor(() => expect(api.calls('PUT /categories/:uuid')).toHaveLength(1));
    expect(api.calls('PUT /categories/:uuid')[0].body).toEqual({
      name: 'Food', icon: 'Tag', description: null, priority: null, notes: null,
    });
  });
});

describe('Edit Budget Matching Rule', () => {
  const rule = matchingRule({ id: 9, uuid: RULE, matching_text: 'SMPLMART', notes: 'from the card', budget_item_name: 'Shopping' });
  const routes = () => ({
    'GET /budgets/item-matching-rules': [rule],
    'GET /budgets/items': [budgetItem({ id: 5, name: 'Shopping' })],
    'GET /merchants': [merchantLite({ id: 3, uuid: uuidFor(3, 3), name: 'Sample Mart' })],
    'PUT /budgets/item-matching-rules/:uuid': (req: ApiRequest) => savedMatchingRule(rule, req.body as object),
  });
  const renderEdit = () => renderWithProviders(<Theme><BudgetMatchingRulesPage /></Theme>, { route: `/${RULE}/edit` });

  it('sends cleared notes as null', async () => {
    const api = mockApi(routes());
    renderEdit();
    const user = userEvent.setup();
    await user.clear(await screen.findByDisplayValue('from the card'));
    await user.click(screen.getAllByRole('button', { name: /save changes/i })[0]);

    await waitFor(() => expect(api.calls('PUT /budgets/item-matching-rules/:uuid')).toHaveLength(1));
    expect(api.calls('PUT /budgets/item-matching-rules/:uuid')[0].body).toEqual({
      budget_item_id: 5, method: 'contains', matching_text: 'SMPLMART', merchant_id: null,
      amount_min: null, amount_max: null, priority: 100, is_active: true, notes: null,
    });
  });

  it('drops the matching text when the method changes to merchant matching', async () => {
    const api = mockApi(routes());
    renderEdit();
    const user = userEvent.setup();
    await screen.findByDisplayValue('SMPLMART');
    await user.click(screen.getByRole('combobox', { name: /matching method/i }));
    await user.click(await screen.findByRole('option', { name: /merchant match/i }));
    await user.click(await screen.findByRole('button', { name: /^merchant/i }));
    await user.click(await screen.findByRole('option', { name: /sample mart/i }));
    await user.click(screen.getAllByRole('button', { name: /save changes/i })[0]);

    await waitFor(() => expect(api.calls('PUT /budgets/item-matching-rules/:uuid')).toHaveLength(1));
    expect(api.calls('PUT /budgets/item-matching-rules/:uuid')[0].body).toMatchObject({
      method: 'merchant_exact', merchant_id: 3, matching_text: null,
    });
  });
});

describe('Budget Matching Rule bounds, merchant and active box', () => {
  const base = matchingRule({ id: 9, uuid: RULE, matching_text: 'GAS', budget_item_name: 'Shopping' });
  const PUT = 'PUT /budgets/item-matching-rules/:uuid';
  const routes = (rule: MatchingRuleWire) => ({
    'GET /budgets/item-matching-rules': [rule],
    'GET /budgets/items': [budgetItem({ id: 5, name: 'Shopping' })],
    'GET /merchants': [merchantLite({ id: 3, uuid: uuidFor(3, 3), name: 'Sample Mart' })],
    [PUT]: (req: ApiRequest) => savedMatchingRule(rule, req.body as object),
    'POST /budgets/item-matching-rules': (req: ApiRequest) => ({ status: 201, body: savedMatchingRule(rule, req.body as object) }),
  });
  const renderAt = (route: string) => renderWithProviders(<Theme><BudgetMatchingRulesPage /></Theme>, { route });
  const save = async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getAllByRole('button', { name: /save changes/i })[0]);

  // The bounds were TextFields that stored parseFloat of each keystroke and showed it back, so
  // the dot of "12.50" vanished (12. is 12) and the rule's minimum was 1250.
  it('saves the bounds as typed, either separator', async () => {
    const api = mockApi(routes(base));
    renderAt(`/${RULE}/edit`);
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Minimum Amount' }), '12.50');
    await user.type(screen.getByRole('textbox', { name: 'Maximum Amount' }), '1.234,56');
    await save(user);
    await waitFor(() => expect(api.calls(PUT)).toHaveLength(1));
    expect(api.calls(PUT)[0].body).toMatchObject({ amount_min: 12.5, amount_max: 1234.56 });
  });

  it('keeps a bound of 0 typed, which is a bound, not none', async () => {
    const api = mockApi(routes(base));
    renderAt(`/${RULE}/edit`);
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Minimum Amount' }), '0');
    await save(user);
    await waitFor(() => expect(api.calls(PUT)).toHaveLength(1));
    expect(api.calls(PUT)[0].body).toMatchObject({ amount_min: 0, amount_max: null });
  });

  it('shows a stored bound, 0 included, and refuses one it cannot read beside it', async () => {
    const api = mockApi(routes({ ...base, amount_min: '0.00', amount_max: '50.00' }));
    renderAt(`/${RULE}/edit`);
    const user = userEvent.setup();
    const max = await screen.findByRole('textbox', { name: 'Maximum Amount' });
    expect(screen.getByRole('textbox', { name: 'Minimum Amount' })).toHaveValue('0.00');
    expect(max).toHaveValue('50.00');
    await user.clear(max);
    await user.type(max, '5o');
    await save(user);
    await waitFor(() => expect(max).toHaveAccessibleDescription('Not an amount: enter it like 1,234.56, or leave it empty.'));
    expect(api.calls(PUT)).toHaveLength(0);
    await user.clear(max);
    await save(user);
    await waitFor(() => expect(api.calls(PUT)).toHaveLength(1));
    expect(api.calls(PUT)[0].body).toMatchObject({ amount_min: 0, amount_max: null });
  });

  // The merchant picked for merchant matching stayed in the form when the method changed, and
  // the matcher read the text rule only for that merchant's transactions.
  it('drops the merchant when the method changes away from merchant matching', async () => {
    const api = mockApi(routes({ ...base, method: 'merchant_exact', matching_text: null, merchant_id: 3 }));
    renderAt(`/${RULE}/edit`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /matching method/i }));
    await user.click(await screen.findByRole('option', { name: /^contains/i }));
    await user.type(await screen.findByLabelText(/matching text/i), 'GAS');
    await save(user);
    await waitFor(() => expect(api.calls(PUT)).toHaveLength(1));
    expect(api.calls(PUT)[0].body).toMatchObject({ method: 'contains', matching_text: 'GAS', merchant_id: null });
  });

  it('keeps the merchant a text rule has already', async () => {
    const api = mockApi(routes({ ...base, merchant_id: 3 }));
    renderAt(`/${RULE}/edit`);
    const user = userEvent.setup();
    await screen.findByDisplayValue('GAS');
    await save(user);
    await waitFor(() => expect(api.calls(PUT)).toHaveLength(1));
    expect(api.calls(PUT)[0].body).toMatchObject({ method: 'contains', merchant_id: 3 });
  });

  // The add form's "Rule is active" box was left out of the body.
  it('creates the rule inactive when the box is cleared', async () => {
    const api = mockApi(routes(base));
    renderAt('/add?budget_item_id=5');
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText(/text to match in transaction descriptions/i), 'SAMPLE STORE');
    await user.click(screen.getByRole('checkbox', { name: /active/i }));
    await user.click(screen.getAllByRole('button', { name: /create rule/i })[0]);
    await waitFor(() => expect(api.calls('POST /budgets/item-matching-rules')).toHaveLength(1));
    expect(api.calls('POST /budgets/item-matching-rules')[0].body).toMatchObject({ matching_text: 'SAMPLE STORE', is_active: false, merchant_id: null });
  });
});
