import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Database, Trash2, Play, AlertTriangle, CheckCircle } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { clearAllTestData, generateAllTestData, generateTestAccountInstitutions, generateTestAccounts, generateTestBudgetItems, generateTestBudgetPeriods, generateTestCategories, generateTestTransactions } from '../services/api';
import { logger } from '../utils/logger';
import { useConfirmation } from '../hooks/useConfirmation';
import ConfirmationDialog from '../components/ConfirmationDialog';
import SettingsPageHeader from '../components/SettingsPageHeader';
import { Card, Flex, Text, Button, Callout, Grid, Spinner } from '@radix-ui/themes';
import PageContainer from '../components/PageContainer';

const TestDataPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [operationType, setOperationType] = useState<string | null>(null);

  // Confirmation dialog
  const { confirmAsync, dialogProps } = useConfirmation();

  const handleGenerateAllTestData = async () => {
    setLoading(true);
    setOperationType('generate-all');
    
    try {
      const result = await generateAllTestData();
      toast.success('All test data generated successfully!');
      logger.info({ result }, 'Test data generated successfully');
    } catch (error) {
      logger.error({ err: error }, 'Failed to generate test data');
      toast.error('Failed to generate test data');
    } finally {
      // Generated or cleared data touches every screen, even when the call failed partway.
      void queryClient.invalidateQueries();
      setLoading(false);
      setOperationType(null);
    }
  };

  const handleGenerateBudgetPeriods = async () => {
    setLoading(true);
    setOperationType('budget-periods');
    
    try {
      const months = [
        { year: 2024, monthNumber: 1 },
        { year: 2024, monthNumber: 2 },
        { year: 2024, monthNumber: 3 }
      ];
      const result = await generateTestBudgetPeriods(months);
      toast.success('Budget periods created successfully!');
      logger.info({ result }, 'Budget periods generated successfully');
    } catch (error) {
      logger.error({ err: error }, 'Failed to generate budget periods');
      toast.error('Failed to generate budget periods');
    } finally {
      // Generated or cleared data touches every screen, even when the call failed partway.
      void queryClient.invalidateQueries();
      setLoading(false);
      setOperationType(null);
    }
  };

  const handleGenerateBudgetItems = async () => {
    setLoading(true);
    setOperationType('budget-items');
    
    try {
      const result = await generateTestBudgetItems();
      toast.success('Budget items created successfully!');
      logger.info({ result }, 'Budget items generated successfully');
    } catch (error) {
      logger.error({ err: error }, 'Failed to generate budget items');
      toast.error('Failed to generate budget items');
    } finally {
      // Generated or cleared data touches every screen, even when the call failed partway.
      void queryClient.invalidateQueries();
      setLoading(false);
      setOperationType(null);
    }
  };

  const handleGenerateTransactions = async () => {
    setLoading(true);
    setOperationType('transactions');
    
    try {
      const result = await generateTestTransactions();
      toast.success('Test transactions created successfully!');
      logger.info({ result }, 'Transactions generated successfully');
    } catch (error) {
      logger.error({ err: error }, 'Failed to generate transactions');
      toast.error('Failed to generate transactions');
    } finally {
      // Generated or cleared data touches every screen, even when the call failed partway.
      void queryClient.invalidateQueries();
      setLoading(false);
      setOperationType(null);
    }
  };

  const handleGenerateCategories = async () => {
    setLoading(true);
    setOperationType('categories');
    
    try {
      const result = await generateTestCategories();
      toast.success('Test categories created successfully!');
      logger.info({ result }, 'Categories generated successfully');
    } catch (error) {
      logger.error({ err: error }, 'Failed to generate categories');
      toast.error('Failed to generate categories');
    } finally {
      // Generated or cleared data touches every screen, even when the call failed partway.
      void queryClient.invalidateQueries();
      setLoading(false);
      setOperationType(null);
    }
  };

  const handleGenerateAccountInstitutions = async () => {
    setLoading(true);
    setOperationType('account-institutions');
    
    try {
      const result = await generateTestAccountInstitutions();
      toast.success('Test account institutions created successfully!');
      logger.info({ result }, 'Account institutions generated successfully');
    } catch (error) {
      logger.error({ err: error }, 'Failed to generate account institutions');
      toast.error('Failed to generate account institutions');
    } finally {
      // Generated or cleared data touches every screen, even when the call failed partway.
      void queryClient.invalidateQueries();
      setLoading(false);
      setOperationType(null);
    }
  };

  const handleGenerateAccounts = async () => {
    setLoading(true);
    setOperationType('accounts');
    
    try {
      const result = await generateTestAccounts();
      toast.success('Test accounts created successfully!');
      logger.info({ result }, 'Accounts generated successfully');
    } catch (error) {
      logger.error({ err: error }, 'Failed to generate accounts');
      toast.error('Failed to generate accounts');
    } finally {
      // Generated or cleared data touches every screen, even when the call failed partway.
      void queryClient.invalidateQueries();
      setLoading(false);
      setOperationType(null);
    }
  };

  const handleClearAllTestData = async () => {
    const confirmed = await confirmAsync({
      title: "Delete all of this ledger's data",
      message: "This deletes every account, transaction, budget item, budget period, category and institution in this ledger, not only generated test data. It can't be undone.",
      variant: 'danger',
      confirmText: 'Delete everything',
      cancelText: 'Cancel',
      icon: <AlertTriangle size={24} />,
      details: [
        'Every account in this ledger',
        'Every transaction',
        'All budget items, periods and categories',
        'This is permanent'
      ]
    });

    if (!confirmed) return;

    setLoading(true);
    setOperationType('clear-all');
    
    try {
      await clearAllTestData();
      toast.success("All of this ledger's data was deleted");
    } catch (error) {
      logger.error({ err: error }, 'Failed to clear test data');
      toast.error('Failed to clear test data');
    } finally {
      // Generated or cleared data touches every screen, even when the call failed partway.
      void queryClient.invalidateQueries();
      setLoading(false);
      setOperationType(null);
    }
  };

  const isOperationLoading = (operation: string) => loading && operationType === operation;

  return (
    <PageContainer>
      {/* Header */}
      <SettingsPageHeader
        title="Test Data Generator"
        subtitle="Generate sample data for development and testing"
        icon={<Database size={20} className="text-[var(--red-11)]" />}
        iconBackground="bg-[var(--red-3)]"
        backPath="/settings"
      />

      {/* Warning Card */}
      <Callout.Root highContrast color="yellow" className="mb-6 sm:mb-8">
        <Callout.Icon>
          <AlertTriangle size={20} className="sm:w-6 sm:h-6" />
        </Callout.Icon>
        <Callout.Text>
          <Flex direction="column" gap="2">
            <Text size="4" weight="bold">Important Notes</Text>
            <Flex direction="column" gap="1" style={{ fontSize: '0.875rem' }}>
              <Text>• Test data generation requires an admin user to be logged in</Text>
              <Text>• This will create sample budget periods, items, and transactions</Text>
              <Text>• Only use this feature in development or demonstration environments</Text>
              <Text>• Clearing test data will remove all financial data - use with caution</Text>
            </Flex>
          </Flex>
        </Callout.Text>
      </Callout.Root>

      <Grid columns={{ initial: '1', lg: '2' }} gap="4" className="sm:gap-6 lg:gap-8">
        {/* Generate Data Section */}
        <Card>
          <Flex direction="column" gap="4">
            <Flex align="center" gap="3">
              <Flex 
                align="center" 
                justify="center" 
                width="40px"
                height="40px"
                className="bg-[var(--green-3)] rounded-[var(--radius-4)]"
              >
                <Play size={20} className="text-[var(--green-12)]" />
              </Flex>
              <Text size="5" weight="bold">Generate Test Data</Text>
            </Flex>

            <Flex direction="column" gap="4">
              {/* Generate All Button */}
              <Button
                onClick={handleGenerateAllTestData}
                disabled={loading}
                size="3"
                color="green"
                style={{ width: '100%' }}
              >
                {isOperationLoading('generate-all') ? (
                  <Spinner />
                ) : (
                  <CheckCircle size={20} />
                )}
                Generate All Test Data
              </Button>

              <Text align="center" size="2" color="gray">
                or generate components individually:
              </Text>

              {/* Individual Generation Buttons */}
              <Flex direction="column" gap="3">
                <Button
                  onClick={handleGenerateCategories}
                  disabled={loading}
                  size="3"
                  color="purple"
                  style={{ width: '100%' }}
                >
                  {isOperationLoading('categories') && <Spinner />}
                  Generate Categories
                </Button>

                <Button
                  onClick={handleGenerateAccountInstitutions}
                  disabled={loading}
                  size="3"
                  color="indigo"
                  style={{ width: '100%' }}
                >
                  {isOperationLoading('account-institutions') && <Spinner />}
                  Generate Account Institutions
                </Button>

                <Button
                  onClick={handleGenerateAccounts}
                  disabled={loading}
                  size="3"
                  color="cyan"
                  style={{ width: '100%' }}
                >
                  {isOperationLoading('accounts') && <Spinner />}
                  Generate Test Accounts
                </Button>

                <Button
                  onClick={handleGenerateBudgetPeriods}
                  disabled={loading}
                  size="3"
                  style={{ width: '100%' }}
                >
                  {isOperationLoading('budget-periods') && <Spinner />}
                  Generate Budget Periods (Jan-Mar 2024)
                </Button>

                <Button
                  onClick={handleGenerateBudgetItems}
                  disabled={loading}
                  size="3"
                  style={{ width: '100%' }}
                >
                  {isOperationLoading('budget-items') && <Spinner />}
                  Generate Budget Items
                </Button>

                <Button
                  onClick={handleGenerateTransactions}
                  disabled={loading}
                  size="3"
                  style={{ width: '100%' }}
                >
                  {isOperationLoading('transactions') && <Spinner />}
                  Generate Test Transactions
                </Button>
              </Flex>
            </Flex>
          </Flex>
        </Card>

        {/* Clear Data Section */}
        <Card>
          <Flex direction="column" gap="4">
            <Flex align="center" gap="3">
              <Flex 
                align="center" 
                justify="center" 
                width="40px"
                height="40px"
                className="bg-[var(--red-3)] rounded-[var(--radius-4)]"
              >
                <Trash2 size={20} className="text-[var(--red-11)]" />
              </Flex>
              <Text size="5" weight="bold">Clear Test Data</Text>
            </Flex>

            <Callout.Root color="red">
              <Callout.Text>
                <Flex direction="column" gap="2">
                  <Text weight="bold">⚠️ Destructive Action</Text>
                  <Text size="2">
                    This will permanently delete all budget periods, budget items, transactions, and related data.
                    This action cannot be undone.
                  </Text>
                </Flex>
              </Callout.Text>
            </Callout.Root>

            <Button
              onClick={handleClearAllTestData}
              disabled={loading}
              size="3"
              color="red"
              style={{ width: '100%' }}
            >
              {isOperationLoading('clear-all') ? (
                <Spinner />
              ) : (
                <Trash2 size={20} />
              )}
              Delete all of this ledger&apos;s data
            </Button>
          </Flex>
        </Card>
      </Grid>

      {/* Generated Data Info */}
      <Callout.Root color="blue" className="mt-6 sm:mt-8">
        <Callout.Text>
          <Flex direction="column" gap="3">
            <Text size="4" weight="bold">What Gets Generated:</Text>
            <Grid columns={{ initial: '1', md: '2' }} gap="4">
              <Flex direction="column" gap="2">
                <Text weight="medium">Budget Periods</Text>
                <Flex direction="column" gap="1" style={{ fontSize: '0.875rem' }}>
                  <Text>• January 2024</Text>
                  <Text>• February 2024</Text>
                  <Text>• March 2024</Text>
                </Flex>
              </Flex>
              <Flex direction="column" gap="2">
                <Text weight="medium">Budget Items</Text>
                <Flex direction="column" gap="1" style={{ fontSize: '0.875rem' }}>
                  <Text>• Utilities ($200/month)</Text>
                  <Text>• Transportation ($300/month)</Text>
                  <Text>• Insurance ($180/month)</Text>
                  <Text>• Income ($5000/month)</Text>
                </Flex>
              </Flex>
              <Flex direction="column" gap="2">
                <Text weight="medium">Transactions</Text>
                <Flex direction="column" gap="1" style={{ fontSize: '0.875rem' }}>
                  <Text>• Sample income transactions</Text>
                  <Text>• Expense transactions for each category</Text>
                  <Text>• Account starting balances</Text>
                  <Text>• Transfer transactions</Text>
                </Flex>
              </Flex>
            </Grid>
          </Flex>
        </Callout.Text>
      </Callout.Root>
      
      {/* Confirmation Dialog */}
      <ConfirmationDialog {...dialogProps} />
    </PageContainer>
  );
};

export default TestDataPage;
