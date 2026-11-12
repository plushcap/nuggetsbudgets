import React, { lazy, Suspense } from 'react';
import { Link, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import {
  Store,
  FolderOpen,
  Users,
  Download,
  Settings as SettingsIcon,
  Building2,
  TrendingUp,
  RefreshCw,
  Database,
  Target,
  Bell,
  BellRing,
  Trash2,
  KeyRound,
  Wallet,
  Network,
  User,
  Wrench
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import NuggetSpinner from '../components/NuggetSpinner';
import RequireSettingsAccess from '../components/RequireSettingsAccess';
import { mayUseSettingsPage, settingsPageAt, type SettingsPageKey } from '../components/settingsAccess';
import { Flex, Grid, Box, Heading, Text, Card } from '@radix-ui/themes';
import PageContainer from '../components/PageContainer';

// Lazy load the pages to avoid circular dependencies
const MerchantManagementPage = lazy(() => import('./MerchantManagementPage'));
const CategoriesPage = lazy(() => import('./CategoriesPage'));
const InstitutionsPage = lazy(() => import('./InstitutionsPage'));
const AddInstitutionPage = lazy(() => import('./AddInstitutionPage'));
const EditInstitutionPage = lazy(() => import('./EditInstitutionPage'));
const UserManagementPage = lazy(() => import('./UserManagementPage'));
const AddUserPage = lazy(() => import('./AddUserPage'));
const EditUserPage = lazy(() => import('./EditUserPage'));
const ImportSettingsPage = lazy(() => import('./ImportSettingsPage'));
const GeneralSettingsPage = lazy(() => import('./GeneralSettingsPage'));
const TestDataPage = lazy(() => import('./TestDataPage'));
const NetWorthResetPage = lazy(() => import('./NetWorthResetPage'));
const BudgetMatchingRulesPage = lazy(() => import('./BudgetMatchingRulesPage'));
const BudgetPeriodsPage = lazy(() => import('./BudgetPeriodsPage'));
const AddBudgetPeriodPage = lazy(() => import('./AddBudgetPeriodPage'));
const BackupPage = lazy(() => import('./BackupPage'));
const UtilitiesPage = lazy(() => import('./UtilitiesPage'));
const NotificationSettingsPage = lazy(() => import('./NotificationSettingsPage'));
const NotificationRulesPage = lazy(() => import('./NotificationRulesPage'));
const DataExportPage = lazy(() => import('./DataExportPage'));
const DataDeletionSettingsPage = lazy(() => import('./DataDeletionSettingsPage'));
const McpAccessPage = lazy(() => import('./McpAccessPage'));
const TenantSettingsPage = lazy(() => import('./TenantSettingsPage'));
const OrganizationSettingsPage = lazy(() => import('./OrganizationSettingsPage'));
const OrganizationsConsolePage = lazy(() => import('./OrganizationsConsolePage'));
const PriceSyncSettingsPage = lazy(() => import('./PriceSyncSettingsPage'));
const NotFoundPage = lazy(() => import('./NotFoundPage'));

interface NavItem {
  name: string;
  href: string;
  icon: React.ElementType;
  description: string;
}

// Settings grouped by the tier whose data they touch. Each section is shown only
// to the role that owns it (see the `show` flags below), and in it only the pages
// that person can use now (settingsAccess.ts: their role, and a ledger if the page
// needs one).
//
// My Account — per-user, everyone.
const accountNav: NavItem[] = [
  { name: 'Profile', href: '/profile', icon: User, description: 'Your name, avatar, colour, icon, and password' },
  { name: 'MCP Access', href: '/settings/mcp', icon: KeyRound, description: 'Create and revoke personal access tokens for AI agents and other MCP clients' },
];

// Ledger Settings — the active ledger's data; ledger admins only.
const tenantNav: NavItem[] = [
  { name: 'Ledger', href: '/settings/ledger', icon: Wallet, description: 'Rename this ledger and manage who can access it' },
  { name: 'General', href: '/settings/general', icon: SettingsIcon, description: "This ledger's time zone, and your theme" },
  { name: 'Categories', href: '/settings/categories', icon: FolderOpen, description: 'Organise this ledger with custom categories' },
  { name: 'Merchants', href: '/settings/merchants', icon: Store, description: 'Manage merchants and matching rules' },
  { name: 'Institutions', href: '/settings/institutions', icon: Building2, description: 'Manage financial institutions for account assignments' },
  { name: 'Budget Matching', href: '/settings/budget-matching', icon: Target, description: 'Automatic budget assignment rules for transactions' },
  { name: 'Budget Periods', href: '/settings/budget-periods', icon: RefreshCw, description: 'Manage budget periods and timeline structure' },
  { name: 'Notifications', href: '/settings/notification-rules', icon: BellRing, description: 'What this ledger tells its members about, and when' },
  { name: 'Export Data', href: '/settings/export', icon: Download, description: 'Export transactions and other data to CSV files' },
  { name: 'Net Worth Reset', href: '/settings/net-worth-reset', icon: TrendingUp, description: 'Rebuild net worth history and create historical snapshots' },
  { name: 'Data Management', href: '/settings/data-management', icon: Trash2, description: 'Safely delete transaction data with automatic backups' },
  // Development builds only: its "delete" wipes the whole ledger.
  ...(import.meta.env.DEV
    ? [{ name: 'Test Data Generator', href: '/settings/test-data', icon: SettingsIcon, description: 'Development only: generate test data, or delete all of this ledger\'s data' }]
    : []),
];

// Organization Settings — org admins (and deployment admins).
const orgNav: NavItem[] = [
  { name: 'Organization', href: '/settings/organization', icon: Building2, description: 'Rename the organization, manage its ledgers, and invite and manage its members' },
  { name: 'Bank Import', href: '/settings/import-settings', icon: Database, description: "The organization's SimpleFin connection, and this ledger's automatic import" },
  { name: 'Investments', href: '/settings/price-sync', icon: TrendingUp, description: 'Price sync schedule and securities-catalog maintenance' },
];

// Deployment Settings — deployment admins only. App-wide infrastructure.
const deploymentNav: NavItem[] = [
  { name: 'Organizations', href: '/settings/organizations', icon: Network, description: 'Create and manage every organization in this deployment' },
  { name: 'Users', href: '/settings/users', icon: Users, description: 'Manage who can log in to this deployment' },
  { name: 'Email Notifications', href: '/settings/notifications', icon: Bell, description: 'Configure SMTP and email notifications for budget alerts' },
  { name: 'Database Backup', href: '/settings/backup', icon: Database, description: 'Create encrypted backups and restore your financial data' },
  { name: 'Utilities', href: '/settings/utilities', icon: Wrench, description: 'Download the database schema and its migration history to attach to a bug report' },
];

const SettingsCard: React.FC<{ item: NavItem; active: boolean }> = ({ item, active }) => {
  const Icon = item.icon;
  return (
    <Link to={item.href}>
      <Card
        className={`p-6 hover:shadow-lg transition-all duration-200 group cursor-pointer ${active ? 'shadow-lg' : ''}`}
        style={{ minHeight: '140px' }}
      >
        <Flex align="start" gap="4">
          <Flex
            align="center"
            justify="center"
            width="48px"
            height="48px"
            className={`rounded-[var(--radius-4)] transition-colors duration-200 ${
              active
                ? 'bg-[var(--accent-4)] text-[var(--accent-11)]'
                : 'bg-[var(--gray-3)] text-[var(--gray-11)] group-hover:bg-[var(--accent-4)] group-hover:text-[var(--accent-11)]'
            }`}
          >
            <Icon size={24} />
          </Flex>
          <Box flexGrow="1">
            <Text as="div" size="4" weight="bold" mb="1" className={`${active ? 'text-[var(--accent-11)]' : 'text-[var(--gray-12)]'}`}>
              {item.name}
            </Text>
            <Text size="2" className="text-[var(--gray-11)] leading-relaxed">
              {item.description}
            </Text>
          </Box>
        </Flex>
      </Card>
    </Link>
  );
};

/** A settings page behind the role gate for it (the ledger gate is RequireLedger's). */
const guard = (page: SettingsPageKey, element: React.ReactElement) => (
  <RequireSettingsAccess page={page}>{element}</RequireSettingsAccess>
);

const SettingsPage: React.FC = () => {
  const location = useLocation();
  const { isDeploymentAdmin, orgRole, tenantRole, activeTenant, activeOrganization, organizations } = useAuth();

  const isActive = (href: string) => location.pathname === href || location.pathname.startsWith(href);

  // If we're on a specific settings page, render that page
  if (location.pathname !== '/settings') {
    return (
      <Suspense fallback={<Flex justify="center" align="center" height="256px"><NuggetSpinner size={32} /></Flex>}>
        <Routes>
          <Route path="merchants/*" element={guard('merchants', <MerchantManagementPage />)} />
          <Route path="categories/*" element={guard('categories', <CategoriesPage />)} />
          <Route path="institutions" element={guard('institutions', <InstitutionsPage />)} />
          <Route path="institutions/add" element={guard('institutions', <AddInstitutionPage />)} />
          <Route path="institutions/edit/:uuid" element={guard('institutions', <EditInstitutionPage />)} />
          <Route path="budget-matching/*" element={guard('budget-matching', <BudgetMatchingRulesPage />)} />
          <Route path="budget-periods" element={guard('budget-periods', <BudgetPeriodsPage />)} />
          <Route path="budget-periods/add" element={guard('budget-periods', <AddBudgetPeriodPage />)} />
          <Route path="import-settings" element={guard('import-settings', <ImportSettingsPage />)} />
          <Route path="general" element={guard('general', <GeneralSettingsPage />)} />
          {/*
            Income / Bills / Expenses are one budget_item entity, now managed
            entirely on the Budget page. The old Settings list, add, and
            edit routes are retired — redirect any lingering bookmarks to
            /budgets. Create/edit live at /budget-items/add and
            /budget-items/:uuid/edit.
          */}
          <Route path="income/*" element={<Navigate to="/budgets" replace />} />
          <Route path="bills/*" element={<Navigate to="/budgets" replace />} />
          <Route path="expenses/*" element={<Navigate to="/budgets" replace />} />
          <Route path="users" element={guard('users', <UserManagementPage />)} />
          <Route path="users/add" element={guard('users', <AddUserPage />)} />
          <Route path="users/edit/:uuid" element={guard('users', <EditUserPage />)} />
          {import.meta.env.DEV && <Route path="test-data" element={guard('test-data', <TestDataPage />)} />}
          <Route path="net-worth-reset" element={guard('net-worth-reset', <NetWorthResetPage />)} />
          <Route path="backup" element={guard('backup', <BackupPage />)} />
          <Route path="utilities" element={guard('utilities', <UtilitiesPage />)} />
          <Route path="data-management" element={guard('data-management', <DataDeletionSettingsPage />)} />
          <Route path="notifications" element={guard('notifications', <NotificationSettingsPage />)} />
          <Route path="notification-rules" element={guard('notification-rules', <NotificationRulesPage />)} />
          <Route path="export" element={guard('export', <DataExportPage />)} />
          <Route path="mcp" element={guard('mcp', <McpAccessPage />)} />
          <Route path="ledger" element={guard('ledger', <TenantSettingsPage />)} />
          {/* The ledger's page was /settings/budget, a name the envelope budget has. */}
          <Route path="budget" element={<Navigate to="/settings/ledger" replace />} />
          <Route path="organization" element={guard('organization', <OrganizationSettingsPage />)} />
          <Route path="price-sync" element={guard('price-sync', <PriceSyncSettingsPage />)} />
          <Route path="organizations" element={guard('organizations', <OrganizationsConsolePage />)} />
          <Route path="organizations/:uuid" element={guard('organizations/:uuid', <OrganizationSettingsPage />)} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    );
  }

  // A card only for a page that opens for this person now, so the menu never leads to
  // a page that refuses them or asks for a ledger first.
  const canOpen = (item: NavItem) => {
    const page = settingsPageAt(item.href);
    if (!page) return true;
    if (page.ledger && !activeTenant) return false;
    return mayUseSettingsPage(page, { isDeploymentAdmin, tenantRole, orgRole, organizations });
  };

  // Sections ordered most-personal → most-global; each shown only to its role.
  const sections: { key: string; title: string; items: NavItem[]; show: boolean }[] = [
    { key: 'account', title: 'My Account', items: accountNav, show: true },
    {
      key: 'tenant',
      title: activeTenant ? `Ledger Settings — ${activeTenant.name}` : 'Ledger Settings',
      items: tenantNav,
      show: tenantRole === 'admin',
    },
    {
      key: 'organization',
      title: activeOrganization ? `Organization Settings — ${activeOrganization.name}` : 'Organization Settings',
      items: orgNav,
      show: orgRole === 'admin' || isDeploymentAdmin,
    },
    { key: 'deployment', title: 'Deployment Settings', items: deploymentNav, show: isDeploymentAdmin },
  ];

  return (
    <PageContainer>
      <Box mb="8">
        <Flex align="center" gap="3" mb="2">
          <SettingsIcon size={32} className="text-[var(--gray-11)]" aria-hidden="true" />
          <Heading as="h1" size="8" weight="bold" className="text-[var(--gray-12)]">Settings</Heading>
        </Flex>
        <Text size="3" className="text-[var(--gray-11)]">Manage your account, ledger, and (if you administer them) your organization and deployment.</Text>
      </Box>

      {sections
        .map((section) => ({ ...section, items: section.items.filter(canOpen) }))
        .filter((section) => section.show && section.items.length > 0)
        .map((section) => (
          <Box key={section.key} mb="9">
            <Heading as="h2" size="6" weight="bold" mb="5" className="text-[var(--gray-12)]">{section.title}</Heading>
            <Grid columns={{ initial: '1', md: '2', lg: '3', xl: '4' }} gap="6">
              {section.items.map((item) => (
                <SettingsCard key={item.name} item={item} active={isActive(item.href)} />
              ))}
            </Grid>
          </Box>
        ))}
    </PageContainer>
  );
};

export default SettingsPage;
