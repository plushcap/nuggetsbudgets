import React from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import { Account, BudgetPeriod, ZeroBalanceAccount, ZeroBalanceSummary } from '../../services/api';
import ZeroBalanceAccountCard from './ZeroBalanceAccountCard';
import { CARD_CORNERS } from './cardCorners';
import InfoPopover from '../InfoPopover';
import { Box, Card, Flex, Grid, Text, Button } from '@radix-ui/themes';

interface ZeroBalanceAccountsSectionProps {
  accounts: ZeroBalanceAccount[];
  summary: ZeroBalanceSummary;
  periodId: string;
  isLoading?: boolean;
  /** Full account rows (for resolving id/type/default-pay-from when building a transfer). */
  fullAccounts: Account[];
  budgetPeriods: BudgetPeriod[];
}

/** The section's title and its tip, in every state (the loading and empty states had a bare icon). */
const Section: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Flex direction="column" gap="4">
    <Flex align="center" gap="2">
      <Text size="5" weight="bold" className="text-[var(--gray-12)]">
        Zero-Balance Accounts
      </Text>
      <InfoPopover label="About zero-balance accounts">
        Accounts configured to require a zero balance at month-end for reconciliation tracking.
      </InfoPopover>
    </Flex>
    {children}
  </Flex>
);

/**
 * The account cards: one column, two from 768px, three from 1024px (Radix's sm and md, the
 * Tailwind md and lg it had: index.css).
 */
const CardGrid: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Grid columns={{ initial: '1', sm: '2', md: '3' }} gap="4">{children}</Grid>
);

const ZeroBalanceAccountsSection: React.FC<ZeroBalanceAccountsSectionProps> = ({
  accounts,
  periodId,
  isLoading = false,
  fullAccounts,
  budgetPeriods,
}) => {
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <Section>
        <Card size="3" className={`animate-pulse ${CARD_CORNERS}`}>
          <Box height="5rem" className="bg-[var(--gray-3)] rounded-[var(--radius-2)]" />
        </Card>
        <CardGrid>
          {[1, 2, 3].map((i) => (
            <Card key={i} size="2" className="animate-pulse">
              <Box height="8rem" className="bg-[var(--gray-3)] rounded-[var(--radius-2)]" />
            </Card>
          ))}
        </CardGrid>
      </Section>
    );
  }

  if (accounts.length === 0) {
    return (
      <Section>
        <Card size="5" className={CARD_CORNERS}>
          <Flex direction="column" align="center" className="text-center">
            <BarChart3 size={64} className="text-[var(--gray-11)]" aria-hidden="true" />
            <Text as="p" size="4" weight="medium" mt="4" mb="2" className="text-[var(--gray-12)]">
              No accounts configured for zero-balance verification
            </Text>
            <Text as="p" size="2" className="text-[var(--gray-11)]">
              Configure accounts that should have a zero balance at month-end to track and verify them here.
            </Text>
            <Box mt="5">
              <Button onClick={() => navigate('/accounts')}>
                Configure Accounts
              </Button>
            </Box>
          </Flex>
        </Card>
      </Section>
    );
  }

  return (
    <Section>
      <CardGrid>
        {accounts.map((account) => (
          <ZeroBalanceAccountCard
            key={account.uuid}
            account={account}
            periodId={periodId}
            fullAccounts={fullAccounts}
            budgetPeriods={budgetPeriods}
          />
        ))}
      </CardGrid>
    </Section>
  );
};

export default ZeroBalanceAccountsSection;
