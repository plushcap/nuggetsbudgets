import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Wallet, Plus, ArrowRight, Building2 } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { Card, Flex, Box, Heading, Text, Button, TextField, Select, Separator } from '@radix-ui/themes';
import FormSelectRoot from './forms/FormSelectRoot';
import { useAuth } from '../contexts/AuthContext';
import { createOrgBudget } from '../services/api';
import { logger } from '../utils/logger';
import PageContainer from './PageContainer';
import PageLoader from './PageLoader';

/**
 * Shown by {@link RequireLedger} when the user has no active ledger. Adapts to who
 * they are (issue: no-ledger UX):
 *  - exactly one accessible ledger → select it automatically;
 *  - several → a picker (grouped by organization);
 *  - none, and they can administer an org → create their first ledger inline;
 *  - none, deployment admin without an org → point them at the Organizations console;
 *  - none, not an admin → tell them to ask an admin (the only real recovery path).
 */
const LedgerSelectionScreen: React.FC = () => {
  const { tenants, organizations, isDeploymentAdmin, switchTenant } = useAuth();

  const adminOrgs = useMemo(() => organizations.filter((o) => o.role === 'admin'), [organizations]);
  const [orgUuid, setOrgUuid] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // A lone accessible ledger that wasn't auto-selected server-side (e.g. one the
  // user can see via org-admin but isn't a direct member of): just open it.
  const onlyTenantUuid = tenants.length === 1 ? (tenants[0]?.uuid ?? null) : null;
  useEffect(() => {
    if (onlyTenantUuid) void switchTenant(onlyTenantUuid);
  }, [onlyTenantUuid, switchTenant]);

  // ----- exactly one ledger: auto-selecting -----
  if (tenants.length === 1) {
    return <PageLoader label="Opening your ledger…" />;
  }

  // ----- several ledgers: pick one -----
  if (tenants.length >= 2) {
    const groups = new Map<string, { orgName: string; items: typeof tenants }>();
    for (const t of tenants) {
      const g = groups.get(t.organizationUuid) ?? { orgName: t.organizationName, items: [] };
      g.items.push(t);
      groups.set(t.organizationUuid, g);
    }
    return (
      <PageContainer width="auth">
        <Flex direction="column" align="center" gap="2" mt="6" mb="5">
          <Wallet size={32} className="text-[var(--accent-11)]" />
          <Heading size="6" align="center">Choose a ledger</Heading>
          <Text size="2" align="center" className="text-[var(--gray-11)]">
            Pick which ledger you want to work in. You can switch anytime from the header.
          </Text>
        </Flex>
        <Flex direction="column" gap="4">
          {[...groups.values()].map((group) => (
            <Box key={group.orgName}>
              <Text size="1" weight="medium" className="text-[var(--gray-11)]">{group.orgName}</Text>
              <Flex direction="column" gap="2" mt="2">
                {group.items.map((t) => (
                  <Button
                    key={t.uuid}
                    variant="surface"
                    size="3"
                    onClick={() => void switchTenant(t.uuid)}
                    style={{ justifyContent: 'space-between' }}
                  >
                    <Flex align="center" gap="2">
                      <Wallet size={16} />
                      <Text>{t.name}</Text>
                    </Flex>
                    <ArrowRight size={16} />
                  </Button>
                ))}
              </Flex>
            </Box>
          ))}
        </Flex>
      </PageContainer>
    );
  }

  // ----- no ledgers -----
  const canCreate = adminOrgs.length > 0;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetOrg = orgUuid || adminOrgs[0]?.uuid;
    const trimmed = name.trim();
    if (!targetOrg) return;
    if (!trimmed) {
      toast.error('Enter a name for the ledger');
      return;
    }
    setSubmitting(true);
    try {
      const { uuid } = await createOrgBudget(targetOrg, trimmed);
      // Switching invalidates every query (incl. the membership summary), so the
      // gate re-renders with the new active ledger and unmounts this screen.
      await switchTenant(uuid);
    } catch (err) {
      logger.error({ err }, 'Failed to create first ledger');
      toast.error(err instanceof Error ? err.message : 'Could not create the ledger');
      setSubmitting(false);
    }
  };

  if (canCreate) {
    return (
      <PageContainer width="auth">
        <Flex direction="column" align="center" gap="2" mt="6" mb="5">
          <Plus size={32} className="text-[var(--accent-11)]" />
          <Heading size="6" align="center">Create your first ledger</Heading>
          <Text size="2" align="center" className="text-[var(--gray-11)]">
            A ledger holds one shared set of accounts, transactions, and budgets.
          </Text>
        </Flex>
        <Card>
          <Flex asChild direction="column" gap="4">
            <form onSubmit={handleCreate}>
              {adminOrgs.length > 1 && (
                <Box>
                  <Text as="label" htmlFor="ledger-organization" size="2" weight="medium" mb="1" style={{ display: 'block' }}>
                    Organization
                  </Text>
                  <FormSelectRoot value={orgUuid || adminOrgs[0]?.uuid || ''} onValueChange={setOrgUuid}>
                    <Select.Trigger id="ledger-organization" placeholder="Select an organization" style={{ width: '100%' }} />
                    <Select.Content>
                      {adminOrgs.map((o) => (
                        <Select.Item key={o.uuid} value={o.uuid}>{o.name}</Select.Item>
                      ))}
                    </Select.Content>
                  </FormSelectRoot>
                </Box>
              )}
              <Box>
                <Text as="label" size="2" weight="medium" mb="1" htmlFor="ledger-name" style={{ display: 'block' }}>
                  Ledger name
                </Text>
                <TextField.Root
                  id="ledger-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Household"
                  maxLength={100}
                />
              </Box>
              <Button type="submit" size="3" disabled={submitting} loading={submitting}>
                Create ledger
              </Button>
            </form>
          </Flex>
        </Card>
      </PageContainer>
    );
  }

  // Deployment admin with no organization yet → must create an org first.
  if (isDeploymentAdmin) {
    return (
      <PageContainer width="auth">
        <Flex direction="column" align="center" gap="3" mt="6">
          <Building2 size={32} className="text-[var(--accent-11)]" />
          <Heading size="6" align="center">No ledgers yet</Heading>
          <Text size="2" align="center" className="text-[var(--gray-11)]">
            Create an organization, then add a ledger to it, from the Organizations console.
          </Text>
          <Button asChild size="3" mt="2">
            <Link to="/settings/organizations">
              Open Organizations console
              <ArrowRight size={16} />
            </Link>
          </Button>
        </Flex>
      </PageContainer>
    );
  }

  // Non-admin with no ledger access → only an admin can fix this.
  return (
    <PageContainer width="auth">
      <Flex direction="column" align="center" gap="3" mt="6">
        <Wallet size={32} className="text-[var(--gray-11)]" />
        <Heading size="6" align="center">No ledger yet</Heading>
        <Text size="2" align="center" className="text-[var(--gray-11)]">
          You&apos;re not a member of any ledger. Ask an administrator to add you to one — it&apos;ll
          appear here as soon as they do.
        </Text>
        <Separator size="4" my="2" />
        <Text size="1" align="center" className="text-[var(--gray-11)]">
          Signed in but stuck? You can still update your profile from the menu.
        </Text>
      </Flex>
    </PageContainer>
  );
};

export default LedgerSelectionScreen;
