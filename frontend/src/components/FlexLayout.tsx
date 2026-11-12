import React, { useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import NuggetsLogo from './NuggetsLogo';
import { ThemeToggle } from './ThemeToggle';
import TenantSwitcher from './TenantSwitcher';
import RequireLedger from './RequireLedger';
import { profileImageUrl } from '../utils/profileImage';
import { Flex, Box, Text, IconButton, Button, DropdownMenu, Badge, Dialog, VisuallyHidden } from '@radix-ui/themes';
import { useAnnotationCountsQuery } from '../hooks/queries/annotations';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useRouteFocus } from '../hooks/useRouteFocus';
import { NAV_ITEMS, BOTTOM_TAB_HREFS, SETTINGS_PREFIXES, navCurrent, navSectionFor } from './navigation';
import { Menu, Settings, LogOut, User, ChevronDown, MoreHorizontal, X } from 'lucide-react';
import { personName } from '../utils/personName';

interface LayoutProps {
  children: React.ReactNode;
}

export const DESKTOP_QUERY = '(min-width: 1024px)';
const SIDEBAR_WIDTH = '16rem';

/** Shared look of a menu link (its row is the Flex asChild around it): the current page's (or section's) link is highlighted. */
const menuLinkClass = (current: boolean) =>
  `py-2.5 rounded-[var(--radius-4)] text-sm font-medium transition-colors duration-200 border focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--accent-8)] focus-visible:ring-offset-2 ${
    current
      ? 'bg-[var(--accent-3)] text-[var(--accent-11)] border-[var(--accent-6)]'
      : 'text-[var(--gray-11)] hover:text-[var(--gray-12)] row-hover border-transparent'
  }`;

/**
 * The app's main menu: the logo row (`top`), then a list of links. The current page's
 * link is `aria-current`.
 */
const MainMenu: React.FC<{
  pathname: string;
  activityBadge: number;
  onNavigate: (href: string) => void;
  top: React.ReactNode;
}> = ({ pathname, activityBadge, onNavigate, top }) => (
  <nav aria-label="Main">
    <Flex align="center" justify="between" height="64px" px="6" className="border-b border-[var(--gray-6)]">
      {top}
    </Flex>
    <Flex asChild direction="column" gap="1" px="4" py="5" m="0">
      <ul className="list-none">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const current = navCurrent(pathname, item.href, item.also);
          return (
            <li key={item.href}>
              <Flex asChild align="center" gap="3" px="3">
              <Link
                to={item.href}
                aria-current={current}
                onClick={() => onNavigate(item.href)}
                className={menuLinkClass(current !== undefined)}
              >
                <Icon size={20} aria-hidden="true" />
                <span>{item.name}</span>
                {item.href === '/activity' && activityBadge > 0 && (
                  <>
                    <Badge color="amber" variant="solid" radius="full" ml="auto" aria-hidden="true">
                      {activityBadge}
                    </Badge>
                    <VisuallyHidden>{`, ${activityBadge} new`}</VisuallyHidden>
                  </>
                )}
              </Link>
              </Flex>
            </li>
          );
        })}
      </ul>
    </Flex>
  </nav>
);

/** The logo, linking home. */
const HomeLink: React.FC<{ onNavigate: (href: string) => void }> = ({ onNavigate }) => (
  <Flex asChild align="center" gap="3"><Link
    to="/dashboard"
    className="rounded-[var(--radius-4)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--accent-8)] focus-visible:ring-offset-2"
    onClick={() => onNavigate('/dashboard')}
  >
    <span aria-hidden="true">
      <NuggetsLogo size={24} className="shrink-0" />
    </span>
    <span className="text-xl font-semibold text-[var(--gray-12)]">Nuggets</span>
  </Link></Flex>
);

/**
 * The app shell: a header (banner), the main menu and the page (`main`).
 *
 * On a wide screen the menu is a column beside the page that the header's menu button
 * shows and hides; hidden, it is `inert`, so its links leave the tab order and the
 * accessibility tree. On a narrow screen it is a drawer: a modal dialog, which keeps
 * the keyboard inside it, closes on Escape and returns the focus to the button that
 * opened it. A bottom tab bar holds four shortcuts and a "More" button for the drawer.
 *
 * Each page's title and focus are handled by useRouteFocus: after a navigation the new
 * page's heading is focused and named in document.title.
 */
const FlexLayout: React.FC<LayoutProps> = ({ children }) => {
  const { pathname } = useLocation();
  const { user, logout } = useAuth();
  const avatarUrl = profileImageUrl(user?.profile_image);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { data: annotationCounts } = useAnnotationCountsQuery();
  const activityBadge = annotationCounts?.notify ?? 0;
  const mainRef = useRef<HTMLElement>(null);
  const menuId = useId();
  // The button that opened the drawer gets the focus back when it closes, unless a link
  // in it was followed: then the new page takes it (useRouteFocus).
  const drawerOpener = useRef<HTMLElement | null>(null);
  const leftByLink = useRef(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  const section = navSectionFor(pathname);
  const inSettings = SETTINGS_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const sectionName = section?.name ?? (inSettings ? 'Settings' : pathname.startsWith('/profile') ? 'Profile' : '');
  useRouteFocus(mainRef, sectionName || undefined);

  const bottomTabs = BOTTOM_TAB_HREFS.map((href) => NAV_ITEMS.find((n) => n.href === href)).filter(
    (n): n is (typeof NAV_ITEMS)[number] => Boolean(n)
  );

  const openDrawer = (event: React.MouseEvent<HTMLElement>) => {
    drawerOpener.current = event.currentTarget;
    leftByLink.current = false;
    setDrawerOpen(true);
  };
  const followedFromDrawer = (href: string) => {
    leftByLink.current = href !== pathname;
    setDrawerOpen(false);
  };

  const skipToMain = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    mainRef.current?.focus();
    mainRef.current?.scrollIntoView?.();
  };

  const menuButtonLabel = 'Main menu';
  const sidebarShown = isDesktop && sidebarOpen;

  return (
    <Box minHeight="100vh" className="bg-[var(--gray-2)]">
      {/* Skip link: the first stop for the keyboard; it moves the focus to the page. */}
      <a
        href="#main-content"
        onClick={skipToMain}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 z-[60] rounded-[var(--radius-3)] bg-[var(--accent-9)] text-[var(--accent-contrast)] px-4 py-2 text-sm font-medium focus:outline-hidden focus:ring-2 focus:ring-[var(--accent-12)] focus:ring-offset-2"
      >
        Skip to main content
      </a>

      {/* Narrow screens: the menu drawer, a modal dialog. */}
      {!isDesktop && (
        <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
          <Dialog.Content
            ref={drawerRef}
            id={menuId}
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              // Start on the current page's link (else the first), not the logo.
              const content = drawerRef.current;
              const target =
                content?.querySelector<HTMLElement>('nav a[aria-current="page"], nav a[aria-current="true"]') ??
                content?.querySelector<HTMLElement>('nav a');
              if (target) {
                event.preventDefault();
                target.focus();
              }
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (leftByLink.current) leftByLink.current = false;
              else drawerOpener.current?.focus();
            }}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              bottom: 0,
              width: SIDEBAR_WIDTH,
              maxWidth: '85vw',
              height: '100dvh',
              maxHeight: '100dvh',
              margin: 0,
              padding: 0,
              borderRadius: 0,
            }}
          >
            <VisuallyHidden>
              <Dialog.Title>Menu</Dialog.Title>
            </VisuallyHidden>
            <MainMenu
              pathname={pathname}
              activityBadge={activityBadge}
              onNavigate={followedFromDrawer}
              top={
                <>
                  <HomeLink onNavigate={followedFromDrawer} />
                  <Dialog.Close>
                    <IconButton variant="ghost" color="gray" aria-label="Close menu">
                      <X size={20} />
                    </IconButton>
                  </Dialog.Close>
                </>
              }
            />
          </Dialog.Content>
        </Dialog.Root>
      )}

      {/* Header and page; the page clears the menu column while it's shown. */}
      <div style={{ marginLeft: sidebarShown ? SIDEBAR_WIDTH : 0, transition: 'margin-left 300ms ease-in-out' }}>
        <header className="bg-[var(--color-panel-solid)] border-b border-[var(--gray-6)] shadow-xs">
          <Flex align="center" justify="between" height="64px" px={{ initial: '4', sm: '6', lg: '8' }}>
            <Flex align="center" minWidth="0" flexGrow="1" gap="4">
              {isDesktop ? (
                <IconButton
                  onClick={() => setSidebarOpen((open) => !open)}
                  variant="ghost"
                  color="gray"
                  aria-label={menuButtonLabel}
                  aria-expanded={sidebarOpen}
                  aria-controls={menuId}
                  title={sidebarOpen ? 'Hide menu' : 'Show menu'}
                >
                  <Menu size={20} />
                </IconButton>
              ) : (
                <IconButton
                  onClick={openDrawer}
                  variant="ghost"
                  color="gray"
                  aria-label={menuButtonLabel}
                  aria-haspopup="dialog"
                  aria-expanded={drawerOpen}
                  aria-controls={drawerOpen ? menuId : undefined}
                >
                  <Menu size={20} />
                </IconButton>
              )}

              {/* The section's name; the page's own <h1> is in main. */}
              <Box minWidth="0" flexGrow="1">
                <Text as="p" size="4" weight="bold" truncate>
                  {sectionName}
                </Text>
              </Box>
            </Flex>

            {/* Right side - ledger switcher, theme toggle and user menu */}
            <Flex align="center" gap="4" flexShrink="0">
              <TenantSwitcher />
              <ThemeToggle variant="icon" />

              <IconButton asChild variant="ghost" color="gray">
                <Link to="/settings" aria-label="Settings" aria-current={inSettings ? (pathname === '/settings' ? 'page' : true) : undefined}>
                  <Settings size={20} />
                </Link>
              </IconButton>

              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  <Button variant="ghost" color="gray" aria-label="User menu" highContrast>
                    <Flex
                      align="center"
                      justify="center"
                      width="32px"
                      height="32px"
                      overflow="hidden" className="bg-linear-to-r from-[var(--accent-9)] to-[var(--accent-10)] text-[var(--accent-contrast)] rounded-full"
                    >
                      {avatarUrl ? (
                        <Box asChild width="100%" height="100%"><img src={avatarUrl} alt="" className="object-cover" /></Box>
                      ) : (
                        <Text size="2" weight="medium">
                          {user?.first_name?.charAt(0) || 'U'}
                        </Text>
                      )}
                    </Flex>
                    <Box display={{ initial: 'none', sm: 'block' }} style={{ textAlign: 'left' }}>
                      <Text as="div" size="2" weight="medium">
                        {user?.first_name || 'User'}
                      </Text>
                      <Text as="div" size="1" color="gray">
                        Admin
                      </Text>
                    </Box>
                    <ChevronDown size={16} aria-hidden="true" />
                  </Button>
                </DropdownMenu.Trigger>

                <DropdownMenu.Content align="end">
                  <DropdownMenu.Label>
                    <Flex direction="column">
                      <Text size="2" weight="medium" color="gray" highContrast>
                        {user ? personName(user, user.email) : null}
                      </Text>
                      <Text size="1" color="gray">
                        {user?.email}
                      </Text>
                    </Flex>
                  </DropdownMenu.Label>

                  <DropdownMenu.Item asChild>
                    <Link to="/profile">
                      <User size={16} />
                      Profile Settings
                    </Link>
                  </DropdownMenu.Item>

                  <DropdownMenu.Separator />

                  <DropdownMenu.Item color="red" onClick={() => logout()}>
                    <LogOut size={16} />
                    Sign out
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </Flex>
          </Flex>
        </header>

        {/* Wide screens: the menu column. Hidden, it is inert (out of the tab order). */}
        {isDesktop && (
          <Box
            id={menuId}
            inert={!sidebarOpen}
            position="fixed"
            top="0"
            left="0"
            height="100vh"
            width="256px"
            overflowY="auto"
            className={`z-50 bg-[var(--color-panel-solid)] shadow-xl border-r border-[var(--gray-6)] transition-transform duration-300 ease-in-out ${
              sidebarOpen ? 'translate-x-0' : '-translate-x-full'
            }`}
          >
            <MainMenu
              pathname={pathname}
              activityBadge={activityBadge}
              onNavigate={() => {}}
              top={<HomeLink onNavigate={() => {}} />}
            />
          </Box>
        )}

        {/* The page (extra bottom padding on a narrow screen clears the tab bar). It takes
            the focus from the skip link, and on navigation when it has no heading. */}
        <Box asChild flexGrow="1" flexBasis="0%" overflowY="auto"><main id="main-content" ref={mainRef} tabIndex={-1} >
          <Box className="p-4 sm:p-6 lg:p-8 pb-24 lg:pb-8">
            <RequireLedger>{children}</RequireLedger>
          </Box>
        </main></Box>
      </div>

      {/* Narrow screens: the bottom tab bar (thumb-reachable). */}
      {!isDesktop && (
        <Box asChild position="fixed" bottom="0" left="0" right="0"><nav
          className="z-40 bg-[var(--color-panel-solid)] border-t border-[var(--gray-6)]"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          aria-label="Shortcuts"
        >
          <Flex asChild align="stretch" height="64px" m="0" p="0">
            <ul className="list-none">
              {bottomTabs.map((item) => {
                const Icon = item.icon;
                const current = navCurrent(pathname, item.href, item.also);
                return (
                  <Flex asChild key={item.href} flexGrow="1" flexBasis="0%"><li>
                    <Flex asChild flexGrow="1" flexBasis="0%" direction="column" align="center" justify="center">
                    <Link
                      to={item.href}
                      aria-current={current}
                      className={`gap-0.5 text-[11px] font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-8)] ${
                        current !== undefined ? 'text-[var(--accent-11)]' : 'text-[var(--gray-11)]'
                      }`}
                    >
                      <Icon size={20} aria-hidden="true" />
                      <span>{item.name}</span>
                    </Link>
                    </Flex>
                  </li></Flex>
                );
              })}
              <Flex asChild flexGrow="1" flexBasis="0%"><li>
                <Button
                  variant="ghost"
                  color="gray"
                  radius="none"
                  onClick={openDrawer}
                  aria-haspopup="dialog"
                  aria-expanded={drawerOpen}
                  aria-controls={drawerOpen ? menuId : undefined}
                  className="flex-1 h-full flex-col gap-0.5 text-[11px] font-medium m-0"
                >
                  <MoreHorizontal size={20} aria-hidden="true" />
                  <span>More</span>
                </Button>
              </li></Flex>
            </ul>
          </Flex>
        </nav></Box>
      )}
    </Box>
  );
};

export default FlexLayout;
