import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { toast } from 'react-hot-toast';
import { renderWithProviders } from '../../test/renderWithProviders';
import RadixTransactionTable from '../RadixTransactionTable';
import { updateTransaction, type BudgetPeriod, type Transaction, type User } from '../../services/api';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return { ...actual, updateTransaction: vi.fn(), getTags: vi.fn(async () => []), getBudgetItems: vi.fn(async () => []) };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const transaction = {
  id: 1,
  uuid: 't-1',
  description: 'Corner store',
  amount: -12.5,
  transaction_date: '2026-10-20',
  review_status: 'needs review',
  status: 'posted',
  assigned_to: null,
  tags: [],
} as unknown as Transaction;
const users = [{ id: 7, first_name: 'Alice', last_name: 'Smith' }] as unknown as User[];
const budgetPeriods = [{ id: 3, name: 'October 2026' }] as unknown as BudgetPeriod[];

// The merchant, tag and budget item pages pass the table no handlers.
const renderTable = () =>
  renderWithProviders(
    <Theme>
      <RadixTransactionTable transactions={[transaction]} users={users} budgetPeriods={budgetPeriods} budgetItems={[]} />
    </Theme>,
  );

describe('RadixTransactionTable quick actions on a page without handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updateTransaction).mockResolvedValue({} as Awaited<ReturnType<typeof updateTransaction>>);
  });

  it('assigns the transaction through the context menu', async () => {
    renderTable();
    fireEvent.contextMenu(screen.getAllByText('Corner store')[0]);
    await userEvent.click(await screen.findByText('Assign To'));
    await userEvent.click(await screen.findByText('Alice Smith'));

    await waitFor(() => expect(updateTransaction).toHaveBeenCalledWith('t-1', { assigned_to: 7 }));
    expect(toast.success).toHaveBeenCalledWith('Transaction assigned to Alice');
  });

  it('says why a change failed instead of failing silently', async () => {
    vi.mocked(updateTransaction).mockRejectedValue(new Error('This transaction is split; assign its parts instead'));
    renderTable();
    fireEvent.contextMenu(screen.getAllByText('Corner store')[0]);
    await userEvent.click(await screen.findByText('Assign To'));
    await userEvent.click(await screen.findByText('Unassign'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This transaction is split; assign its parts instead'));
    expect(updateTransaction).toHaveBeenCalledWith('t-1', { assigned_to: null });
  });
});

describe('RadixTransactionTable status icons', () => {
  it('words its review-status, assignee and tag icons for a screen reader', () => {
    renderWithProviders(
      <Theme>
        <RadixTransactionTable
          transactions={[
            transaction,
            {
              ...transaction,
              id: 2,
              uuid: 't-2',
              review_status: 'flagged',
              assigned_to: 7,
              tags: [{ id: 1, name: 'Groceries', icon: 'Tag', color: '#2563eb' }, { id: 2, name: 'Vacation', icon: 'Tag' }],
            } as unknown as Transaction,
          ]}
          users={users}
          budgetPeriods={budgetPeriods}
          budgetItems={[]}
        />
      </Theme>,
    );
    const [, firstRow, secondRow] = screen.getAllByRole('row');
    expect(firstRow).toHaveTextContent('Needs review');
    expect(firstRow).toHaveTextContent('Unassigned');
    expect(secondRow).toHaveTextContent('Flagged');
    expect(secondRow).toHaveTextContent('Assigned to Alice Smith');
    expect(secondRow).toHaveTextContent('Groceries, Vacation');
  });
});

// The badge showed the stored value ('cleared') and coloured it through toLowerCase(); it shows
// the label and compares the value itself, keeping a value from before today's list as it is.
describe('RadixTransactionTable status badge', () => {
  it("shows each status's label, green once cleared, and a legacy value as it is", () => {
    renderWithProviders(
      <Theme>
        <RadixTransactionTable
          transactions={[
            { ...transaction, status: 'cleared' } as unknown as Transaction,
            { ...transaction, id: 2, uuid: 't-2', status: 'pending' } as unknown as Transaction,
            { ...transaction, id: 3, uuid: 't-3', status: 'reconciled' } as unknown as Transaction,
            { ...transaction, id: 4, uuid: 't-4', status: 'posted' } as unknown as Transaction,
          ]}
          users={users}
          budgetPeriods={budgetPeriods}
          budgetItems={[]}
        />
      </Theme>,
    );
    const [, cleared, pending, reconciled, legacy] = screen.getAllByRole('row');
    const badge = (row: HTMLElement | undefined, text: string) =>
      [...(row?.querySelectorAll('.rt-Badge') ?? [])].find((el) => el.textContent === text);
    expect(badge(cleared, 'Cleared')).toHaveAttribute('data-accent-color', 'green');
    expect(badge(pending, 'Pending')).toHaveAttribute('data-accent-color', 'gray');
    expect(badge(reconciled, 'Reconciled')).toHaveAttribute('data-accent-color', 'green');
    expect(badge(legacy, 'posted')).toHaveAttribute('data-accent-color', 'gray');
  });
});

describe('RadixTransactionTable selection checkboxes', () => {
  it('names each checkbox after its row, and selects from the keyboard', async () => {
    const onTransactionSelect = vi.fn();
    const onSelectAll = vi.fn();
    renderWithProviders(
      <Theme>
        <RadixTransactionTable
          transactions={[transaction]}
          users={users}
          budgetPeriods={budgetPeriods}
          budgetItems={[]}
          onTransactionSelect={onTransactionSelect}
          onSelectAll={onSelectAll}
        />
      </Theme>,
    );

    // One per layout (the desktop table and the mobile cards).
    const rowBoxes = screen.getAllByRole('checkbox', { name: 'Select Corner store, 10/20/2026' });
    expect(rowBoxes).toHaveLength(2);
    rowBoxes[0].focus();
    await userEvent.keyboard(' ');
    expect(onTransactionSelect).toHaveBeenCalledWith('t-1');

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all transactions' }));
    expect(onSelectAll).toHaveBeenCalled();
  });
});

// A person's initials were white on their own colour, however light it was.
describe("RadixTransactionTable on a person's colour", () => {
  it("draws the assignee's initials in a colour that reads on theirs", () => {
    const pale = { id: 8, first_name: 'Bea', last_name: 'Lane', default_color: '#FEF08A' } as unknown as User;
    renderWithProviders(
      <Theme>
        <RadixTransactionTable
          transactions={[{ ...transaction, assigned_to: 8, assigned_user: pale } as unknown as Transaction]}
          users={[pale]}
          budgetPeriods={budgetPeriods}
          budgetItems={[]}
        />
      </Theme>,
    );
    const avatar = screen.getAllByTitle('Bea Lane')[0];
    expect(avatar).toHaveStyle({ backgroundColor: '#FEF08A', color: '#000000' });
    expect(avatar).not.toHaveClass('text-white');
  });

  // With no colour, the initials were white on gray-9 (3.30:1 on slate).
  it("draws the initials of someone with no colour in step-12 text on a gray tint", () => {
    const plain = { id: 9, first_name: 'Cal', last_name: 'Moss', default_color: null } as unknown as User;
    renderWithProviders(
      <Theme>
        <RadixTransactionTable
          transactions={[{ ...transaction, assigned_to: 9, assigned_user: plain } as unknown as Transaction]}
          users={[plain]}
          budgetPeriods={budgetPeriods}
          budgetItems={[]}
        />
      </Theme>,
    );
    for (const avatar of screen.getAllByTitle('Cal Moss')) {
      expect(avatar).toHaveClass('bg-[var(--gray-5)]', 'text-[var(--gray-12)]');
      expect(avatar).not.toHaveClass('text-[var(--gray-contrast)]');
    }
  });
});

// The sheet opens without a Dialog.Trigger, so Radix gave the focus back to nothing and
// it went to <body> when the sheet closed: a keyboard user started over from the page's top.
describe('RadixTransactionTable quick-actions sheet focus', () => {
  it('gives the focus back to the button that opened the sheet when it closes', async () => {
    const user = userEvent.setup();
    renderTable();
    const [quick] = screen.getAllByRole('button', { name: /^Quick actions for Corner store/ });
    quick.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(quick).toHaveFocus();
  });

  // Safari doesn't focus a button that is clicked, so the sheet took the focused element
  // (<body>) as its opener and gave the focus back to nothing. A click passes its button.
  it.each([0, 1])('gives the focus back to the button clicked without focusing it (Safari), layout %i', async (layout) => {
    const user = userEvent.setup();
    renderTable();
    const quick = screen.getAllByRole('button', { name: /^Quick actions for Corner store/ })[layout];
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(quick);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(quick).not.toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(quick).toHaveFocus();
  });
});
