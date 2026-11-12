import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TrendingUp, TrendingDown, Wallet, CheckCircle2 } from 'lucide-react';
import { formatMoney } from '@nuggets/shared';
import type { Account, BudgetPeriod, EnvelopeReconciliation } from '../../services/api';
import { Box, Callout, Card, Flex, Grid, Text, Button } from '@radix-ui/themes';
import TransferModal from '../transfer/TransferModal';
import InfoPopover from '../InfoPopover';
import { CARD_CORNERS } from './cardCorners';
import type { TransferFormData } from '../transfer/TransferForm';
import { todayLocal } from '../../utils/dateUtils';
import { centsToAmount, toCents } from '../../utils/currency';

/**
 * Why the envelope account isn't reconciled, as the page's banner says it: its balance
 * can't be computed, or the close-out data (the accounts among it) didn't load.
 */
export type EnvelopeUnavailable = 'balance' | 'failed';

interface EnvelopeReconciliationSectionProps {
  reconciliation: EnvelopeReconciliation | null;
  /** Set when the envelope account isn't reconciled for a reason; see EnvelopeUnavailable. */
  unavailable?: EnvelopeUnavailable | null;
  isLoading?: boolean;
  /** Full account rows — to resolve the envelope account's id/type/default transfer account. */
  fullAccounts?: Account[];
  budgetPeriods?: BudgetPeriod[];
  periodId?: string;
}

const UNAVAILABLE_TEXT: Record<EnvelopeUnavailable, { title: string; body: (account: string) => string }> = {
  balance: {
    title: 'Envelope account balance unavailable',
    body: (account) => `${account}'s balance can't be worked out right now, so it isn't reconciled against the envelopes.`,
  },
  failed: {
    title: 'Envelope reconciliation unavailable',
    body: () => "The close-out data didn't load, so the envelope account isn't reconciled.",
  },
};

/** The section's title and its tip, in every state (the loading and empty states had a bare icon). */
const Section: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Flex direction="column" gap="4">
    <Flex align="center" gap="2">
      <Text size="5" weight="bold" className="text-[var(--gray-12)]">
        Envelope Account Reconciliation
      </Text>
      <InfoPopover label="About envelope account reconciliation">
        Verify that your envelope account balance matches the sum of all envelope budget items.
      </InfoPopover>
    </Flex>
    {children}
  </Flex>
);

/** Why there is nothing to reconcile, and where to go about it. */
const EmptyState: React.FC<{ title: string; body: string; action?: React.ReactNode }> = ({ title, body, action }) => (
  <Card size="5" className={CARD_CORNERS}>
    <Flex direction="column" align="center" className="text-center">
      <Wallet size={64} className="text-[var(--gray-11)]" aria-hidden="true" />
      <Text as="p" size="4" weight="medium" mt="4" mb="2" className="text-[var(--gray-12)]">{title}</Text>
      <Text as="p" size="2" className="text-[var(--gray-11)]">{body}</Text>
      {action && <Box mt="5">{action}</Box>}
    </Flex>
  </Card>
);

/** One of the three figures: its label, the amount, and what it is of. */
const Figure: React.FC<{ label: string; children: React.ReactNode; note?: string }> = ({ label, children, note }) => (
  <Box className="text-center">
    <Text as="div" size="2" weight="medium" mb="2" className="text-[var(--gray-11)]">{label}</Text>
    {children}
    {note && <Text as="div" size="1" mt="1" className="text-[var(--gray-11)]">{note}</Text>}
  </Box>
);

const EnvelopeReconciliationSection: React.FC<EnvelopeReconciliationSectionProps> = ({
  reconciliation,
  unavailable = null,
  isLoading = false,
  fullAccounts = [],
  budgetPeriods = [],
  periodId = '',
}) => {
  const navigate = useNavigate();
  const [transferOpen, setTransferOpen] = useState(false);

  if (isLoading) {
    return (
      <Section>
        <Card size="3" className={`animate-pulse ${CARD_CORNERS}`}>
          <Box height="10rem" className="bg-[var(--gray-3)] rounded-[var(--radius-2)]" />
        </Card>
      </Section>
    );
  }

  if (!reconciliation || !reconciliation.envelope_account) {
    const configured = fullAccounts.find((a) => a.is_envelope_account);
    const viewConfigured = configured && (
      <Button onClick={() => navigate(`/accounts/${configured.uuid}`)}>View Envelope Account</Button>
    );
    // Not reconciled for a reason says that reason, whether or not the account is known: when
    // the accounts didn't load, there is none to find, and none configured is not the case.
    if (unavailable) {
      const why = UNAVAILABLE_TEXT[unavailable];
      return (
        <Section>
          <EmptyState title={why.title} body={why.body(configured?.name ?? 'The envelope account')} action={viewConfigured} />
        </Section>
      );
    }
    if (configured) {
      return (
        <Section>
          <EmptyState
            title="Nothing to reconcile yet"
            body={`This period has no budget items to reconcile ${configured.name} against.`}
            action={viewConfigured}
          />
        </Section>
      );
    }
    return (
      <Section>
        <EmptyState
          title="No envelope account configured"
          body="Designate a savings account as your envelope account to track budget reconciliation."
          action={<Button onClick={() => navigate('/accounts')}>Configure Envelope Account</Button>}
        />
      </Section>
    );
  }

  const { envelope_account, budget_summary, variance } = reconciliation;

  // Reconciliation guidance. Underfunded is unambiguous (top the account up).
  // Overfunded is often legitimate (unbudgeted income such as interest), so we
  // prompt the user to investigate the cause rather than blindly withdraw.
  const getVarianceText = () => {
    if (!variance) return 'Unknown';
    if (variance.status === 'balanced') {
      return 'Perfectly balanced!';
    }
    if (variance.status === 'overfunded') {
      return `Record unbudgeted income (e.g. interest), or withdraw the excess from ${envelope_account.name}`;
    }
    // Underfunded: the account genuinely needs topping up to cover the envelopes.
    return `Deposit ${formatMoney(Math.abs(variance.amount))} into ${envelope_account.name}`;
  };

  // Banner styling mirrors the variance status: green when balanced, red when the
  // account is short, and the theme accent for an overfunded (informational) case.
  const varianceColor: 'green' | 'red' | undefined =
    variance?.status === 'balanced' ? 'green'
      : variance?.status === 'underfunded' ? 'red'
      : undefined;
  const VarianceIcon =
    variance?.status === 'balanced' ? CheckCircle2
      : variance?.status === 'underfunded' ? TrendingDown
      : TrendingUp;

  // The reconciliation payload's envelope_account only carries name/uuid/balance;
  // resolve the full row for the numeric id + the configured default transfer account.
  const fullEnvelope = fullAccounts.find((a) => a.uuid === envelope_account.uuid);
  const canTransfer = !!fullEnvelope && !!variance && variance.status !== 'balanced';

  // Direction follows the variance: underfunded → deposit INTO the envelope (the
  // counterparty is the source); overfunded → withdraw the excess OUT of it (the
  // counterparty is the destination). All fields stay editable in the modal. The amount
  // is the variance's whole cents, at two decimals: the API refuses more.
  const buildTransferInitialValues = (): Partial<TransferFormData> => {
    if (!fullEnvelope || !variance) return {};
    const amount = centsToAmount(Math.abs(toCents(variance.amount)));
    const transaction_date = todayLocal();
    const budget_period_id = budgetPeriods.find((p) => p.uuid === periodId)?.id ?? null;
    const counterparty = fullEnvelope.default_pay_from_account_id ?? null;
    if (variance.status === 'underfunded') {
      return {
        type: 'transfer',
        source_account_id: counterparty,
        destination_account_id: fullEnvelope.id,
        amount,
        transaction_date,
        budget_period_id,
        description: `Envelope deposit: ${fullEnvelope.name}`,
      };
    }
    return {
      type: 'transfer',
      source_account_id: fullEnvelope.id,
      destination_account_id: counterparty,
      amount,
      transaction_date,
      budget_period_id,
      description: `Envelope withdrawal: ${fullEnvelope.name}`,
    };
  };

  return (
    <Section>
      <Card size="3" className={CARD_CORNERS}>
        {/* Variance guidance banner (shown for every status) */}
        <Callout.Root {...(varianceColor ? { color: varianceColor } : {})} mb="6">
          <Callout.Icon>
            <VarianceIcon size={16} />
          </Callout.Icon>
          <Callout.Text>{getVarianceText()}</Callout.Text>
        </Callout.Root>

        <Grid columns={{ initial: '1', sm: '3' }} gap="5">
          <Figure label="Actual Envelope Balance" note={envelope_account.name}>
            <Text size="8" weight="bold" className="text-[var(--gray-12)]">
              {formatMoney(envelope_account.actual_balance)}
            </Text>
          </Figure>

          <Figure label="Expected Budget Balance" note={`${budget_summary?.envelope_items_count || 0} envelope items`}>
            <Text size="8" weight="bold" className="text-[var(--gray-12)]">
              {formatMoney(budget_summary?.expected_balance || 0)}
            </Text>
          </Figure>

          <Figure label="Variance">
            <Flex align="center" justify="center" gap="2">
              {variance && variance.status === 'overfunded' && (
                <TrendingUp size={24} className="text-[var(--gray-11)]" />
              )}
              {variance && variance.status === 'underfunded' && (
                <TrendingDown size={24} className="text-[var(--red-11)]" />
              )}
              {variance && variance.status === 'balanced' && (
                <TrendingUp size={24} className="text-[var(--green-12)]" />
              )}
              <Text size="8" weight="bold" className={
                variance?.status === 'balanced' ? 'text-[var(--green-12)]' :
                variance?.status === 'underfunded' ? 'text-[var(--red-11)]' :
                'text-[var(--gray-12)]'
              }>
                {formatMoney(variance ? Math.abs(variance.amount) : 0)}
              </Text>
            </Flex>
          </Figure>
        </Grid>

        {/* The actions share the row equally on a wide screen, stacked on a narrow one. */}
        <Grid columns={{ initial: '1', sm: canTransfer ? '3' : '2' }} gap="3" mt="6">
          {canTransfer && (
            <Button onClick={() => setTransferOpen(true)}>
              Submit Transfer
            </Button>
          )}
          <Button
            onClick={() => navigate(`/accounts/${envelope_account.uuid}`)}
            variant={canTransfer ? 'soft' : 'solid'}
          >
            View Envelope Account
          </Button>
          <Button
            onClick={() => navigate('/budgets?filter=envelope')}
            variant="outline"
          >
            View Envelope Budget
          </Button>
        </Grid>

        {fullEnvelope && (
          <TransferModal
            open={transferOpen}
            onClose={() => setTransferOpen(false)}
            accounts={fullAccounts}
            budgetPeriods={budgetPeriods}
            initialValues={buildTransferInitialValues()}
            onSuccess={() => setTransferOpen(false)}
          />
        )}
      </Card>
    </Section>
  );
};

export default EnvelopeReconciliationSection;
