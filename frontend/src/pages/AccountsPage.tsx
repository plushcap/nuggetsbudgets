import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { PlusCircle, CreditCard, DollarSign, ArrowLeftRight } from 'lucide-react';
import { ACCOUNT_TYPE_LABELS, vocabularyLabel, assetType } from '@nuggets/shared';
import { type Account } from '../services/api';
import { useAccountsQuery } from '../hooks/queries/accounts';
import { useCurrentNetWorthQuery } from '../hooks/queries/networth';
import { Switch, Card, Flex, Grid, Box, Heading, Text, Button, Badge, Callout } from '@radix-ui/themes';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import AccountConnectionPill from '../components/AccountConnectionPill';
import StretchedLink from '../components/StretchedLink';

// For consistency with API calls
import { getBackendBaseUrl } from '../config/environment';
import PageContainer from '../components/PageContainer';
import { centsOf, centsToAmount, formatCurrency, toCents } from '../utils/currency';

const API_BASE_URL = getBackendBaseUrl();

const AccountsPage: React.FC = () => {
  const [showHiddenAccounts, setShowHiddenAccounts] = useState(false);
  // Page renders its own error panel below, so suppress the global error toast.
  const {
    data: accounts = [],
    isLoading: loading,
    error,
  } = useAccountsQuery(showHiddenAccounts, { meta: { suppressErrorToast: true } });
  // The summary is today's net worth from the server's one definition, not a
  // sum over this list: the list leaves out closed accounts and can show hidden ones,
  // and which accounts count (not hidden or excluded, in dollars) and how a
  // liability's pre-signed balance counts are the server's to say.
  const netWorthQuery = useCurrentNetWorthQuery({ meta: { suppressErrorToast: true } });

  // Coloured currency for inline totals — colour comes from Radix Text props so
  // it follows the theme (red for negatives, default gray-12 otherwise).
  // A null balance couldn't be computed: show "Unavailable", never $0.
  const formatBalance = (amount: number | null) => {
    if (amount === null) return <Text color="gray">Unavailable</Text>;
    // Red below zero by its cents: -0.004 is $0.00, and not red.
    return toCents(amount) < 0 ? <Text color="red">{formatCurrency(amount)}</Text> : <Text>{formatCurrency(amount)}</Text>;
  };

  const formatCurrencyText = (amount: number | null) => (amount === null ? 'Unavailable' : formatCurrency(amount));

  // A total over any unavailable balance is unavailable too (null). Added in whole cents:
  // as floats, -0.10 - 0.20 + 0.30 is -5.6e-17, a red $0.00.
  const sumBalances = (list: Account[]): number | null =>
    list.some((a) => a.calculated_balance == null)
      ? null
      : centsToAmount(list.reduce((sum, a) => sum + centsOf(a.calculated_balance), 0));

  // A summary figure, or null (Unavailable) when net worth couldn't be loaded.
  const summaryAmount = (value: unknown): number | null => {
    const amount = typeof value === 'string' ? parseFloat(value) : value;
    return typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
  };
  const currentNetWorth = netWorthQuery.data?.current_net_worth;
  const summaryText = (value: unknown) =>
    netWorthQuery.isPending ? '…' : formatCurrencyText(summaryAmount(value));

  // Group accounts by type and account_group
  const groupedAccounts = accounts.reduce((groups, account) => {

    // The class net worth gives it: the net_worth_accounts view counts an account as a
    // liability only when accounts.type is 'Liability'; one saved with none (NULL, or a legacy
    // '') is an asset there, whatever its kind, so it is listed with the assets here too.
    const type = account.type === assetType.enum.Liability ? 'Liability' : 'Asset';
    const group = account.account_group || 'other'; // Handle null/undefined account_group

    if (!groups[type]) {
      groups[type] = {};
    }
    if (!groups[type][group]) {
      groups[type][group] = [];
    }
    groups[type][group].push(account);

    return groups;
  }, {} as Record<string, Record<string, Account[]>>);

  // Calculate totals for each group
  const calculateGroupTotal = (accounts: Account[]) => sumBalances(accounts);

  const calculateTypeTotal = (accountGroups: Record<string, Account[]>) =>
    calculateGroupTotal(Object.values(accountGroups).flat());

  const getAccountGroupDisplayName = (group: string) => {
    const groupNames: Record<string, string> = {
      'cash': 'Cash & Bank Accounts',
      'credit_cards': 'Credit Cards',
      'credit cards': 'Credit Cards', // Handle both variations
      'investments': 'Investments',
      'loans': 'Loans',
      'other': 'Other Accounts'
    };
    return groupNames[group] || group?.charAt(0).toUpperCase() + group?.slice(1) || 'Unknown';
  };

  const renderAccountCard = (account: Account, variant: 'desktop' | 'mobile') => {
    const imageSize = variant === 'desktop' ? '40px' : '48px';
    const iconSize = variant === 'desktop' ? 20 : 24;

    const avatar = account.account_image ? (
      <Box asChild width={imageSize} height={imageSize}>
        <img
          src={`${API_BASE_URL}${account.account_image}`}
          alt={account.name}
          className="rounded-[var(--radius-4)] object-cover border border-[var(--gray-6)]"
        />
      </Box>
    ) : (
      <Flex
        align="center"
        justify="center"
        width={imageSize}
        height={imageSize}
        className="bg-[var(--accent-3)] rounded-[var(--radius-3)]"
      >
        <DollarSign size={iconSize} className="text-[var(--accent-11)]" />
      </Flex>
    );

    return (
      <Card
        key={account.id}
        className={`transition-all hover:shadow-md ${account.hide_account ? 'opacity-60' : ''}`}
      >
        {variant === 'desktop' ? (
          <Flex align="center" justify="between">
            <Flex align="center" gap="4">
              <Box flexShrink="0">{avatar}</Box>
              <Box flexGrow="1" minWidth="0">
                <Flex align="center" gap="3">
                  <Text size="3" weight="medium" truncate asChild>
                    <StretchedLink to={`/accounts/${account.uuid}`}>{account.name}</StretchedLink>
                  </Text>
                  <Badge variant="soft" color="gray" radius="full">
                    {vocabularyLabel(ACCOUNT_TYPE_LABELS, account.account_type)}
                  </Badge>
                  {account.hide_account && (
                    <Badge variant="soft" color="red" radius="full">
                      Hidden
                    </Badge>
                  )}
                </Flex>
                <Flex align="center" gap="3" mt="1" wrap="wrap">
                  <Text size="2" color="gray">
                    {account.institution_name || 'No Institution'}
                  </Text>
                  <AccountConnectionPill account={account} />
                </Flex>
              </Box>
            </Flex>

            <Box style={{ textAlign: 'right' }}>
              <Text size="3" weight="bold" as="div">
                {formatBalance(account.calculated_balance)}
              </Text>

              {/* SimpleFin Balance Information */}
              {account.import_balance !== null && account.import_balance !== undefined && account.import_balance_date && (
                <Box mt="1" pt="1" className="border-t border-[var(--gray-6)]">
                  <Text size="1" className={toCents(account.import_balance) < 0 ? 'text-[var(--red-11)]' : 'text-[var(--gray-11)]'}>
                    Bank Balance as of {new Date(account.import_balance_date).toLocaleDateString()}:&nbsp;
                    {formatCurrencyText(account.import_balance)}
                    {account.import_available_balance !== null &&
                      account.import_available_balance !== undefined &&
                      account.import_available_balance !== 0 && (
                        <>
                          <span className="text-[var(--gray-11)]">&nbsp;•&nbsp;Av. </span>
                          <span className={toCents(account.import_available_balance) < 0 ? 'text-[var(--red-11)]' : 'text-[var(--gray-11)]'}>
                            {formatCurrencyText(account.import_available_balance)}
                          </span>
                        </>
                      )}
                  </Text>
                </Box>
              )}
            </Box>
          </Flex>
        ) : (
          <>
            {/* Account Header */}
            <Flex align="start" gap="3" mb="3">
              <Box flexShrink="0">{avatar}</Box>
              <Box flexGrow="1" minWidth="0">
                <Text size="3" weight="bold" className="break-words" asChild>
                  <StretchedLink to={`/accounts/${account.uuid}`}>{account.name}</StretchedLink>
                </Text>
                <Text size="2" color="gray" as="p" mt="1">
                  {account.institution_name || 'No Institution'}
                </Text>
                <Flex wrap="wrap" gap="2" mt="2">
                  <Badge variant="soft" color="gray" radius="full">
                    {vocabularyLabel(ACCOUNT_TYPE_LABELS, account.account_type)}
                  </Badge>
                  {account.hide_account && (
                    <Badge variant="soft" color="red" radius="full">
                      Hidden
                    </Badge>
                  )}
                  <AccountConnectionPill account={account} />
                </Flex>
              </Box>
            </Flex>

            {/* Balance */}
            <Box pt="3" className="border-t border-[var(--gray-6)]">
              <Flex align="center" justify="between">
                <Text size="2" color="gray">
                  Current Balance
                </Text>
                <Text size="4" weight="bold">
                  {formatBalance(account.calculated_balance)}
                </Text>
              </Flex>

              {/* Bank Balance Info */}
              {account.import_balance !== null && account.import_balance !== undefined && account.import_balance_date && (
                <Box mt="2" pt="2" className="border-t border-[var(--gray-6)]">
                  <Flex align="center" justify="between">
                    <Text size="1" color="gray">
                      Bank Balance ({new Date(account.import_balance_date).toLocaleDateString()})
                    </Text>
                    <Text size="1" className={toCents(account.import_balance) < 0 ? 'text-[var(--red-11)]' : 'text-[var(--gray-11)]'}>
                      {formatCurrencyText(account.import_balance)}
                    </Text>
                  </Flex>
                  {account.import_available_balance !== null &&
                    account.import_available_balance !== undefined &&
                    account.import_available_balance !== 0 && (
                      <Flex align="center" justify="between" mt="1">
                        <Text size="1" color="gray">
                          Available Balance
                        </Text>
                        <Text size="1" className={toCents(account.import_available_balance) < 0 ? 'text-[var(--red-11)]' : 'text-[var(--gray-11)]'}>
                          {formatCurrencyText(account.import_available_balance)}
                        </Text>
                      </Flex>
                    )}
                </Box>
              )}
            </Box>
          </>
        )}
      </Card>
    );
  };

  return (
    <PageContainer>
      {loading ? (
        <PageLoader label="Loading accounts…" />
      ) : error ? (
        <Callout.Root color="red">
          <Callout.Text>
            Error loading accounts: {error.message}
          </Callout.Text>
          <Box mt="2">
            <Button variant="soft" color="red" onClick={() => window.location.reload()}>
              Try again
            </Button>
          </Box>
        </Callout.Root>
      ) : (
        <>
          <PageHeader
            title="Accounts"
            subtitle={`${accounts.length} ${showHiddenAccounts ? 'total' : 'active'} accounts`}
            actions={
              <>
                <Button asChild className="flex-1 sm:flex-initial">
                  <Link to="/transfertransaction" state={{ from: '/accounts' }}>
                    <ArrowLeftRight size={16} />
                    Transfer
                  </Link>
                </Button>
                <Button asChild className="flex-1 sm:flex-initial">
                  <Link to="/accounts/add">
                    <PlusCircle size={16} />
                    Add Account
                  </Link>
                </Button>
              </>
            }
          >
            {/* Show Hidden Accounts Toggle and Financial Summary */}
            <Flex
              direction={{ initial: 'column', sm: 'row' }}
              align={{ initial: 'stretch', sm: 'center' }}
              justify="between"
              gap="4"
            >
              <label style={{ cursor: 'pointer' }}>
                <Flex align="center" gap="2">
                  <Switch checked={showHiddenAccounts} onCheckedChange={setShowHiddenAccounts} size="2" />
                  <Text size="2" color="gray">
                    Show hidden accounts
                  </Text>
                </Flex>
              </label>

              {/* Financial Summary Inline */}
              <Flex align="center" justify="center" gap={{ initial: '2', sm: '4' }}>
                <Box style={{ textAlign: 'center' }}>
                  <Text size="1" color="gray" as="div">
                    Assets
                  </Text>
                  <Text size="2" weight="bold" color="green" as="div" highContrast>
                    {summaryText(currentNetWorth?.total_assets)}
                  </Text>
                </Box>
                <Box style={{ textAlign: 'center' }}>
                  <Text size="1" color="gray" as="div">
                    Liabilities
                  </Text>
                  <Text size="2" weight="bold" color="red" as="div">
                    {summaryText(currentNetWorth?.total_liabilities)}
                  </Text>
                </Box>
                <Box style={{ textAlign: 'center' }}>
                  <Text size="1" color="gray" as="div">
                    Net Worth
                  </Text>
                  <Text size="2" weight="bold" as="div">
                    {summaryText(currentNetWorth?.net_worth)}
                  </Text>
                </Box>
              </Flex>
            </Flex>
          </PageHeader>

          {/* Accounts List - Grouped by Type and Account Group */}
          <Flex direction="column" gap="6">
            {Object.keys(groupedAccounts).length === 0 ? (
              <Card>
                <Flex direction="column" align="center" gap="4" py="6" px="4">
                  <Flex
                    align="center"
                    justify="center"
                    width="64px"
                    height="64px"
                    className="bg-[var(--gray-3)] rounded-full"
                  >
                    <CreditCard size={32} className="text-[var(--gray-11)]" />
                  </Flex>
                  <Box style={{ textAlign: 'center' }}>
                    <Heading size="4" mb="1">
                      No accounts yet
                    </Heading>
                    <Text size="2" color="gray">
                      Get started by adding the first family account
                    </Text>
                  </Box>
                  <Button asChild size="3">
                    <Link to="/accounts/add">Add First Account</Link>
                  </Button>
                </Flex>
              </Card>
            ) : (
              Object.entries(groupedAccounts)
                .sort(([a]) => (a === 'Liability' ? -1 : 1)) // Liabilities first
                .map(([accountType, accountGroups]) => {
                  const typeTotal = calculateTypeTotal(accountGroups);

                  return (
                    <Flex key={accountType} direction="column" gap="4">
                      {/* Account Type Header (no background panel) */}
                      <Flex
                        direction={{ initial: 'column', sm: 'row' }}
                        align={{ initial: 'start', sm: 'center' }}
                        justify="between"
                        gap="3"
                      >
                        <Flex align="center" gap="3">
                          <Heading size={{ initial: '4', sm: '5' }}>
                            {accountType === assetType.enum.Asset ? 'Assets' : 'Liabilities'}
                          </Heading>
                          <Text size="2" color="gray">
                            ({Object.values(accountGroups).flat().length} accounts)
                          </Text>
                        </Flex>
                        <Text size={{ initial: '4', sm: '5' }} weight="bold">
                          {formatBalance(typeTotal)}
                        </Text>
                      </Flex>

                      {/* Account Groups within Type */}
                      <Flex direction="column" gap="6">
                        {Object.entries(accountGroups)
                          .sort(([a], [b]) => a.localeCompare(b))
                          .map(([groupName, groupAccounts]) => {
                            const groupTotal = calculateGroupTotal(groupAccounts);

                            return (
                              <Flex key={`${accountType}-${groupName}`} direction="column" gap="3">
                                {/* Account Group Header */}
                                <Flex
                                  direction={{ initial: 'column', sm: 'row' }}
                                  align={{ initial: 'start', sm: 'center' }}
                                  justify="between"
                                  gap="2"
                                >
                                  <Heading size={{ initial: '3', sm: '4' }} weight="medium">
                                    {getAccountGroupDisplayName(groupName)}
                                  </Heading>
                                  <Text size={{ initial: '3', sm: '4' }} weight="bold">
                                    {formatBalance(groupTotal)}
                                  </Text>
                                </Flex>

                                {/* Individual Accounts - Desktop View */}
                                <Box display={{ initial: 'none', sm: 'block' }}>
                                  {/* Two columns on a wide screen, so a row card doesn't stretch to 1600px. */}
                                  <Grid columns={{ initial: '1', xl: '2' }} gap="3">
                                    {groupAccounts.map((account) => renderAccountCard(account, 'desktop'))}
                                  </Grid>
                                </Box>

                                {/* Individual Accounts - Mobile Card View */}
                                <Box display={{ initial: 'block', sm: 'none' }}>
                                  <Flex direction="column" gap="3">
                                    {groupAccounts.map((account) => renderAccountCard(account, 'mobile'))}
                                  </Flex>
                                </Box>
                              </Flex>
                            );
                          })}
                      </Flex>
                    </Flex>
                  );
                })
            )}
          </Flex>
        </>
      )}
    </PageContainer>
  );
};

export default AccountsPage;
