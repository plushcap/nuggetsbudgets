import React, { useMemo } from 'react';
import { DEFAULT_LOCALE, MONEY_LOCALES, formatMoney, ledgerCurrencies, supportedMoneyLocale } from '@nuggets/shared';
import { logger } from '../utils/logger';
import { Settings, Clock, Save, Coins } from 'lucide-react';
import { Card, Flex, Box, Text, TextField, Select, Checkbox, Callout } from '@radix-ui/themes';
import { toast } from 'react-hot-toast';
import { type SystemSetting } from '../services/api';
import { isSessionExpiredError } from '../services/api/base';
import { useGeneralSettingsQuery, useAvailableTimezonesQuery, useUpdateGeneralSettingsMutation } from '../hooks/queries/settings';
import SettingsPageHeader from '../components/SettingsPageHeader';
import ThemeSettings from '../components/ThemeSettings';
import { useSeededState } from '../hooks/useSeededState';
import PageContainer from '../components/PageContainer';

/** The ledger's money settings, shown in their own section rather than under Other Settings. */
const MONEY_KEYS = ['application_currency', 'application_locale'];
const SECTION_KEYS = ['application_timezone', ...MONEY_KEYS];

/** A name for each currency code and locale, in English as the rest of the page is; the code itself where Intl has none. */
const displayName = (type: 'currency' | 'language', code: string): string => {
  try {
    return new Intl.DisplayNames(['en'], { type }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** `options`, with `value` first when it is set and not one of them (one set through the API). */
const withStored = (options: readonly string[], value: string): string[] =>
  !value || options.includes(value) ? [...options] : [value, ...options];

const GeneralSettingsPage: React.FC = () => {
  const { data: settingsData, isLoading: settingsLoading } = useGeneralSettingsQuery();
  const { data: timezones = [], isLoading: tzLoading } = useAvailableTimezonesQuery();
  const settings = settingsData ?? [];
  const loading = settingsLoading || tzLoading;
  const updateSettingsMutation = useUpdateGeneralSettingsMutation();
  const saving = updateSettingsMutation.isPending;
  // The editable form, set from the settings each time they load.
  const [formData, setFormData] = useSeededState<Record<string, string>>((current) => {
    if (!settingsData) return current ?? {};
    const initialData: Record<string, string> = {};
    settingsData.forEach(setting => {
      initialData[setting.setting_key] = setting.setting_value ?? '';
    });
    return initialData;
  }, [settingsData]);

  const handleSave = async () => {
    try {
      await updateSettingsMutation.mutateAsync(formData);
      toast.success('General settings updated successfully');
    } catch (error) {
      logger.error({ err: error }, 'Failed to save general settings');
      if (isSessionExpiredError(error)) return;
      // A refusal (e.g. a zone that isn't one) says why; anything else stays general.
      const status = (error as { status?: unknown } | null)?.status;
      const refused = typeof status === 'number' && status >= 400 && status < 500 && error instanceof Error && error.message;
      toast.error(refused ? `Not saved: ${error.message}` : 'Failed to save general settings');
    }
  };

  // Only currencies with cents: the ledger keeps its amounts to two decimals.
  const currencies = useMemo(() => ledgerCurrencies(), []);

  const handleInputChange = (key: string, value: string) => {
    setFormData(prev => ({
      ...prev,
      [key]: value
    }));
  };

  const renderSettingField = (setting: SystemSetting) => {
    const { setting_key, setting_type, description } = setting;
    const value = formData[setting_key] || '';

    if (setting_key === 'application_currency' || setting_key === 'application_locale') {
      const currency = setting_key === 'application_currency';
      const id = currency ? 'application-currency' : 'application-locale';
      const options = currency ? withStored(currencies, value) : withStored(MONEY_LOCALES, value);
      return (
        <Flex key={setting_key} direction="column" gap="2">
          <Text as="label" htmlFor={id} size="2" weight="medium">
            {currency ? 'Ledger Currency' : 'Number Format'}
          </Text>
          <Text size="2" color="gray" mb="1">
            {description}
          </Text>
          <Select.Root value={value} onValueChange={(newValue) => handleInputChange(setting_key, newValue)}>
            <Select.Trigger id={id} placeholder={currency ? 'Select a currency...' : 'Select a number format...'} style={{ width: '100%' }} />
            <Select.Content>
              {options.map((option) => (
                <Select.Item key={option} value={option}>
                  {currency
                    ? `${option} – ${displayName('currency', option)}`
                    : `${displayName('language', option)} (${formatMoney(1234.56, { currency: formData.application_currency, locale: option })})`}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </Flex>
      );
    }

    if (setting_key === 'application_timezone') {
      // A saved zone that isn't in the list (one the upgrade seeded, say) still shows.
      const zoneOptions = !value || timezones.some((tz) => tz.value === value)
        ? timezones
        : [{ value, label: value, offset: '' }, ...timezones];
      return (
        <Flex key={setting_key} direction="column" gap="2">
          <Text as="label" htmlFor="application-timezone" size="2" weight="medium">
            Ledger Time Zone
          </Text>
          <Text size="2" color="gray" mb="1">
            {description}
          </Text>
          <Select.Root
            value={value}
            onValueChange={(newValue) => handleInputChange(setting_key, newValue)}
          >
            <Select.Trigger
              id="application-timezone"
              placeholder="Select a timezone..."
              style={{ width: '100%' }}
            />
            <Select.Content>
              {zoneOptions.map((tz) => (
                <Select.Item key={tz.value} value={tz.value}>
                  {tz.offset ? `${tz.label} (${tz.offset})` : tz.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </Flex>
      );
    }

    switch (setting_type) {
      case 'boolean':
        return (
          <Flex key={setting_key} align="center" gap="3" minHeight="44px">
            <Checkbox
              id={`setting-${setting_key}`}
              checked={value === 'true'}
              onCheckedChange={(checked) => handleInputChange(setting_key, checked ? 'true' : 'false')}
              style={{ flexShrink: 0 }}
            />
            <Text as="label" htmlFor={`setting-${setting_key}`} size="2" weight="medium">
              {description}
            </Text>
          </Flex>
        );

      case 'integer':
        return (
          <Flex key={setting_key} direction="column" gap="2">
            <Text as="label" htmlFor={`setting-${setting_key}`} size="2" weight="medium">
              {description}
            </Text>
            <TextField.Root
              id={`setting-${setting_key}`}
              type="number"
              value={value}
              onChange={(e) => handleInputChange(setting_key, e.target.value)}
              size="3"
              variant="surface"
            />
          </Flex>
        );

      default:
        return (
          <Flex key={setting_key} direction="column" gap="2">
            <Text as="label" htmlFor={`setting-${setting_key}`} size="2" weight="medium">
              {description}
            </Text>
            <TextField.Root
              id={`setting-${setting_key}`}
              type="text"
              value={value}
              onChange={(e) => handleInputChange(setting_key, e.target.value)}
              size="3"
              variant="surface"
            />
          </Flex>
        );
    }
  };

  if (loading) {
    return (
      <PageContainer width="form">
        <Box className="animate-pulse space-y-6">
          {/* Header Skeleton */}
          <Flex align="center" gap="3">
            <Box width="40px" height="40px" className="rounded-[var(--radius-5)] bg-[var(--gray-4)]"></Box>
            <Flex direction="column" gap="2" flexGrow="1" flexBasis="0%">
              <Box height="24px" width="192px" className="rounded-[var(--radius-2)] bg-[var(--gray-4)]"></Box>
              <Box height="16px" width="256px" className="rounded-[var(--radius-2)] bg-[var(--gray-4)]"></Box>
            </Flex>
          </Flex>
          {/* Content Skeleton */}
          <Card>
            <Flex direction="column" gap="6">
              <Box height="16px" width="128px" className="rounded-[var(--radius-2)] bg-[var(--gray-4)]"></Box>
              <Box height="40px" className="rounded-[var(--radius-2)] bg-[var(--gray-4)]"></Box>
              <Box height="16px" width="128px" className="rounded-[var(--radius-2)] bg-[var(--gray-4)]"></Box>
              <Box height="40px" className="rounded-[var(--radius-2)] bg-[var(--gray-4)]"></Box>
            </Flex>
          </Card>
        </Box>
      </PageContainer>
    );
  }

  return (
    <PageContainer width="form">
      {/* Header */}
      <SettingsPageHeader
        title="General Settings"
        subtitle="Configure application-wide settings"
        icon={<Settings size={20} className="text-[var(--accent-11)]" />}
        iconBackground="bg-[var(--accent-3)]"
        backPath="/settings"
        primaryAction={{
          label: 'Save Settings',
          onClick: handleSave,
          icon: <Save size={16} />,
          disabled: saving,
          loading: saving
        }}
      />

      {/* Settings Form */}
      <Card>
        <Flex direction="column" gap="8">
          
          {/* Timezone Section */}
          <Flex direction="column" gap="4">
            <Flex align="center" gap="2">
              <Clock
                size={20} className="shrink-0 text-[var(--accent-11)]"
              />
              <Text size="5" weight="bold">
                Date & Time
              </Text>
            </Flex>
            <Card mb="2" className="[--card-background-color:var(--accent-3)]">
              <Flex direction="column" gap="2">
                <Text size="2" weight="medium" className="text-[var(--accent-11)]">
                  Why set a timezone?
                </Text>
                <Text
                  size="2"
                  className="text-[var(--accent-11)]"
                  style={{ lineHeight: '1.6' }}
                >
                  This ensures all dates and times in the application (including imported bank transactions)
                  are displayed consistently in your local timezone, regardless of where the server is located.
                </Text>
              </Flex>
            </Card>
            
            {settings
              .filter(setting => setting.setting_key === 'application_timezone')
              .map(renderSettingField)}
          </Flex>

          {/* Money: the ledger's currency and number format */}
          {settings.some((setting) => MONEY_KEYS.includes(setting.setting_key)) && (
            <Flex direction="column" gap="4">
              <Flex align="center" gap="2">
                <Coins size={20} className="shrink-0 text-[var(--accent-11)]" />
                <Text size="5" weight="bold">
                  Money
                </Text>
              </Flex>
              {settings.filter((setting) => MONEY_KEYS.includes(setting.setting_key)).map(renderSettingField)}
              <Text size="2" color="gray" aria-live="polite">
                Amounts show as {formatMoney(-1234.56, { currency: formData.application_currency, locale: formData.application_locale })}
                {' '}for everyone in this ledger.
              </Text>
              {formData.application_locale && supportedMoneyLocale(formData.application_locale) !== formData.application_locale && (
                // A browser without that locale would write amounts in its own language: formatMoney
                // shows them in en-US instead, the same on every such browser.
                <Callout.Root color="amber" highContrast size="1">
                  <Callout.Text>
                    This browser can&apos;t write numbers the {displayName('language', formData.application_locale)} way, so it
                    shows this ledger&apos;s amounts as {DEFAULT_LOCALE} does.
                  </Callout.Text>
                </Callout.Root>
              )}
            </Flex>
          )}

          {/* Other General Settings */}
          {settings.filter(setting => !SECTION_KEYS.includes(setting.setting_key)).length > 0 && (
            <Flex direction="column" gap="4">
              <Flex align="center" gap="2">
                <Settings
                  size={20} className="shrink-0 text-[var(--gray-11)]"
                />
                <Text size="5" weight="bold">
                  Other Settings
                </Text>
              </Flex>
              <Flex direction="column" gap="6">
                {settings
                  .filter(setting => !SECTION_KEYS.includes(setting.setting_key))
                  .map(renderSettingField)}
              </Flex>
            </Flex>
          )}

        </Flex>
      </Card>

      {/* Info Note */}
      <Card mt="5" className="[--card-background-color:var(--gray-3)]">
        <Text size="2" color="gray" style={{ lineHeight: '1.6' }}>
          <strong>Note:</strong> Changes to timezone settings will affect how dates are displayed and processed
          for future transactions. Existing transaction dates will remain as originally imported.
        </Text>
      </Card>

      {/* Runtime theme picker */}
      <Box mt="6">
        <ThemeSettings />
      </Box>
    </PageContainer>
  );
};

export default GeneralSettingsPage;
