import React from 'react';
import { Card, Flex, Text, Box } from '@radix-ui/themes';
import { textColorProps } from '../utils/textColor';
import { formatMoney } from '@nuggets/shared';

interface ProgressTowardGoalCardProps {
  targetAmount: number;
  currentSavings: number;
  monthlyBudget: number;
  monthlySpent: number;
  previouslySpent?: number | undefined;
  transfers?: number | undefined;
  expectedTotal?: {
    amount: number;
    date: string;
    status: 'success' | 'warning' | 'danger';
  } | null;
}

const ProgressTowardGoalCard: React.FC<ProgressTowardGoalCardProps> = ({
  targetAmount,
  currentSavings,
  monthlyBudget,
  monthlySpent,
  previouslySpent = 0,
  transfers = 0,
  expectedTotal = null,
}) => {

  const progressPercentage = Math.min(100, Math.max(0, (currentSavings / targetAmount) * 100));
  const remainingAmount = targetAmount - currentSavings;

  return (
    <Card>
      <Flex direction="column" gap="4" p="4">
        <Text size="4" weight="bold">Progress Toward Target</Text>
        
        <Flex direction="column" gap="4">
          {/* Goal Progress */}
          <Flex direction="column" gap="2">
            <Flex justify="between" align="center">
              <Text size="2" weight="medium" color="gray">Target Amount</Text>
              <Text size="2" weight="bold">
                {formatMoney(targetAmount)}
              </Text>
            </Flex>
            
            {/* Expected Total on Next Payment Date */}
            {expectedTotal && (
              <Flex justify="between" align="center">
                <Text size="2" weight="medium" color="gray">
                  Expected Total ({expectedTotal.date})
                </Text>
                <Text
                  size="2"
                  weight="bold"
                  {...textColorProps(
                    expectedTotal.status === 'danger' ? 'red' : expectedTotal.status === 'warning' ? 'yellow' : 'green',
                  )}
                >
                  {formatMoney(expectedTotal.amount)}
                </Text>
              </Flex>
            )}
            
            <Flex justify="between" align="center">
              <Text size="2" weight="medium" color="gray">Current Savings</Text>
              <Text size="2" weight="bold" color="green" highContrast>
                {formatMoney(Math.max(0, currentSavings))}
              </Text>
            </Flex>
            
            {/* Progress Bar */}
            <Box width="100%" height="12px" className="rounded-full bg-[var(--gray-5)]">
              <Box
                height="12px" className="rounded-full transition-all duration-300 bg-[var(--green-9)]"
                style={{
                  width: `${progressPercentage}%`,
                }}
              />
            </Box>
            
            <Flex justify="between" align="center">
              <Text size="1" color="gray">
                {Math.round(progressPercentage)}% Complete
              </Text>
              <Text size="1" color="gray">
                {formatMoney(Math.max(0, remainingAmount))} to go
              </Text>
            </Flex>
          </Flex>
          
          {/* Budget Breakdown */}
          {(previouslySpent > 0 || transfers !== 0) && (
            <Flex direction="column" gap="1" pt="4" className="border-t border-[var(--gray-4)]">
              {previouslySpent > 0 && (
                <Flex justify="between">
                  <Text size="1" color="gray">Previously Spent:</Text>
                  <Text size="1" weight="medium" color="red">
                    -{formatMoney(previouslySpent)}
                  </Text>
                </Flex>
              )}
              {transfers !== 0 && (
                <Flex justify="between">
                  <Text size="1" color="gray">Transfers:</Text>
                  <Text size="1" weight="medium" {...textColorProps(transfers >= 0 ? 'green' : 'red')}>
                    {transfers >= 0 ? '+' : ''}{formatMoney(transfers)}
                  </Text>
                </Flex>
              )}
            </Flex>
          )}
          
          {/* Monthly Budget Info */}
          <Flex direction="column" gap="1" pt="4" className="border-t border-[var(--gray-4)]">
            <Flex justify="between" align="center">
              <Text size="2" color="gray">Monthly Budget</Text>
              <Text size="2" weight="medium">
                {formatMoney(monthlyBudget)}
              </Text>
            </Flex>
            <Flex justify="between" align="center">
              <Text size="2" color="gray">This Month Spent</Text>
              <Text size="2" weight="medium" color="red">
                {formatMoney(monthlySpent)}
              </Text>
            </Flex>
          </Flex>
        </Flex>
      </Flex>
    </Card>
  );
};

export default ProgressTowardGoalCard;
