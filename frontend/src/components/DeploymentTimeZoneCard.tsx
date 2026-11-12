import React, { useState } from 'react';
import { toast } from 'react-hot-toast';
import { Button, Callout, Card, Flex, Select, Text } from '@radix-ui/themes';
import { AlertTriangle, CheckCircle, Globe } from 'lucide-react';
import { useAvailableTimezonesQuery } from '../hooks/queries/settings';
import { useDeploymentSettingsQuery, useUpdateDeploymentSettingsMutation } from '../hooks/queries/settingsExtras';
import { apiErrorMessage } from '../utils/errors';
import { isSessionExpiredError } from '../services/api/base';
import { clearTimezoneCache } from '../utils/timezone';
import FieldError, { fieldErrorProps } from './forms/FieldError';

const FIELD_ID = 'deployment-timezone';
const HINT_ID = 'deployment-timezone-hint';

/**
 * The deployment's time zone, for deployment admins on the Backup page: the zone of
 * every ledger that hasn't set its own (a ledger's admins set that in General Settings) and
 * of the backup schedule. PUT /api/admin/deployment-settings checks the zone.
 */
const DeploymentTimeZoneCard: React.FC = () => {
  const { data, isLoading, isError, refetch } = useDeploymentSettingsQuery();
  const { data: timezones = [] } = useAvailableTimezonesQuery();
  const update = useUpdateDeploymentSettingsMutation();
  const stored = data?.settings.application_timezone;
  // What the admin picked, until it is saved; the stored zone otherwise.
  const [picked, setPicked] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const value = picked ?? stored ?? '';

  // A stored zone that isn't in the list (one set before, or by SQL) still shows.
  const options = !value || timezones.some((tz) => tz.value === value)
    ? timezones
    : [{ value, label: value, offset: '' }, ...timezones];

  const save = async () => {
    if (!value) return;
    setRefusal(null);
    try {
      const saved = await update.mutateAsync({ application_timezone: value });
      setPicked(null);
      // Pages that read the ledger's zone through it (utils/timezone.ts) see the change now.
      clearTimezoneCache();
      if (saved.notice === undefined) {
        toast.success('Deployment time zone saved');
      } else {
        // The zone is saved, but some ledgers' goal history wasn't moved to it; saving again
        // retries them.
        const count = saved.tenants_not_clamped;
        const which = count === undefined ? "Some ledgers'" : `${count} ${count === 1 ? "ledger's" : "ledgers'"}`;
        toast.error(`Time zone saved, but ${which} goal history couldn't be moved to it. Save the time zone again to retry.`);
      }
    } catch (error) {
      if (isSessionExpiredError(error)) return;
      const status = (error as { status?: unknown } | null)?.status;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        setRefusal(apiErrorMessage(error, "That time zone can't be used"));
      } else {
        toast.error(apiErrorMessage(error, "The deployment's time zone wasn't saved"));
      }
    }
  };

  return (
    <Card mb="6">
      <Flex direction="column" gap="4">
        <Flex align="center" gap="2">
          <Globe aria-hidden size={20} className="text-[var(--accent-11)]" />
          <Text size="5" weight="bold">Deployment Time Zone</Text>
        </Flex>
        <Text id={HINT_ID} size="2" className="text-[var(--gray-11)]">
          The time zone of every ledger that hasn't set its own (its admins set that in General
          Settings), and of the backup schedule below. It decides which day is &quot;today&quot; for those
          ledgers.
        </Text>

        {isError ? (
          <Callout.Root color="red" role="alert">
            <Callout.Icon>
              <AlertTriangle size={16} />
            </Callout.Icon>
            <Callout.Text>
              The deployment&apos;s time zone didn&apos;t load.{' '}
              <Button variant="ghost" size="1" onClick={() => void refetch()}>Try again</Button>
            </Callout.Text>
          </Callout.Root>
        ) : (
          <Flex direction="column" gap="2">
            <Text as="label" htmlFor={FIELD_ID} size="2" weight="medium">Time zone</Text>
            <Select.Root
              value={value || undefined}
              onValueChange={(zone) => {
                setPicked(zone);
                setRefusal(null);
              }}
              disabled={isLoading}
            >
              <Select.Trigger
                id={FIELD_ID}
                placeholder={isLoading ? 'Loading…' : 'Select a time zone…'}
                style={{ width: '100%' }}
                {...fieldErrorProps(FIELD_ID, refusal, HINT_ID)}
              />
              <Select.Content>
                {options.map((tz) => (
                  <Select.Item key={tz.value} value={tz.value}>
                    {tz.offset ? `${tz.label} (${tz.offset})` : tz.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            <FieldError fieldId={FIELD_ID} message={refusal} />
            <Flex>
              <Button onClick={() => void save()} disabled={isLoading || !value} loading={update.isPending} size="3">
                <CheckCircle size={16} />
                Save Time Zone
              </Button>
            </Flex>
          </Flex>
        )}
      </Flex>
    </Card>
  );
};

export default DeploymentTimeZoneCard;
