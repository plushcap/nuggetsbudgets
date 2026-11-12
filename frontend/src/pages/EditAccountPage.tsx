import React, { useState, useMemo } from 'react';
import FilePickerButton from '../components/forms/FilePickerButton';
import FieldError, { fieldErrorDescribedBy } from '../components/forms/FieldError';
import { IMAGE_UPLOAD_TYPES, imageUploadProblem } from '../utils/imageUploads';
import { useForm, useWatch, type FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { withUnreadableAmounts } from '../components/forms/optionalAmount';
import { accountUpdateSchemaFor, formatMoney } from '@nuggets/shared';
import { logger } from '../utils/logger';
import { apiErrorMessage } from '../utils/errors';
import { useNavigate, useParams } from 'react-router-dom';
import { Check, Database, Trash2 } from 'lucide-react';
import { toast } from 'react-hot-toast';
import {
  connectAccountToBank,
  disconnectBankAccount,
  getImportAccounts,
  type Account,
  type DiscoveredBankAccount,
  type Institution,
  type User,
} from '../services/api';
import {
  useAccountQuery,
  useAccountsQuery,
  useInstitutionsQuery,
  useUsersQuery,
  useUpdateAccountWithImageMutation,
  useUpdateAccountImportSettingsMutation,
} from '../hooks/queries';
import { formatInstantDate } from '../utils/dateUtils';
import { config } from '../config/environment';
import { Card, Select, Checkbox, Flex, Box, Heading, Text, Button, IconButton } from '@radix-ui/themes';
import FormSelectRoot from '../components/forms/FormSelectRoot';
import { EMPTY_LIST } from '../utils/emptyList';
import { X, Upload, Image as ImageIcon } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import { useAuth } from '../contexts/AuthContext';
import PageLoader from '../components/PageLoader';
import AccountFormFields, { type AccountFormData } from '../components/forms/AccountFormFields';
import PageContainer from '../components/PageContainer';

/**
 * The form's values for a stored account.
 *
 * `type` and `icon` are nullable on the account row, but the form schema requires
 * them: seed a valid default so a null value doesn't render the Select blank and
 * silently fail validation on save. An account with no category (NULL, or a legacy '')
 * is an asset, as the Accounts list and net worth (net_worth_accounts) count it:
 * seeded from its account_type, a credit card showed as a Liability, and saving any edit
 * wrote that, moving it across net worth. Its account_type stays in the Account Type
 * select (withCurrentValue), by its label (a credit card is "Credit Card"), so
 * nothing renders blank.
 */
const accountFormValues = (account: Account): AccountFormData => ({
  name: account.name,
  type: account.type || 'Asset',
  account_type: account.account_type || 'checking',
  account_group: account.account_group || 'cash',
  institution_id: account.institution_id || null,
  account_number: account.account_number || '',
  routing_number: account.routing_number || '',
  // Not editable here: the opening balance is a 'starting balance'
  // transaction, and the PUT ignores this field.
  initial_balance: 0,
  close_account: account.close_account || false,
  notes: account.notes || '',
  instructions: account.instructions ?? '',
  account_image: null, // File handled via local accountImage state
  icon: account.icon || 'CreditCard',
  custom_sort: account.custom_sort || null,
  subtype: account.subtype || '',
  hide_transactions: account.hide_transactions,
  hide_account: account.hide_account,
  exclude_account_balance: account.exclude_account_balance,
  is_envelope_account: account.is_envelope_account || false,
  require_zero_balance: account.require_zero_balance || false,
  default_pay_from_account_id: account.default_pay_from_account_id ?? null,
  // SimpleFin Import Fields
  import_account_id: account.import_account_id ?? undefined,
  import_enabled: account.import_enabled || false,
  import_account_rebalance: account.import_account_rebalance || false,
  // Import automation settings
  import_auto_match_merchants: account.import_auto_match_merchants === true,
  import_auto_assign_budget_period: account.import_auto_assign_budget_period === true,
  import_auto_assign_budget_item: account.import_auto_assign_budget_item === true,
  import_auto_review: account.import_auto_review === true,
  import_default_assigned_to: account.import_default_assigned_to || undefined,
});

const EditAccountPage: React.FC = () => {
  const navigate = useNavigate();
  const { uuid } = useParams<{ uuid: string }>();
  const { data: account, isLoading: loadingAccount } = useAccountQuery(uuid);
  const { data: institutions = EMPTY_LIST, isLoading: loadingInstitutions } = useInstitutionsQuery();
  const { data: allAccounts = EMPTY_LIST, isLoading: loadingAccounts } = useAccountsQuery(false);
  // The people who can open this ledger: whom imported transactions can be assigned to.
  const { data: users = EMPTY_LIST, isLoading: loadingUsers } = useUsersQuery();

  // The form mounts once the account and its option lists have loaded, seeded with the
  // account, so every Select holds its value from its first render.
  if (loadingAccount || loadingInstitutions || loadingAccounts || loadingUsers) {
    return (
      <PageContainer width="form">
        <PageLoader label="Loading account..." />
      </PageContainer>
    );
  }

  if (!account) {
    return (
      <PageContainer width="form">
        <Card>
          <Flex direction="column" align="center" gap="4" py="9">
            <Text size="5" weight="medium" className="text-[var(--gray-12)]">
              Account not found
            </Text>
            <Button onClick={() => navigate('/accounts')}>Back to Accounts</Button>
          </Flex>
        </Card>
      </PageContainer>
    );
  }

  return (
    // Keyed on the account: opening another one starts a fresh form.
    <EditAccountForm
      key={account.uuid}
      account={account}
      institutions={institutions}
      otherAccounts={allAccounts.filter((a) => a.id !== account.id)}
      users={users}
    />
  );
};

interface EditAccountFormProps {
  account: Account;
  institutions: Institution[];
  /** The ledger's other accounts: the default pay-from / transfer choices. */
  otherAccounts: Account[];
  users: User[];
}

const EditAccountForm: React.FC<EditAccountFormProps> = ({ account, institutions, otherAccounts, users }) => {
  const { orgRole, isDeploymentAdmin } = useAuth();
  const canConnectBank = orgRole === 'admin' || isDeploymentAdmin;
  const navigate = useNavigate();
  const updateAccountWithImageMutation = useUpdateAccountWithImageMutation();
  const updateImportSettingsMutation = useUpdateAccountImportSettingsMutation();
  const uuid = account.uuid;

  const [currentImageUrl, setCurrentImageUrl] = useState<string | null>(
    account.account_image ? `${config.backendBaseUrl}${account.account_image}` : null,
  );

  // SimpleFin Import State
  const [showBankConnection, setShowBankConnection] = useState(false);
  const [discoveredAccounts, setDiscoveredAccounts] = useState<DiscoveredBankAccount[]>([]);
  const [selectedBankAccount, setSelectedBankAccount] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Image is a File — kept outside RHF (files don't round-trip cleanly).
  const [accountImage, setAccountImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // react-hook-form drives form state + validation: the shared update schema for this
  // account, which also accepts its stored classification when that is a legacy value
  // outside today's options. Seeded at mount: no reset() after the Selects mount.
  const resolver = useMemo(() => withUnreadableAmounts(zodResolver(accountUpdateSchemaFor(account))) as never, [account]);
  const form = useForm<AccountFormData>({
    defaultValues: accountFormValues(account),
    resolver,
  });
  const { handleSubmit, setValue, getValues, control } = form;
  const [
    importAccountId,
    importEnabled,
    importAccountRebalance,
    importAutoMatchMerchants,
    importAutoAssignBudgetPeriod,
    importAutoAssignBudgetItem,
    importAutoReview,
    importDefaultAssignedTo,
  ] = useWatch({
    control,
    name: [
      'import_account_id',
      'import_enabled',
      'import_account_rebalance',
      'import_auto_match_merchants',
      'import_auto_assign_budget_period',
      'import_auto_assign_budget_item',
      'import_auto_review',
      'import_default_assigned_to',
    ],
  });

  // Why a picked image wasn't taken, beside its button: it was a toast, and checked
  // less than the server does (any image type).
  const [imageProblem, setImageProblem] = useState<string | null>(null);
  const handleImageUpload = (file: File) => {
    const problem = imageUploadProblem(file);
    setImageProblem(problem);
    if (problem) return;

    setAccountImage(file);

    // Create preview
    const reader = new FileReader();
    reader.onload = () => {
      setImagePreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const removeImage = () => {
    setAccountImage(null);
    setImagePreview(null);
    setCurrentImageUrl(null);
    setImageProblem(null);
  };

  // Surface validation failures: without this, react-hook-form silently swallows
  // a blocked submit (no onSubmit, no toast), so clicking Update appears to do
  // nothing. This happens when a required Select holds a value the schema rejects
  // (e.g. a legacy account whose stored type/icon drifted out of the option set).
  const onInvalid = (formErrors: FieldErrors<AccountFormData>) => {
    const fieldLabels: Partial<Record<keyof AccountFormData, string>> = {
      name: 'Account Name',
      account_group: 'Account Group',
      type: 'Account Category',
      account_type: 'Account Type',
      icon: 'Account Icon',
      initial_balance: 'Initial Balance',
    };
    const invalid = Object.keys(formErrors)
      .map((key) => fieldLabels[key as keyof AccountFormData] || key)
      .join(', ');
    // Log only field→message; the raw RHF error objects carry DOM/fiber refs.
    const messages = Object.fromEntries(
      Object.entries(formErrors).map(([key, e]) => [key, (e as { message?: string })?.message])
    );
    logger.warn({ invalidFields: messages }, 'Account update blocked by validation');
    toast.error(invalid ? `Please fix: ${invalid}` : 'Please fix the highlighted fields before saving.');
  };

  const onSubmit = async () => {
    setIsSubmitting(true);

    try {
      const formData = getValues();
      logger.debug({ formData }, 'Form data before submit');

      // Create FormData for multipart/form-data
      const formDataToSend = new FormData();
      
      // Add all form fields
      formDataToSend.append('name', formData.name);
      formDataToSend.append('type', formData.type);
      formDataToSend.append('account_type', formData.account_type);
      formDataToSend.append('account_group', formData.account_group);
      if (formData.notes) {
        formDataToSend.append('notes', formData.notes);
      }
      // Always send instructions so clearing the field persists.
      formDataToSend.append('instructions', formData.instructions || '');
      formDataToSend.append('icon', formData.icon);
      if (formData.custom_sort !== null && formData.custom_sort !== undefined) {
        formDataToSend.append('custom_sort', formData.custom_sort.toString());
      }
      if (formData.subtype) {
        formDataToSend.append('subtype', formData.subtype);
      }
      formDataToSend.append('is_active', (!formData.close_account).toString());
      formDataToSend.append('hide_transactions', formData.hide_transactions.toString());
      formDataToSend.append('hide_account', formData.hide_account.toString());
      formDataToSend.append('exclude_account_balance', formData.exclude_account_balance.toString());
      formDataToSend.append('is_envelope_account', formData.is_envelope_account.toString());
      formDataToSend.append('require_zero_balance', formData.require_zero_balance.toString());
      // Always send (empty = clear); '' coerces to null server-side so the pay-from can be removed.
      formDataToSend.append(
        'default_pay_from_account_id',
        formData.default_pay_from_account_id != null ? formData.default_pay_from_account_id.toString() : '',
      );

      // SimpleFin Import Fields
      if (formData.import_account_id) {
        formDataToSend.append('import_account_id', formData.import_account_id);
      }
      formDataToSend.append('import_enabled', (formData.import_enabled || false).toString());
      formDataToSend.append('import_account_rebalance', (formData.import_account_rebalance || false).toString());
      
      // Import automation settings
      formDataToSend.append('import_auto_match_merchants', (formData.import_auto_match_merchants || false).toString());
      formDataToSend.append('import_auto_assign_budget_period', (formData.import_auto_assign_budget_period || false).toString());
      formDataToSend.append('import_auto_assign_budget_item', (formData.import_auto_assign_budget_item || false).toString());
      
      if (formData.institution_id) {
        formDataToSend.append('institution_id', formData.institution_id.toString());
      }
      if (formData.account_number) {
        formDataToSend.append('account_number', formData.account_number);
      }
      if (formData.routing_number) {
        formDataToSend.append('routing_number', formData.routing_number);
      }
      
      // Add image file if selected
      if (accountImage) {
        formDataToSend.append('account_image', accountImage);
      }

      // Update the account
      await updateAccountWithImageMutation.mutateAsync({ uuid, formData: formDataToSend });
      
      toast.success('Account updated successfully!');
      
      // Navigate back to accounts page
      navigate('/accounts');
      
    } catch (error) {
      logger.error({ err: error, uuid }, 'Failed to update account');
      // The server's reason when it refuses the change (an asset account with incomes made a
      // liability, 409 ACCOUNT_HAS_INCOME), and the request's reference on a failure.
      toast.error(apiErrorMessage(error, 'Failed to update account. Please try again.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  // SimpleFin Import Handlers
  const handleDiscoverBankAccounts = async () => {
    setConnecting(true);
    try {
      // Use the system's existing SimpleFin connection to discover accounts
      const { accounts } = await getImportAccounts();
      
      setDiscoveredAccounts(accounts);
      setShowBankConnection(true);
      toast.success(`Found ${accounts.length} bank accounts`);
    } catch (error) {
      logger.error({ err: error }, 'Failed to discover bank accounts');
      toast.error('Failed to discover bank accounts. Please check your SimpleFin connection in Import Settings.');
    } finally {
      setConnecting(false);
    }
  };

  const handleConnectBankAccount = async () => {
    if (!selectedBankAccount) {
      toast.error('Please select a bank account');
      return;
    }

    setConnecting(true);
    try {
      // Connect the selected SimpleFin account to this Nuggets account
      await connectAccountToBank(uuid, selectedBankAccount);

      // Update form data to reflect connection
      setValue('import_account_id', selectedBankAccount);
      setValue('import_enabled', true);

      // Reset connection state
      setShowBankConnection(false);
      setDiscoveredAccounts([]);
      setSelectedBankAccount(null);

      toast.success('Bank account connected successfully!');
    } catch (error) {
      logger.error({ err: error, uuid }, 'Failed to connect bank account');
      // Surface the server message (e.g. the duplicate-mapping guard naming the
      // ledger/account the bank account is already mapped to).
      toast.error(error instanceof Error ? error.message : 'Failed to connect bank account');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnectBank = async () => {
    setDisconnecting(true);
    try {
      await disconnectBankAccount(uuid);

      setValue('import_account_id', undefined);
      setValue('import_enabled', false);
      setValue('import_account_rebalance', false);

      toast.success('Bank account disconnected');
    } catch (error) {
      logger.error({ err: error, uuid }, 'Failed to disconnect bank account');
      toast.error('Failed to disconnect bank account');
    } finally {
      setDisconnecting(false);
    }
  };

  const handleImportSettingsToggle = async (field: 'import_enabled' | 'import_account_rebalance' | 'import_auto_match_merchants' | 'import_auto_assign_budget_period' | 'import_auto_assign_budget_item' | 'import_auto_review' | 'import_default_assigned_to', value: boolean | number | undefined) => {
    try {
      await updateImportSettingsMutation.mutateAsync({ uuid, settings: { [field]: value } });

      setValue(field, value as never);

      toast.success('Import settings updated');
    } catch (error) {
      if (error instanceof Error) {
        toast.error(`Failed to update import settings: ${error.message}`);
      } else {
        toast.error('Failed to update import settings - unknown error');
      }
    }
  };


  return (
    <PageContainer width="form">
      <PageHeader
        title="Edit Account"
        subtitle="Update account information"
        backPath="/accounts"
      />

      {/* Form */}
      <Card>
        <Heading size="4" mb="4">Account Information</Heading>

        <Flex asChild direction="column" gap="6">
        <form onSubmit={handleSubmit(onSubmit, onInvalid)}>
          {/* Image Upload Section */}
          <Flex direction="column" gap="3">
            <Text as="p" size="2" weight="medium">
              Account Image
            </Text>

            <Flex align="center" gap="4">
              {/* Image Preview */}
              <Box position="relative">
                {imagePreview || currentImageUrl ? (
                  <Box position="relative">
                    <Box asChild width="80px" height="80px"><img
                      src={imagePreview || currentImageUrl || ''}
                      alt="Account preview"
                      className="rounded-full object-cover border-2 border-[var(--gray-6)] shadow-xs"
                    /></Box>
                    <IconButton
                      type="button"
                      onClick={removeImage}
                      color="red"
                      radius="full"
                      size="1"
                      aria-label="Remove image"
                      style={{ position: 'absolute', top: -4, right: -4 }}
                    >
                      <X size={12} />
                    </IconButton>
                  </Box>
                ) : (
                  <Flex
                    align="center"
                    justify="center"
                    width="80px" height="80px" className="rounded-full bg-[var(--gray-3)] border-2 border-[var(--gray-6)] shadow-xs"
                  >
                    <ImageIcon size={24} className="text-[var(--gray-11)]" />
                  </Flex>
                )}
              </Box>

              {/* Upload Button */}
              <Box flexGrow="1">
                <FilePickerButton
                  accept={IMAGE_UPLOAD_TYPES.join(',')}
                  onFiles={([file]) => file && handleImageUpload(file)}
                  aria-describedby={fieldErrorDescribedBy('account-image', imageProblem, 'account-image-hint')}
                  color="gray"
                >
                  <Upload size={16} />
                  {currentImageUrl || imagePreview ? 'Change Image' : 'Upload Image'}
                </FilePickerButton>
                <Text as="p" id="account-image-hint" size="1" color="gray" mt="1">
                  JPG, PNG, GIF or WebP (max 5MB)
                </Text>
                {/* Said as it appears: the chooser leaves the focus on the button. */}
                <Box aria-live="polite">
                  <FieldError fieldId="account-image" message={imageProblem} />
                </Box>
              </Box>
            </Flex>
          </Flex>

          <AccountFormFields
            form={form}
            institutions={institutions}
            accounts={otherAccounts}
            showInitialBalance={false}
          />

          {/* SimpleFin Bank Import Section */}
          <Flex direction="column" gap="3">
            <Flex align="center" gap="2">
              <Database size={20} className="text-[var(--accent-11)]" />
              <Text as="p" size="2" weight="medium">
                Bank Account Import (SimpleFin)
              </Text>
            </Flex>

            {importAccountId ? (
              // Connected State
              <Box
                p="4"
                className="bg-[var(--accent-2)] border border-[var(--accent-6)] rounded-[var(--radius-3)]"
              >
                <Flex align="start" justify="between">
                  <Flex align="start" gap="3">
                    <Flex
                      align="center"
                      justify="center"
                      flexShrink="0"
                      width="32px"
                      height="32px"
                      className="bg-[var(--accent-3)] rounded-full"
                    >
                      <Check size={16} className="text-[var(--accent-11)]" />
                    </Flex>
                    <Box flexGrow="1">
                      <Text as="div" weight="medium" className="text-[var(--accent-12)]">Connected to Bank</Text>
                      <Text as="div" size="2" mb="3" className="text-[var(--accent-11)]">Account ID: {importAccountId}</Text>

                      {account.import_balance && (
                        <Text as="div" size="2" color="gray" mb="3">
                          Bank Balance: {formatMoney(account.import_balance)}
                          {account.import_balance_date && (
                            <Text color="gray"> (as of {formatInstantDate(account.import_balance_date, 'en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })})</Text>
                          )}
                        </Text>
                      )}

                      {account.import_available_balance != null && (
                        <Text as="div" size="2" color="gray" mb="3">
                          Available Balance: {formatMoney(account.import_available_balance)}
                        </Text>
                      )}

                      <Flex direction="column" gap="2">
                        <Text as="label" size="2" className="cursor-pointer">
                          <Flex align="center" gap="2">
                            <Checkbox
                              checked={importEnabled || false}
                              onCheckedChange={(checked) => handleImportSettingsToggle('import_enabled', checked as boolean)}
                              size="2"
                            />
                            Enable automatic sync
                          </Flex>
                        </Text>
                        <Text as="label" size="2" className="cursor-pointer">
                          <Flex align="center" gap="2">
                            <Checkbox
                              checked={importAccountRebalance || false}
                              onCheckedChange={(checked) => handleImportSettingsToggle('import_account_rebalance', checked as boolean)}
                              size="2"
                            />
                            Enable automatic balance adjustments
                          </Flex>
                        </Text>

                        {/* Import Automation Settings */}
                        <Box pt="3" mt="3" className="border-t border-[var(--gray-6)]">
                          <Text as="div" size="2" weight="medium" mb="2">Import Automation</Text>
                          <Flex direction="column" gap="2">
                            <Text as="label" size="2" className="cursor-pointer">
                              <Flex align="start" gap="2">
                                <Checkbox
                                  checked={importAutoMatchMerchants === true}
                                  onCheckedChange={(checked) => handleImportSettingsToggle('import_auto_match_merchants', checked as boolean)}
                                  size="2"
                                  className="mt-0.5"
                                />
                                <Box flexGrow="1">
                                  Auto-match merchants
                                  <Text size="1" color="gray" ml="1">(Automatically run merchant matching rules)</Text>
                                </Box>
                              </Flex>
                            </Text>
                            <Text as="label" size="2" className="cursor-pointer">
                              <Flex align="start" gap="2">
                                <Checkbox
                                  checked={importAutoAssignBudgetPeriod === true}
                                  onCheckedChange={(checked) => handleImportSettingsToggle('import_auto_assign_budget_period', checked as boolean)}
                                  size="2"
                                  className="mt-0.5"
                                />
                                <Box flexGrow="1">
                                  Auto-assign budget period
                                  <Text size="1" color="gray" ml="1">(Automatically assign transactions to current budget period)</Text>
                                </Box>
                              </Flex>
                            </Text>
                            <Text as="label" size="2" className="cursor-pointer">
                              <Flex align="start" gap="2">
                                <Checkbox
                                  checked={importAutoAssignBudgetItem === true}
                                  onCheckedChange={(checked) => handleImportSettingsToggle('import_auto_assign_budget_item', checked as boolean)}
                                  size="2"
                                  className="mt-0.5"
                                />
                                <Box flexGrow="1">
                                  Auto-assign budget items
                                  <Text size="1" color="gray" ml="1">(Automatically categorize transactions using matching rules)</Text>
                                </Box>
                              </Flex>
                            </Text>
                            <Text as="label" size="2" className="cursor-pointer">
                              <Flex align="start" gap="2">
                                <Checkbox
                                  checked={importAutoReview === true}
                                  onCheckedChange={(checked) => handleImportSettingsToggle('import_auto_review', checked as boolean)}
                                  size="2"
                                  className="mt-0.5"
                                />
                                <Box flexGrow="1">
                                  Auto-review transactions
                                  <Text size="1" color="gray" ml="1">(Mark imported transactions as reviewed automatically)</Text>
                                </Box>
                              </Flex>
                            </Text>
                            <Flex direction="column" gap="1">
                              <Text as="label" htmlFor="edit-account-default-assignee" size="2">Default assignee for imported transactions</Text>
                              <FormSelectRoot
                                value={importDefaultAssignedTo?.toString() || 'none'}
                                onValueChange={(value) => handleImportSettingsToggle('import_default_assigned_to', value === 'none' ? undefined : parseInt(value))}
                                size="3"
                              >
                                <Select.Trigger id="edit-account-default-assignee" placeholder="No default assignment" />
                                <Select.Content>
                                  <Select.Item value="none">No default assignment</Select.Item>
                                  {users.map((user) => (
                                    <Select.Item key={user.id} value={user.id.toString()}>
                                      {[user.first_name, user.last_name].filter(Boolean).join(' ')}
                                    </Select.Item>
                                  ))}
                                </Select.Content>
                              </FormSelectRoot>
                              <Text size="1" color="gray">(Select a user to automatically assign imported transactions to)</Text>
                            </Flex>
                          </Flex>
                        </Box>
                      </Flex>
                    </Box>
                  </Flex>
                  <IconButton
                    type="button"
                    onClick={handleDisconnectBank}
                    disabled={disconnecting}
                    variant="ghost"
                    color="red"
                    aria-label="Disconnect bank account"
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </Flex>
              </Box>
            ) : (
              // Not Connected State
              <Box
                p="4"
                className="border border-[var(--gray-6)] rounded-[var(--radius-3)]"
              >
                {!canConnectBank ? (
                  // The bank accounts come from the organization's SimpleFin connection,
                  // which covers every ledger in it, so only its admins connect them.
                  <Text as="div" size="2" color="gray" align="center">
                    An organization admin can connect this account to the bank.
                  </Text>
                ) : !showBankConnection ? (
                  <Flex direction="column" align="center">
                    <Text as="div" size="2" color="gray" mb="4">
                      Connect this account to your bank for automatic balance updates and transaction sync.
                    </Text>
                    <Button
                      type="button"
                      onClick={handleDiscoverBankAccounts}
                      disabled={connecting}
                      loading={connecting}
                    >
                      <Database size={16} />
                      {connecting ? 'Discovering Accounts...' : 'Discover Bank Accounts'}
                    </Button>
                  </Flex>
                ) : (
                  // Bank Account Selection
                  <Flex direction="column" gap="4">
                    <Text as="div" size="2" weight="medium">Select Bank Account</Text>

                    <Text as="div" size="2" color="gray">
                      Choose which bank account to connect to this Nuggets account:
                    </Text>

                    <Flex direction="column" gap="2" maxHeight="160px" overflowY="auto">
                      {discoveredAccounts.map((bankAccount) => {
                        // Already mapped to a DIFFERENT Nuggets account (in any of the
                        // org's ledgers)? Mapping it again would import the same bank
                        // transactions twice, so disable it and say where it's linked.
                        // The connect-bank route rejects it too.
                        const existingMapping = bankAccount.mappings?.find((m) => m.accountUuid !== uuid);
                        const isMapped = Boolean(existingMapping);
                        const isSelected = selectedBankAccount === bankAccount.id;
                        return (
                          <Box
                            key={bankAccount.id}
                            p="3"
                            aria-disabled={isMapped}
                            className={`transition-colors rounded-[var(--radius-3)] ${
                              isMapped
                                ? 'cursor-not-allowed opacity-60 border border-[var(--gray-5)]'
                                : isSelected
                                  ? 'cursor-pointer border border-[var(--accent-7)] bg-[var(--accent-3)]'
                                  : 'cursor-pointer border border-[var(--gray-6)] hover:border-[var(--gray-8)]'
                            }`}
                            onClick={() => { if (!isMapped) setSelectedBankAccount(bankAccount.id); }}
                          >
                            <Flex align="center" justify="between" gap="3">
                              <Box>
                                <Text as="div" size="2" weight="medium">{bankAccount.name}</Text>
                                <Text as="div" size="1" color="gray">{bankAccount.org?.name}</Text>
                                {existingMapping && (
                                  <Text as="div" size="1" color="amber" mt="1" highContrast>
                                    Already linked to {existingMapping.accountName} in {existingMapping.tenantName}
                                  </Text>
                                )}
                              </Box>
                              <Text as="div" size="2" weight="medium">
                                {formatMoney(parseFloat(String(bankAccount.balance || '0')))}
                              </Text>
                            </Flex>
                          </Box>
                        );
                      })}
                    </Flex>

                    <Flex gap="2">
                      <Button
                        type="button"
                        onClick={handleConnectBankAccount}
                        disabled={connecting || !selectedBankAccount}
                        loading={connecting}
                        className="flex-1"
                      >
                        {connecting ? 'Connecting...' : 'Connect Selected Account'}
                      </Button>
                      <Button
                        type="button"
                        variant="soft"
                        color="gray"
                        onClick={() => {
                          setShowBankConnection(false);
                          setDiscoveredAccounts([]);
                          setSelectedBankAccount(null);
                        }}
                      >
                        Cancel
                      </Button>
                    </Flex>
                  </Flex>
                )}
              </Box>
            )}
          </Flex>

          {/* Form Actions */}
          <Flex align="center" justify="end" gap="3" pt="4" className="border-t border-[var(--gray-6)]">
            <Button
              type="button"
              variant="soft"
              color="gray"
              onClick={() => navigate('/accounts')}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting} loading={isSubmitting}>
              Update Account
            </Button>
          </Flex>
        </form>
        </Flex>
      </Card>
    </PageContainer>
  );
};

export default EditAccountPage;
