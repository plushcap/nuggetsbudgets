import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Box, Button, Callout, Heading } from '@radix-ui/themes';
import { AlertCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import PageContainer from './PageContainer';
import PageLoader from './PageLoader';
import LedgerSelectionScreen from './LedgerSelectionScreen';
import LedgerMoneyFormat from './LedgerMoneyFormat';
import { settingsPageAt, settingsPathNeedsLedger } from './settingsAccess';

/**
 * Routes that are usable without an active ledger. Everything else is tenant
 * scoped and its API calls require one (the backend returns 400 NO_ACTIVE_TENANT
 * otherwise). These are account-level pages, accepting an invitation, which someone
 * new does before they have a ledger, and the settings pages that don't work on one
 * (settingsAccess.ts): the Settings menu itself, MCP access, and the admin areas an
 * admin must still reach with no ledger selected — e.g. to create one — which are the
 * deployment's and an organization's by its address.
 */
const LEDGER_OPTIONAL_PREFIXES = ['/profile', '/invitations'];

const within = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

const isLedgerOptional = (pathname: string): boolean =>
  LEDGER_OPTIONAL_PREFIXES.some((p) => within(pathname, p)) ||
  (within(pathname, '/settings') && !settingsPathNeedsLedger(pathname));

/** A settings page that needs a role: its own gate says who may use it (RequireSettingsAccess). */
const needsSettingsRole = (pathname: string): boolean => {
  const level = settingsPageAt(pathname)?.level;
  return level !== undefined && level !== 'user' && level !== 'member';
};

/**
 * Gate for tenant-scoped pages. When no ledger is active, render the selection /
 * onboarding screen instead of the page, so we never mount pages that would fire
 * a cascade of failing (NO_ACTIVE_TENANT) requests. Ledger-independent routes and
 * the loading window pass straight through. Mounted inside the layout so the
 * header chrome (ledger switcher, profile, logout) stays available.
 *
 * If the membership summary couldn't be loaded, whether there is a ledger isn't known:
 * it says so and offers to ask again, rather than wait for good (it isn't asked for again
 * on its own). A settings page that needs a role leaves that to its role gate.
 */
const RequireLedger: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { activeTenant, loading, membershipLoading, membershipFailed, retryMembership } = useAuth();
  const { pathname } = useLocation();
  const [retrying, setRetrying] = useState(false);

  // Pages that work without a ledger show none of its money, so they don't wait for its settings.
  if (isLedgerOptional(pathname)) return <>{children}</>;
  // A ledger's pages show its money in its currency and locale (General Settings), once loaded.
  if (activeTenant) return <LedgerMoneyFormat>{children}</LedgerMoneyFormat>;
  if (membershipFailed && !loading) {
    if (needsSettingsRole(pathname)) return <>{children}</>;
    const retry = async () => {
      setRetrying(true);
      try {
        await retryMembership();
      } finally {
        setRetrying(false);
      }
    };
    return (
      <PageContainer width="auth">
        <Heading size="6" align="center" mb="4">Your ledgers didn&apos;t load</Heading>
        <Callout.Root highContrast color="amber" size="2">
          <Callout.Icon>
            <AlertCircle size={16} aria-hidden="true" />
          </Callout.Icon>
          <Callout.Text>We couldn&apos;t load your ledgers just now, so this page can&apos;t open yet.</Callout.Text>
          <Box>
            <Button variant="soft" color="amber" onClick={retry} loading={retrying}>Try again</Button>
          </Box>
        </Callout.Root>
      </PageContainer>
    );
  }
  if (loading || membershipLoading) return <PageLoader label="Loading…" />;
  return <LedgerSelectionScreen />;
};

export default RequireLedger;
