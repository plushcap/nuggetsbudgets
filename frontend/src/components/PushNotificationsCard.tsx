import React, { useEffect, useId, useState } from 'react';
import { Button, Callout, Card, Flex, Separator, Switch, Text } from '@radix-ui/themes';
import { Info, Send } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { usePushDeviceCountQuery, useSendTestPushMutation } from '../hooks/queries/push';
import { disablePush, enablePush, getPushState, type PushState } from '../utils/pushNotifications';
import { logger } from '../utils/logger';

const UNAVAILABLE: Partial<Record<PushState, string>> = {
  unsupported: "This browser can't show Nuggets notifications.",
  insecure: 'Notifications need Nuggets to be opened over HTTPS.',
  'install-first':
    'On iPhone and iPad, add Nuggets to your Home Screen first (Share, then Add to Home Screen), open it from there, and turn notifications on in that app.',
  denied:
    "Notifications are blocked for Nuggets in this browser's site settings. Allow them there, then come back to turn them on.",
};

/**
 * Turns push notifications on or off for the browser or installed app the
 * person is using now. Which notifications come this way is chosen per rule
 * in the card above it.
 */
export const PushNotificationsCard: React.FC = () => {
  const [state, setState] = useState<PushState | null>(null);
  const toggleId = useId();
  const [busy, setBusy] = useState(false);
  const deviceCount = usePushDeviceCountQuery();
  const testMutation = useSendTestPushMutation();

  useEffect(() => {
    getPushState()
      .then(setState)
      .catch((err) => {
        logger.warn({ err }, 'Could not read the push notification state');
        setState('unsupported');
      });
  }, []);

  const handleToggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) {
        const next = await enablePush();
        setState(next);
        if (next === 'enabled') toast.success('Notifications are on for this device');
      } else {
        await disablePush();
        setState('disabled');
        toast.success('Notifications are off for this device');
      }
      await deviceCount.refetch();
    } catch (err) {
      logger.error({ err }, 'Failed to change push notifications');
      toast.error('Could not change notifications for this device');
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    try {
      const result = await testMutation.mutateAsync();
      if (result.sent > 0) {
        toast.success(`Test sent to ${result.sent} device${result.sent === 1 ? '' : 's'}`);
      } else {
        toast.error('No device accepted the test notification');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to send test push');
      toast.error('Could not send a test notification');
    }
  };

  const unavailable = state ? UNAVAILABLE[state] : undefined;
  const devices = deviceCount.data?.count ?? 0;

  return (
    <Card>
      <Flex direction="column" gap="4" p="4">
        <Flex direction="column" gap="1">
          <Text size="4" weight="bold" color="gray" highContrast>Phone & browser notifications</Text>
          <Text size="2" color="gray">
            Get your Nuggets notifications on this device, even when Nuggets isn't open.
          </Text>
        </Flex>

        <Separator size="4" />

        {unavailable ? (
          <Callout.Root color="gray">
            <Callout.Icon><Info size={16} /></Callout.Icon>
            <Callout.Text>{unavailable}</Callout.Text>
          </Callout.Root>
        ) : (
          <Text as="label" size="3">
            <Flex align="center" justify="between" gap="4">
              <Flex direction="column" gap="1">
                <Text id={`${toggleId}-label`} weight="medium" color="gray" highContrast>Notifications on this device</Text>
                <Text id={`${toggleId}-hint`} size="2" color="gray">
                  Turn this on separately on each phone or computer you use.
                </Text>
              </Flex>
              <Switch
                aria-labelledby={`${toggleId}-label`}
                aria-describedby={`${toggleId}-hint`}
                checked={state === 'enabled'}
                disabled={state === null || busy}
                onCheckedChange={(checked) => void handleToggle(checked)}
              />
            </Flex>
          </Text>
        )}

        {devices > 0 && (
          <Flex align="center" justify="between" gap="4" wrap="wrap">
            <Text size="2" color="gray">
              On for {devices} device{devices === 1 ? '' : 's'}.
            </Text>
            <Button variant="soft" onClick={() => void handleTest()} loading={testMutation.isPending}>
              <Send size={16} />
              Send a test
            </Button>
          </Flex>
        )}
      </Flex>
    </Card>
  );
};
