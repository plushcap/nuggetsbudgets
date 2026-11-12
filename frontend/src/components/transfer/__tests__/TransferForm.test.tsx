import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../../test/renderWithProviders';
import { pinTimeZone } from '../../../test/timeZone';
import TransferForm, { transferFormSchema } from '../TransferForm';
import type { BudgetPeriod } from '../../../services/api';

// Radix Select's hidden native <select> resets a value set from an effect on
// mount in jsdom (its options register a render later), so stand in a plain
// <select> for it: these tests are about which period the form picks.
vi.mock('@radix-ui/themes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@radix-ui/themes')>();
  const Root = ({ value, onValueChange, children }: { value?: string; onValueChange?: (v: string) => void; children?: React.ReactNode }) => (
    <select aria-label="select" value={value} onChange={(e) => onValueChange?.(e.target.value)}>{children}</select>
  );
  const Content = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Item = ({ value, children }: { value: string; children?: React.ReactNode }) => <option value={value}>{children}</option>;
  return { ...actual, Select: { Root, Trigger: () => null, Content, Item } };
});

const period = (id: number, name: string, month: number, start: string, end: string) =>
  ({ id, uuid: `p${id}`, name, year: 2026, month, month_number: month, start_date: start, end_date: end, status: 'active' }) as unknown as BudgetPeriod;

// The API has sent DATE columns both as 'YYYY-MM-DD' and as an ISO instant at
// UTC midnight; either must mean that calendar day.
const periods = [
  period(10, 'October 2026', 10, '2026-10-01', '2026-10-31T00:00:00.000Z'),
  period(11, 'November 2026', 11, '2026-11-01T00:00:00.000Z', '2026-11-30'),
];

const renderForm = () => renderWithProviders(<Theme><TransferForm accounts={[]} budgetPeriods={periods} /></Theme>);

const selectedPeriod = () =>
  screen.getAllByRole('combobox').map((s) => (s as HTMLSelectElement).selectedOptions[0]?.textContent)
    .find((text) => text?.includes('2026') || text === 'No budget period');

// At 9:30 pm on Oct 31 in Los Angeles it is already Nov 1 in UTC.
describe('TransferForm defaults, 9:30 pm on Oct 31 in Los Angeles', () => {
  pinTimeZone('America/Los_Angeles', '2026-10-31T21:30:00-07:00');

  it('dates the transfer today (Oct 31), not tomorrow', () => {
    const { container } = renderForm();
    expect(within(container).getByLabelText(/^Date/)).toHaveValue('2026-10-31');
  });

  it("picks today's budget period (October), not November", () => {
    renderForm();
    expect(selectedPeriod()).toBe('October 2026');
  });
});

describe('TransferForm defaults, 8:00 am on Nov 1 in Kiritimati (UTC+14)', () => {
  pinTimeZone('Pacific/Kiritimati', '2026-11-01T08:00:00+14:00');

  it('dates the transfer today (Nov 1)', () => {
    const { container } = renderForm();
    expect(within(container).getByLabelText(/^Date/)).toHaveValue('2026-11-01');
  });

  it("picks today's budget period (November)", () => {
    renderForm();
    expect(selectedPeriod()).toBe('November 2026');
  });
});

// Text the box can't read is NaN in the form (nullableAmountInput), so a reset
// empties the box; the schema refuses it as no amount, in its own words.
describe('TransferForm with an amount it cannot read', () => {
  it('refuses it as no amount', () => {
    const valid = {
      source_account_id: 1, destination_account_id: 2, amount: 10, transaction_date: '2026-10-31',
      type: 'transfer' as const, description: '', budget_period_id: null,
    };
    expect(transferFormSchema.safeParse(valid).success).toBe(true);
    expect(transferFormSchema.safeParse({ ...valid, amount: Number.NaN }).error?.issues.map((i) => [i.path[0], i.message])).toEqual([
      ['amount', 'Amount must be greater than zero'],
    ]);
  });
});
