import React from 'react';
import { Box, Button, Card, Flex, Text } from '@radix-ui/themes';
import { Check, Search } from 'lucide-react';
import type { Merchant } from '../../services/api';
import { useMerchantRuleTest } from '../../hooks/useMerchantRuleTest';
import ConfirmationDialog from '../ConfirmationDialog';
import RuleMatchRow from './RuleMatchRow';

/**
 * The merchant rules page's "Test Rules" card: finds the transactions the rules match that
 * aren't the merchant's yet, and sets the merchant on the ones chosen.
 */
const MerchantRuleTestSection: React.FC<{ merchant: Merchant }> = ({ merchant }) => {
  const test = useMerchantRuleTest(merchant);
  const matches = test.results?.matchingTransactions ?? [];

  return (
    <Card mt="4">
      <Flex direction="column" gap="4">
        <Flex align="center" gap="2">
          <Search size={20} className="text-[var(--gray-11)]" />
          <Text size="5" weight="bold" color="gray" highContrast>
            Test Rules
          </Text>
        </Flex>
        <Text size="2" color="gray">
          Test your rules to find transactions that match but aren't assigned to this merchant yet.
        </Text>

        <Flex direction="column" gap="4">
          <Flex align="center" justify="between" wrap="wrap" gap="3">
            <Button onClick={test.runTest} disabled={test.testing} loading={test.testing} color="blue" size="3">
              <Search size={16} />
              Test Rules
            </Button>

            {matches.length > 0 && (
              <Flex align="center" gap="3">
                <Button variant="ghost" onClick={test.toggleAll} size="2">
                  {test.allSelected ? 'Deselect All' : 'Select All'}
                </Button>
                {test.selected.size > 0 && (
                  <Button onClick={test.applySelected} disabled={test.applying} loading={test.applying} color="green" size="3">
                    <Check size={16} />
                    Apply to {test.selected.size} Selected
                  </Button>
                )}
              </Flex>
            )}
          </Flex>

          {test.results && (
            <Box p="4" className="bg-[var(--gray-2)] rounded-[var(--radius-3)]">
              <Text size="2" color="gray" mb="3">
                {test.results.message} (using {test.results.totalRules} rules)
              </Text>

              {matches.length > 0 ? (
                <Flex direction="column" gap="3">
                  {matches.map((match) => (
                    <RuleMatchRow key={match.id} match={match} selected={test.selected.has(match.id)} onToggle={test.toggle} />
                  ))}
                </Flex>
              ) : (
                <Flex direction="column" align="center" gap="2" py="6">
                  <Search size={32} className="text-[var(--gray-6)]" />
                  <Text size="2" color="gray">
                    No matching transactions found
                  </Text>
                  <Text size="1" color="gray">
                    All transactions may already be assigned to this merchant
                  </Text>
                </Flex>
              )}
            </Box>
          )}
        </Flex>
      </Flex>

      <ConfirmationDialog {...test.confirmationProps} />
    </Card>
  );
};

export default MerchantRuleTestSection;
