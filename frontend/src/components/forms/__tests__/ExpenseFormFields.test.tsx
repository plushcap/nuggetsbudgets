import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../../test/renderWithProviders';
import ExpenseFormFields, { createDefaultExpenseForm, type ExpenseFormData } from '../ExpenseFormFields';

vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** YYYY-MM-DD for the 1st of the month `months` from now. */
const monthsAhead = (months: number) => {
  const d = new Date();
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-01`;
};

function Envelope({ values, currentBalance = null }: { values: Partial<ExpenseFormData>; currentBalance?: number | null }) {
  const form = useForm<ExpenseFormData>({
    defaultValues: { ...createDefaultExpenseForm(), type: 'Envelope', rollover: true, subtype: 'Fixed', ...values },
  });
  return (
    <ExpenseFormFields
      form={form}
      categories={[]}
      tags={[]}
      selectedTags={[]}
      onTagsChange={() => {}}
      autoTag={null}
      onAutoTagChange={() => {}}
      currentBalance={currentBalance}
    />
  );
}

const renderEnvelope = (values: Partial<ExpenseFormData>, currentBalance?: number | null) =>
  renderWithProviders(<Theme><Envelope values={values} currentBalance={currentBalance} /></Theme>);

describe('ExpenseFormFields envelope savings check', () => {
  it("doesn't ask for the whole target in one month when there's no target date", () => {
    renderEnvelope({ default_budget_amount: 15, rollover_target_amount: 175 });
    expect(screen.getByLabelText('Target Date')).toBeInTheDocument();
    expect(screen.queryByText('Insufficient Savings Amount')).not.toBeInTheDocument();
  });

  it('accepts a monthly amount that reaches the target by the target date', () => {
    // $175 over 12 months is $14.59 a month.
    renderEnvelope({ default_budget_amount: 15, rollover_target_amount: 175, rollover_target_date: monthsAhead(12) });
    expect(screen.queryByText('Insufficient Savings Amount')).not.toBeInTheDocument();
  });

  it("warns when the monthly amount won't get there, dividing by the months left", () => {
    renderEnvelope({ default_budget_amount: 15, rollover_target_amount: 175, rollover_target_date: monthsAhead(2) });
    expect(screen.getByText('Insufficient Savings Amount')).toBeInTheDocument();
    expect(screen.getByText(/÷ 2 months until the target date = \$87\.50/)).toBeInTheDocument();
  });

  it('asks for exactly what is left, to the cent', () => {
    // Rounding up a float asked for $150.31 of $150.30.
    renderEnvelope({ default_budget_amount: 100, rollover_target_amount: 150.3, rollover_target_date: monthsAhead(0) });
    expect(screen.getByText(/÷ 1 month until the target date = \$150\.30$/)).toBeInTheDocument();
  });

  it("measures an existing envelope from what's in it now", () => {
    renderEnvelope({ default_budget_amount: 15, rollover_target_amount: 175, rollover_starting_balance: 0, rollover_target_date: monthsAhead(2) }, 145);
    // ($175 - $145) ÷ 2 = $15: enough.
    expect(screen.queryByText('Insufficient Savings Amount')).not.toBeInTheDocument();
  });
});
