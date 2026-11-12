import { describe, it, expect, vi } from 'vitest';
import { useEffect } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../../test/renderWithProviders';
import BillFormFields, { createDefaultBillForm, type BillFormData } from '../BillFormFields';

vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() }, toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../hooks/queries')>()),
  useMerchantsQuery: () => ({ data: [] }),
  useCategoriesQuery: () => ({ data: [] }),
  useReportRootsQuery: () => ({ data: [], isLoading: false }),
  useTagsQuery: () => ({ data: [], isLoading: false }),
}));

let billForm: UseFormReturn<BillFormData>;
function Bill({ values }: { values: Partial<BillFormData> }) {
  const form = useForm<BillFormData>({ defaultValues: { ...createDefaultBillForm(), ...values } });
  // Hands the test the form after each render (a render mustn't write outside itself).
  useEffect(() => {
    billForm = form;
  });
  return (
    <BillFormFields form={form} tags={[]} selectedTags={[]} onTagsChange={vi.fn()} autoTag={null} onAutoTagChange={vi.fn()} />
  );
}

describe('BillFormFields budget check', () => {
  // A monthly bill with no next date: one month until it is paid. Rounding up a float asked for
  // $150.31 of a $150.30 bill (150.3 * 100 is 15030.000000000002), and Fix set that.
  it('asks for exactly the bill, to the cent, and Fix sets that', async () => {
    renderWithProviders(
      <Theme>
        <Bill values={{ recurring_payment_amount: 150.3, recurring_payment_frequency: 1, default_budget_amount: 100 }} />
      </Theme>,
    );
    expect(screen.getByText('Insufficient Budget Amount')).toBeInTheDocument();
    // One month, not "1 months".
    expect(screen.getByText(/÷ 1 month until payment = \$150\.30$/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Fix Budget Amounts' }));
    expect(billForm.getValues('default_budget_amount')).toBe(150.3);
  });

  it('rounds a share that leaves a remainder up to the next cent', () => {
    // $100.00 over 3 months: 33.33 three times falls a cent short.
    renderWithProviders(
      <Theme>
        <Bill values={{ recurring_payment_amount: 100, recurring_payment_frequency: 3, default_budget_amount: 10 }} />
      </Theme>,
    );
    expect(screen.getByText(/÷ 3 months until payment = \$33\.34$/)).toBeInTheDocument();
  });
});
