import type { LucideIcon } from 'lucide-react';
import {
  Home,
  CreditCard,
  Target,
  BarChart3,
  CheckSquare,
  Wallet,
  FileSliders,
  Receipt,
  CheckCircle,
  Tag,
  TrendingUp,
  MessageSquare,
} from 'lucide-react';

export interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  /** Other path prefixes that belong to this section (e.g. a budget item's pages to Budgets). */
  also?: string[];
  /** A section still in beta: the menu marks it with a small Beta tag. */
  beta?: boolean;
  /** The menu sets it apart from the entries above it, with a gap and a line. */
  separated?: boolean;
}

/** The main menu: the sidebar on a wide screen, the drawer on a narrow one. */
export const NAV_ITEMS: NavItem[] = [
  { name: 'Home', href: '/dashboard', icon: Home },
  { name: 'Budgets', href: '/budgets', icon: FileSliders, also: ['/budget-items'] },
  { name: 'Tasks', href: '/tasks', icon: CheckSquare },
  { name: 'Close-Out', href: '/close-out', icon: CheckCircle },
  { name: 'Goals', href: '/goals', icon: Target },
  { name: 'Bills', href: '/bills', icon: Receipt },
  { name: 'Accounts', href: '/accounts', icon: Wallet },
  { name: 'Transactions', href: '/transactions', icon: CreditCard, also: ['/transfertransaction'] },
  { name: 'Agent Activity', href: '/activity', icon: MessageSquare },
  { name: 'Tags', href: '/tags', icon: Tag },
  { name: 'Investments', href: '/investments', icon: TrendingUp, beta: true },
  { name: 'Reports', href: '/reports', icon: BarChart3, separated: true },
];

/** The thumb-reachable destinations in the bottom tab bar on a narrow screen. */
export const BOTTOM_TAB_HREFS = ['/dashboard', '/goals', '/tasks', '/budgets'];

/** The settings pages, reached from the header's Settings link. */
export const SETTINGS_PREFIXES = ['/settings', '/categories', '/import'];

const within = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * How a menu link relates to the page shown, as its `aria-current`: 'page' when it
 * links to this very page, true when the page is inside its section (an account's page
 * under Accounts), else undefined.
 */
export function navCurrent(pathname: string, href: string, also: string[] = []): 'page' | true | undefined {
  if (pathname === href) return 'page';
  return [href, ...also].some((prefix) => within(pathname, prefix)) ? true : undefined;
}

/** The menu section the page belongs to, if any. */
export function navSectionFor(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => navCurrent(pathname, item.href, item.also) !== undefined);
}
