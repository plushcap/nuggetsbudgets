import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Flex, Grid, Text, Select, Switch, Button, Callout } from '@radix-ui/themes';
import { Settings, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import PageHeader from '../components/PageHeader';
import { useAccountsQuery } from '../hooks/queries/accounts';
import { useSecuritiesQuery, useSetCostBasisMethodMutation } from '../hooks/queries/investments';
import { logger } from '../utils/logger';
import { COST_BASIS_METHODS, COST_BASIS_METHOD_LABELS, type CostBasisMethod, accountGroup, accountType, costBasisMethod } from '@nuggets/shared';
import { apiErrorMessage } from '../utils/errors';
import PageContainer from '../components/PageContainer';


const CostBasisSettingsPage: React.FC = () => {
  const navigate = useNavigate();
  const { data: accounts = [] } = useAccountsQuery();
  const { data: securities = [] } = useSecuritiesQuery();
  const setMethod = useSetCostBasisMethodMutation();

  const investmentAccounts = accounts.filter((a) => a.account_type === accountType.enum.investment || a.account_group === accountGroup.enum.investments);
  const [accountUuid, setAccountUuid] = useState('');
  const [securityUuid, setSecurityUuid] = useState('default');
  const [method, setMethodValue] = useState<CostBasisMethod>('fifo');
  const [dripEnabled, setDripEnabled] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = !!accountUuid;

  const onSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await setMethod.mutateAsync({
        account_uuid: accountUuid,
        security_uuid: securityUuid === 'default' ? null : securityUuid,
        method,
        drip_enabled: dripEnabled,
      });
      toast.success('Settings saved');
      navigate('/investments');
    } catch (err) {
      logger.error({ err }, 'Failed to save cost-basis settings');
      toast.error(apiErrorMessage(err, 'Failed to save settings'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageContainer width="form">
      <PageHeader title="Cost-basis settings" subtitle="Per-account default or per-security cost-basis method and DRIP" icon={<Settings />} backPath="/investments" />
      <Card>
        <Flex direction="column" gap="4" p="2">
          <label>
            <Text as="div" size="2" mb="1" weight="medium">Account</Text>
            <Select.Root value={accountUuid} onValueChange={setAccountUuid}>
              <Select.Trigger placeholder="Select an investment account" style={{ width: '100%' }} />
              <Select.Content>{investmentAccounts.map((a) => <Select.Item key={a.uuid} value={a.uuid}>{a.name}</Select.Item>)}</Select.Content>
            </Select.Root>
          </label>
          <label>
            <Text as="div" size="2" mb="1" weight="medium">Scope</Text>
            <Select.Root value={securityUuid} onValueChange={setSecurityUuid}>
              <Select.Trigger style={{ width: '100%' }} />
              <Select.Content>
                <Select.Item value="default">Account default (all securities)</Select.Item>
                {securities.map((s) => <Select.Item key={s.uuid} value={s.uuid}>{s.ticker}</Select.Item>)}
              </Select.Content>
            </Select.Root>
          </label>
          <Grid columns={{ initial: '1', sm: '2' }} gap="3">
            <label>
              <Text as="div" size="2" mb="1" weight="medium">Cost-basis method</Text>
              <Select.Root value={method} onValueChange={(v) => setMethodValue(v as CostBasisMethod)}>
                <Select.Trigger style={{ width: '100%' }} />
                <Select.Content>{COST_BASIS_METHODS.map((m) => <Select.Item key={m} value={m}>{COST_BASIS_METHOD_LABELS[m]}</Select.Item>)}</Select.Content>
              </Select.Root>
            </label>
            <Flex align="end" gap="2" pb="2" width="fit-content" asChild>
              <label>
                <Switch checked={dripEnabled} onCheckedChange={setDripEnabled} />
                <Text size="2">Enable DRIP (auto-reinvest dividends)</Text>
              </label>
            </Flex>
          </Grid>
          {method === costBasisMethod.enum.average_cost && (
            <Callout.Root highContrast color="amber" variant="soft">
              <Callout.Icon><Info size={16} /></Callout.Icon>
              <Callout.Text>Average cost is IRS-restricted to funds and is hard to change once elected — confirm before applying.</Callout.Text>
            </Callout.Root>
          )}
          <Flex gap="3" justify="end">
            <Button type="button" variant="soft" color="gray" onClick={() => navigate('/investments')}>Cancel</Button>
            <Button type="button" disabled={!canSubmit || submitting} onClick={onSubmit}>Save</Button>
          </Flex>
        </Flex>
      </Card>
    </PageContainer>
  );
};

export default CostBasisSettingsPage;
