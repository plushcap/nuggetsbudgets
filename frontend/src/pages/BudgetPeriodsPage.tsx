import React, { useState } from 'react';
import { logger } from '../utils/logger';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Search, Plus, Trash2, Calendar } from 'lucide-react';
import { useConfirmation } from '../hooks/useConfirmation';
import ConfirmationDialog from '../components/ConfirmationDialog';
import SettingsPageHeader from '../components/SettingsPageHeader';
import { toast } from 'react-hot-toast';
import { useBudgetPeriodsManagementQuery, useDeleteBudgetPeriodMutation } from '../hooks/queries';
import type { BudgetPeriodManagement } from '../services/api';
import { calendarMonthKey, formatCalendarDate } from '../utils/dateUtils';
import { Card, Box, Flex, Grid, Text, Button, TextField, IconButton, Table, Badge } from '@radix-ui/themes';
import { apiErrorMessage } from '../utils/errors';
import PageContainer from '../components/PageContainer';

const BudgetPeriodsPage: React.FC = () => {
  const navigate = useNavigate();
  const { confirmAsync, dialogProps } = useConfirmation();
  const { data, isLoading: loading } = useBudgetPeriodsManagementQuery();
  const budgetPeriods = data?.periods ?? [];
  const stats = data?.stats ?? null;
  const deletePeriodMutation = useDeleteBudgetPeriodMutation();
  const [searchTerm, setSearchTerm] = useState('');

  const handleDeletePeriod = async (period: BudgetPeriodManagement) => {
    // An envelope's balance is a running total over the periods up to each one, so a
    // later period's balance includes this one's budgets and spending.
    const hasActivity = Number(period.transaction_count) > 0 || Number(period.budget_transaction_count) > 0;
    const monthOf = (p: BudgetPeriodManagement) => calendarMonthKey(p.start_date) ?? '';
    const laterPeriod = budgetPeriods.some((other) => monthOf(other) > monthOf(period));
    const confirmed = await confirmAsync({
      title: 'Delete Budget Period',
      message: `Delete "${period.name}"?\n\nThis will permanently remove the budget period and all associated budget data.`,
      variant: 'danger',
      confirmText: 'Delete Period',
      cancelText: 'Keep Period',
      icon: <Trash2 size={24} />,
      details: [
        `${period.transaction_count} transactions will be unassociated (not deleted)`,
        `${period.budget_item_count} budget period items will be removed`,
        `${period.budget_transaction_count} budget period transactions will be deleted`,
        ...(hasActivity && laterPeriod
          ? ["Envelope balances in later periods include this period's budgets and spending, so they will change"]
          : []),
        'This action cannot be undone'
      ]
    });

    if (!confirmed) return;

    try {
      await deletePeriodMutation.mutateAsync(period.uuid);
      toast.success(`Budget period "${period.name}" deleted successfully`);
    } catch (error) {
      logger.error({ err: error, periodUuid: period.uuid }, 'Failed to delete budget period');
      toast.error(apiErrorMessage(error, 'Failed to delete budget period'));
    }
  };

  const filteredPeriods = budgetPeriods.filter(period =>
    period.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    period.year.toString().includes(searchTerm)
  );

  // A period's first and last days are calendar dates, not UTC instants.
  const formatDateRange = (startDate: string, endDate: string) =>
    `${formatCalendarDate(startDate)} - ${formatCalendarDate(endDate)}`;

  if (loading) {
    return (
      <PageContainer>
        <Card>
          <Flex justify="center" align="center" py="9">
            <Box height="32px" width="32px" className="animate-spin rounded-full border-b-2 border-[var(--accent-9)]"></Box>
          </Flex>
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Header */}
      <SettingsPageHeader
        title="Budget Periods"
        subtitle="Manage budget periods and timeline structure"
        icon={<RefreshCw size={20} className="text-[var(--accent-11)]" />}
        iconBackground="bg-[var(--accent-3)]"
        backPath="/settings"
        primaryAction={{
          label: 'Add Budget Period',
          onClick: () => navigate('/settings/budget-periods/add'),
          icon: <Plus size={16} />
        }}
      />

      {/* Search and Stats Card */}
      <Card mb="4">
        <Flex direction={{ initial: 'column', sm: 'row' }} align={{ sm: 'center' }} justify="between" gap="4">
          <Box flexGrow="1" maxWidth={{ sm: '28rem' }}>
            <TextField.Root
              aria-label="Search budget periods"
              placeholder="Search budget periods..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              size="3"
              variant="surface"
            >
              <TextField.Slot>
                <Search size={16} />
              </TextField.Slot>
            </TextField.Root>
          </Box>
          <Flex align="center" justify={{ initial: 'between', sm: 'start' }} gap="4">
            <Text size="2" color="gray">
              Total: <Text weight="medium" color="gray" highContrast>{filteredPeriods.length}</Text>
            </Text>
            {stats && (
              <Text size="2" className="text-[var(--accent-11)]" weight="medium">
                {stats.earliest_year} - {stats.latest_year}
              </Text>
            )}
          </Flex>
        </Flex>
      </Card>

      {/* Budget Periods List */}
      {filteredPeriods.length === 0 ? (
        <Card>
          <Flex direction="column" align="center" gap="4" py="9">
            <Calendar size={48} className="text-[var(--gray-6)]" />
            <Flex direction="column" align="center" gap="2">
              <Text size="4" weight="bold" color="gray" highContrast>
                {searchTerm ? 'No matching periods found' : 'No budget periods yet'}
              </Text>
              <Text size="2" color="gray" align="center">
                {searchTerm
                  ? 'Try adjusting your search terms to find what you\'re looking for.'
                  : 'Get started by creating your first budget period.'
                }
              </Text>
            </Flex>
            {!searchTerm && (
              <Button size="3" onClick={() => navigate('/settings/budget-periods/add')}>
                <Plus size={16} />
                Create Budget Period
              </Button>
            )}
          </Flex>
        </Card>
      ) : (
        <>
          {/* Mobile Card View */}
          <Card className="block md:hidden">
            <Flex direction="column" gap="4">
              {filteredPeriods.map((period) => (
                <Card key={period.id} variant="surface">
                  {/* Header */}
                  <Flex align="start" justify="between" mb="3">
                    <Flex direction="column" gap="1" flexGrow="1" minWidth="0">
                      <Text size="3" weight="bold" className="truncate">{period.name}</Text>
                      <Text size="2" color="gray">
                        {period.month_number}/{period.year}
                      </Text>
                    </Flex>
                    <IconButton
                      onClick={() => handleDeletePeriod(period)}
                      color="red"
                      variant="ghost"
                      size="3"
                      aria-label={`Delete ${period.name}`}
                      className="shrink-0"
                    >
                      <Trash2 size={20} />
                    </IconButton>
                  </Flex>

                  {/* Date Range */}
                  <Card variant="surface" mb="3" className="[--card-background-color:var(--gray-3)]">
                    <Flex align="center" gap="2">
                      <Calendar size={16} className="shrink-0 text-[var(--gray-11)]" />
                      <Text size="2" color="gray" className="truncate">
                        {formatDateRange(period.start_date, period.end_date)}
                      </Text>
                    </Flex>
                  </Card>

                  {/* Stats */}
                  <Grid columns="3" gap="2">
                    <Card className="[--card-background-color:var(--blue-3)]" style={{ textAlign: 'center' }}>
                      <Flex direction="column" gap="1">
                        <Text size="1" weight="medium" className="text-[var(--accent-11)]">Transactions</Text>
                        <Text size="4" weight="bold" className="text-[var(--accent-11)]">{period.transaction_count}</Text>
                      </Flex>
                    </Card>
                    <Card className="[--card-background-color:var(--green-3)]" style={{ textAlign: 'center' }}>
                      <Flex direction="column" gap="1">
                        <Text size="1" weight="medium" color="green" highContrast>Items</Text>
                        <Text size="4" weight="bold" color="green" highContrast>{period.budget_item_count}</Text>
                      </Flex>
                    </Card>
                    <Card className="[--card-background-color:var(--purple-3)]" style={{ textAlign: 'center' }}>
                      <Flex direction="column" gap="1">
                        <Text size="1" weight="medium" color="purple">Events</Text>
                        <Text size="4" weight="bold" color="purple">{period.budget_transaction_count}</Text>
                      </Flex>
                    </Card>
                  </Grid>
                </Card>
              ))}
            </Flex>
          </Card>

          {/* Desktop Table View */}
          <Card className="hidden md:block">
            <Table.Root size="2">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Period Name</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Year/Month</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Date Range</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell justify="center">Transactions</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell justify="center">Items</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell justify="center">Events</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell justify="end">Actions</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filteredPeriods.map((period) => (
                  <Table.Row key={period.id}>
                    <Table.Cell>
                      <Flex direction="column" gap="1">
                        <Text size="2" weight="medium">{period.name}</Text>
                        <Text size="1" color="gray">
                          {period.year}-{period.month_number.toString().padStart(2, '0')}
                        </Text>
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="2" color="gray">
                        {period.month_number}/{period.year}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="2" color="gray">
                        {formatDateRange(period.start_date, period.end_date)}
                      </Text>
                    </Table.Cell>
                    <Table.Cell justify="center">
                      <Badge color="blue" variant="soft">
                        {period.transaction_count}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell justify="center">
                      <Badge highContrast color="green" variant="soft">
                        {period.budget_item_count}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell justify="center">
                      <Badge color="purple" variant="soft">
                        {period.budget_transaction_count}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell justify="end">
                      <IconButton
                        onClick={() => handleDeletePeriod(period)}
                        color="red"
                        variant="ghost"
                        size="2"
                        aria-label={`Delete ${period.name}`}
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Card>
        </>
      )}

      <ConfirmationDialog {...dialogProps} />
    </PageContainer>
  );
};

export default BudgetPeriodsPage;
