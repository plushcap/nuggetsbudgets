import type { MemberRole, OrganizationSummary } from '@nuggets/shared';

/**
 * Who may use a settings page. The levels are the backend's, weakest first
 * (`Level` in backend/src/__tests__/route-authorization.test.ts); each one includes those
 * above it, as the server's guards do: an organization admin administers its ledgers, a
 * deployment admin everything.
 */
export type SettingsLevel = 'user' | 'member' | 'tenantAdmin' | 'orgAdmin' | 'deploymentAdmin';

export interface SettingsPageAccess {
  /** The page's name: the heading shown in its place when someone can't use it. */
  title: string;
  /** The level of the API routes the page calls (ACCESS in route-authorization.test.ts). */
  level: SettingsLevel;
  /**
   * Whether it works on the active ledger: its routes run behind `requireTenantMember`
   * (400 NO_ACTIVE_TENANT without one), or it manages the active ledger's organization.
   */
  ledger: boolean;
  /** The organization is the one in the address (`organizations/:uuid`), not the active ledger's. */
  orgFromAddress?: boolean;
}

/**
 * Each settings page, by its address under /settings (the first segment; the
 * organization drill-in by its pattern). An address not listed is no page: it shows
 * "Page not found", with or without a ledger.
 */
const PAGES = {
  // My Account: /api/auth/*, /api/passkeys/*.
  mcp: { title: 'MCP Access', level: 'user', ledger: false },
  // The active ledger's data: any member of it may use these (GET /api/tenants/current and
  // /api/notifications/rules are member routes; their pages are read-only for members).
  ledger: { title: 'Ledger', level: 'member', ledger: true },
  categories: { title: 'Categories', level: 'member', ledger: true },
  merchants: { title: 'Merchants', level: 'member', ledger: true },
  institutions: { title: 'Institutions', level: 'member', ledger: true },
  'budget-matching': { title: 'Budget Matching', level: 'member', ledger: true },
  'budget-periods': { title: 'Budget Periods', level: 'member', ledger: true },
  'notification-rules': { title: 'Notifications', level: 'member', ledger: true },
  export: { title: 'Export Data', level: 'member', ledger: true },
  // /api/data-management/*: requireTenantAdmin.
  'data-management': { title: 'Data Management', level: 'tenantAdmin', ledger: true },
  // The ledger's own time zone: GET /api/settings/general is a member route, and
  // saving it (POST) is the ledger's admins'.
  general: { title: 'General Settings', level: 'tenantAdmin', ledger: true },
  // POST /api/net-worth/rebuild, DELETE /api/net-worth/clear and /api/admin/test-data/*:
  // deployment admins, on the active ledger.
  'net-worth-reset': { title: 'Net Worth Reset', level: 'deploymentAdmin', ledger: true },
  'test-data': { title: 'Test Data Generator', level: 'deploymentAdmin', ledger: true },
  // Bank import: GET /api/import/settings and /status and POST /api/import/sync (Sync Now)
  // are member routes, and the account pages' Reconnect pill sends members here. The page
  // shows the organization's connection (/api/organizations/:uuid/simplefin/*,
  // /api/import/test-sync, /api/import/simplefin-accounts) and the ledger's own schedule
  // (POST /api/import/settings, /api/import/scheduler/start|stop) to its admins only.
  'import-settings': { title: 'Bank Import Settings', level: 'member', ledger: true },
  // The active ledger's organization: /api/organizations/:uuid/*, /api/import/accounts.
  organization: { title: 'Organization', level: 'orgAdmin', ledger: true },
  'price-sync': { title: 'Investments', level: 'orgAdmin', ledger: true },
  // The organization in the address: /api/organizations/:uuid/* (its uuid param handler).
  'organizations/:uuid': { title: 'Organization', level: 'orgAdmin', ledger: false, orgFromAddress: true },
  // The deployment: /api/admin/*, /api/backup/*, /api/onedrive/*.
  organizations: { title: 'Organizations', level: 'deploymentAdmin', ledger: false },
  users: { title: 'Users', level: 'deploymentAdmin', ledger: false },
  // /api/backup/*, and the deployment's time zone (/api/admin/deployment-settings).
  backup: { title: 'Database Backup', level: 'deploymentAdmin', ledger: false },
  // /api/admin/database/*: the schema and applied migrations, for a bug report.
  utilities: { title: 'Utilities', level: 'deploymentAdmin', ledger: false },
  // /api/admin/notifications/settings, /status, /test, /preview, /scheduler: deployment
  // admins, with no ledger. The page also shows the active ledger's history
  // (/api/notifications/history) when there is one, and leaves it out when there isn't.
  notifications: { title: 'Email Notifications', level: 'deploymentAdmin', ledger: false },
} satisfies Record<string, SettingsPageAccess>;

export type SettingsPageKey = keyof typeof PAGES;

export const settingsPage = (key: SettingsPageKey): SettingsPageAccess => PAGES[key];

const SETTINGS_PAGES: ReadonlyMap<string, SettingsPageAccess> = new Map(Object.entries(PAGES));

/** The settings page at an address (`/settings/users/add` → Users), if it is one. */
export function settingsPageAt(pathname: string): SettingsPageAccess | undefined {
  if (!pathname.startsWith('/settings/')) return undefined;
  const [segment = '', next] = pathname.slice('/settings/'.length).split('/');
  if (segment === 'organizations' && next) return SETTINGS_PAGES.get('organizations/:uuid');
  return SETTINGS_PAGES.get(segment);
}

/** Whether a settings address needs an active ledger (RequireLedger asks for one first). */
export const settingsPathNeedsLedger = (pathname: string): boolean => settingsPageAt(pathname)?.ledger ?? false;

/** The caller's roles, from the membership summary (useAuth). */
export interface SettingsRoles {
  isDeploymentAdmin: boolean;
  /** On the active ledger: 'admin' for its admins, its organization's and the deployment's. */
  tenantRole: MemberRole | null;
  /** On the active ledger's organization: 'admin' for its admins and the deployment's. */
  orgRole: MemberRole | null;
  /** The organizations they belong to, with their role in each. */
  organizations: OrganizationSummary[];
}

/**
 * Whether someone's role may use a page. Membership of the active ledger needs no check
 * here: a ledger is active only for someone who may open it (the ledger itself is
 * RequireLedger's to ask for). `orgUuid` is the organization in the address, for a page
 * that names one.
 */
export function mayUseSettingsPage(page: SettingsPageAccess, roles: SettingsRoles, orgUuid?: string): boolean {
  switch (page.level) {
    case 'user':
    case 'member':
      return true;
    case 'tenantAdmin':
      return roles.isDeploymentAdmin || roles.tenantRole === 'admin' || roles.orgRole === 'admin';
    case 'orgAdmin':
      if (roles.isDeploymentAdmin) return true;
      if (page.orgFromAddress) return roles.organizations.some((org) => org.uuid === orgUuid && org.role === 'admin');
      return roles.orgRole === 'admin';
    case 'deploymentAdmin':
      return roles.isDeploymentAdmin;
  }
}

/** The message shown in place of a page someone's role can't use. */
export const REFUSAL: Record<Exclude<SettingsLevel, 'user' | 'member'>, { heading: string; text: (title: string) => string }> = {
  tenantAdmin: {
    heading: 'Ledger admins only',
    text: (title) => `${title} changes this ledger for everyone in it, so only an admin of the ledger can use it. Ask one of its admins.`,
  },
  orgAdmin: {
    heading: 'Organization admins only',
    text: (title) => `${title} covers the whole organization, so only an admin of the organization can use it.`,
  },
  deploymentAdmin: {
    heading: 'Deployment admins only',
    text: (title) => `${title} covers the whole deployment, so only a deployment admin can use it.`,
  },
};
