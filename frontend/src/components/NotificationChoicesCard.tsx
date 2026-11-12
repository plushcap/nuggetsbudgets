import React, { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Button, Callout, Card, Checkbox, Flex, Link, Separator, Text } from '@radix-ui/themes';
import { Info } from 'lucide-react';
import { sendsBy, type NotificationPreference, type NotificationRuleKind, type NotificationSendBy } from '@nuggets/shared';
import { useNotificationPreferencesQuery, useSetNotificationPreferencesMutation } from '../hooks/queries/settingsExtras';
import { logger } from '../utils/logger';

const ruleHints: Record<NotificationRuleKind, string> = {
  budget_item: 'When a budget item matches this rule, once each budget period.',
  transaction: 'When a new transaction matches this rule.',
  review_reminder: 'When transactions assigned to you are waiting for review.',
  digest: 'A summary, once a week.',
  bill: 'When a bill payment matches this rule, once for each due date.',
};

const sendByHints: Record<Exclude<NotificationSendBy, 'both'>, string> = {
  email: 'Your ledger sends this one by email only.',
  push: 'Your ledger sends this one to phones and browsers only.',
};

type Channel = 'email' | 'push';

/**
 * Which of the ledger's notifications reach the signed-in person, and how:
 * by email, on their phones and browsers (push), both, or neither. Each tick
 * saves at once; the box shows the new state while it saves and never
 * disables, so focus stays put.
 */
export const NotificationChoicesCard: React.FC = () => {
  const preferences = useNotificationPreferencesQuery({ meta: { suppressErrorToast: true } });
  const mutation = useSetNotificationPreferencesMutation();
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [failed, setFailed] = useState(false);

  const choose = (rule: NotificationPreference, channel: Channel, value: boolean) => {
    const key = `${rule.rule}:${channel}`;
    setShown((current) => ({ ...current, [key]: value }));
    setFailed(false);
    mutation.mutate(
      { rules: [{ rule: rule.rule, [channel]: value }] },
      {
        onError: (err) => {
          logger.error({ err }, 'Failed to save a notification choice');
          setFailed(true);
        },
        onSettled: () => setShown((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        }),
      }
    );
  };

  const isOn = (rule: NotificationPreference, channel: Channel) => shown[`${rule.rule}:${channel}`] ?? rule[channel];

  return (
    <Card>
      <Flex direction="column" gap="4" p="4">
        <Flex direction="column" gap="1">
          <Text size="4" weight="bold" color="gray" highContrast>What Nuggets tells you about</Text>
          <Text size="2" color="gray">
            Your choices for this ledger. Turn on phone & browser notifications for each device below.{' '}
            <Link asChild size="2">
              <RouterLink to="/settings/notification-rules">See the ledger's rules</RouterLink>
            </Link>
          </Text>
        </Flex>

        <Separator size="4" />

        {preferences.isPending && <Text size="2" color="gray">Loading your notifications…</Text>}

        {preferences.isError && (
          <Callout.Root color="red">
            <Callout.Icon><Info size={16} /></Callout.Icon>
            <Callout.Text>
              Your notification choices didn't load.{' '}
              <Button variant="ghost" size="1" onClick={() => void preferences.refetch()}>Try again</Button>
            </Callout.Text>
          </Callout.Root>
        )}

        {preferences.data && preferences.data.rules.length === 0 && (
          <Text size="2" color="gray">This ledger doesn't send any notifications right now.</Text>
        )}

        {preferences.data && !preferences.data.emailAvailable && preferences.data.rules.length > 0 && (
          <Callout.Root color="gray">
            <Callout.Icon><Info size={16} /></Callout.Icon>
            <Callout.Text>Email isn't set up for Nuggets yet, so these arrive only as phone & browser notifications.</Callout.Text>
          </Callout.Root>
        )}

        {preferences.data?.rules.map((rule) => {
          const byEmail = sendsBy(rule.sendBy, 'email');
          const byPush = sendsBy(rule.sendBy, 'push');
          return (
            <Flex key={rule.rule} direction="column" gap="2" role="group" aria-label={rule.label}>
              <Flex direction="column" gap="1">
                <Text size="3" weight="medium" color="gray" highContrast>{rule.label}</Text>
                <Text size="2" color="gray">
                  {ruleHints[rule.kind]}
                  {rule.sendBy !== 'both' && ` ${sendByHints[rule.sendBy]}`}
                </Text>
              </Flex>
              <Flex gap="5" wrap="wrap">
                <Text as="label" size="2">
                  <Flex align="center" gap="2">
                    <Checkbox
                      // A channel the rule doesn't use shows off and can't be turned on.
                      checked={byEmail && isOn(rule, 'email')}
                      disabled={!byEmail || !preferences.data.emailAvailable}
                      onCheckedChange={(checked) => choose(rule, 'email', checked === true)}
                    />
                    Email
                  </Flex>
                </Text>
                <Text as="label" size="2">
                  <Flex align="center" gap="2">
                    <Checkbox
                      checked={byPush && isOn(rule, 'push')}
                      disabled={!byPush}
                      onCheckedChange={(checked) => choose(rule, 'push', checked === true)}
                    />
                    Phone & browser
                  </Flex>
                </Text>
              </Flex>
            </Flex>
          );
        })}

        {failed && (
          <Text size="2" color="red" role="alert">That change didn't save. Try again.</Text>
        )}
      </Flex>
    </Card>
  );
};
