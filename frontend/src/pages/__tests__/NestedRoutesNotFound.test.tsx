import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import CategoriesPage from '../CategoriesPage';
import BudgetMatchingRulesPage from '../BudgetMatchingRulesPage';
import MerchantManagementPage from '../MerchantManagementPage';

/**
 * The pages with routes of their own show "Page not found" for an address none of them
 * matches, as App, Settings and Reports do, instead of an empty page.
 * Mounted at the paths App.tsx and SettingsPage.tsx give them.
 */
const renderAt = (route: string) =>
  renderWithProviders(
    <Theme>
      <Routes>
        <Route path="/categories/*" element={<CategoriesPage />} />
        <Route path="/settings/categories/*" element={<CategoriesPage />} />
        <Route path="/settings/budget-matching/*" element={<BudgetMatchingRulesPage />} />
        <Route path="/settings/merchants/*" element={<MerchantManagementPage />} />
      </Routes>
    </Theme>,
    { route }
  );

describe('Unknown addresses under a page with routes of its own', () => {
  it.each([
    '/categories/foo',
    '/settings/categories/foo',
    '/settings/categories/cat-1/view',
    '/settings/budget-matching/foo',
    '/settings/budget-matching/rule-1/view',
    '/settings/merchants/foo',
    '/settings/merchants/m-1/unknown',
  ])('%s says the page is not found', async (route) => {
    renderAt(route);
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the dashboard' })).toHaveAttribute('href', '/');
  });
});
