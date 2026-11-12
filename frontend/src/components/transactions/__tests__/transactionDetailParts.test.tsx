import { describe, it, expect, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { TRANSACTION_TYPE_LABELS, type TransactionWithSplits } from '@nuggets/shared';
import type { BudgetItem } from '../../../services/api';
import { budgetItem } from '../../../test/fixtures';
import { SplitEditor } from '../SplitEditor';
import { BudgetItemField } from '../BudgetItemField';
import { ExternalLinkField } from '../ExternalReferenceFields';
import { TransactionSelectField } from '../TransactionSelectField';
import { useSplitEditor } from '../useSplitEditor';

vi.mock('../../../hooks/queries', () => ({
  useSplitTransactionMutation: () => ({ mutateAsync: vi.fn() }),
  useUnsplitTransactionMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const transaction = { uuid: '0190a000-0000-7000-8000-0000000000a1', amount: -2000, budget_period_id: 9, is_split_parent: false, split_children: [] } as unknown as TransactionWithSplits;

/** The page's split editor, started on a transaction not split yet. */
const Editing = () => {
  const editor = useSplitEditor({ transaction, confirmAsync: vi.fn(), whileSaving: async (write) => write() });
  const { start, isEditing } = editor;
  useEffect(() => {
    if (!isEditing) start();
  }, [isEditing, start]);
  return isEditing ? <SplitEditor editor={editor} amount={transaction.amount} budgetItems={[]} tags={[]} saving={false} /> : null;
};

describe('the split editor', () => {
  // Its amount box was a TextField that took only digits and a dot, so a pasted
  // `1,234.56` was dropped. It is a CurrencyInput, as every other money field.
  it('reads an amount pasted with a thousands separator, either way round', async () => {
    const user = userEvent.setup();
    render(<Theme><Editing /></Theme>);
    const amount = await screen.findByRole('textbox', { name: 'Amount *' });

    await user.click(amount);
    await user.paste('1,234.56');
    await user.click(screen.getByRole('button', { name: 'Add Split' }));
    expect(screen.getByText('Split 1')).toBeInTheDocument();

    await user.click(amount);
    await user.paste('765,44');
    await user.click(screen.getByRole('button', { name: 'Add Split' }));
    expect(screen.getByText('Split 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update Split' })).toBeEnabled();
  });

  it('keeps text that is no amount in the box, explained, and adds nothing', async () => {
    const user = userEvent.setup();
    render(<Theme><Editing /></Theme>);
    const amount = await screen.findByRole('textbox', { name: 'Amount *' });

    await user.type(amount, '12.345');
    expect(amount).toHaveValue('12.345');
    expect(amount).toHaveAccessibleDescription(/Not an amount/);
    expect(screen.getByRole('button', { name: 'Add Split' })).toBeDisabled();
  });
});

describe('BudgetItemField', () => {
  const field = (budgetItems: BudgetItem[]) => (
    <Theme>
      <BudgetItemField
        editing
        status={{ isSaving: false }}
        isSplitParent={false}
        value={7}
        onChange={vi.fn()}
        budgetItems={budgetItems}
        budgetItemName={null}
        budgetItemUuid={null}
      />
    </Theme>
  );

  // While the budget items loaded, the link went to /budget-items/undefined/rules.
  it('links to the chosen item’s rules once the items have loaded, and not before', () => {
    const { rerender } = render(field([]));
    expect(screen.getByText('Budget item selected')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View Rules/ })).not.toBeInTheDocument();

    const uuid = '0190a000-0000-7000-8000-0000000000b7';
    rerender(field([budgetItem({ id: 7, uuid, name: 'Groceries' })] as unknown as BudgetItem[]));
    expect(screen.getByRole('link', { name: /View Rules/ })).toHaveAttribute('href', `/budget-items/${uuid}/rules`);
  });
});

describe('ExternalLinkField', () => {
  /** The field as the page holds it: the text in the form, a save on blur. */
  const Field = ({ onCommit }: { onCommit: (link: string) => void }) => {
    const [value, setValue] = useState('');
    return (
      <Theme>
        <ExternalLinkField editing status={{ isSaving: false }} value={value} onChange={setValue} onCommit={onCommit} />
      </Theme>
    );
  };

  // The field took `javascript:alert(1)` with no word, and the page saved it (the server
  // refuses it; one with a user name in it, `https://bank.example@evil.example`, it stored).
  it('refuses a link that is no web address beside the box, and saves nothing', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Field onCommit={onCommit} />);
    const box = screen.getByRole('textbox', { name: 'External Link' });

    await user.type(box, 'javascript:alert(1)');
    await user.tab();
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box).toHaveAccessibleDescription('A website starts with http:// or https://.');
    expect(onCommit).not.toHaveBeenCalled();

    await user.clear(box);
    await user.type(box, 'https://bank.example@evil.example/r');
    await user.tab();
    expect(box).toHaveAccessibleDescription(/user name or password/);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('saves a web address, a bare host with https://, and an empty box as no link', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Field onCommit={onCommit} />);
    const box = screen.getByRole('textbox', { name: 'External Link' });

    await user.type(box, 'example.com/r/1');
    await user.tab();
    expect(onCommit).toHaveBeenLastCalledWith('https://example.com/r/1');
    expect(box).toHaveValue('https://example.com/r/1');
    expect(box).not.toHaveAttribute('aria-invalid');

    await user.clear(box);
    await user.tab();
    expect(onCommit).toHaveBeenLastCalledWith('');
  });
});

// A value outside the options was "<value> (legacy value)" even when it is one the list
// names (Income, left out on a liability account): only a value no label names is legacy.
describe('TransactionSelectField', () => {
  const options = [{ value: 'expense', label: 'Expense' }];
  const renderField = (value: string) =>
    render(
      <Theme>
        <TransactionSelectField
          id="transaction-type"
          label="Type"
          editing
          status={{ isSaving: false }}
          value={value}
          options={options}
          keepUnlistedValue
          labels={TRANSACTION_TYPE_LABELS}
          onChange={vi.fn()}
          display={null}
        />
      </Theme>,
    );

  it.each([
    ['income', 'Income'],
    ['adjustment', 'adjustment (legacy value)'],
    ['constructor', 'constructor (legacy value)'],
  ])('shows %j outside the options as %j', (value, shown) => {
    renderField(value);
    expect(screen.getByRole('combobox', { name: /^Type/ })).toHaveTextContent(shown);
  });
});
