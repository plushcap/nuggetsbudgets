import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Box, Button, Callout, Heading } from '@radix-ui/themes';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import PageContainer from './PageContainer';
import PageLoader from './PageLoader';
import SettingsPageHeader from './SettingsPageHeader';
import { REFUSAL, mayUseSettingsPage, settingsPage, type SettingsPageKey } from './settingsAccess';

/**
 * Role gate for a settings page. Someone whose role can't use the page
 * sees why in its place, under the page's title, instead of a page whose requests the
 * server refuses (a burst of 403 toasts). The server stays the real boundary. A page
 * that needs a ledger has already been given one by RequireLedger.
 *
 * A page anyone signed in (or any member of the ledger) may use doesn't wait for the
 * roles. One that needs a role waits for them; if they couldn't be loaded, it says who
 * may use it and offers to ask again, rather than wait for good: the membership summary
 * isn't asked for again on its own.
 */
const RequireSettingsAccess: React.FC<{ page: SettingsPageKey; children: React.ReactNode }> = ({ page, children }) => {
  const { isDeploymentAdmin, tenantRole, orgRole, organizations, loading, membershipLoading, membershipFailed, retryMembership } = useAuth();
  const { uuid } = useParams();
  const [retrying, setRetrying] = useState(false);
  const access = settingsPage(page);

  if (access.level === 'user' || access.level === 'member') return <>{children}</>;
  const refusal = REFUSAL[access.level];

  // The roles come with the membership summary: until it arrives, nobody is an admin.
  if (loading || (membershipLoading && !membershipFailed)) return <PageLoader label="Loading…" />;
  if (!membershipFailed && mayUseSettingsPage(access, { isDeploymentAdmin, tenantRole, orgRole, organizations }, uuid)) {
    return <>{children}</>;
  }

  const retry = async () => {
    setRetrying(true);
    try {
      await retryMembership();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <PageContainer width="form">
      <SettingsPageHeader
        title={access.title}
        icon={<ShieldAlert size={20} className="text-[var(--amber-12)]" aria-hidden="true" />}
        iconBackground="bg-[var(--amber-3)]"
        backPath="/settings"
      />
      <Callout.Root highContrast color="amber" size="2">
        <Callout.Icon>
          <ShieldAlert size={16} aria-hidden="true" />
        </Callout.Icon>
        <Heading as="h2" size="3">{refusal.heading}</Heading>
        <Callout.Text>{refusal.text(access.title)}</Callout.Text>
        {membershipFailed && (
          <>
            <Callout.Text>We couldn&apos;t load your roles just now, so this page can&apos;t tell whether you may use it.</Callout.Text>
            <Box>
              <Button variant="soft" color="amber" onClick={retry} loading={retrying}>Try again</Button>
            </Box>
          </>
        )}
      </Callout.Root>
    </PageContainer>
  );
};

export default RequireSettingsAccess;
