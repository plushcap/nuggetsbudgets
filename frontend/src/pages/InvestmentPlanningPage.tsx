import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Controller, useForm, type FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Flex, Grid, Card, Heading, Text, Table, Select, TextField, Button, Badge } from '@radix-ui/themes';
import { Calculator } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import AdvisoryDisclaimer from '../components/AdvisoryDisclaimer';
import FieldError, { fieldErrorProps } from '../components/forms/FieldError';
import { useAccountsQuery } from '../hooks/queries/accounts';
import { useSecuritiesQuery, useSellTaxImpactQuery, useTaxLossHarvestQuery, useConcentrationQuery } from '../hooks/queries/investments';
import { textColorProps } from '../utils/textColor';
import { apiErrorMessage } from '../utils/errors';
import { decimalTextProblem } from '../utils/decimalText';
import { focusFirstError } from '../utils/focusFirstError';
import { EMPTY_LIST } from '../utils/emptyList';
import type { SellTaxImpactParams } from '../services/api/investments';
import { COST_BASIS_METHODS, COST_BASIS_METHOD_LABELS, type CostBasisMethod, formatMoney, sellTaxImpactQuery, accountGroup, accountType } from '@nuggets/shared';
import { oneOf } from '../utils/vocabularyOptions';
import PageContainer from '../components/PageContainer';

const glColor = (n: number): 'gray' | 'green' | 'red' => (n === 0 ? 'gray' : n > 0 ? 'green' : 'red');

/** The sell-tax calculator's inputs, as typed (react-hook-form). */
export interface SellTaxFormData {
  account: string;
  security: string;
  shares: string;
  method: CostBasisMethod;
  st_rate: string;
  lt_rate: string;
}

const RATE_PROBLEM = 'Enter the rate as a fraction from 0 to 1, like 0.25.';
const rateProblem = (rate: string): string | null => {
  const text = rate.trim();
  return text !== '' && Number.isFinite(Number(text)) && Number(text) >= 0 && Number(text) <= 1 ? null : RATE_PROBLEM;
};

/**
 * The calculator's checks: each field in the page's words, then the query as
 * GET /investments/reports/sell-tax-impact reads it (`sellTaxImpactQuery`, the route's own).
 */
export const sellTaxFormSchema = z
  .object({ account: z.string(), security: z.string(), shares: z.string(), method: z.enum(COST_BASIS_METHODS), st_rate: z.string(), lt_rate: z.string() })
  .superRefine((form, ctx) => {
    const problems: Array<[keyof SellTaxFormData, string | null]> = [
      ['account', form.account ? null : 'Choose an investment account.'],
      ['security', form.security ? null : 'Choose a security.'],
      // A plain decimal: a number field takes 1e2.
      ['shares', decimalTextProblem(form.shares, 6)],
      ['st_rate', rateProblem(form.st_rate)],
      ['lt_rate', rateProblem(form.lt_rate)],
    ];
    let refused = false;
    for (const [field, message] of problems) {
      if (!message) continue;
      refused = true;
      ctx.addIssue({ code: 'custom', path: [field], message });
    }
    if (refused) return;
    const checked = sellTaxImpactQuery.safeParse(form);
    for (const issue of checked.success ? [] : checked.error.issues) ctx.addIssue({ code: 'custom', path: [String(issue.path[0] ?? 'shares')], message: issue.message });
  });

/** What the calculator asks for: the figures as numbers, as it always has. */
const sellTaxParams = (form: SellTaxFormData): SellTaxImpactParams => ({
  account: form.account,
  security: form.security,
  shares: Number(form.shares),
  method: form.method,
  st_rate: Number(form.st_rate),
  lt_rate: Number(form.lt_rate),
});

const InvestmentPlanningPage: React.FC = () => {
  const navigate = useNavigate();
  const { data: accounts = EMPTY_LIST } = useAccountsQuery();
  const { data: securities = EMPTY_LIST } = useSecuritiesQuery();
  const investmentAccounts = accounts.filter((a) => a.account_type === accountType.enum.investment || a.account_group === accountGroup.enum.investments);

  // Sell-tax calculator inputs. Calculate stays enabled: one pressed too soon says what to fill in.
  const { control, register, handleSubmit, formState: { errors } } = useForm<SellTaxFormData>({
    defaultValues: { account: '', security: '', shares: '', method: 'fifo', st_rate: '', lt_rate: '' },
    resolver: zodResolver(sellTaxFormSchema),
    // The selects are buttons react-hook-form doesn't focus: focusFirstError, in the fields' order.
    shouldFocusError: false,
  });
  const [submitted, setSubmitted] = useState<SellTaxImpactParams | null>(null);

  const { data: impact, isError, error } = useSellTaxImpactQuery(submitted);
  const { data: tlh } = useTaxLossHarvestQuery();
  const { data: concentration } = useConcentrationQuery(10);

  const calculate = (form: SellTaxFormData) => setSubmitted(sellTaxParams(form));
  const refused = (found: FieldErrors<SellTaxFormData>) =>
    focusFirstError(found, [
      ['account', '#tax-account'],
      ['security', '#tax-security'],
      ['shares', '#tax-shares'],
      ['st_rate', '#tax-st-rate'],
      ['lt_rate', '#tax-lt-rate'],
    ]);
  const problem = (field: keyof SellTaxFormData) => errors[field]?.message ?? null;

  return (
    <PageContainer>
      <PageHeader title="Tax planning" subtitle="Sell-tax preview, loss harvesting, and concentration" icon={<Calculator />} backPath="/investments" />
      <Flex direction="column" gap="3">
        <AdvisoryDisclaimer />

        {/* Sell-tax calculator */}
        <Card>
          <form noValidate onSubmit={handleSubmit(calculate, refused)}>
          <Flex direction="column" gap="3" p="2">
            <Heading size="3">Sell-tax impact calculator</Heading>
            <Grid columns={{ initial: '1', sm: '3' }} gap="3">
              <Flex direction="column" gap="1">
                <Text as="label" htmlFor="tax-account" size="2" weight="medium">Account</Text>
                <Controller control={control} name="account" render={({ field }) => (
                  <Select.Root value={field.value} onValueChange={field.onChange}>
                    <Select.Trigger ref={field.ref} id="tax-account" placeholder="Account" style={{ width: '100%' }} {...fieldErrorProps('tax-account', problem('account'))} />
                    <Select.Content>{investmentAccounts.map((a) => <Select.Item key={a.uuid} value={a.uuid}>{a.name}</Select.Item>)}</Select.Content>
                  </Select.Root>
                )} />
                <FieldError fieldId="tax-account" message={problem('account')} />
              </Flex>
              <Flex direction="column" gap="1">
                <Text as="label" htmlFor="tax-security" size="2" weight="medium">Security</Text>
                <Controller control={control} name="security" render={({ field }) => (
                  <Select.Root value={field.value} onValueChange={field.onChange}>
                    <Select.Trigger ref={field.ref} id="tax-security" placeholder="Security" style={{ width: '100%' }} {...fieldErrorProps('tax-security', problem('security'))} />
                    <Select.Content>{securities.map((s) => <Select.Item key={s.uuid} value={s.uuid}>{s.ticker}</Select.Item>)}</Select.Content>
                  </Select.Root>
                )} />
                <FieldError fieldId="tax-security" message={problem('security')} />
              </Flex>
              <Flex direction="column" gap="1">
                <Text as="label" htmlFor="tax-shares" size="2" weight="medium">Shares</Text>
                <TextField.Root id="tax-shares" type="number" min="0" step="0.000001" placeholder="100" {...register('shares')} {...fieldErrorProps('tax-shares', problem('shares'))} />
                <FieldError fieldId="tax-shares" message={problem('shares')} />
              </Flex>
            </Grid>
            <Grid columns={{ initial: '1', sm: '3' }} gap="3">
              <Flex direction="column" gap="1">
                <Text as="label" htmlFor="tax-method" size="2" weight="medium">Method</Text>
                <Controller control={control} name="method" render={({ field }) => (
                  <Select.Root value={field.value} onValueChange={(v) => field.onChange(oneOf(COST_BASIS_METHODS, v) ?? 'fifo')}>
                    <Select.Trigger ref={field.ref} id="tax-method" style={{ width: '100%' }} />
                    <Select.Content>{COST_BASIS_METHODS.map((m) => <Select.Item key={m} value={m}>{COST_BASIS_METHOD_LABELS[m]}</Select.Item>)}</Select.Content>
                  </Select.Root>
                )} />
              </Flex>
              <Flex direction="column" gap="1">
                <Text as="label" htmlFor="tax-st-rate" size="2" weight="medium">Short-term rate</Text>
                <TextField.Root id="tax-st-rate" type="number" min="0" max="1" step="0.01" {...register('st_rate')} {...fieldErrorProps('tax-st-rate', problem('st_rate'))} />
                <FieldError fieldId="tax-st-rate" message={problem('st_rate')} />
              </Flex>
              <Flex direction="column" gap="1">
                <Text as="label" htmlFor="tax-lt-rate" size="2" weight="medium">Long-term rate</Text>
                <TextField.Root id="tax-lt-rate" type="number" min="0" max="1" step="0.01" {...register('lt_rate')} {...fieldErrorProps('tax-lt-rate', problem('lt_rate'))} />
                <FieldError fieldId="tax-lt-rate" message={problem('lt_rate')} />
              </Flex>
            </Grid>
            <Flex justify="end"><Button type="submit">Calculate</Button></Flex>

            {/* The API's reason, or this, never an error's own text ("Failed to fetch"). */}
            {isError && <Text size="2" color="red">{apiErrorMessage(error, 'Could not calculate — check that a price exists.')}</Text>}
            {impact && (
              <Grid columns={{ initial: '2', md: '4' }} gap="3">
                <Card variant="surface"><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Proceeds</Text><Heading size="5">{formatMoney(impact.plan.totalProceeds)}</Heading></Flex></Card>
                <Card variant="surface"><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Realized G/L</Text><Heading size="5" {...textColorProps(glColor(impact.plan.totalRealized))}>{formatMoney(impact.plan.totalRealized)}</Heading><Text size="1" color="gray">LT {formatMoney(impact.plan.longTermRealized)} · ST {formatMoney(impact.plan.shortTermRealized)}</Text></Flex></Card>
                <Card variant="surface"><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Est. tax</Text><Heading size="5" {...textColorProps(glColor(impact.tax.estimatedTotalTax))}>{formatMoney(impact.tax.estimatedTotalTax)}</Heading></Flex></Card>
                <Card variant="surface"><Flex direction="column" gap="1" p="2"><Text size="1" color="gray">Net after tax</Text><Heading size="5">{formatMoney(impact.tax.netProceedsAfterTax)}</Heading></Flex></Card>
              </Grid>
            )}
          </Flex>
          </form>
        </Card>

        {/* Tax-loss-harvest candidates */}
        <Card>
          <Flex direction="column" gap="2" p="2">
            <Heading size="3">Tax-loss-harvest candidates</Heading>
            {!tlh || tlh.candidates.length === 0 ? <Text size="2" color="gray">No lots are currently at a loss.</Text> : (
              <>
                <Table.Root variant="surface">
                  <Table.Header><Table.Row><Table.ColumnHeaderCell>Security</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">Market value</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">Unrealized loss</Table.ColumnHeaderCell></Table.Row></Table.Header>
                  <Table.Body>
                    {tlh.candidates.map((c) => (
                      <Table.Row key={c.lot_uuid}><Table.Cell>{c.ticker}</Table.Cell><Table.Cell align="right">{formatMoney(c.market_value)}</Table.Cell><Table.Cell align="right"><Text color="red">{formatMoney(c.unrealized_loss)}</Text></Table.Cell></Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
                <Text size="1" color="amber" highContrast>{tlh.note}</Text>
              </>
            )}
          </Flex>
        </Card>

        {/* Concentration */}
        <Card>
          <Flex direction="column" gap="2" p="2">
            <Heading size="3">Concentration (&gt; {concentration?.threshold_pct ?? 10}% flagged)</Heading>
            {!concentration || concentration.rows.length === 0 ? <Text size="2" color="gray">No holdings.</Text> : (
              <Table.Root variant="surface">
                <Table.Header><Table.Row><Table.ColumnHeaderCell>Security</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">Market value</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">% of portfolio</Table.ColumnHeaderCell></Table.Row></Table.Header>
                <Table.Body>
                  {concentration.rows.map((r) => (
                    <Table.Row key={r.securityId}>
                      <Table.Cell><Flex align="center" gap="2">{r.ticker}{r.exceedsThreshold && <Badge highContrast color="amber" variant="soft">concentrated</Badge>}</Flex></Table.Cell>
                      <Table.Cell align="right">{formatMoney(r.marketValue)}</Table.Cell>
                      <Table.Cell align="right">{r.portfolioPct.toFixed(1)}%</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            )}
          </Flex>
        </Card>

        <Flex><Button variant="ghost" onClick={() => navigate('/investments')}>← Back to investments</Button></Flex>
      </Flex>
    </PageContainer>
  );
};

export default InvestmentPlanningPage;
