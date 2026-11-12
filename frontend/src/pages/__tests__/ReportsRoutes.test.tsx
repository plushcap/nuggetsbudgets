import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import ReportsPage from '../ReportsPage';

const Where = () => <p>at {useLocation().pathname}</p>;

const renderAt = (route: string) =>
  renderWithProviders(
    <Theme>
      <Routes>
        <Route path="/reports/*" element={<ReportsPage />} />
        <Route path="/investments/performance" element={<Where />} />
      </Routes>
    </Theme>,
    { route }
  );

/**
 * Reports → Investment Performance showed randomly generated returns for the user's own
 * accounts. The real, API-backed page is under Investments; old links go there.
 * An unknown address shows "Page not found" instead of an empty page.
 */
describe('Report routes', () => {
  it('sends the old investment performance report to the real one', async () => {
    renderAt('/reports/investment-performance');
    expect(await screen.findByText('at /investments/performance')).toBeInTheDocument();
  });

  it('links the Investment Performance card to the real page', async () => {
    renderAt('/reports');
    const card = await screen.findByRole('link', { name: /Investment Performance/ });
    expect(card).toHaveAttribute('href', '/investments/performance');
  });

  it('says so for a report that does not exist', async () => {
    renderAt('/reports/no-such-report');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
