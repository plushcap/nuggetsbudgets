import React, { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Flex, Heading, Text } from '@radix-ui/themes';
import { unsubscribeRequestSchema } from '@nuggets/shared';
import NuggetsLogo from '../components/NuggetsLogo';
import { inspectUnsubscribeLink, unsubscribeByLink } from '../services/api';
import PageContainer from '../components/PageContainer';

/**
 * The page a notification email's "Stop these emails" link opens. No sign-in:
 * the token in the link (after the #, so it never reaches a server log) is the
 * credential. It names the notification first and stops it only when the
 * person presses the button, so a mail scanner that opens links stops nothing.
 */

function initialToken(): string {
  const fromHash = window.location.hash.slice(1);
  if (fromHash) return fromHash;
  const state = window.history.state as { unsubscribeToken?: unknown } | null;
  return typeof state?.unsubscribeToken === 'string' ? state.unsubscribeToken : '';
}

/** The server's explanation (`{ error }`), which the API helpers leave on `response.data`. */
function errorMessage(error: unknown): string {
  const data = (error as { response?: { data?: { error?: unknown } } } | null)?.response?.data;
  return typeof data?.error === 'string' ? data.error : 'This link has expired or doesn’t work.';
}

const UnsubscribePage: React.FC = () => {
  const navigate = useNavigate();
  const [token] = useState(initialToken);
  const valid = unsubscribeRequestSchema.safeParse({ token }).success;

  // Keep the token out of the address bar (and so out of history and bookmarks)
  // while a reload still works.
  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState({ ...(window.history.state ?? {}), unsubscribeToken: token }, '', window.location.pathname);
    }
  }, [token]);

  // One look only: each counts against the link endpoints' rate limit.
  const link = useQuery({
    queryKey: ['unsubscribe-link', token],
    queryFn: () => inspectUnsubscribeLink(token),
    enabled: valid,
    retry: false,
    staleTime: Infinity,
    refetchOnReconnect: false,
    meta: { suppressErrorToast: true },
  });
  const stop = useMutation({ mutationFn: () => unsubscribeByLink(token) });

  let heading: string;
  let body: string;
  if (!valid) {
    heading = 'This link doesn’t work';
    body = 'It isn’t complete. Choose which notifications you get in My Profile.';
  } else if (link.isPending) {
    heading = 'Checking the link…';
    body = '';
  } else if (link.isError) {
    heading = 'This link doesn’t work';
    body = errorMessage(link.error);
  } else if (stop.isSuccess) {
    heading = 'You won’t get these any more';
    body = `We’ve stopped emailing you “${stop.data.label}”. Your other notifications stay as they are.`;
  } else {
    heading = `Stop “${link.data.label}”?`;
    body = 'You’ll stop getting these emails from Nuggets. Your other notifications, and this one on your phone, stay as they are.';
  }

  const canStop = valid && link.isSuccess && !stop.isSuccess;

  return (
    <Flex align="center" justify="center" className="bg-[var(--gray-2)]" minHeight="100vh" py="9">
      <PageContainer width="auth">
        <Card size="4">
          <Flex direction="column" gap="5" align="center">
            <NuggetsLogo size={64} />
            <Heading size="5" align="center">{heading}</Heading>
            {body && <Text size="2" color="gray" align="center">{body}</Text>}
            {stop.isError && <Text size="2" color="red" align="center" role="alert">{errorMessage(stop.error)}</Text>}
            <Flex gap="3" justify="center" wrap="wrap">
              {canStop && (
                <Button size="3" onClick={() => stop.mutate()} loading={stop.isPending}>
                  Stop these emails
                </Button>
              )}
              <Button size="3" variant={canStop ? 'soft' : 'solid'} onClick={() => navigate('/profile')}>
                Open My Profile
              </Button>
            </Flex>
          </Flex>
        </Card>
      </PageContainer>
    </Flex>
  );
};

export default UnsubscribePage;
