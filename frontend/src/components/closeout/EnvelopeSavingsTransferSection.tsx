import { useNavigate } from 'react-router-dom';
import { Card, Flex, Text, Button, Grid } from '@radix-ui/themes';
import { CheckCircle, TrendingUp, AlertTriangle, Eye, TrendingDown } from 'lucide-react';
import { centsOf, centsToAmount, formatCurrency } from '../../utils/currency';
import { textColorProps } from '../../utils/textColor';
import type { BudgetPeriodItem } from '../../services/api/types';
import { useEnvelopeTransfersQuery } from '../../hooks/queries';
import PageLoader from '../PageLoader';
import InfoPopover from '../InfoPopover';
import { CARD_CORNERS } from './cardCorners';
import { errorCode } from '../../utils/errors';

/** How far, either way, what was transferred may be from what was expected and still be balanced. */
const TOLERANCE_CENTS = 50;

interface EnvelopeSavingsTransferSectionProps {
  budgetPeriodItems: BudgetPeriodItem[];
  periodUuid: string;
  isLoading: boolean;
}

export default function EnvelopeSavingsTransferSection({
  budgetPeriodItems,
  periodUuid,
  isLoading: parentLoading
}: EnvelopeSavingsTransferSectionProps) {
  const navigate = useNavigate();
  // Inline error UI below (suppress the global error toast). A 404 with code
  // NO_ENVELOPE_ACCOUNT ("No envelope account configured") is an expected, non-error state.
  const { data: transferResponse, isLoading: loading, error: queryError } =
    useEnvelopeTransfersQuery(periodUuid, { meta: { suppressErrorToast: true } });

  const transferData = transferResponse?.data ?? null;
  const noEnvelopeAccount = errorCode(queryError) === 'NO_ENVELOPE_ACCOUNT';
  const error = noEnvelopeAccount
    ? 'No envelope account configured'
    : queryError
      ? 'Failed to load envelope transfer data'
      : null;

  // Envelope budget and spending from the period's items, added in whole cents: float
  // sums made a variance of nothing -5.55e-17, shown as ($0.00), and moved one of exactly
  // 50 cents outside the 50 cents allowed.
  const envelopeItems = budgetPeriodItems.filter(item => item.type === 'Envelope');
  const envelopeBudgetCents = envelopeItems.reduce((sum, item) => sum + centsOf(item.calculated_budget), 0);
  const envelopeSpendingCents = envelopeItems.reduce((sum, item) => sum + Math.abs(centsOf(item.calculated_actual)), 0);
  const expectedNetCents = envelopeBudgetCents - envelopeSpendingCents;
  const transferredCents = centsOf(transferData?.net_transfer_amount);
  const varianceCents = transferredCents - expectedNetCents;

  const envelopeBudget = centsToAmount(envelopeBudgetCents);
  const envelopeSpending = centsToAmount(envelopeSpendingCents);
  const expectedNetSavings = centsToAmount(expectedNetCents);
  const actualTransferred = centsToAmount(transferredCents);
  const transferVariance = centsToAmount(varianceCents);

  // Determine status
  const isBalanced = Math.abs(varianceCents) <= TOLERANCE_CENTS;
  const isOverTransferred = varianceCents > TOLERANCE_CENTS;

  const getStatusConfig = () => {
    if (isBalanced) {
      return {
        color: 'green' as const,
        icon: CheckCircle,
        iconClass: 'text-[var(--green-9)]',
        cardClass: '[--card-background-color:var(--green-3)] border border-[var(--green-6)]',
        message: 'Perfectly balanced! ✓',
        hint: null
      };
    } else if (isOverTransferred) {
      return {
        color: 'blue' as const,
        icon: TrendingUp,
        iconClass: 'text-[var(--blue-9)]',
        cardClass: '[--card-background-color:var(--blue-3)] border border-[var(--blue-6)]',
        message: `Transferred ${formatCurrency(Math.abs(transferVariance))} extra to envelope account`,
        hint: "Consider adjusting next month's transfer"
      };
    } else {
      return {
        color: 'orange' as const,
        icon: AlertTriangle,
        iconClass: 'text-[var(--orange-9)]',
        cardClass: '[--card-background-color:var(--orange-3)] border border-[var(--orange-6)]',
        message: `Need to transfer ${formatCurrency(Math.abs(transferVariance))} more to envelope account`,
        hint: 'Transfer additional funds to match budget'
      };
    }
  };

  const status = getStatusConfig();
  const StatusIcon = status.icon;

  if (error === 'No envelope account configured') {
    return null; // Don't show section if no envelope account exists
  }

  if (parentLoading || loading) {
    return (
      <Card size="3" className={CARD_CORNERS}>
        <Flex direction="column" gap="4">
          <Flex justify="between" align="center">
            <Text size="5" weight="bold" color="gray" highContrast>
              Envelope Savings Transfer Tracking
            </Text>
          </Flex>
          <PageLoader label="Loading…" minHeight="6rem" />
        </Flex>
      </Card>
    );
  }

  if (error) {
    return (
      <Card size="3" className={CARD_CORNERS}>
        <Flex direction="column" gap="4">
          <Flex justify="between" align="center">
            <Text size="5" weight="bold" color="gray" highContrast>
              Envelope Savings Transfer Tracking
            </Text>
          </Flex>
          <Text size="2" color="red">{error}</Text>
        </Flex>
      </Card>
    );
  }

  return (
    <Card size="3" className={CARD_CORNERS}>
      <Flex direction="column" gap="4">
        {/* Section Header */}
        <Flex justify="between" align="center">
          <Text size="5" weight="bold" color="gray" highContrast>
            Envelope Savings Transfer Tracking
          </Text>
          <InfoPopover label="About envelope savings transfer tracking">
            This section helps verify that the correct amount has been transferred to your envelope savings account for the budget period.
          </InfoPopover>
        </Flex>

        {/* Metrics Grid */}
        <Grid columns={{ initial: '1', sm: '2', md: '4' }} gap="4">
          {/* Envelope Budget */}
          <Card className="[--card-background-color:var(--gray-2)]">
            <Flex direction="column" gap="2" p="4">
              <Text size="2" color="gray">
                Envelope Budget
              </Text>
              <Text size="6" weight="bold" color="gray" highContrast>
                {formatCurrency(envelopeBudget)}
              </Text>
              <Text size="1" color="gray">
                Allocated for envelopes
              </Text>
            </Flex>
          </Card>

          {/* Envelope Spending */}
          <Card className="[--card-background-color:var(--gray-2)]">
            <Flex direction="column" gap="2" p="4">
              <Text size="2" color="gray">
                Envelope Spending
              </Text>
              <Text size="6" weight="bold" color="gray" highContrast>
                {formatCurrency(envelopeSpending)}
              </Text>
              <Text size="1" color="gray">
                Actual envelope expenses
              </Text>
            </Flex>
          </Card>

          {/* Expected Net to Savings */}
          <Card className="[--card-background-color:var(--gray-2)]">
            <Flex direction="column" gap="2" p="4">
              <Text size="2" color="gray">
                Expected Net to Savings
              </Text>
              <Text size="6" weight="bold" className="text-[var(--accent-11)]">
                {formatCurrency(expectedNetSavings)}
              </Text>
              <Text size="1" color="gray">
                Should be in envelope account
              </Text>
            </Flex>
          </Card>

          {/* Amount Transferred */}
          <Card className="[--card-background-color:var(--gray-2)]">
            <Flex direction="column" gap="2" p="4">
              <Text size="2" color="gray">
                Amount Transferred
              </Text>
              <Text size="6" weight="bold" {...textColorProps(status.color)}>
                {formatCurrency(actualTransferred)}
              </Text>
              <Text size="1" color="gray">
                Net transfers this period
              </Text>
            </Flex>
          </Card>
        </Grid>

        {/* Variance Row */}
        <Card className={status.cardClass}>
          <Flex direction="column" gap="2" p="4">
            <Flex align="center" gap="2">
              <StatusIcon size={20} className={status.iconClass} />
              {/* On its own colour's step-3 fill, step 11 is under AA for blue (4.26:1): step 12. */}
              <Text size="4" weight="bold" color={status.color} highContrast>
                Transfer Variance: {formatCurrency(transferVariance)}
              </Text>
            </Flex>
            <Text size="2" color="gray" highContrast>
              {status.message}
            </Text>
            {status.hint && (
              <Text size="1" color="gray">
                {status.hint}
              </Text>
            )}
          </Flex>
        </Card>

        {/* Action Buttons */}
        {transferData && (
          <Flex gap="3" wrap="wrap">
            <Button
              variant="soft"
              size="2"
              onClick={() => navigate(`/accounts/${transferData.envelope_account.uuid}`)}
            >
              <Eye size={16} />
              View Envelope Account
            </Button>
            {transferData.transfer_count > 0 && (
              <Button
                variant="soft"
                size="2"
                color="gray"
                onClick={() => navigate(`/accounts/${transferData.envelope_account.uuid}?transactionType=transfer`)}
              >
                <TrendingDown size={16} />
                View Transfer History ({transferData.transfer_count})
              </Button>
            )}
          </Flex>
        )}
      </Flex>
    </Card>
  );
}
