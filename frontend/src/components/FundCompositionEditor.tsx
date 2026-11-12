import React, { useEffect, useId, useMemo, useState } from 'react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Card, Flex, Box, Grid, Text, TextField, Select, Button, IconButton, Badge, Callout } from '@radix-ui/themes';
import { Plus, Trash2, Save, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { compositionUpsertSchema, type CompositionUpsertInput, securityType as securityTypes } from '@nuggets/shared';
import RadixDatePicker from './RadixDatePicker';
import { useFundCompositionQuery, useUpsertCompositionMutation } from '../hooks/queries/investments';
import type { FundCompositionRow } from '../services/api/investments';
import { logger } from '../utils/logger';
import { apiErrorMessage } from '../utils/errors';
import { todayLocal } from '../utils/dateUtils';
import { useFormReset } from '../hooks/useFormReset';
import FieldError, { fieldErrorProps } from './forms/FieldError';

/**
 * Per-security classification editor (issue: investments allocation). All
 * classification lives in fund_compositions now — there's no single asset_class
 * column on a security. A plain security carries ONE category per dimension; a
 * pass-through fund splits into weighted rows. The allocation report sums each
 * security's value × its weights, so unclassified value shows up as "Unknown".
 */

// Mirror of the backend tolerance (lookThrough.ts WEIGHT_MIN/MAX).
const WEIGHT_MIN = 95;
const WEIGHT_MAX = 105;

const DIMENSIONS = [
  'asset_class', 'sector', 'region', 'country', 'market_cap', 'style', 'credit_quality', 'rate_sensitivity',
] as const;

// Controlled-vocabulary quick-add labels per dimension, aligned to the
// Investment Classification Standard (Morningstar asset allocation / style box;
// GICS 11 sectors). Free-form — you can still type others — but pick from these
// so the same exposure groups into one slice across funds.
const SUGGESTIONS: Record<string, string[]> = {
  // Morningstar asset-allocation buckets (8).
  asset_class: ['Domestic Stock', 'Foreign Stock', 'Domestic Bond', 'Foreign Bond', 'Cash', 'Preferred', 'Convertibles', 'Other'],
  // GICS 11 sectors (verbatim).
  sector: [
    'Communication Services', 'Consumer Discretionary', 'Consumer Staples', 'Energy', 'Financials',
    'Health Care', 'Industrials', 'Information Technology', 'Materials', 'Real Estate', 'Utilities',
  ],
  region: ['North America', 'Europe Developed', 'Asia-Pacific Developed', 'Japan', 'United Kingdom', 'Emerging Markets'],
  // Morningstar equity style box axes.
  market_cap: ['Large Cap', 'Mid Cap', 'Small Cap'],
  style: ['Value', 'Blend', 'Growth'],
  // Morningstar bond style box axes.
  credit_quality: ['High', 'Medium', 'Low'],
  rate_sensitivity: ['Limited', 'Moderate', 'Extensive'],
};

// Some dimensions only describe one *sleeve* of a mixed fund (e.g. sector only
// covers the equity portion of a target-date fund). Nuggets requires each
// dimension to sum to ~100% of the whole fund, so we use the residual-bucket
// convention: enter the sleeve's weights as a share of the WHOLE fund, then fill
// the rest with a remainder row so it still totals 100%. Equity-only dimensions
// leave a "Non-equity" remainder; bond-only dimensions a "Non-bond" one.
const RESIDUAL_LABEL: Record<string, string> = {
  sector: 'Non-equity',
  market_cap: 'Non-equity',
  style: 'Non-equity',
  credit_quality: 'Non-bond',
  rate_sensitivity: 'Non-bond',
};
const DEFAULT_RESIDUAL = 'Unclassified';

// Dimensions that describe only the equity sleeve / only the bond sleeve. The
// rest (asset_class, region, country) describe the holding as a whole.
const EQUITY_DIMS = new Set(['sector', 'market_cap', 'style']);
const BOND_DIMS = new Set(['credit_quality', 'rate_sensitivity']);

// Friendly label + one-line explanation per dimension (the "what am I entering").
const DIM_META: Record<string, { label: string; help: string }> = {
  asset_class: { label: 'Asset class', help: 'Broad asset mix (Morningstar buckets). Applies to every holding.' },
  sector: { label: 'Sector', help: 'GICS industry of the stock holdings.' },
  region: { label: 'Region', help: 'Broad geographic exposure.' },
  country: { label: 'Country', help: 'Specific country exposure — use only when you have country-level data.' },
  market_cap: { label: 'Market cap', help: 'Company size of the stock holdings (equity style box).' },
  style: { label: 'Style', help: 'Value / Blend / Growth of the stock holdings (equity style box).' },
  credit_quality: { label: 'Credit quality', help: 'Credit rating of the bond holdings (bond style box).' },
  rate_sensitivity: { label: 'Rate sensitivity', help: 'Interest-rate sensitivity / duration of the bond holdings (bond style box).' },
};

const typeNoun = (t: string): string =>
  ({ stock: 'stock', bond: 'bond', etf: 'ETF', mutual_fund: 'mutual fund', money_market: 'money-market / cash position', crypto: 'crypto holding', other: 'holding' }[t] ?? 'holding');

type Applicability = 'applies' | 'sleeve' | 'na';

/**
 * Whether a dimension applies to a security of this type. Individual securities
 * get a definite yes/no from their type (a bond has no sectors; a stock has no
 * credit quality). Funds (etf/mutual_fund) can hold any mix, so equity/bond
 * dimensions "apply to a sleeve" — guided, not blocked.
 */
function applicability(securityType: string, dimension: string): { state: Applicability; note?: string } {
  const isFund = securityType === securityTypes.enum.etf || securityType === securityTypes.enum.mutual_fund;
  if (dimension === 'asset_class') return { state: 'applies' };
  if (dimension === 'region' || dimension === 'country') {
    if (securityType === securityTypes.enum.money_market || securityType === securityTypes.enum.crypto) {
      return { state: 'na', note: `A ${typeNoun(securityType)} doesn't have a geographic breakdown.` };
    }
    return { state: 'applies' };
  }
  if (EQUITY_DIMS.has(dimension)) {
    if (securityType === securityTypes.enum.stock) return { state: 'applies' };
    if (isFund) return { state: 'sleeve', note: 'Describes only the stock (equity) sleeve of the fund.' };
    return { state: 'na', note: `Describes stock holdings — a ${typeNoun(securityType)} has none.` };
  }
  if (BOND_DIMS.has(dimension)) {
    if (securityType === securityTypes.enum.bond) return { state: 'applies' };
    if (isFund) return { state: 'sleeve', note: 'Describes only the bond (fixed-income) sleeve of the fund.' };
    return { state: 'na', note: `Describes bond holdings — a ${typeNoun(securityType)} has none.` };
  }
  return { state: 'applies' };
}

/** A category and its weight, as typed: the weight is sent as typed. */
export interface CompositionRow {
  value: string;
  weight: string;
}

/**
 * The classification form (react-hook-form): the date it is as of and the chosen
 * dimension's categories. The dimension is chosen beside it: choosing another starts the form
 * over from that dimension's saved rows.
 */
export interface FundCompositionFormData {
  snapshot_date: string;
  rows: CompositionRow[];
}

const emptyRow = (): CompositionRow => ({ value: '', weight: '' });

/** A dimension's rows to start from: the latest saved snapshot's (one, for a plain security). */
export function seedRows(composition: readonly FundCompositionRow[] | undefined, dimension: string, singleMode: boolean): CompositionRow[] {
  const forDim = (composition ?? [])
    .filter((r) => r.dimension === dimension)
    .map((r) => ({ value: r.dimension_value, weight: String(r.weight_percentage) }));
  if (singleMode) return [forDim[0] ?? emptyRow()];
  return forDim.length > 0 ? forDim : [emptyRow()];
}

/** The weights' total, to the tenth the badge shows. */
const weightTotal = (rows: readonly CompositionRow[]) => Math.round(rows.reduce((s, r) => s + (parseFloat(r.weight) || 0), 0) * 10) / 10;

/**
 * A weight the API reads: digits, with an optional decimal part. A blank one is refused beside
 * its row, not sent as "" (the API's refusal named no row) nor as 0.
 */
export const weightProblem = (weight: string): string | null => {
  const w = weight.trim();
  if (w === '') return 'Enter a weight (0 for none).';
  return /^(\d+(\.\d*)?|\.\d+)$/.test(w) ? null : 'Enter the weight as a number, like 12.5.';
};

/**
 * The body POST /investments/compositions takes for the dimension: a plain security's one
 * category at 100%, a fund's weights as typed (the API reads them exactly, to 6 places;
 * Number() made "1e2" 100 and "" 0).
 */
export function compositionBody(securityUuid: string, dimension: string, singleMode: boolean, form: FundCompositionFormData): CompositionUpsertInput {
  const dimensionRows = singleMode
    ? [{ dimension_value: (form.rows[0]?.value ?? '').trim(), weight_percentage: 100 }]
    : form.rows.map((r) => ({ dimension_value: r.value.trim(), weight_percentage: r.weight.trim() }));
  return { security_uuid: securityUuid, snapshot_date: form.snapshot_date, dimensions: { [dimension]: dimensionRows }, source: 'manual' };
}

/** What the form says when a fund's weights don't total ~100%. */
const totalMessage = (dimension: string) => {
  const sleeve = (RESIDUAL_LABEL[dimension] ?? DEFAULT_RESIDUAL) === 'Non-bond' ? 'bonds' : 'stocks';
  return `Weights must total between ${WEIGHT_MIN}% and ${WEIGHT_MAX}%. For a fund that's only partly ${sleeve}, enter each weight as a share of the whole fund and use “Fill remaining” to add the leftover sleeve.`;
};

/**
 * The form's checks, in the order its fields are focused: a plain security's category; each
 * of a fund's rows named and weighted, then the weights within the tolerance; then the body
 * as compositionUpsertSchema (the route's own) reads it, each issue on its row.
 */
export const fundCompositionSchema = (securityUuid: string, dimension: string, singleMode: boolean) =>
  z
    .object({ snapshot_date: z.string(), rows: z.array(z.object({ value: z.string(), weight: z.string() })) })
    .superRefine((form, ctx) => {
      let refused = false;
      const refuse = (path: (string | number)[], message: string) => {
        refused = true;
        ctx.addIssue({ code: 'custom', path, message });
      };
      if (singleMode) {
        if (!(form.rows[0]?.value ?? '').trim()) refuse(['rows', 0, 'value'], 'Enter a category.');
      } else {
        form.rows.forEach((row, i) => {
          if (!row.value.trim()) refuse(['rows', i, 'value'], 'Enter a category, or remove the row.');
          const problem = weightProblem(row.weight);
          if (problem) refuse(['rows', i, 'weight'], problem);
        });
        const total = weightTotal(form.rows);
        if (total < WEIGHT_MIN || total > WEIGHT_MAX) refuse(['rows'], totalMessage(dimension));
      }
      if (refused) return;
      const checked = compositionUpsertSchema.safeParse(compositionBody(securityUuid, dimension, singleMode, form));
      if (checked.success) return;
      for (const issue of checked.error.issues) {
        // dimensions.<dimension>.<row>.<field>
        const row = issue.path[2];
        const path = typeof row !== 'number' ? ['rows'] : singleMode ? ['rows', 0, 'value'] : ['rows', row, 'weight'];
        ctx.addIssue({ code: 'custom', path, message: issue.message });
      }
    });

const FundCompositionEditor: React.FC<{ securityUuid: string; isPassThrough: boolean; securityType: string }> = ({ securityUuid, isPassThrough, securityType }) => {
  const { data: composition, isLoading } = useFundCompositionQuery(securityUuid);
  const upsert = useUpsertCompositionMutation();

  // A plain (non-pass-through) security holds a single category per dimension.
  const singleMode = !isPassThrough;

  // Only offer dimensions that apply to this security type — you can't classify
  // sectors on a bond, or credit quality on a stock.
  const applicableDimensions = useMemo(
    () => DIMENSIONS.filter((d) => applicability(securityType, d).state !== 'na'),
    [securityType],
  );

  const [chosenDimension, setChosenDimension] = useState<string>('asset_class');
  // A chosen dimension that doesn't apply to this security shows asset class
  // (which always applies) instead.
  const dimension = applicableDimensions.includes(chosenDimension as (typeof DIMENSIONS)[number])
    ? chosenDimension
    : 'asset_class';

  const schema = useMemo(() => fundCompositionSchema(securityUuid, dimension, singleMode), [securityUuid, dimension, singleMode]);
  const resolver = useMemo(() => zodResolver(schema), [schema]);
  const { control, handleSubmit, reset, getValues, formState: { submitCount } } = useForm<FundCompositionFormData>({
    defaultValues: { snapshot_date: todayLocal(), rows: seedRows(composition, dimension, singleMode) },
    resolver,
    // The first field with a problem is focused by its id, after the render that shows it.
    shouldFocusError: false,
  });
  const { fields, append, remove, replace } = useFieldArray({ control, name: 'rows' });
  const snapshotDate = useWatch({ control, name: 'snapshot_date' });
  const rows = useWatch({ control, name: 'rows' });
  // The rows start over from the latest saved snapshot whenever it loads, or the dimension or
  // the arity mode changes, with the date kept; so do the messages (another dimension starts clean).
  useFormReset(reset, { snapshot_date: snapshotDate, rows: seedRows(composition, dimension, singleMode) }, [composition, dimension, singleMode]);

  const totalRounded = weightTotal(rows);
  const withinTolerance = totalRounded >= WEIGHT_MIN && totalRounded <= WEIGHT_MAX;

  // Residual-bucket helper: fill the gap to 100% with a remainder row so a
  // sleeve-only dimension (sector, credit_quality, …) still validates.
  const residualLabel = RESIDUAL_LABEL[dimension] ?? DEFAULT_RESIDUAL;
  const nonResidualTotal = useMemo(
    () =>
      rows
        .filter((r) => r.value.trim().toLowerCase() !== residualLabel.toLowerCase())
        .reduce((s, r) => s + (parseFloat(r.weight) || 0), 0),
    [rows, residualLabel],
  );
  const remainder = Math.round((100 - nonResidualTotal) * 10) / 10;
  const fillRemainder = () => {
    const others = rows.filter(
      (r) => r.value.trim() && r.value.trim().toLowerCase() !== residualLabel.toLowerCase(),
    );
    if (remainder <= 0) return;
    replace([...others, { value: residualLabel, weight: String(remainder) }]);
  };

  const addRow = () => append(emptyRow());
  const removeRow = (i: number) => (rows.length === 1 ? replace([emptyRow()]) : remove(i));

  const addSuggestion = (label: string) => {
    if (singleMode) {
      replace([{ value: label, weight: '' }]);
      return;
    }
    if (rows.some((r) => r.value.trim().toLowerCase() === label.toLowerCase())) return;
    // Replace a single empty starter row rather than leaving it dangling.
    const [only] = rows;
    if (rows.length === 1 && only && !only.value.trim() && !only.weight) replace([{ value: label, weight: '' }]);
    else append({ value: label, weight: '' });
  };

  const idBase = useId();
  const categoryId = `${idBase}-category`;
  const rowCategoryId = (i: number) => `${idBase}-category-${i}`;
  const weightId = (i: number) => `${idBase}-weight-${i}`;
  const totalId = `${idBase}-total`;
  /** The control a check's path is about. */
  const idFor = (path: readonly PropertyKey[]): string => {
    if (path.length < 2) return totalId;
    if (singleMode) return categoryId;
    const i = Number(path[1]);
    return path[2] === 'weight' ? weightId(i) : rowCategoryId(i);
  };

  // Each check's message by control, from the values as they are; shown once a save is tried.
  const problems = new Map<string, string>();
  const checked = schema.safeParse({ snapshot_date: snapshotDate, rows });
  for (const issue of checked.success ? [] : checked.error.issues) {
    const id = idFor(issue.path);
    if (!problems.has(id)) problems.set(id, issue.message);
  }
  const shown = (id: string): string | null => (submitCount > 0 ? problems.get(id) ?? null : null);
  // The total's message shows as the weights are typed, as it always has.
  const totalProblem = submitCount > 0 || rows.some((r) => r.weight) ? problems.get(totalId) ?? null : null;

  // The first bad box takes the focus after the render that shows its message, so it is read with it.
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null);
  useEffect(() => {
    if (focusRequest) document.getElementById(focusRequest.id)?.focus();
  }, [focusRequest]);

  const onSave = async (form: FundCompositionFormData) => {
    try {
      await upsert.mutateAsync(compositionBody(securityUuid, dimension, singleMode, form));
      toast.success('Classification saved');
    } catch (err) {
      logger.error({ err }, 'Failed to save fund composition');
      toast.error(apiErrorMessage(err, 'Failed to save classification'));
    }
  };
  const onRefused = () => {
    const checked = schema.safeParse(getValues());
    const first = checked.success ? undefined : checked.error.issues[0];
    if (first) setFocusRequest({ id: idFor(first.path) });
  };

  const suggestions = SUGGESTIONS[dimension] ?? [];
  const fit = applicability(securityType, dimension);

  return (
    <Card>
      <form noValidate onSubmit={handleSubmit(onSave, onRefused)}>
        <Flex direction="column" gap="4" p="2">
          <Box>
            <Text as="div" size="3" weight="bold">Classification {singleMode ? '' : '(look-through)'}</Text>
            <Text as="div" size="2" color="gray">
              {singleMode
                ? 'Pick one category per dimension. To split this into multiple weighted categories (e.g. a target-date fund), mark it as a pass-through fund above and save.'
                : `Split this fund into weighted categories per dimension. Weights should total ~100% (${WEIGHT_MIN}–${WEIGHT_MAX}% allowed); any shortfall lands in the allocation report's "Unknown" bucket.`}
            </Text>
          </Box>

          <Grid columns={{ initial: '1', sm: '2' }} gap="3">
            <label>
              <Text as="div" size="2" mb="1" weight="medium">Dimension</Text>
              <Select.Root value={dimension} onValueChange={setChosenDimension}>
                <Select.Trigger style={{ width: '100%' }} />
                <Select.Content>
                  {applicableDimensions.map((d) => <Select.Item key={d} value={d}>{DIM_META[d]?.label ?? d.replace('_', ' ')}</Select.Item>)}
                </Select.Content>
              </Select.Root>
            </label>
            <Box>
              <Text as="div" id={`${idBase}-as-of-label`} size="2" mb="1" weight="medium">As-of date</Text>
              <Controller
                control={control}
                name="snapshot_date"
                render={({ field }) => <RadixDatePicker aria-labelledby={`${idBase}-as-of-label`} value={field.value} onChange={field.onChange} />}
              />
            </Box>
          </Grid>

          {/* Teach what this dimension is and which holdings it applies to. */}
          <Callout.Root highContrast color={fit.state === 'sleeve' ? 'amber' : 'gray'}>
            <Callout.Icon><Info size={16} /></Callout.Icon>
            <Callout.Text>
              <Text as="span" weight="medium">{DIM_META[dimension]?.label ?? dimension}:</Text>{' '}
              {DIM_META[dimension]?.help}
              {fit.note ? ` ${fit.note}` : ''}
              {fit.state === 'sleeve'
                ? ` Enter each weight as a share of the whole fund and use "Fill remaining" for the rest of the fund.`
                : ''}
            </Callout.Text>
          </Callout.Root>

          {suggestions.length > 0 && (
            <Flex gap="2" wrap="wrap" align="center">
              <Text size="1" color="gray">Quick {singleMode ? 'pick' : 'add'}:</Text>
              {suggestions.map((s) => (
                <Button key={s} type="button" size="1" variant="soft" onClick={() => addSuggestion(s)}>
                  <Plus size={12} />{s}
                </Button>
              ))}
            </Flex>
          )}

          {isLoading ? (
            <Text size="2" color="gray">Loading classification…</Text>
          ) : singleMode ? (
            <Flex direction="column" gap="1">
              <Text as="label" htmlFor={categoryId} size="2" weight="medium">Category</Text>
              <Controller
                control={control}
                name="rows.0.value"
                render={({ field }) => (
                  <TextField.Root
                    id={categoryId}
                    placeholder="e.g. Domestic Stock"
                    value={field.value ?? ''}
                    onChange={(e) => field.onChange(e.target.value)}
                    onBlur={field.onBlur}
                    {...fieldErrorProps(categoryId, shown(categoryId))}
                  />
                )}
              />
              <FieldError fieldId={categoryId} message={shown(categoryId)} />
            </Flex>
          ) : (
            <Flex direction="column" gap="2">
              {fields.map((row, i) => (
                <Box key={row.id}>
                  <Flex gap="2" align="center">
                    <Box flexGrow="1">
                      <Controller
                        control={control}
                        name={`rows.${i}.value`}
                        render={({ field }) => (
                          <TextField.Root
                            id={rowCategoryId(i)}
                            aria-label={`Category ${i + 1}`}
                            placeholder="e.g. Domestic Stock"
                            value={field.value}
                            onChange={(e) => field.onChange(e.target.value)}
                            onBlur={field.onBlur}
                            {...fieldErrorProps(rowCategoryId(i), shown(rowCategoryId(i)))}
                          />
                        )}
                      />
                    </Box>
                    <Box width="110px">
                      <Controller
                        control={control}
                        name={`rows.${i}.weight`}
                        render={({ field }) => (
                          <TextField.Root
                            id={weightId(i)}
                            aria-label={`Category ${i + 1} weight`}
                            type="number"
                            inputMode="decimal"
                            placeholder="%"
                            value={field.value}
                            onChange={(e) => field.onChange(e.target.value)}
                            onBlur={field.onBlur}
                            {...fieldErrorProps(weightId(i), shown(weightId(i)))}
                          >
                            <TextField.Slot side="right">%</TextField.Slot>
                          </TextField.Root>
                        )}
                      />
                    </Box>
                    <IconButton type="button" variant="soft" color="gray" aria-label="Remove row" onClick={() => removeRow(i)}>
                      <Trash2 size={16} />
                    </IconButton>
                  </Flex>
                  <FieldError fieldId={rowCategoryId(i)} message={shown(rowCategoryId(i))} />
                  <FieldError fieldId={weightId(i)} message={shown(weightId(i))} />
                </Box>
              ))}
              <Flex justify="between" align="center" mt="1" wrap="wrap" gap="2">
                <Flex gap="2" wrap="wrap">
                  <Button type="button" size="1" variant="soft" color="gray" onClick={addRow}>
                    <Plus size={12} />Add row
                  </Button>
                  {remainder >= 0.5 && nonResidualTotal > 0 && (
                    <Button type="button" size="1" variant="soft" onClick={fillRemainder}>
                      <Plus size={12} />Fill remaining {remainder}% as &ldquo;{residualLabel}&rdquo;
                    </Button>
                  )}
                </Flex>
                <Badge highContrast color={withinTolerance ? 'green' : 'amber'} variant="soft" radius="full">Total: {totalRounded}%</Badge>
              </Flex>
              {/* Focused, with its message, when a save is refused for the total. */}
              {totalProblem && <Text as="p" id={totalId} tabIndex={-1} size="1" color="amber" highContrast>{totalProblem}</Text>}
            </Flex>
          )}

          <Flex justify="end">
            {/* Enabled: a save it can't make says why, beside the field (CLAUDE.md's form rules). */}
            <Button type="submit" loading={upsert.isPending}>
              <Save size={16} />Save classification
            </Button>
          </Flex>
        </Flex>
      </form>
    </Card>
  );
};

export default FundCompositionEditor;
