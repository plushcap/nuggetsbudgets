import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Target, Plus, Calendar, TrendingUp, Edit2, AlertCircle, BarChart3 } from 'lucide-react';
import { type Goal } from '../services/api';
import { useGoalsQuery } from '../hooks/queries/goals';
import { Card, Flex, Box, Grid, Text, Button, Badge } from '@radix-ui/themes';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import { calendarDaysBetween, formatCalendarDate, todayLocal } from '../utils/dateUtils';
import { BUDGET_ITEM_STATUSES, BUDGET_ITEM_STATUS_LABELS, type BudgetItemStatus, formatMoney, budgetItemStatus } from '@nuggets/shared';
import PageContainer from '../components/PageContainer';

/** The filter's choices: a goal's status (the server's values), or all. */
const STATUS_FILTERS: (BudgetItemStatus | 'all')[] = ['all', ...BUDGET_ITEM_STATUSES];

const GoalsPage: React.FC = () => {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<BudgetItemStatus | 'all'>('active');
  const { data, isLoading: loading } = useGoalsQuery();
  const allGoals = data?.goals ?? [];
  // Filter by status on the client (load errors surface via the global toast).
  const goals = statusFilter === 'all'
    ? allGoals
    : allGoals.filter(g => g.status === statusFilter);

  // null for a goal with no target (one made as a budget item): it has no share.
  const calculateProgress = (goal: Goal): number | null => {
    if (goal.target_amount == null) return null;
    if (goal.target_amount <= 0) return 0;
    const current = goal.current_progress || 0;
    return Math.min((current / goal.target_amount) * 100, 100);
  };

  const getStatusColor = (status: string): 'green' | 'blue' | 'yellow' | 'gray' => {
    switch (status) {
      case budgetItemStatus.enum.active:
        return 'green';
      case budgetItemStatus.enum.completed:
        return 'blue';
      case budgetItemStatus.enum.paused:
        return 'yellow';
      case budgetItemStatus.enum.archived:
        return 'gray';
      default:
        return 'gray';
    }
  };


  // target_date is a calendar day: show it and count to it as one, not as a UTC instant.
  const formatDate = (dateString: string): string =>
    formatCalendarDate(dateString, 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  // Calendar days from today to the target: 0 on the day itself, negative once past.
  const getDaysRemaining = (targetDate: string): number => calendarDaysBetween(todayLocal(), targetDate);

  const filteredGoals = goals;

  if (loading) {
    return (
      <PageContainer>
        <PageLoader label="Loading goals…" />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Financial Goals"
        icon={<Target size={20} />}
        actions={
          <Button onClick={() => navigate('/goals/add')} className="flex-1 sm:flex-initial">
            <Plus size={16} />
            Add Goal
          </Button>
        }
      >
        {/* Status Filter and Stats */}
        <Card>
          <Flex direction={{ initial: 'column', sm: 'row' }} align={{ sm: 'center' }} justify="between" gap="4">
            <Flex align="center" gap="2">
              <Text size="2" weight="medium" color="gray">Filter:</Text>
              <Flex gap="2" wrap="wrap">
                {STATUS_FILTERS.map((status) => (
                  <Button
                    key={status}
                    onClick={() => setStatusFilter(status)}
                    variant={statusFilter === status ? 'solid' : 'soft'}
                    size="1"
                  >
                    {status === 'all' ? 'All' : BUDGET_ITEM_STATUS_LABELS[status]}
                  </Button>
                ))}
              </Flex>
            </Flex>
            <Flex align="center" gap="4">
              <Text size="2" color="gray">Total Goals: {goals.length}</Text>
              <Text size="2" className="text-[var(--green-12)]">
                Active: {goals.filter(g => g.status === budgetItemStatus.enum.active).length}
              </Text>
            </Flex>
          </Flex>
        </Card>
      </PageHeader>

      {/* Goals Grid */}
      {filteredGoals.length === 0 ? (
        <Card>
          <Flex direction="column" align="center" gap="2" py="9" px="4">
            <Target size={64} className="text-[var(--gray-6)]" />
            <Text size="4" weight="bold">
              No goals found
            </Text>
            <Text size="2" color="gray" mb="4">
              Start tracking your financial goals by creating your first goal.
            </Text>
            <Button onClick={() => navigate('/goals/add')}>
              <Plus size={16} />
              Create Your First Goal
            </Button>
          </Flex>
        </Card>
      ) : (
        <Grid columns={{ initial: '1', md: '2', lg: '3', xl: '4' }} gap="6">
          {filteredGoals.map((goal) => {
            const progress = calculateProgress(goal);
            // A goal with no target date has no days left and is never overdue.
            const daysRemaining = goal.target_date == null ? null : getDaysRemaining(goal.target_date);
            const isOverdue = daysRemaining != null && daysRemaining < 0;
            const isNearTarget = daysRemaining != null && daysRemaining > 0 && daysRemaining <= 30;

            return (
              <Card
                key={goal.uuid}
                className="overflow-hidden hover:shadow-lg transition-shadow"
              >
                {/* Goal Image */}
                {goal.image_path ? (
                  <Box height="192px" overflow="hidden" className="bg-[var(--gray-3)]">
                    <Box asChild width="100%" height="100%"><img
                      src={goal.image_path}
                      alt={goal.name}
                      className="object-cover"
                    /></Box>
                  </Box>
                ) : (
                  <Flex align="center" justify="center" height="192px" className="bg-linear-to-br from-[var(--accent-3)] to-[var(--accent-5)]">
                    <Target size={64} className="text-[var(--accent-7)]" />
                  </Flex>
                )}

                {/* Goal Content */}
                <Box p="6">
                  {/* Header with Status */}
                  <Flex align="start" justify="between" mb="3">
                    <Text size="4" weight="bold" mr="2" className="flex-1">
                      {goal.name}
                    </Text>
                    <Badge color={getStatusColor(goal.status)} size="1">
                      {goal.status}
                    </Badge>
                  </Flex>

                  {/* Description */}
                  {goal.description && (
                    <Text size="2" color="gray" mb="4" className="line-clamp-2" as="p">
                      {goal.description}
                    </Text>
                  )}

                  {/* Progress Bar */}
                  <Box mb="4">
                    <Flex align="center" justify="between" mb="2">
                      <Text size="2" weight="medium" color="gray">Progress</Text>
                      <Text size="2" weight="bold">
                        {progress == null ? 'No target' : `${progress.toFixed(1)}%`}
                      </Text>
                    </Flex>
                    <Box width="100%" height="12px" overflow="hidden" className="bg-[var(--gray-4)] rounded-full">
                      {progress != null && (
                        <Box
                          height="100%"
                          className={`transition-all duration-500 ${
                            progress >= 100
                              ? 'bg-[var(--green-9)]'
                              : progress >= 75
                              ? 'bg-[var(--accent-9)]'
                              : progress >= 50
                              ? 'bg-[var(--yellow-9)]'
                              : 'bg-[var(--orange-9)]'
                          }`}
                          style={{ width: `${Math.min(progress, 100)}%` }}
                        ></Box>
                      )}
                    </Box>
                  </Box>

                  {/* Amount Details */}
                  <Flex align="center" justify="between" mb="4">
                    <Box>
                      <Text size="2" color="gray" as="div">Current</Text>
                      <Text size="2" weight="bold">
                        {formatMoney(goal.current_progress || 0)}
                      </Text>
                    </Box>
                    <Box style={{ textAlign: 'right' }}>
                      <Text size="2" color="gray" as="div">Target</Text>
                      <Text size="2" weight="bold">
                        {goal.target_amount == null ? 'None' : formatMoney(goal.target_amount)}
                      </Text>
                    </Box>
                  </Flex>

                  {/* Target Date */}
                  <Flex align="center" gap="2" mb="4" p="3" className={`rounded-[var(--radius-4)] ${
                    isOverdue
                      ? 'bg-[var(--red-3)] text-[var(--red-11)]'
                      : isNearTarget
                      ? 'bg-[var(--yellow-3)] text-[var(--yellow-12)]'
                      : 'bg-[var(--gray-3)] text-[var(--gray-11)]'
                  }`}>
                    <Calendar size={16} />
                    <Box flexGrow="1">
                      <Text size="1" as="div">Target Date</Text>
                      <Text size="2" weight="bold">{goal.target_date == null ? 'None' : formatDate(goal.target_date)}</Text>
                    </Box>
                    {daysRemaining == null ? null : isOverdue ? (
                      <Box style={{ textAlign: 'right' }}>
                        <AlertCircle size={20} />
                        <Text size="1" weight="bold" as="div">Overdue</Text>
                      </Box>
                    ) : (
                      <Box style={{ textAlign: 'right' }}>
                        <Text size="1" as="div">Days Left</Text>
                        <Text size="2" weight="bold">{daysRemaining}</Text>
                      </Box>
                    )}
                  </Flex>

                  {/* Estimated Contribution */}
                  {goal.estimated_monthly_contribution != null && goal.estimated_monthly_contribution > 0 && (
                    <Flex align="center" gap="2" mb="4">
                      <TrendingUp size={16} className="text-[var(--gray-11)]" />
                      <Text size="2" color="gray">
                        Monthly: {formatMoney(goal.estimated_monthly_contribution)}
                      </Text>
                    </Flex>
                  )}

                  {/* Action Buttons */}
                  <Flex gap="2" pt="4" className="border-t border-[var(--gray-6)]">
                    <Button
                      onClick={() => navigate(`/goals/${goal.uuid}/view`)}
                      variant="soft"
                      className="flex-1"
                    >
                      <BarChart3 size={16} />
                      Details
                    </Button>
                    <Button
                      onClick={() => navigate(`/goals/${goal.uuid}/edit`)}
                      variant="soft"
                      className="flex-1"
                    >
                      <Edit2 size={16} />
                      Edit
                    </Button>
                  </Flex>
                </Box>
              </Card>
            );
          })}
        </Grid>
      )}
    </PageContainer>
  );
};

export default GoalsPage;
