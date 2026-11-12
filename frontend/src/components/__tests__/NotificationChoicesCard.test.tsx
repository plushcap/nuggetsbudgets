import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import type { NotificationPreferences } from '@nuggets/shared';
import { renderWithProviders } from '../../test/renderWithProviders';
import { NotificationChoicesCard } from '../NotificationChoicesCard';

const api = vi.hoisted(() => ({
  preferences: null as NotificationPreferences | null,
  get: vi.fn(),
  set: vi.fn(),
}));
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    getNotificationPreferences: () => api.get(),
    setNotificationPreferences: (request: unknown) => api.set(request),
  };
});

const preferences: NotificationPreferences = {
  emailAvailable: true,
  rules: [
    { rule: 'over_budget', label: 'A budget item over budget', kind: 'budget_item', sendBy: 'both', email: true, push: true },
    { rule: 'review_reminder', label: 'Transactions waiting for review', kind: 'review_reminder', sendBy: 'both', email: false, push: true },
  ],
};

const renderCard = () => renderWithProviders(<Theme><NotificationChoicesCard /></Theme>);

describe('NotificationChoicesCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue(preferences);
  });

  it('shows each rule with its email and phone choices', async () => {
    renderCard();
    const overBudget = await screen.findByRole('group', { name: 'A budget item over budget' });
    expect(within(overBudget).getByRole('checkbox', { name: 'Email' })).toBeChecked();
    expect(within(overBudget).getByRole('checkbox', { name: 'Phone & browser' })).toBeChecked();
    const review = screen.getByRole('group', { name: 'Transactions waiting for review' });
    expect(within(review).getByRole('checkbox', { name: 'Email' })).not.toBeChecked();
  });

  it('saves one channel of one rule per tick, showing it at once and keeping focus', async () => {
    let finish: (value: NotificationPreferences) => void = () => {};
    api.set.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    renderCard();

    const overBudget = await screen.findByRole('group', { name: 'A budget item over budget' });
    const push = within(overBudget).getByRole('checkbox', { name: 'Phone & browser' });
    await userEvent.click(push);

    expect(api.set).toHaveBeenCalledWith({ rules: [{ rule: 'over_budget', push: false }] });
    expect(push).not.toBeChecked();
    expect(push).toBeEnabled();
    expect(push).toHaveFocus();

    finish({ ...preferences, rules: [{ ...preferences.rules[0], push: false }, preferences.rules[1]] });
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'A budget item over budget' })).getByRole('checkbox', { name: 'Phone & browser' })).not.toBeChecked());
  });

  it('sends changes one at a time, in click order, so a late reply cannot undo a later click', async () => {
    const replies: ((value: NotificationPreferences) => void)[] = [];
    api.set.mockImplementation(() => new Promise((resolve) => { replies.push(resolve); }));
    renderCard();

    const overBudget = await screen.findByRole('group', { name: 'A budget item over budget' });
    await userEvent.click(within(overBudget).getByRole('checkbox', { name: 'Email' }));
    await userEvent.click(within(overBudget).getByRole('checkbox', { name: 'Phone & browser' }));
    expect(api.set).toHaveBeenCalledTimes(1);

    replies[0]({ ...preferences, rules: [{ ...preferences.rules[0], email: false }, preferences.rules[1]] });
    await waitFor(() => expect(api.set).toHaveBeenCalledTimes(2));
    expect(api.set).toHaveBeenLastCalledWith({ rules: [{ rule: 'over_budget', push: false }] });
    replies[1]({ ...preferences, rules: [{ ...preferences.rules[0], email: false, push: false }, preferences.rules[1]] });

    await waitFor(() => expect(within(screen.getByRole('group', { name: 'A budget item over budget' })).getByRole('checkbox', { name: 'Phone & browser' })).not.toBeChecked());
    expect(within(screen.getByRole('group', { name: 'A budget item over budget' })).getByRole('checkbox', { name: 'Email' })).not.toBeChecked();
  });

  it("greys out a channel the rule doesn't send by, and says why", async () => {
    api.get.mockResolvedValue({
      ...preferences,
      rules: [{ ...preferences.rules[0], sendBy: 'push' }, preferences.rules[1]],
    });
    renderCard();
    const overBudget = await screen.findByRole('group', { name: 'A budget item over budget' });
    // The person's stored choice is email on, but the rule doesn't send email.
    expect(within(overBudget).getByRole('checkbox', { name: 'Email' })).not.toBeChecked();
    expect(within(overBudget).getByRole('checkbox', { name: 'Email' })).toBeDisabled();
    expect(within(overBudget).getByRole('checkbox', { name: 'Phone & browser' })).toBeEnabled();
    expect(within(overBudget).getByText(/sends this one to phones and browsers only/)).toBeInTheDocument();
  });

  it('says so, and greys out email, while email is not set up', async () => {
    api.get.mockResolvedValue({ ...preferences, emailAvailable: false });
    renderCard();
    expect(await screen.findByText(/Email isn't set up for Nuggets yet/)).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'A budget item over budget' })).getByRole('checkbox', { name: 'Email' })).toBeDisabled();
  });

  it('puts the box back and says the change did not save', async () => {
    api.set.mockRejectedValue(new Error('boom'));
    renderCard();
    const overBudget = await screen.findByRole('group', { name: 'A budget item over budget' });
    await userEvent.click(within(overBudget).getByRole('checkbox', { name: 'Email' }));

    expect(await screen.findByRole('alert')).toHaveTextContent("That change didn't save.");
    expect(within(overBudget).getByRole('checkbox', { name: 'Email' })).toBeChecked();
  });
});
