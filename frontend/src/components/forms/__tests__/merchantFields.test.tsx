import { describe, it, expect, vi } from 'vitest';
import { useEffect } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { Theme } from '@radix-ui/themes';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '../../../test/renderWithProviders';
import type { Merchant } from '../../../services/api';
import BudgetMatchingRuleFormFields, {
  createDefaultBudgetMatchingRuleForm,
  type BudgetMatchingRuleFormData,
} from '../BudgetMatchingRuleFormFields';
import BillFormFields, { createDefaultBillForm, type BillFormData } from '../BillFormFields';

/**
 * A form opened on a record with a merchant shows that merchant's name, and
 * follows the form's merchant when it changes (an edit page's reset, say).
 */
const merchants = vi.hoisted(
  () =>
    [
      { id: 1, uuid: 'm-1', name: 'Corner Store' },
      { id: 2, uuid: 'm-2', name: 'Acme Hardware' },
    ] as unknown as Merchant[],
);

vi.mock('../../../hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../hooks/queries')>()),
  useMerchantsQuery: () => ({ data: merchants }),
  useCategoriesQuery: () => ({ data: [] }),
  useReportRootsQuery: () => ({ data: [], isLoading: false }),
  useTagsQuery: () => ({ data: [], isLoading: false }),
}));

/** Hands the test the form after each render (a render mustn't write outside itself). */
function useCapture<T>(value: T, capture: (value: T) => void) {
  useEffect(() => capture(value));
}

let ruleForm: UseFormReturn<BudgetMatchingRuleFormData>;
function RuleForm({ merchantId }: { merchantId: number | null }) {
  const form = useForm<BudgetMatchingRuleFormData>({
    defaultValues: { ...createDefaultBudgetMatchingRuleForm(), method: 'merchant_exact', merchant_id: merchantId },
  });
  useCapture(form, (f) => {
    ruleForm = f;
  });
  return (
    <Theme>
      <BudgetMatchingRuleFormFields form={form} budgetItems={[]} merchants={merchants} />
    </Theme>
  );
}

let billForm: UseFormReturn<BillFormData>;
function BillForm({ merchantId }: { merchantId: number | null }) {
  const form = useForm<BillFormData>({ defaultValues: { ...createDefaultBillForm(), merchant_id: merchantId } });
  useCapture(form, (f) => {
    billForm = f;
  });
  return (
    <QueryClientProvider client={makeTestQueryClient()}>
      <Theme>
        <BillFormFields
          form={form}
          tags={[]}
          selectedTags={[]}
          onTagsChange={vi.fn()}
          autoTag={null}
          onAutoTagChange={vi.fn()}
        />
      </Theme>
    </QueryClientProvider>
  );
}

describe('BudgetMatchingRuleFormFields merchant', () => {
  it("shows the rule's merchant, and the form's merchant after it changes", async () => {
    render(<RuleForm merchantId={2} />);
    expect(screen.getByRole('button', { name: 'Merchant * Selected merchant: Acme Hardware' })).toBeInTheDocument();
    await act(async () => ruleForm.setValue('merchant_id', 1));
    expect(screen.getByRole('button', { name: 'Merchant * Selected merchant: Corner Store' })).toBeInTheDocument();
  });

  it('shows nothing chosen for a new rule', () => {
    render(<RuleForm merchantId={null} />);
    expect(screen.getByRole('button', { name: 'Merchant * Start typing merchant name...' })).toBeInTheDocument();
  });
});

describe('BillFormFields merchant', () => {
  // The shared merchant picker: the old text box kept the bill's merchant_id when
  // its text was emptied or retyped, so a bill's merchant couldn't be removed.
  const trigger = (value: string) => screen.getByRole('button', { name: `Merchant ${value}` });

  it("shows the bill's merchant, and can remove it", async () => {
    render(<BillForm merchantId={2} />);
    await userEvent.click(trigger('Selected merchant: Acme Hardware'));
    await userEvent.click(screen.getByRole('option', { name: /No merchant/ }));
    expect(billForm.getValues('merchant_id')).toBeNull();
    expect(trigger('Search for a merchant...')).toBeInTheDocument();
  });

  it('changes to another merchant by keyboard', async () => {
    render(<BillForm merchantId={2} />);
    await userEvent.click(trigger('Selected merchant: Acme Hardware'));
    const search = screen.getByRole('combobox', { name: 'Search merchants' });
    await userEvent.clear(search);
    await userEvent.type(search, 'corn');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(billForm.getValues('merchant_id')).toBe(1);
    expect(trigger('Selected merchant: Corner Store')).toHaveFocus();
  });

  it('follows the form when it gets a merchant', async () => {
    render(<BillForm merchantId={null} />);
    expect(trigger('Search for a merchant...')).toBeInTheDocument();
    await act(async () => billForm.setValue('merchant_id', 1));
    expect(trigger('Selected merchant: Corner Store')).toBeInTheDocument();
  });
});
