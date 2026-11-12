import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import type { MemberRole } from '@nuggets/shared';
import { renderWithProviders } from '../../test/renderWithProviders';
import RequireLedger from '../../components/RequireLedger';
import SettingsPage from '../SettingsPage';
import App from '../../App';

/**
 * Who can open each settings page. A page someone's role can't use shows
 * why in its place, a page that works on the active ledger asks for one first, and the
 * Settings menu links to exactly the pages that open. The levels are the backend's for
 * the routes each page calls (ACCESS in backend/src/__tests__/route-authorization.test.ts).
 */

// Each page is a stub naming itself, so this checks the routing, not the pages.
// The ledger's money gate waits for its settings (LedgerMoneyFormat.test.tsx); this test serves
// none, so its pages render as a USD ledger's would.
vi.mock('../../components/LedgerMoneyFormat', () => ({ default: ({ children }: { children: import('react').ReactNode }) => children }));
vi.mock('../MerchantManagementPage', () => ({ default: () => 'Merchants page' }));
vi.mock('../CategoriesPage', () => ({ default: () => 'Categories page' }));
vi.mock('../InstitutionsPage', () => ({ default: () => 'Institutions page' }));
vi.mock('../AddInstitutionPage', () => ({ default: () => 'Add institution page' }));
vi.mock('../EditInstitutionPage', () => ({ default: () => 'Edit institution page' }));
vi.mock('../UserManagementPage', () => ({ default: () => 'Users page' }));
vi.mock('../AddUserPage', () => ({ default: () => 'Add user page' }));
vi.mock('../EditUserPage', () => ({ default: () => 'Edit user page' }));
vi.mock('../ImportSettingsPage', () => ({ default: () => 'Bank import page' }));
vi.mock('../GeneralSettingsPage', () => ({ default: () => 'General page' }));
vi.mock('../TestDataPage', () => ({ default: () => 'Test data page' }));
vi.mock('../NetWorthResetPage', () => ({ default: () => 'Net worth reset page' }));
vi.mock('../BudgetMatchingRulesPage', () => ({ default: () => 'Budget matching page' }));
vi.mock('../BudgetPeriodsPage', () => ({ default: () => 'Budget periods page' }));
vi.mock('../AddBudgetPeriodPage', () => ({ default: () => 'Add budget period page' }));
vi.mock('../BackupPage', () => ({ default: () => 'Backup page' }));
vi.mock('../UtilitiesPage', () => ({ default: () => 'Utilities page' }));
vi.mock('../NotificationSettingsPage', () => ({ default: () => 'Email notifications page' }));
vi.mock('../NotificationRulesPage', () => ({ default: () => 'Notification rules page' }));
vi.mock('../DataExportPage', () => ({ default: () => 'Export page' }));
vi.mock('../DataDeletionSettingsPage', () => ({ default: () => 'Data management page' }));
vi.mock('../McpAccessPage', () => ({ default: () => 'MCP page' }));
vi.mock('../TenantSettingsPage', () => ({ default: () => 'Ledger page' }));
vi.mock('../OrganizationSettingsPage', () => ({ default: () => 'Organization page' }));
vi.mock('../OrganizationsConsolePage', () => ({ default: () => 'Organizations console page' }));
vi.mock('../PriceSyncSettingsPage', () => ({ default: () => 'Price sync page' }));
vi.mock('../../components/LedgerSelectionScreen', () => ({ default: () => 'Choose a ledger screen' }));
// The app's own routes (App.tsx), for an address outside /settings: signed in, and the
// layout reduced to its ledger gate and the address it is at.
vi.mock('../../components/ProtectedRoute', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../../components/FlexLayout', async () => {
  const { useLocation } = await import('react-router-dom');
  const { default: Gate } = await import('../../components/RequireLedger');
  const Layout = ({ children }: { children: ReactNode }) => {
    const { pathname } = useLocation();
    return <><p data-testid="address">{pathname}</p><Gate>{children}</Gate></>;
  };
  return { default: Layout };
});

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const ledger = { uuid: 'ledger-1', name: 'Home', organizationUuid: ORG, organizationName: 'Family' };
const inOrg = (role: MemberRole) => [{ uuid: ORG, name: 'Family', status: 'active' as const, role }];

/** The membership summary the server sends each kind of person (MembershipService). */
const SCENARIOS = {
  member: { activeTenant: ledger, tenantRole: 'member', orgRole: 'member', organizations: inOrg('member'), isDeploymentAdmin: false },
  'ledger admin': { activeTenant: ledger, tenantRole: 'admin', orgRole: 'member', organizations: inOrg('member'), isDeploymentAdmin: false },
  'organization admin': { activeTenant: ledger, tenantRole: 'admin', orgRole: 'admin', organizations: inOrg('admin'), isDeploymentAdmin: false },
  'deployment admin': { activeTenant: ledger, tenantRole: 'admin', orgRole: 'admin', organizations: [], isDeploymentAdmin: true },
  'member with no ledger': { activeTenant: null, tenantRole: null, orgRole: null, organizations: inOrg('member'), isDeploymentAdmin: false },
  'organization admin with no ledger': { activeTenant: null, tenantRole: null, orgRole: null, organizations: inOrg('admin'), isDeploymentAdmin: false },
  'deployment admin with no ledger': { activeTenant: null, tenantRole: null, orgRole: null, organizations: [], isDeploymentAdmin: true },
} as const;
type Scenario = keyof typeof SCENARIOS;
const SCENARIO_NAMES = Object.keys(SCENARIOS) as Scenario[];

const auth = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.current }));

const use = (scenario: Scenario) => {
  const s = SCENARIOS[scenario];
  auth.current = {
    ...s,
    user: { id: 1, email: 'someone@example.com' },
    loading: false,
    membershipLoading: false,
    tenants: s.activeTenant ? [{ ...ledger, status: 'active', role: s.tenantRole, isActiveTenant: true }] : [],
    activeOrganization: s.activeTenant ? { uuid: ORG, name: 'Family' } : null,
  };
};

const renderAt = (route: string) =>
  renderWithProviders(
    <Theme>
      <RequireLedger>
        <Routes>
          <Route path="/profile" element="Profile page" />
          <Route path="/settings/*" element={<SettingsPage />} />
        </Routes>
      </RequireLedger>
    </Theme>,
    { route }
  );

// P: the page opens. L: it asks for a ledger first. R: it says who may use it instead.
type Outcome = 'P' | 'L' | 'R';
const LEDGER_ADMINS = 'Ledger admins only';
const ORG_ADMINS = 'Organization admins only';
const DEPLOYMENT_ADMINS = 'Deployment admins only';

/**
 * Each address, the stub its page shows, the heading of the message shown in its place,
 * and the outcome for each scenario in SCENARIOS order: member, ledger admin, organization
 * admin, deployment admin | with no ledger: member, organization admin, deployment admin.
 */
const PAGES: Array<[path: string, page: string, refusal: string | null, outcomes: string]> = [
  ['/profile', 'Profile page', null, 'PPPP PPP'],
  ['/settings/mcp', 'MCP page', null, 'PPPP PPP'],
  // The active ledger's data: any member of it (the menu shows them to its admins).
  ['/settings/ledger', 'Ledger page', null, 'PPPP LLL'],
  ['/settings/categories', 'Categories page', null, 'PPPP LLL'],
  ['/settings/categories/add', 'Categories page', null, 'PPPP LLL'],
  ['/settings/merchants', 'Merchants page', null, 'PPPP LLL'],
  ['/settings/merchants/add', 'Merchants page', null, 'PPPP LLL'],
  ['/settings/institutions', 'Institutions page', null, 'PPPP LLL'],
  ['/settings/institutions/add', 'Add institution page', null, 'PPPP LLL'],
  ['/settings/institutions/edit/i-1', 'Edit institution page', null, 'PPPP LLL'],
  ['/settings/budget-matching', 'Budget matching page', null, 'PPPP LLL'],
  ['/settings/budget-periods', 'Budget periods page', null, 'PPPP LLL'],
  ['/settings/budget-periods/add', 'Add budget period page', null, 'PPPP LLL'],
  ['/settings/notification-rules', 'Notification rules page', null, 'PPPP LLL'],
  ['/settings/export', 'Export page', null, 'PPPP LLL'],
  // /api/data-management: requireTenantAdmin.
  ['/settings/data-management', 'Data management page', LEDGER_ADMINS, 'RPPP LLL'],
  // The ledger's own time zone: POST /api/settings/general is its admins'.
  ['/settings/general', 'General page', LEDGER_ADMINS, 'RPPP LLL'],
  // /api/net-worth/{rebuild,clear} and /api/admin/test-data: deployment admins, on the active ledger.
  ['/settings/net-worth-reset', 'Net worth reset page', DEPLOYMENT_ADMINS, 'RRRP LLL'],
  ['/settings/test-data', 'Test data page', DEPLOYMENT_ADMINS, 'RRRP LLL'],
  // Bank import: GET /api/import/settings and /status and POST /api/import/sync are member
  // routes; the page shows its organization's connection to its admins only (the menu
  // links it for them).
  ['/settings/import-settings', 'Bank import page', null, 'PPPP LLL'],
  // The active ledger's organization: /api/organizations/:uuid, price sync.
  ['/settings/organization', 'Organization page', ORG_ADMINS, 'RRPP LLL'],
  ['/settings/price-sync', 'Price sync page', ORG_ADMINS, 'RRPP LLL'],
  // The organization in the address: its admins, with a ledger or none.
  [`/settings/organizations/${ORG}`, 'Organization page', ORG_ADMINS, 'RRPP RPP'],
  [`/settings/organizations/${OTHER_ORG}`, 'Organization page', ORG_ADMINS, 'RRRP RRP'],
  // The deployment: /api/admin/*, /api/backup, with a ledger or none.
  ['/settings/organizations', 'Organizations console page', DEPLOYMENT_ADMINS, 'RRRP RRP'],
  ['/settings/users', 'Users page', DEPLOYMENT_ADMINS, 'RRRP RRP'],
  ['/settings/users/add', 'Add user page', DEPLOYMENT_ADMINS, 'RRRP RRP'],
  ['/settings/users/edit/u-1', 'Edit user page', DEPLOYMENT_ADMINS, 'RRRP RRP'],
  ['/settings/backup', 'Backup page', DEPLOYMENT_ADMINS, 'RRRP RRP'],
  // /api/admin/database/*: the schema and applied migrations.
  ['/settings/utilities', 'Utilities page', DEPLOYMENT_ADMINS, 'RRRP RRP'],
  // /api/admin/notifications/*, with a ledger or none: the page leaves the ledger's history out without one.
  ['/settings/notifications', 'Email notifications page', DEPLOYMENT_ADMINS, 'RRRP RRP'],
];

const outcomeFor = (outcomes: string, scenario: Scenario): Outcome =>
  outcomes.replace(' ', '')[SCENARIO_NAMES.indexOf(scenario)] as Outcome;

const cases = SCENARIO_NAMES.flatMap((scenario) =>
  PAGES.map(([path, page, refusal, outcomes]) => ({ scenario, path, page, refusal, outcome: outcomeFor(outcomes, scenario) }))
);

/** The Settings menu's links for each scenario. */
const MENU: Record<Scenario, string[]> = {
  member: ['/profile', '/settings/mcp'],
  'ledger admin': [
    '/profile', '/settings/mcp',
    '/settings/ledger', '/settings/general', '/settings/categories', '/settings/merchants', '/settings/institutions',
    '/settings/budget-matching', '/settings/budget-periods', '/settings/notification-rules',
    '/settings/export', '/settings/data-management',
  ],
  'organization admin': [
    '/profile', '/settings/mcp',
    '/settings/ledger', '/settings/general', '/settings/categories', '/settings/merchants', '/settings/institutions',
    '/settings/budget-matching', '/settings/budget-periods', '/settings/notification-rules',
    '/settings/export', '/settings/data-management',
    '/settings/organization', '/settings/import-settings', '/settings/price-sync',
  ],
  'deployment admin': [
    '/profile', '/settings/mcp',
    '/settings/ledger', '/settings/general', '/settings/categories', '/settings/merchants', '/settings/institutions',
    '/settings/budget-matching', '/settings/budget-periods', '/settings/notification-rules',
    '/settings/export', '/settings/net-worth-reset', '/settings/data-management', '/settings/test-data',
    '/settings/organization', '/settings/import-settings', '/settings/price-sync',
    '/settings/organizations', '/settings/users', '/settings/notifications', '/settings/backup', '/settings/utilities',
  ],
  'member with no ledger': ['/profile', '/settings/mcp'],
  'organization admin with no ledger': ['/profile', '/settings/mcp'],
  'deployment admin with no ledger': [
    '/profile', '/settings/mcp',
    '/settings/organizations', '/settings/users', '/settings/notifications', '/settings/backup', '/settings/utilities',
  ],
};

async function expectOutcome(page: string, refusal: string | null, outcome: Outcome) {
  if (outcome === 'P') {
    expect(await screen.findByText(page)).toBeInTheDocument();
    expect(screen.queryByText(/admins only/)).not.toBeInTheDocument();
  } else if (outcome === 'L') {
    expect(await screen.findByText('Choose a ledger screen')).toBeInTheDocument();
    expect(screen.queryByText(page)).not.toBeInTheDocument();
  } else {
    // A message with a heading in the page's place, under the page's own <h1>.
    const heading = await screen.findByRole('heading', { name: refusal ?? '' });
    expect(heading.closest('.rt-CalloutRoot')).not.toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByText(page)).not.toBeInTheDocument();
    expect(screen.queryByText('Choose a ledger screen')).not.toBeInTheDocument();
  }
}

describe('Settings pages by role', () => {
  beforeEach(() => use('member'));

  it.each(cases)('$scenario at $path: $outcome', async ({ scenario, path, page, refusal, outcome }) => {
    use(scenario);
    renderAt(path);
    await expectOutcome(page, refusal, outcome);
  });

  // The account pages' Reconnect pill used to lead to /import/settings, which showed the
  // page with no role gate while /settings/import-settings had one.
  it.each(SCENARIO_NAMES)('/import/settings is /settings/import-settings (%s)', async (scenario) => {
    const [path, page, refusal, outcomes] = PAGES.find(([p]) => p === '/settings/import-settings')!;
    use(scenario);
    renderWithProviders(<Theme><App /></Theme>, { route: '/import/settings' });
    const outcome = outcomeFor(outcomes, scenario);
    await expectOutcome(page, refusal, outcome);
    // With no ledger the gate asks for one first, and the address moves once there is one.
    if (outcome !== 'L') expect(screen.getByTestId('address')).toHaveTextContent(path);
  });

  // The ledger's page was /settings/budget, the envelope budget's name: a bookmark
  // of it opens /settings/ledger.
  it.each(SCENARIO_NAMES)('/settings/budget is /settings/ledger (%s)', async (scenario) => {
    const [path, page, refusal, outcomes] = PAGES.find(([p]) => p === '/settings/ledger')!;
    use(scenario);
    renderWithProviders(<Theme><App /></Theme>, { route: '/settings/budget' });
    const outcome = outcomeFor(outcomes, scenario);
    await expectOutcome(page, refusal, outcome);
    if (outcome !== 'L') expect(screen.getByTestId('address')).toHaveTextContent(path);
  });

  it.each(SCENARIO_NAMES)('the menu links to exactly the pages that open (%s)', async (scenario) => {
    use(scenario);
    renderAt('/settings');
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(MENU[scenario]);

    // Each link's page opens for them (the cases above render every one).
    const refused = hrefs.filter((href) => {
      const row = PAGES.find(([path]) => path === href);
      return !row || outcomeFor(row[3], scenario) !== 'P';
    });
    expect(refused).toEqual([]);
  });

  it("doesn't refuse anyone before their roles arrive", () => {
    auth.current = { ...auth.current, isDeploymentAdmin: false, membershipLoading: true };
    renderAt('/settings/users');
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText(/admins only/)).not.toBeInTheDocument();
  });
});
