import React from 'react';
import { type UseFormReturn, Controller } from 'react-hook-form';
import { Flex, Text, TextField, Select, Checkbox, TextArea, Grid } from '@radix-ui/themes';
import CurrencyInput from '../CurrencyInput';
import FormSelectRoot from './FormSelectRoot';
import FieldError, { fieldErrorProps } from './FieldError';
import { optionalAmountInput } from './optionalAmount';
import RadixIconPicker from '../RadixIconPicker';
import type { Account, Institution } from '../../services/api';
import {
  ACCOUNT_GROUPS,
  ACCOUNT_GROUP_LABELS,
  ACCOUNT_TYPE_LABELS,
  ASSET_TYPES,
  ASSET_TYPE_LABELS,
  type AccountType,
  type AssetType,
  assetType,
} from '@nuggets/shared';

/**
 * Account form shape + defaults, co-located with the shared fields component.
 *
 * Create and edit share one field set (the add form was brought up to match
 * edit, which had accreted subtype / custom_sort / require_zero_balance; edit
 * in turn gained the editable starting balance). The image file and the
 * SimpleFin import block are rendered by the pages themselves — the image UI
 * differs between create/edit, and the bank-connection block is genuinely
 * edit-only (it connects an existing account to a bank).
 */
export interface AccountFormData {
  name: string;
  type: string; // 'Asset' | 'Liability'
  account_type: string;
  account_group: string;
  subtype?: string | null;
  institution_id?: number | null;
  account_number?: string | null;
  routing_number?: string | null;
  initial_balance: number;
  notes?: string | null;
  instructions?: string | null;
  icon: string;
  custom_sort?: number | null;
  close_account: boolean;
  hide_transactions: boolean;
  hide_account: boolean;
  exclude_account_balance: boolean;
  is_envelope_account: boolean;
  require_zero_balance: boolean;
  default_pay_from_account_id?: number | null;
  account_image?: File | string | null;
  // SimpleFin import settings (edit-only UI, but part of the form state there).
  import_account_id?: string | undefined;
  import_enabled?: boolean;
  import_account_rebalance?: boolean;
  import_auto_match_merchants?: boolean;
  import_auto_assign_budget_period?: boolean;
  import_auto_assign_budget_item?: boolean;
  import_auto_review?: boolean;
  import_default_assigned_to?: number | undefined;
}

export const createDefaultAccountForm = (): AccountFormData => ({
  name: '',
  type: 'Asset',
  account_type: 'checking',
  account_group: 'cash',
  subtype: '',
  institution_id: null,
  account_number: '',
  routing_number: '',
  initial_balance: 0,
  notes: '',
  instructions: '',
  icon: 'CreditCard',
  custom_sort: null,
  close_account: false,
  hide_transactions: false,
  hide_account: false,
  exclude_account_balance: false,
  is_envelope_account: false,
  require_zero_balance: false,
  default_pay_from_account_id: null,
  account_image: null,
  import_enabled: false,
  import_account_rebalance: false,
  import_auto_match_merchants: true,
});

// The options come from the shared lists, so every stored group shows, not a blank
// Select. `credit_cards` is a legacy alias of `credit cards` that still exists in data.
const accountGroups = ACCOUNT_GROUPS.map((value) => ({ value, label: ACCOUNT_GROUP_LABELS[value] }));

const accountCategories = ASSET_TYPES.map((value) => ({ value, label: ASSET_TYPE_LABELS[value] }));

/** The account types each category offers ('other' is in both). */
const ASSET_ACCOUNT_TYPES: AccountType[] = ['checking', 'savings', 'investment', 'business', 'cash', 'other'];
const LIABILITY_ACCOUNT_TYPES: AccountType[] = ['credit_card', 'loan', 'mortgage', 'line_of_credit', 'other'];
const accountTypeOptions = (types: AccountType[], category: AssetType) =>
  types.map((value) => ({ value, label: value === 'other' ? `Other ${category}` : ACCOUNT_TYPE_LABELS[value] }));

const assetTypes = accountTypeOptions(ASSET_ACCOUNT_TYPES, 'Asset');
const liabilityTypes = accountTypeOptions(LIABILITY_ACCOUNT_TYPES, 'Liability');

const subtypeOptions = [
  { value: 'none', label: 'None' },
  { value: '401k', label: '401k' },
  { value: 'Roth IRA', label: 'Roth IRA' },
  { value: 'IRA', label: 'IRA' },
  { value: 'Stocks', label: 'Stocks' },
  { value: 'Cash', label: 'Cash' },
];

type SelectOption = { value: string; label: string };

/** `labels`' own label for `value` (not one an object inherits, like `constructor`). */
const ownLabel = (labels: Readonly<Record<string, string>>, value: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(labels, value) ? labels[value] : undefined;

/**
 * A Radix Select renders a BLANK trigger when its controlled value isn't among
 * its items — which is how legacy/unexpected stored values made the Account
 * Classification fields "disappear". Guarantee the current value
 * is always present by appending it as a visible, selectable option instead of
 * silently rendering nothing. A value `labels` names is shown by its label: a
 * credit card with no category is an asset (as net worth counts it), outside
 * the asset types but no legacy value.
 */
export const withCurrentValue = (
  options: SelectOption[],
  current: string | null | undefined,
  labels: Readonly<Record<string, string>> = {},
): SelectOption[] =>
  current && !options.some((o) => o.value === current)
    ? [...options, { value: current, label: ownLabel(labels, current) ?? `${current} (legacy value)` }]
    : options;

const settingFields = [
  ['is_envelope_account', 'Designate as envelope account for budget comparison'],
  ['close_account', 'Account is closed'],
  ['exclude_account_balance', 'Exclude from net worth calculation'],
  ['hide_transactions', 'Hide transactions from lists and reports'],
  ['hide_account', 'Hide account from account lists'],
  ['require_zero_balance', 'Require zero balance at month-end'],
] as const;

interface AccountFormFieldsProps {
  form: UseFormReturn<AccountFormData>;
  institutions: Institution[];
  loadingInstitutions?: boolean;
  /** Asset accounts offered as the "default pay-from" for liability accounts. */
  accounts?: Account[];
  /**
   * Show the Initial Balance field (Add Account only). The opening balance is a
   * 'starting balance' transaction, so Edit Account doesn't offer it.
   */
  showInitialBalance?: boolean;
}

/** Each section's divider above it. */
const SECTION_CLASS = 'border-t border-[var(--gray-6)]';

/**
 * Shared field block for the add/edit account forms. The parent renders the
 * image section above and (edit only) the SimpleFin import block below, plus
 * the page chrome and submit.
 */
const AccountFormFields: React.FC<AccountFormFieldsProps> = ({ form, institutions, loadingInstitutions, accounts = [], showInitialBalance = true }) => {
  const { register, control, watch, setValue, formState: { errors } } = form;
  const selectedType = watch('type');
  const isEnvelopeAccount = watch('is_envelope_account');
  const getAvailableAccountTypes = () => (selectedType === assetType.enum.Asset ? assetTypes : liabilityTypes);
  // Only asset accounts make sense as the counterparty; the parent already
  // excludes the account being edited from this list.
  const payFromOptions = accounts.filter((a) => a.type === assetType.enum.Asset && !a.hide_account && !a.close_account);
  // The default counterparty applies to liabilities (pay-from) and to the envelope
  // account (the other side of a Close-Out reconciliation transfer, either direction).
  const showCounterpartyAccount = selectedType === assetType.enum.Liability || isEnvelopeAccount;
  const counterpartyLabel = selectedType === assetType.enum.Liability ? 'Default Pay-From Account' : 'Default Transfer Account';
  const counterpartySectionTitle = selectedType === assetType.enum.Liability ? 'Payment' : 'Transfers';
  const counterpartyHelp = selectedType === assetType.enum.Liability
    ? 'Pre-filled as the source when paying this account from Close-Out.'
    : 'Pre-filled as the other side when transferring to/from this envelope account on Close-Out.';

  return (
    <>
      {/* Basic Account Information */}
      <Flex direction="column" gap="3" pt="2" className={SECTION_CLASS}>
        <Text as="p" size="2" weight="medium">Basic Account Information</Text>
        <Grid columns={{ initial: '1', sm: '2' }} gap="4">
          <Flex direction="column" gap="1">
            <Text as="label" size="2" weight="medium" htmlFor="name">
              Account Name *
            </Text>
            <TextField.Root
              id="name"
              {...fieldErrorProps('name', errors.name)}
              {...register('name')}
              placeholder="e.g., Primary Checking"
              size="3"
              variant="surface"
            />
            <FieldError fieldId="name" message={errors.name?.message as string | undefined} />
          </Flex>

          <Flex direction="column" gap="1">
            <Text as="label" size="2" weight="medium" htmlFor="institution_id">
              Financial Institution
            </Text>
            <Controller
              control={control}
              name="institution_id"
              render={({ field }) => (
                <FormSelectRoot
                  value={field.value?.toString() || 'none'}
                  onValueChange={(value) => field.onChange(value === 'none' ? null : parseInt(value))}
                  disabled={loadingInstitutions}
                  size="3"
                >
                  <Select.Trigger id="institution_id" placeholder="Select Institution..." />
                  <Select.Content>
                    <Select.Item value="none">Select Institution...</Select.Item>
                    {institutions.map(institution => (
                      <Select.Item key={institution.id} value={institution.id.toString()}>
                        {institution.name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </FormSelectRoot>
              )}
            />
          </Flex>
        </Grid>
      </Flex>

      {/* Account Classification */}
      <Flex direction="column" gap="3" pt="2" className={SECTION_CLASS}>
        <Text as="p" size="2" weight="medium">Account Classification</Text>
        <Grid columns={{ initial: '1', sm: '3' }} gap="4">
          <Flex direction="column" gap="1">
            <Text as="label" size="2" weight="medium" htmlFor="account_group">
              Account Group *
            </Text>
            <Controller
              control={control}
              name="account_group"
              render={({ field }) => (
                <FormSelectRoot value={field.value} onValueChange={field.onChange} size="3">
                  <Select.Trigger id="account_group" {...fieldErrorProps('account_group', errors.account_group)} />
                  <Select.Content>
                    {withCurrentValue(accountGroups, field.value).map(group => (
                      <Select.Item key={group.value} value={group.value}>{group.label}</Select.Item>
                    ))}
                  </Select.Content>
                </FormSelectRoot>
              )}
            />
            <FieldError fieldId="account_group" message={errors.account_group?.message as string | undefined} />
          </Flex>

          <Flex direction="column" gap="1">
            <Text as="label" size="2" weight="medium" htmlFor="type">
              Account Category *
            </Text>
            <Controller
              control={control}
              name="type"
              render={({ field }) => (
                <FormSelectRoot
                  value={field.value}
                  onValueChange={(value) => {
                    field.onChange(value);
                    // Reset account_type to the first option of the new category.
                    const [first] = value === 'Asset' ? assetTypes : liabilityTypes;
                    if (first) setValue('account_type', first.value);
                  }}
                  size="3"
                >
                  <Select.Trigger id="type" {...fieldErrorProps('type', errors.type)} />
                  <Select.Content>
                    {withCurrentValue(accountCategories, field.value).map(category => (
                      <Select.Item key={category.value} value={category.value}>{category.label}</Select.Item>
                    ))}
                  </Select.Content>
                </FormSelectRoot>
              )}
            />
            <FieldError fieldId="type" message={errors.type?.message as string | undefined} />
          </Flex>

          <Flex direction="column" gap="1">
            <Text as="label" size="2" weight="medium" htmlFor="account_type">
              Account Type *
            </Text>
            <Controller
              control={control}
              name="account_type"
              render={({ field }) => (
                <FormSelectRoot value={field.value} onValueChange={field.onChange} size="3">
                  <Select.Trigger id="account_type" {...fieldErrorProps('account_type', errors.account_type)} />
                  <Select.Content>
                    {withCurrentValue(getAvailableAccountTypes(), field.value, ACCOUNT_TYPE_LABELS).map(type => (
                      <Select.Item key={type.value} value={type.value}>{type.label}</Select.Item>
                    ))}
                  </Select.Content>
                </FormSelectRoot>
              )}
            />
            <FieldError fieldId="account_type" message={errors.account_type?.message as string | undefined} />
          </Flex>

          <Flex direction="column" gap="1">
            <Text as="label" size="2" weight="medium" htmlFor="subtype">
              Account Subtype
            </Text>
            <Controller
              control={control}
              name="subtype"
              render={({ field }) => (
                <FormSelectRoot
                  value={field.value || 'none'}
                  onValueChange={(value) => field.onChange(value === 'none' ? '' : value)}
                  size="3"
                >
                  <Select.Trigger id="subtype" />
                  <Select.Content>
                    {withCurrentValue(subtypeOptions, field.value || 'none').map(sub => (
                      <Select.Item key={sub.value} value={sub.value}>{sub.label}</Select.Item>
                    ))}
                  </Select.Content>
                </FormSelectRoot>
              )}
            />
          </Flex>
        </Grid>
      </Flex>

      {/* Default counterparty — liability pay-from, or the envelope account's transfer partner */}
      {showCounterpartyAccount && (
        <Flex direction="column" gap="3" pt="2" className={SECTION_CLASS}>
          <Text as="p" size="2" weight="medium">{counterpartySectionTitle}</Text>
          <Grid columns={{ initial: '1', sm: '2' }} gap="4">
            <Flex direction="column" gap="1">
              <Text as="label" size="2" weight="medium" htmlFor="default_pay_from_account_id">
                {counterpartyLabel}
              </Text>
              <Controller
                control={control}
                name="default_pay_from_account_id"
                render={({ field }) => (
                  <FormSelectRoot
                    value={field.value != null ? field.value.toString() : 'none'}
                    onValueChange={(value) => field.onChange(value === 'none' ? null : parseInt(value))}
                    size="3"
                  >
                    <Select.Trigger id="default_pay_from_account_id" placeholder="Select account..." />
                    <Select.Content>
                      <Select.Item value="none">None</Select.Item>
                      {payFromOptions.map((a) => (
                        <Select.Item key={a.id} value={a.id.toString()}>{a.name}</Select.Item>
                      ))}
                    </Select.Content>
                  </FormSelectRoot>
                )}
              />
              <Text size="1" color="gray">
                {counterpartyHelp}
              </Text>
            </Flex>
          </Grid>
        </Flex>
      )}

      {/* Account Numbers */}
      <Flex direction="column" gap="3" pt="2" className={SECTION_CLASS}>
        <Text as="p" size="2" weight="medium">Account Numbers</Text>
        <Grid columns={{ initial: '1', sm: '2' }} gap="4">
          <Flex direction="column" gap="1">
            <Text as="label" size="2" weight="medium" htmlFor="account_number">
              Account Number
            </Text>
            <TextField.Root
              id="account_number"
              {...register('account_number')}
              placeholder="Last 4 digits: ****1234"
              size="3"
              variant="surface"
            />
          </Flex>

          <Flex direction="column" gap="1">
            <Text as="label" size="2" weight="medium" htmlFor="routing_number">
              Routing Number
            </Text>
            <TextField.Root
              id="routing_number"
              {...register('routing_number')}
              placeholder="9-digit routing number"
              size="3"
              variant="surface"
            />
          </Flex>
        </Grid>
      </Flex>

      {/* Account Details */}
      <Flex direction="column" gap="3" pt="2" className={SECTION_CLASS}>
        <Text as="p" size="2" weight="medium">Account Details</Text>
        <Grid columns={{ initial: '1', sm: '3' }} gap="4">
          {showInitialBalance ? (
            <Flex direction="column" gap="1">
              <Text as="label" size="2" weight="medium" htmlFor="initial_balance">
                Initial Balance
              </Text>
              <Controller
                control={control}
                name="initial_balance"
                render={({ field }) => (
                  <CurrencyInput
                    id="initial_balance"
                    name="initial_balance"
                    {...optionalAmountInput(field)}
                    {...fieldErrorProps('initial_balance', errors.initial_balance)}
                    size="3"
                    allowNegative
                  />
                )}
              />
              <FieldError fieldId="initial_balance" message={errors.initial_balance?.message} />
              <Text size="1" color="gray">Recorded as a Starting Balance transaction.</Text>
            </Flex>
          ) : (
            <Flex direction="column" gap="1">
              <Text as="p" size="2" weight="medium">Opening Balance</Text>
              <Text size="1" color="gray">
                Change it by editing the account&apos;s Starting Balance transaction, or with Adjust Balance on the account page.
              </Text>
            </Flex>
          )}

          <Flex direction="column" gap="1">
            {/* The shared Lucide-based picker used across the app; its value space
                is the canonical PascalCase icon names stored in accounts.icon. */}
            <Controller
              control={control}
              name="icon"
              render={({ field }) => (
                <RadixIconPicker
                  value={field.value || 'CreditCard'}
                  onChange={field.onChange}
                  label="Account Icon"
                />
              )}
            />
          </Flex>

          <Flex direction="column" gap="1">
            <Text as="label" size="2" weight="medium" htmlFor="custom_sort">
              Custom Sort Order
            </Text>
            <Controller
              control={control}
              name="custom_sort"
              render={({ field }) => (
                <TextField.Root
                  id="custom_sort"
                  type="number"
                  value={field.value !== null && field.value !== undefined ? field.value.toString() : ''}
                  onChange={(e) => field.onChange(e.target.value ? parseInt(e.target.value) : null)}
                  placeholder="Optional sort order"
                  size="3"
                />
              )}
            />
          </Flex>
        </Grid>
      </Flex>

      {/* Notes */}
      <Flex direction="column" gap="1">
        <Text as="label" size="2" weight="medium" htmlFor="notes">
          Notes
        </Text>
        <TextArea
          id="notes"
          {...register('notes')}
          placeholder="Optional notes about this account..."
          size="3"
          variant="surface"
          rows={3}
        />
      </Flex>

      {/* AI instructions */}
      <Flex direction="column" gap="1">
        <Text as="label" size="2" weight="medium" htmlFor="instructions">
          ✨ AI instructions
        </Text>
        <TextArea
          id="instructions"
          {...register('instructions')}
          placeholder="Context your AI agent (via MCP) reads when it works with this account..."
          size="3"
          variant="surface"
          rows={3}
        />
        <Text size="1" color="gray">
          Free-form context for AI agents. Distinct from the user-facing notes above.
        </Text>
      </Flex>

      {/* Account Settings */}
      <Flex direction="column" gap="3" pt="2" className={SECTION_CLASS}>
        <Text as="p" size="2" weight="medium">Account Settings</Text>
        <Grid columns={{ initial: '1', sm: '2' }} gap="3">
          {settingFields.map(([fieldName, label]) => (
            <Flex key={fieldName} align="center" gap="3" asChild>
              <Text as="label" size="2" style={{ cursor: 'pointer' }}>
                <Controller
                  control={control}
                  name={fieldName}
                  render={({ field }) => (
                    <Checkbox
                      id={fieldName}
                      checked={!!field.value}
                      onCheckedChange={(checked) => field.onChange(checked === true)}
                      size="2"
                    />
                  )}
                />
                {label}
              </Text>
            </Flex>
          ))}
        </Grid>
      </Flex>
    </>
  );
};

export default AccountFormFields;
