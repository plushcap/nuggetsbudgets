import React from 'react';
import { Card, Flex, Text } from '@radix-ui/themes';
import { TrendingUp, Shield } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import SettingsPageHeader from '../components/SettingsPageHeader';
import PriceSyncCard from '../components/PriceSyncCard';
import SecuritiesCleanupCard from '../components/SecuritiesCleanupCard';
import PageContainer from '../components/PageContainer';

/**
 * Organization-level investments administration: scheduled EOD price sync
 * plus securities-catalog maintenance (bulk cleanup of unused
 * imported funds). Org-admin scoped; the backend re-authorizes every mutation.
 */
const PriceSyncSettingsPage: React.FC = () => {
  const { orgRole, isDeploymentAdmin, activeOrganization } = useAuth();
  const canManage = orgRole === 'admin' || isDeploymentAdmin;
  const orgUuid = activeOrganization?.uuid;

  const header = (
    <SettingsPageHeader
      title="Investments"
      subtitle="Price sync schedule and securities-catalog maintenance"
      icon={<TrendingUp size={20} className="text-[var(--accent-11)]" />}
      iconBackground="bg-[var(--accent-3)]"
      backPath="/settings"
    />
  );

  if (!canManage) {
    return (
      <PageContainer width="form">
        {header}
        <Card>
          <Flex direction="column" align="center" gap="2" py="6">
            <Shield size={48} className="text-[var(--red-11)]" />
            <Text size="3" weight="medium">Organization admins only</Text>
            <Text size="2" align="center" color="gray">
              Investment administration affects the whole organization, so only an
              organization admin can manage it.
            </Text>
          </Flex>
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer width="form">
      {header}
      <Flex direction="column" gap="4">
        {orgUuid ? (
          <PriceSyncCard orgUuid={orgUuid} />
        ) : (
          <Card>
            <Flex direction="column" align="center" gap="2" py="6">
              <Text size="3" weight="medium">No organization selected</Text>
              <Text size="2" align="center" color="gray">
                Choose a ledger from the switcher to manage its organization&apos;s price sync.
              </Text>
            </Flex>
          </Card>
        )}
        <SecuritiesCleanupCard />
      </Flex>
    </PageContainer>
  );
};

export default PriceSyncSettingsPage;
