import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { Routes, Route } from 'react-router-dom';
import { renderWithProviders } from '../../test/renderWithProviders';
import FlexLayout, { DESKTOP_QUERY } from '../FlexLayout';
import { ThemeProvider } from '../../contexts/ThemeContext';

const switchTenant = vi.hoisted(() => vi.fn());
// The ledger's money gate waits for its settings (LedgerMoneyFormat.test.tsx); this test serves
// none, so its pages render as a USD ledger's would.
vi.mock('../LedgerMoneyFormat', () => ({ default: ({ children }: { children: import('react').ReactNode }) => children }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { first_name: 'Alex', last_name: 'Doe', email: 'alex@example.com', profile_image: null },
    logout: vi.fn(),
    tenants: [
      { uuid: 't1', name: 'Household', organizationUuid: 'o1', organizationName: 'Doe family', isActiveTenant: true },
      { uuid: 't2', name: 'Holiday fund', organizationUuid: 'o1', organizationName: 'Doe family', isActiveTenant: false },
    ],
    activeTenant: { uuid: 't1', name: 'Household', organizationUuid: 'o1', organizationName: 'Doe family' },
    switchTenant,
    loading: false,
    membershipLoading: false,
  }),
}));
vi.mock('../../hooks/queries/annotations', () => ({
  useAnnotationCountsQuery: () => ({ data: { notify: 2 } }),
}));

/** Answers the layout's wide-screen query as `desktop` says. */
const setDesktop = (desktop: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches: desktop && query === DESKTOP_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
};

const Page = ({ title }: { title: string }) => <h1>{title}</h1>;

const renderShell = (route: string) =>
  renderWithProviders(
    <ThemeProvider>
    <Theme>
      <FlexLayout>
        <Routes>
          <Route path="/dashboard" element={<Page title="Dashboard" />} />
          <Route path="/accounts" element={<Page title="Accounts" />} />
          <Route path="/accounts/:uuid" element={<Page title="Everyday checking" />} />
          <Route path="/tasks" element={<Page title="Tasks" />} />
          <Route path="/budgets" element={<Page title="Budget" />} />
          <Route path="*" element={<p>No heading here</p>} />
        </Routes>
      </FlexLayout>
    </Theme>
    </ThemeProvider>,
    { route }
  );

describe('FlexLayout (the app shell)', () => {
  const originalMatchMedia = window.matchMedia;
  beforeEach(() => {
    document.title = 'Nuggets';
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  describe('on a wide screen', () => {
    beforeEach(() => setDesktop(true));

    it('has a banner, a named main menu and a main region, and the skip link comes first', async () => {
      renderShell('/dashboard');
      expect(screen.getByRole('banner')).toBeInTheDocument();
      expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
      expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');

      await userEvent.tab();
      expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus();
    });

    it('the skip link moves the focus into the page', async () => {
      renderShell('/dashboard');
      await userEvent.tab();
      await userEvent.keyboard('{Enter}');
      expect(screen.getByRole('main')).toHaveFocus();
    });

    it('marks the current page, and the section of a page inside one, with aria-current', () => {
      const { unmount } = renderShell('/accounts');
      const menu = screen.getByRole('navigation', { name: 'Main' });
      expect(within(menu).getByRole('link', { name: 'Accounts' })).toHaveAttribute('aria-current', 'page');
      expect(within(menu).getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
      unmount();

      renderShell('/accounts/abc');
      expect(
        within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Accounts' })
      ).toHaveAttribute('aria-current', 'true');
    });

    it('the menu button says whether the menu is shown, and a hidden menu leaves the tab order', async () => {
      renderShell('/dashboard');
      const button = screen.getByRole('button', { name: 'Main menu' });
      expect(button).toHaveAttribute('aria-expanded', 'true');
      const menuColumn = document.getElementById(button.getAttribute('aria-controls')!);
      expect(menuColumn).toContainElement(screen.getByRole('navigation', { name: 'Main' }));
      expect(menuColumn).not.toHaveAttribute('inert');

      await userEvent.click(button);
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(menuColumn).toHaveAttribute('inert');
    });

    it('names the activity count it shows', () => {
      renderShell('/dashboard');
      expect(screen.getByRole('link', { name: 'Activity, 2 new' })).toBeInTheDocument();
    });

    it('after following a menu link, focuses the new page’s heading and names the page', async () => {
      renderShell('/dashboard');
      await waitFor(() => expect(document.title).toBe('Dashboard – Nuggets'));
      // The first page shown keeps the focus where the browser put it.
      expect(screen.getByRole('heading', { name: 'Dashboard' })).not.toHaveFocus();

      await userEvent.click(screen.getByRole('link', { name: 'Tasks' }));
      const heading = await screen.findByRole('heading', { level: 1, name: 'Tasks' });
      await waitFor(() => expect(heading).toHaveFocus());
      expect(document.title).toBe('Tasks – Nuggets');
    });

    it('a page without a heading is named after its section, and main takes the focus', async () => {
      renderShell('/dashboard');
      await userEvent.click(screen.getByRole('link', { name: 'Settings' }));
      await waitFor(() => expect(screen.getByRole('main')).toHaveFocus(), { timeout: 7000 });
      expect(document.title).toBe('Settings – Nuggets');
    });

    it('the ledger switcher names the current ledger and checks it in the menu', async () => {
      renderShell('/dashboard');
      await userEvent.click(screen.getByRole('button', { name: 'Switch ledger (current: Household)' }));
      const group = await screen.findByRole('group', { name: 'Doe family' });
      expect(within(group).getByRole('menuitemradio', { name: 'Household' })).toHaveAttribute('aria-checked', 'true');
      expect(within(group).getByRole('menuitemradio', { name: 'Holiday fund' })).toHaveAttribute('aria-checked', 'false');

      await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
      expect(switchTenant).toHaveBeenCalledWith('t2');
    });
  });

  describe('on a narrow screen', () => {
    beforeEach(() => setDesktop(false));

    it('keeps the menu in a drawer: closed, it is out of the page; the tab bar has shortcuts', () => {
      renderShell('/tasks');
      expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
      const shortcuts = screen.getByRole('navigation', { name: 'Shortcuts' });
      expect(within(shortcuts).getByRole('link', { name: 'Tasks' })).toHaveAttribute('aria-current', 'page');
      expect(screen.getByRole('button', { name: 'Main menu' })).toHaveAttribute('aria-expanded', 'false');
    });

    it('opens the drawer as a modal dialog on the current page’s link; Escape returns the focus', async () => {
      renderShell('/tasks');
      const menuButton = screen.getByRole('button', { name: 'Main menu' });
      await userEvent.click(menuButton);

      const drawer = await screen.findByRole('dialog', { name: 'Menu' });
      expect(menuButton).toHaveAttribute('aria-expanded', 'true');
      expect(menuButton).toHaveAttribute('aria-controls', drawer.id);
      const current = within(drawer).getByRole('link', { name: 'Tasks' });
      await waitFor(() => expect(current).toHaveFocus());

      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(menuButton).toHaveFocus());
    });

    it('the drawer keeps the keyboard inside it', async () => {
      renderShell('/tasks');
      await userEvent.click(screen.getByRole('button', { name: 'More' }));
      const drawer = await screen.findByRole('dialog', { name: 'Menu' });
      for (let i = 0; i < 20; i += 1) {
        await userEvent.tab();
        expect(drawer).toContainElement(document.activeElement as HTMLElement);
      }
    });

    it('following a link in the drawer closes it and focuses the new page’s heading', async () => {
      renderShell('/tasks');
      await userEvent.click(screen.getByRole('button', { name: 'More' }));
      const drawer = await screen.findByRole('dialog', { name: 'Menu' });
      await userEvent.click(within(drawer).getByRole('link', { name: 'Accounts' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Accounts' })).toHaveFocus());
      expect(document.title).toBe('Accounts – Nuggets');
    });
  });
});
