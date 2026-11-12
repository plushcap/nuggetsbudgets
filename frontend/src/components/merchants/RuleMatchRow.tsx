import React from 'react';
import { Box, Checkbox, Flex, Text } from '@radix-ui/themes';
import { formatMoney, transactionType } from '@nuggets/shared';
import type { MerchantRuleMatch } from '../../hooks/useMerchantRuleTest';
import { formatCalendarDate } from '../../utils/dateUtils';
import { textColorProps } from '../../utils/textColor';

/** The colour a match's amount and type are shown in. */
const typeColor = (type: string): React.ComponentProps<typeof Text>['color'] => {
  switch (type) {
    case transactionType.enum.income: return 'green';
    case transactionType.enum.expense: return 'red';
    case transactionType.enum.payment: return 'purple';
    case transactionType.enum.transfer: return 'blue';
    default: return 'gray';
  }
};

interface RuleMatchRowProps {
  match: MerchantRuleMatch;
  selected: boolean;
  onToggle: (transactionId: number) => void;
}

/** A transaction the merchant's rules match: what it is, which rule matched, and its checkbox. */
const RuleMatchRow: React.FC<RuleMatchRowProps> = ({ match, selected, onToggle }) => {
  const colour = textColorProps(typeColor(match.type));
  return (
    <Box
      p="4"
      className="hover:border-[var(--gray-7)] transition-colors bg-[var(--color-panel)] border border-[var(--gray-6)] rounded-[var(--radius-2)]"
    >
      <Flex align="center" justify="between">
        <Flex align="center" gap="3">
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggle(match.id)}
            aria-label={`Select ${match.description}`}
          />
          <Flex direction="column" gap="1">
            <Text size="3" weight="medium" color="gray" highContrast>
              {match.description}
            </Text>
            <Text size="2" color="gray">
              {match.account_name} • {formatCalendarDate(match.transaction_date)}
            </Text>
            <Text size="1" className="text-[var(--accent-11)]">
              Matches rule: {match.matchingRule.method} → "{match.matchingRule.matching_text}"
            </Text>
          </Flex>
        </Flex>
        <Flex direction="column" align="end" gap="1">
          <Text size="3" weight="bold" {...colour}>
            {formatMoney(match.amount)}
          </Text>
          <Text size="2" className="capitalize" {...colour}>
            {match.type}
          </Text>
        </Flex>
      </Flex>
    </Box>
  );
};

export default RuleMatchRow;
