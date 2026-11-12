import React, { useState } from 'react';
import { logger } from '../utils/logger';
import { useNavigate } from 'react-router-dom';
import { TrendingUp, RefreshCw, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { clearNetWorthSnapshots, rebuildNetWorthHistory } from '../services/api';
import { toast } from 'react-hot-toast';
import { useConfirmation } from '../hooks/useConfirmation';
import ConfirmationDialog from '../components/ConfirmationDialog';
import SettingsPageHeader from '../components/SettingsPageHeader';
import { Box, Card, Flex, Text, Button, Callout } from '@radix-ui/themes';
import PageContainer from '../components/PageContainer';

const NetWorthResetPage: React.FC = () => {
  const navigate = useNavigate();
  const { confirmAsync, dialogProps } = useConfirmation();
  const [isResetting, setIsResetting] = useState(false);
  const [resetStatus, setResetStatus] = useState<{
    step: string;
    message: string;
    isError?: boolean;
  } | null>(null);

  const handleNetWorthReset = async () => {
    const confirmed = await confirmAsync({
      title: 'Reset Net Worth History',
      message: 'Are you sure you want to reset the entire net worth history?\n\nThis will:\n• Delete all existing net worth snapshots\n• Recalculate net worth for all historical dates\n• Create new snapshots for the past 12 months\n• This operation cannot be undone',
      variant: 'warning',
      confirmText: 'Reset Net Worth',
      cancelText: 'Cancel',
      icon: <AlertTriangle size={24} />,
      details: [
        'All existing net worth snapshots will be permanently deleted',
        'New snapshots will be created for the past 12 months',
        'Historical account balances will be recalculated',
        'This may take several minutes to complete',
        'The dashboard chart will be updated with new data'
      ]
    });

    if (!confirmed) return;

    setIsResetting(true);
    setResetStatus({ step: 'Starting', message: 'Initializing net worth reset...' });

    try {
      // Step 1: Clear existing snapshots
      setResetStatus({ step: 'Clearing', message: 'Deleting existing net worth snapshots...' });
      await clearNetWorthSnapshots();

      // Step 2: Rebuild historical snapshots
      setResetStatus({ step: 'Rebuilding', message: 'Creating historical net worth snapshots...' });
      const result = await rebuildNetWorthHistory();

      // Step 3: Complete
      const successDetails = [];
      if (result.snapshots_created) successDetails.push(`${result.snapshots_created} daily snapshots`);
      if (result.weekly_aggregates) successDetails.push(`${result.weekly_aggregates} weekly aggregates`);
      if (result.monthly_aggregates) successDetails.push(`${result.monthly_aggregates} monthly aggregates`);

      const dateRange = result.earliest_date && result.latest_date
        ? ` from ${result.earliest_date} to ${result.latest_date}`
        : '';
      
      setResetStatus({ 
        step: 'Complete', 
        message: `Successfully created ${successDetails.join(', ')}${dateRange}` 
      });

      toast.success('Net worth history has been reset successfully!');
      
      // Auto-redirect after success
      setTimeout(() => {
        navigate('/settings');
      }, 3000);

    } catch (error) {
      logger.error({ err: error }, 'Net worth reset failed');
      setResetStatus({ 
        step: 'Error', 
        message: 'Failed to reset net worth history. Please try again.',
        isError: true 
      });
      toast.error('Failed to reset net worth history');
    } finally {
      setIsResetting(false);
    }
  };

  const getStatusIcon = () => {
    if (!resetStatus) return null;
    
    switch (resetStatus.step) {
      case 'Starting':
      case 'Clearing':
      case 'Rebuilding':
        return <RefreshCw size={20} className="animate-spin text-[var(--accent-11)]" />;
      case 'Complete':
        return <CheckCircle size={20} className="text-[var(--green-12)]" />;
      case 'Error':
        return <XCircle size={20} className="text-[var(--red-11)]" />;
      default:
        return null;
    }
  };

  return (
    <PageContainer width="form">
      {/* Header */}
      <SettingsPageHeader
        title="Net Worth Reset"
        subtitle="Rebuild and recalculate net worth history"
        icon={<TrendingUp size={20} className="text-[var(--accent-11)]" />}
        iconBackground="bg-[var(--accent-3)]"
        backPath="/settings"
      />

      {/* Main Content */}
      <Box>
        <Card>
          <Flex direction="column" gap="6">
            {/* Explanation Section */}
            <Flex direction="column" gap="4">
              <Text size="5" weight="bold">What does this do?</Text>
              
              <Callout.Root color="blue">
                <Callout.Icon>
                  <TrendingUp size={20} />
                </Callout.Icon>
                <Callout.Text>
                  <Flex direction="column" gap="2">
                    <Text weight="bold">Net Worth History Rebuild</Text>
                    <Text size="2">
                      This tool will completely rebuild your net worth tracking history by analyzing all your account
                      balances and transactions over time. It's useful when you've imported historical data or need
                      to fix inconsistencies in your net worth tracking.
                    </Text>
                  </Flex>
                </Callout.Text>
              </Callout.Root>

              <Flex direction="column" gap="3">
                <Text weight="medium">This process will:</Text>
                <Flex direction="column" gap="2" style={{ fontSize: '0.875rem' }}>
                  <Flex align="start" gap="3">
                    <Box width="6px" height="6px" mt="2" flexShrink="0" className="bg-[var(--accent-9)] rounded-full" />
                    <Text>Delete all existing net worth snapshots (daily, weekly, monthly)</Text>
                  </Flex>
                  <Flex align="start" gap="3">
                    <Box width="6px" height="6px" mt="2" flexShrink="0" className="bg-[var(--accent-9)] rounded-full" />
                    <Text>Recalculate historical account balances from your earliest transaction date</Text>
                  </Flex>
                  <Flex align="start" gap="3">
                    <Box width="6px" height="6px" mt="2" flexShrink="0" className="bg-[var(--accent-9)] rounded-full" />
                    <Text>Create daily net worth snapshots for your complete transaction history</Text>
                  </Flex>
                  <Flex align="start" gap="3">
                    <Box width="6px" height="6px" mt="2" flexShrink="0" className="bg-[var(--accent-9)] rounded-full" />
                    <Text>Generate weekly and monthly aggregated snapshots for efficient charting</Text>
                  </Flex>
                  <Flex align="start" gap="3">
                    <Box width="6px" height="6px" mt="2" flexShrink="0" className="bg-[var(--accent-9)] rounded-full" />
                    <Text>Update all aggregated net worth data (weekly, monthly, yearly)</Text>
                  </Flex>
                  <Flex align="start" gap="3">
                    <Box width="6px" height="6px" mt="2" flexShrink="0" className="bg-[var(--accent-9)] rounded-full" />
                    <Text>Refresh the dashboard net worth chart with accurate historical data</Text>
                  </Flex>
                </Flex>
              </Flex>
            </Flex>

            {/* Warning Section */}
            <Callout.Root highContrast color="amber">
              <Callout.Icon>
                <AlertTriangle size={20} />
              </Callout.Icon>
              <Callout.Text>
                <Flex direction="column" gap="2">
                  <Text weight="bold">⚠️ Important Warning</Text>
                  <Flex direction="column" gap="1" style={{ fontSize: '0.875rem' }}>
                    <Text>• This operation cannot be undone</Text>
                    <Text>• The process may take several minutes for large datasets</Text>
                    <Text>• Your net worth chart may show different values after recalculation</Text>
                    <Text>• Only use this if you're experiencing net worth tracking issues</Text>
                  </Flex>
                </Flex>
              </Callout.Text>
            </Callout.Root>

            {/* Status Display */}
            {resetStatus && (
              <Callout.Root 
                highContrast
                color={
                  resetStatus.isError
                    ? 'red'
                    : resetStatus.step === 'Complete'
                      ? 'green'
                      : 'blue'
                }
              >
                <Callout.Icon>
                  {getStatusIcon()}
                </Callout.Icon>
                <Callout.Text>
                  <Flex direction="column" gap="1">
                    <Text weight="medium" style={{ wordBreak: 'break-word' }}>
                      {resetStatus.step}: {resetStatus.message}
                    </Text>
                    {resetStatus.step === 'Complete' && (
                      <Text size="2">
                        Redirecting to settings page in 3 seconds...
                      </Text>
                    )}
                  </Flex>
                </Callout.Text>
              </Callout.Root>
            )}

            {/* Action Button */}
            <Flex justify="center">
              <Button
                onClick={handleNetWorthReset}
                disabled={isResetting}
                size="3"
                style={{ width: '100%' }}
                className="sm:w-auto"
              >
                {isResetting ? (
                  <>
                    <RefreshCw size={16} className="animate-spin" />
                    Resetting Net Worth...
                  </>
                ) : (
                  <>
                    <TrendingUp size={16} />
                    Reset Net Worth History
                  </>
                )}
              </Button>
            </Flex>

            {/* Additional Info */}
            <Flex direction="column" gap="3" pt="5" className="border-t border-[var(--gray-6)]">
              <Text weight="medium">When should I use this?</Text>
              <Flex direction="column" gap="2" style={{ fontSize: '0.875rem' }}>
                <Text>• After importing historical transaction data</Text>
                <Text>• When you notice inconsistencies in your net worth chart</Text>
                <Text>• If your dashboard shows "Failed to load net worth data"</Text>
                <Text>• After making significant changes to account balances</Text>
                <Text>• When setting up net worth tracking for the first time</Text>
              </Flex>
            </Flex>
          </Flex>
        </Card>
      </Box>

      {/* Confirmation Dialog */}
      <ConfirmationDialog {...dialogProps} />
    </PageContainer>
  );
};

export default NetWorthResetPage;
