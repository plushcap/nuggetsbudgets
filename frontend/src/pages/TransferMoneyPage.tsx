import React, { useMemo } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { Card, Heading, Flex, IconButton } from '@radix-ui/themes';
import PageLoader from '../components/PageLoader';
import { ArrowLeftRight, ArrowLeft } from 'lucide-react';
import { useAccountsQuery, useBudgetPeriodsQuery } from '../hooks/queries';
import TransferForm, { type TransferFormData } from '../components/transfer/TransferForm';
import PageContainer from '../components/PageContainer';

const TransferMoneyPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const { data: accounts = [], isLoading: accountsLoading } = useAccountsQuery();
  const { data: periodsRaw = [], isLoading: periodsLoading } = useBudgetPeriodsQuery();
  const loading = accountsLoading || periodsLoading;

  // The 3 most recent budget periods not archived (year desc, month desc).
  const budgetPeriods = useMemo(() => {
    return periodsRaw
      .filter((period) => !period.archived_at)
      .sort((a, b) => (b.year !== a.year ? b.year - a.year : b.month_number - a.month_number))
      .slice(0, 3);
  }, [periodsRaw]);

  // Preserve the existing deep-link: ?source=<account uuid> pre-selects the source.
  const initialValues = useMemo<Partial<TransferFormData>>(() => {
    const sourceUuid = searchParams.get('source');
    if (!sourceUuid) return {};
    const sourceAccount = accounts.find((acc) => acc.uuid === sourceUuid);
    return sourceAccount ? { source_account_id: sourceAccount.id } : {};
  }, [accounts, searchParams]);

  const goBack = () => navigate(location.state?.from || '/transactions');

  if (loading) {
    return (
      <PageContainer width="form">
        <PageLoader label="Loading…" />
      </PageContainer>
    );
  }

  return (
    <PageContainer width="form">
      {/* Header */}
      <Flex align="center" gap="3" mb="4">
        <IconButton variant="ghost" onClick={goBack} size="3" aria-label="Go back">
          <ArrowLeft size={20} />
        </IconButton>
        <Heading size="6">
          <Flex align="center" gap="2">
            <ArrowLeftRight size={24} />
            Transfer Money
          </Flex>
        </Heading>
      </Flex>

      {/* Form */}
      <Card size="3">
        <TransferForm
          accounts={accounts}
          budgetPeriods={budgetPeriods}
          initialValues={initialValues}
          onSuccess={goBack}
          onCancel={goBack}
        />
      </Card>
    </PageContainer>
  );
};

export default TransferMoneyPage;
