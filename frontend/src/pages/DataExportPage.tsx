import React, { useState, useMemo } from 'react';
import { Download } from 'lucide-react';
import { Button, Card, Flex, Grid, Box, Text, TextField, Select, Separator } from '@radix-ui/themes';
import { exportTransactions, exportAccountTransactions, exportBudgetItems, exportAccounts, getBudgetPeriodItems } from '../services/api';
import type { BudgetPeriodItem } from '../services/api';
import { useAccountsQuery, useBudgetPeriodsQuery } from '../hooks/queries';
import { toast } from 'react-hot-toast';
import { logger } from '../utils/logger';
import { todayLocal } from '../utils/dateUtils';
import PageHeader from '../components/PageHeader';
import { periodsNewestFirst } from '../utils/budgetPeriods';
import { escapeCsvValue } from '@nuggets/shared';
import { saveBlob } from '../utils/saveBlob';
import PageContainer from '../components/PageContainer';

const DataExportPage: React.FC = () => {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isExporting, setIsExporting] = useState(false);

  // Account export state
  const { data: allAccounts = [] } = useAccountsQuery();
  const accounts = useMemo(() => allAccounts.filter(a => !a.hide_account && !a.close_account), [allAccounts]);
  const [selectedAccountUuid, setSelectedAccountUuid] = useState<string>('');
  const [accountStartDate, setAccountStartDate] = useState('');
  const [accountEndDate, setAccountEndDate] = useState('');
  const [isExportingAccount, setIsExportingAccount] = useState(false);

  // Budget export state
  const { data: budgetPeriods = [] } = useBudgetPeriodsQuery();
  const [selectedBudgetPeriodUuid, setSelectedBudgetPeriodUuid] = useState<string | null>(null);
  const [isExportingBudget, setIsExportingBudget] = useState(false);

  // Budget items list export state
  const [isExportingBudgetItems, setIsExportingBudgetItems] = useState(false);

  // Accounts list export state
  const [isExportingAccountsList, setIsExportingAccountsList] = useState(false);

  const handleExportTransactions = async () => {
    if (startDate && endDate && startDate > endDate) {
      toast.error('Start date must be before or equal to end date');
      return;
    }

    setIsExporting(true);
    try {
      const params = {
        ...(startDate && { start_date: startDate }),
        ...(endDate && { end_date: endDate }),
      };

      const blob = await exportTransactions(params);
      const dateRangeStr = startDate || endDate
        ? `_${startDate || 'all'}_to_${endDate || 'all'}`
        : '_all';
      saveBlob(blob, `transactions${dateRangeStr}_${todayLocal()}.csv`);

      toast.success('Transaction export completed successfully');
    } catch (error) {
      logger.error({ err: error, startDate, endDate }, 'Error exporting transactions');
      toast.error('Failed to export transactions');
    } finally {
      setIsExporting(false);
    }
  };

  const handleClearDates = () => {
    setStartDate('');
    setEndDate('');
  };

  const handleExportAccountTransactions = async () => {
    if (!selectedAccountUuid) {
      toast.error('Please select an account');
      return;
    }

    if (accountStartDate && accountEndDate && accountStartDate > accountEndDate) {
      toast.error('Start date must be before or equal to end date');
      return;
    }

    setIsExportingAccount(true);
    try {
      const params = {
        ...(accountStartDate && { start_date: accountStartDate }),
        ...(accountEndDate && { end_date: accountEndDate }),
      };

      const blob = await exportAccountTransactions(selectedAccountUuid, params);
      const selectedAccount = accounts.find(a => a.uuid === selectedAccountUuid);
      const accountNameClean = selectedAccount?.name.replace(/[^a-zA-Z0-9]/g, '_') || 'account';
      const dateRangeStr = accountStartDate || accountEndDate
        ? `_${accountStartDate || 'all'}_to_${accountEndDate || 'all'}`
        : '_all';
      saveBlob(blob, `${accountNameClean}_transactions${dateRangeStr}_${todayLocal()}.csv`);

      toast.success('Account transaction export completed successfully');
    } catch (error) {
      logger.error({ err: error, selectedAccountUuid, accountStartDate, accountEndDate }, 'Error exporting account transactions');
      toast.error('Failed to export account transactions');
    } finally {
      setIsExportingAccount(false);
    }
  };

  const handleClearAccountDates = () => {
    setAccountStartDate('');
    setAccountEndDate('');
  };

  const handleExportBudget = async () => {
    if (!selectedBudgetPeriodUuid) {
      toast.error('Please select a budget period');
      return;
    }

    setIsExportingBudget(true);
    try {
      // Fetch budget period items using existing API
      const response = await getBudgetPeriodItems(selectedBudgetPeriodUuid);
      
      if (!response || !response.success || !Array.isArray(response.data)) {
        toast.error('Failed to load budget data');
        return;
      }

      const items: BudgetPeriodItem[] = response.data;
      
      // Find the selected period for filename
      const selectedPeriod = budgetPeriods.find(p => p.uuid === selectedBudgetPeriodUuid);
      const periodName = selectedPeriod 
        ? `${selectedPeriod.year}-${selectedPeriod.month_number.toString().padStart(2, '0')}`
        : 'budget';

      // Create CSV with all budget items
      const headers = ['Budget Item', 'Type', 'Subtype', 'Priority', 'Expense Type', 'Starting', 'Budget', 'Actual', 'Transfers', 'Remaining', 'Percentage'];
      const rows: string[][] = [];

      // Sort items by budget item name
      items.sort((a, b) => a.budget_item_name.localeCompare(b.budget_item_name)).forEach(item => {
        const starting = Number(item.starting) || 0;
        const budget = Number(item.calculated_budget) || 0;
        const actual = Number(item.calculated_actual) || 0;
        const transfers = Number(item.calculated_transfers) || 0;
        const remaining = Number(item.calculated_remaining) || 0;
        
        const percentage = budget > 0 
          ? ((actual / budget) * 100).toFixed(1) 
          : '0.0';
        rows.push([
          item.budget_item_name || '',
          item.type || '',
          item.subtype || '',
          item.priority || '',
          item.expense_type || '',
          starting.toFixed(2),
          budget.toFixed(2),
          actual.toFixed(2),
          transfers.toFixed(2),
          remaining.toFixed(2),
          percentage + '%'
        ]);
      });

      const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(escapeCsvValue).join(','))
      ].join('\n');

      saveBlob(new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }), `budget_${periodName}_${todayLocal()}.csv`);

      toast.success('Budget export completed successfully');
    } catch (error) {
      logger.error({ err: error, selectedBudgetPeriodUuid }, 'Error exporting budget');
      toast.error('Failed to export budget');
    } finally {
      setIsExportingBudget(false);
    }
  };

  const handleExportBudgetItems = async () => {
    setIsExportingBudgetItems(true);
    try {
      saveBlob(await exportBudgetItems(), `budget_items_${todayLocal()}.csv`);

      toast.success('Budget items export completed successfully');
    } catch (error) {
      logger.error({ err: error }, 'Error exporting budget items');
      toast.error('Failed to export budget items');
    } finally {
      setIsExportingBudgetItems(false);
    }
  };

  const handleExportAccountsList = async () => {
    setIsExportingAccountsList(true);
    try {
      saveBlob(await exportAccounts(), `accounts_${todayLocal()}.csv`);

      toast.success('Accounts list export completed successfully');
    } catch (error) {
      logger.error({ err: error }, 'Error exporting accounts list');
      toast.error('Failed to export accounts list');
    } finally {
      setIsExportingAccountsList(false);
    }
  };

  return (
    <PageContainer width="form">
      <PageHeader
        title="Data Export"
        subtitle="Export your financial data to CSV files with human-readable formats. All exports include related data (merchant names, budget items, tags, etc.) instead of internal IDs."
      />

      <Flex direction="column" gap="6">
        {/* Transaction Export Section */}
        <Card>
          <Flex direction="column" gap="4">
            <Flex align="center" gap="3">
              <Download size={24} className="text-[var(--accent-11)]" />
              <Box>
                <Text size="5" weight="bold" as="div" className="text-[var(--gray-12)]">
                  Export Transactions
                </Text>
                <Text size="2" as="p" className="text-[var(--gray-11)]">
                  Export transaction data with merchant names, budget items, tags, and more
                </Text>
              </Box>
            </Flex>

            {/* Date Range Inputs */}
            <Grid columns={{ initial: '1', md: '2' }} gap="4">
              <Flex direction="column" gap="2">
                <Text as="label" htmlFor="export-tx-start" size="2" weight="medium">
                  Start Date (Optional)
                </Text>
                <TextField.Root
                  id="export-tx-start"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  placeholder="Leave empty for all"
                  size="3"
                />
              </Flex>

              <Flex direction="column" gap="2">
                <Text as="label" htmlFor="export-tx-end" size="2" weight="medium">
                  End Date (Optional)
                </Text>
                <TextField.Root
                  id="export-tx-end"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  placeholder="Leave empty for all"
                  size="3"
                />
              </Flex>
            </Grid>

            {/* Info Message */}
            <Box p="3" className="bg-[var(--blue-3)] border border-[var(--blue-6)] rounded-[var(--radius-3)]">
              <Text size="2" className="text-[var(--gray-12)]">
                {startDate || endDate ? (
                  <>
                    <strong>Date Range:</strong> {startDate || 'Beginning'} to {endDate || 'Present'}
                  </>
                ) : (
                  <>
                    <strong>All Transactions:</strong> Leave dates empty to export all transactions
                  </>
                )}
              </Text>
            </Box>

            {/* Export Columns Info */}
            <Box>
              <Text size="2" weight="medium" as="div" mb="2" className="text-[var(--gray-12)]">
                Exported Columns:
              </Text>
              <Text size="1" className="text-[var(--gray-11)]">
                UUID, Date, Description, Merchant Name, Amount, Type, Account Name, 
                Budget Period, Budget Item, Assigned To, Tags, Status, Review Status, Notes, 
                Pending, Import Description, Import Posted Date, Import Transaction Time, 
                Import Provider, Import Transaction ID, Import Date, Created At, Updated At
              </Text>
            </Box>

            {/* Action Buttons */}
            <Flex gap="3" justify="end">
              <Button
                variant="soft"
                color="gray"
                onClick={handleClearDates}
                disabled={!startDate && !endDate}
              >
                Clear Dates
              </Button>
              <Button
                onClick={handleExportTransactions}
                disabled={isExporting}
              >
                <Download size={16} />
                {isExporting ? 'Exporting...' : 'Export to CSV'}
              </Button>
            </Flex>
          </Flex>
        </Card>

        {/* Account Transaction Export Section */}
        <Card>
          <Flex direction="column" gap="4">
            <Flex align="center" gap="3">
              <Download size={24} className="text-[var(--green-12)]" />
              <Box>
                <Text size="5" weight="bold" as="div" className="text-[var(--gray-12)]">
                  Export Account Transactions
                </Text>
                <Text size="2" as="p" className="text-[var(--gray-11)]">
                  Export transactions for a specific account with running balance
                </Text>
              </Box>
            </Flex>

            {/* Account Selection */}
            <Flex direction="column" gap="2">
              <Text as="label" htmlFor="export-account" size="2" weight="medium">
                Select Account
              </Text>
              <Select.Root value={selectedAccountUuid} onValueChange={setSelectedAccountUuid}>
                <Select.Trigger id="export-account" placeholder="Choose an account..." />
                <Select.Content>
                  {accounts.map(account => (
                    <Select.Item key={account.uuid} value={account.uuid}>
                      {account.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Flex>

            {/* Date Range Inputs */}
            <Grid columns={{ initial: '1', md: '2' }} gap="4">
              <Flex direction="column" gap="2">
                <Text as="label" htmlFor="export-account-start" size="2" weight="medium">
                  Start Date (Optional)
                </Text>
                <TextField.Root
                  id="export-account-start"
                  type="date"
                  value={accountStartDate}
                  onChange={(e) => setAccountStartDate(e.target.value)}
                  placeholder="Leave empty for all"
                  size="3"
                />
              </Flex>

              <Flex direction="column" gap="2">
                <Text as="label" htmlFor="export-account-end" size="2" weight="medium">
                  End Date (Optional)
                </Text>
                <TextField.Root
                  id="export-account-end"
                  type="date"
                  value={accountEndDate}
                  onChange={(e) => setAccountEndDate(e.target.value)}
                  placeholder="Leave empty for all"
                  size="3"
                />
              </Flex>
            </Grid>

            {/* Info Message */}
            <Box p="3" className="bg-[var(--green-3)] border border-[var(--green-6)] rounded-[var(--radius-3)]">
              <Text size="2" className="text-[var(--gray-12)]">
                {accountStartDate || accountEndDate ? (
                  <>
                    <strong>Date Range:</strong> {accountStartDate || 'Beginning'} to {accountEndDate || 'Present'}
                  </>
                ) : (
                  <>
                    <strong>All Transactions:</strong> Leave dates empty to export all transactions
                  </>
                )}
              </Text>
            </Box>

            {/* Export Columns Info */}
            <Box>
              <Text size="2" weight="medium" as="div" mb="2" className="text-[var(--gray-12)]">
                Exported Columns:
              </Text>
              <Text size="1" className="text-[var(--gray-11)]">
                UUID, Date, Description, Merchant Name, Amount, <strong>Running Balance</strong>, Type,
                Budget Period, Budget Item, Assigned To, Tags, Status, Review Status, Notes, 
                Pending, Import Description, Import Posted Date, Import Transaction Time, 
                Import Provider, Import Transaction ID, Import Date, Created At, Updated At
              </Text>
            </Box>

            {/* Action Buttons */}
            <Flex gap="3" justify="end">
              <Button
                variant="soft"
                color="gray"
                onClick={handleClearAccountDates}
                disabled={!accountStartDate && !accountEndDate}
              >
                Clear Dates
              </Button>
              <Button
                color="green"
                onClick={handleExportAccountTransactions}
                disabled={isExportingAccount || !selectedAccountUuid}
              >
                <Download size={16} />
                {isExportingAccount ? 'Exporting...' : 'Export to CSV'}
              </Button>
            </Flex>
          </Flex>
        </Card>

        {/* Budget Export Section */}
        <Card>
          <Flex direction="column" gap="4">
            <Flex align="center" gap="3">
              <Download size={24} className="text-[var(--purple-11)]" />
              <Box>
                <Text size="5" weight="bold" as="div" className="text-[var(--gray-12)]">
                  Export Budget Period
                </Text>
                <Text size="2" as="p" className="text-[var(--gray-11)]">
                  Export budget period data grouped by categories with budget, actual, and remaining amounts
                </Text>
              </Box>
            </Flex>

            <Separator size="4" />

            {/* Budget Period Selector */}
            <Flex direction="column" gap="2">
              <Text as="label" htmlFor="export-budget-period" size="2" weight="medium">
                Select Budget Period
              </Text>
              <Select.Root value={selectedBudgetPeriodUuid || 'null'} onValueChange={(value) => setSelectedBudgetPeriodUuid(value === 'null' ? null : value)}>
                <Select.Trigger id="export-budget-period" placeholder="Choose a budget period..." />
                <Select.Content>
                  <Select.Item value="null">No budget period</Select.Item>
                  {periodsNewestFirst(budgetPeriods).map(period => (
                    <Select.Item key={period.uuid} value={period.uuid}>
                      {period.year}-{period.month_number.toString().padStart(2, '0')} ({period.status})
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Flex>

            {/* Info Message */}
            <Box p="3" className="bg-[var(--purple-3)] border border-[var(--purple-6)] rounded-[var(--radius-3)]">
              <Text size="2" className="text-[var(--gray-12)]">
                <strong>Export Format:</strong> All budget items with detailed columns for type, priority, and financial amounts
              </Text>
            </Box>

            {/* Export Columns Info */}
            <Box>
              <Text size="2" weight="medium" as="div" mb="2" className="text-[var(--gray-12)]">
                Exported Columns:
              </Text>
              <Text size="1" className="text-[var(--gray-11)]">
                Budget Item, Type, Subtype, Priority, Expense Type, Starting, Budget, Actual, Transfers, Remaining, Percentage
              </Text>
            </Box>

            {/* Action Button */}
            <Flex gap="3" justify="end">
              <Button
                color="purple"
                onClick={handleExportBudget}
                disabled={isExportingBudget || !selectedBudgetPeriodUuid}
              >
                <Download size={16} />
                {isExportingBudget ? 'Exporting...' : 'Export to CSV'}
              </Button>
            </Flex>
          </Flex>
        </Card>

        {/* Budget Items List Export */}
        <Card>
          <Flex direction="column" gap="4">
            <Flex align="center" gap="3">
              <Download size={24} className="text-[var(--orange-12)]" />
              <Box>
                <Text size="5" weight="bold" as="div" className="text-[var(--gray-12)]">
                  Export Budget Items List
                </Text>
                <Text size="2" as="p" className="text-[var(--gray-11)]">
                  Export all budget items with names and UUIDs for import mapping
                </Text>
              </Box>
            </Flex>

            <Separator size="4" />

            {/* Info Message */}
            <Box p="3" className="bg-[var(--orange-3)] border border-[var(--orange-6)] rounded-[var(--radius-3)]">
              <Text size="2" className="text-[var(--gray-12)]">
                <strong>Use Case:</strong> Export budget items with UUIDs to match against budget_item_uuid column in transaction imports
              </Text>
            </Box>

            {/* Export Columns Info */}
            <Box>
              <Text size="2" weight="medium" as="div" mb="2" className="text-[var(--gray-12)]">
                Exported Columns:
              </Text>
              <Text size="1" className="text-[var(--gray-11)]">
                UUID, Name, Expense Type, Priority, Type, Subtype, Description, Category Name,
                Merchant Name, Rollover, Default Budget Amount, Is Bill, Recurring Payment Details,
                Goal Details, Icon, Color, Status, Tags
              </Text>
            </Box>

            {/* Action Button */}
            <Flex gap="3" justify="end">
              <Button
                color="orange"
                onClick={handleExportBudgetItems}
                disabled={isExportingBudgetItems}
              >
                <Download size={16} />
                {isExportingBudgetItems ? 'Exporting...' : 'Export to CSV'}
              </Button>
            </Flex>
          </Flex>
        </Card>

        {/* Accounts List Export */}
        <Card>
          <Flex direction="column" gap="4">
            <Flex align="center" gap="3">
              <Download size={24} className="text-[var(--teal-12)]" />
              <Box>
                <Text size="5" weight="bold" as="div" className="text-[var(--gray-12)]">
                  Export Accounts List
                </Text>
                <Text size="2" as="p" className="text-[var(--gray-11)]">
                  Export all accounts with names and UUIDs for import mapping
                </Text>
              </Box>
            </Flex>

            <Separator size="4" />

            {/* Info Message */}
            <Box p="3" className="bg-[var(--teal-3)] border border-[var(--teal-6)] rounded-[var(--radius-3)]">
              <Text size="2" className="text-[var(--gray-12)]">
                <strong>Use Case:</strong> Export accounts with UUIDs to match against account_uuid column in transaction imports
              </Text>
            </Box>

            {/* Export Columns Info */}
            <Box>
              <Text size="2" weight="medium" as="div" mb="2" className="text-[var(--gray-12)]">
                Exported Columns:
              </Text>
              <Text size="1" className="text-[var(--gray-11)]">
                UUID, Name, Account Type, Account Group, Type, Subtype, Institution Name,
                Account Number, Routing Number, Balance, Bank Balance, Bank Available Balance,
                Bank Balance Date, Settings (Exclude, Hide, Close, Envelope, etc.), Sort Order, Notes,
                Created At, Updated At
              </Text>
            </Box>

            {/* Action Button */}
            <Flex gap="3" justify="end">
              <Button
                color="teal"
                onClick={handleExportAccountsList}
                disabled={isExportingAccountsList}
              >
                <Download size={16} />
                {isExportingAccountsList ? 'Exporting...' : 'Export to CSV'}
              </Button>
            </Flex>
          </Flex>
        </Card>

      </Flex>
    </PageContainer>
  );
};

export default DataExportPage;
