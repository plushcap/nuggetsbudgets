import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../../test/renderWithProviders';
import BudgetItemRowMenu from '../BudgetItemRowMenu';

const renderMenu = (handlers: { onView?: () => void; onEdit?: () => void; onRetire?: () => void } = {}) =>
  renderWithProviders(
    <Theme>
      <BudgetItemRowMenu
        onView={handlers.onView ?? vi.fn()}
        onEdit={handlers.onEdit ?? vi.fn()}
        onRetire={handlers.onRetire ?? vi.fn()}
      />
    </Theme>,
  );

describe('BudgetItemRowMenu', () => {
  it('renders the actions trigger', () => {
    renderMenu();
    expect(screen.getByRole('button', { name: /budget item actions/i })).toBeInTheDocument();
  });

  it('opens the menu and fires Edit', async () => {
    const onEdit = vi.fn();
    renderMenu({ onEdit });
    await userEvent.click(screen.getByRole('button', { name: /budget item actions/i }));
    await userEvent.click(await screen.findByText('Edit'));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('fires Archive or delete', async () => {
    const onRetire = vi.fn();
    renderMenu({ onRetire });
    await userEvent.click(screen.getByRole('button', { name: /budget item actions/i }));
    await userEvent.click(await screen.findByText('Archive or delete…'));
    expect(onRetire).toHaveBeenCalledTimes(1);
  });
});
