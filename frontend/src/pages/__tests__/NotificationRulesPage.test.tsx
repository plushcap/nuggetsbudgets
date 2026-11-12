import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { defaultNotificationRules, type NotificationRules } from '@nuggets/shared';
import { renderWithProviders } from '../../test/renderWithProviders';
import NotificationRulesPage from '../NotificationRulesPage';

Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    getNotificationRules: () => api.get(),
    saveNotificationRules: (rules: unknown) => api.save(rules),
  };
});

const auth = vi.hoisted(() => ({ tenantRole: 'admin' as 'admin' | 'member', orgRole: null, isDeploymentAdmin: false }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

const renderPage = () => renderWithProviders(<Theme><NotificationRulesPage /></Theme>, { route: '/settings/notification-rules' });

// These walk the whole rules editor with userEvent, a few seconds per test on a slow
// runner; the global testTimeout (vitest.config.ts) gives them room.
describe('NotificationRulesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.tenantRole = 'admin';
    api.get.mockResolvedValue(defaultNotificationRules);
    api.save.mockImplementation(async (rules: NotificationRules) => rules);
  });

  it('shows a member the rules without letting them change any', async () => {
    auth.tenantRole = 'member';
    renderPage();
    expect(await screen.findByRole('heading', { name: 'A budget item over budget' })).toBeInTheDocument();
    expect(screen.getByText(/Only ledger admins can change the rules/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save the rules' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name for A budget item over budget' })).toHaveAttribute('readonly');
  });

  it('lets an admin turn the digest on, add a transaction rule, and save exactly that', async () => {
    renderPage();
    const digest = await screen.findByRole('group', { name: 'The week in review' });
    await userEvent.click(within(digest).getByRole('checkbox', { name: 'Send it for The week in review' }));
    await userEvent.click(screen.getByRole('button', { name: 'Transaction rule' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save the rules' }));

    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    const saved = api.save.mock.calls[0][0] as NotificationRules;
    expect(saved.rules.find((rule) => rule.key === 'weekly_digest')?.enabled).toBe(true);
    // Added after the defaults, at the end.
    expect(saved.rules[saved.rules.length - 1]).toMatchObject({
      key: expect.stringMatching(/^transaction_[a-z0-9]+$/),
      kind: 'transaction',
      audience: 'everyone',
      when: { all: [{ fact: 'type', is: 'expense' }, { fact: 'size', gte: 500 }] },
    });
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('lets an admin choose how a rule is sent', async () => {
    renderPage();
    const overBudget = await screen.findByRole('group', { name: 'A budget item over budget' });
    const sendBy = within(overBudget).getByRole('combobox', { name: 'Send by for A budget item over budget' });
    expect(sendBy).toHaveTextContent('Email and phone');
    await userEvent.click(sendBy);
    await userEvent.click(await screen.findByRole('option', { name: 'Phone & browser only' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save the rules' }));

    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    const saved = api.save.mock.calls[0][0] as NotificationRules;
    expect(saved.rules.find((rule) => rule.key === 'over_budget')?.sendBy).toBe('push');
    expect(saved.rules.find((rule) => rule.key === 'review_reminder')?.sendBy).toBe('both');
  });

  it('shows a problem the schema finds next to the rule, without asking the server', async () => {
    renderPage();
    const overBudget = await screen.findByRole('group', { name: 'A budget item over budget' });
    await userEvent.clear(within(overBudget).getByRole('textbox', { name: 'Name for A budget item over budget' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save the rules' }));

    expect(await screen.findByText('Give it a name.')).toBeInTheDocument();
    expect(api.save).not.toHaveBeenCalled();
  });

  it("places the server's problem on the rule it names", async () => {
    // As the API helpers reject with validateBody's answer (apiErrorFrom).
    const details = [{ field: 'rules.1.when', message: '“over_budget” is true or false.' }];
    api.save.mockRejectedValue(Object.assign(new Error('“over_budget” is true or false.'), {
      status: 400,
      code: 'VALIDATION_ERROR',
      details,
      response: { data: { error: 'Validation failed', code: 'VALIDATION_ERROR', message: details[0].message, details } },
    }));
    renderPage();
    const overBudget = await screen.findByRole('group', { name: 'A budget item over budget' });
    await userEvent.click(within(overBudget).getByRole('checkbox', { name: 'Send it for A budget item over budget' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save the rules' }));

    expect(await within(overBudget).findByRole('alert')).toHaveTextContent('“over_budget” is true or false.');
  });

  it('moves focus to the next rule when one is removed', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'A budget item over budget' });
    await userEvent.click(screen.getByRole('button', { name: 'Remove Transactions waiting for review' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'A budget item over budget' })).toHaveFocus());
  });
});
