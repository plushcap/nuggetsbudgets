import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Flex, Heading, Text } from '@radix-ui/themes';
import { Building2 } from 'lucide-react';
import { invitationTokenSchema } from '@nuggets/shared';
import { useAuth } from '../contexts/AuthContext';
import { useAcceptInvitationMutation, useInvitationPreviewQuery } from '../hooks/queries/organizations';
import PageContainer from '../components/PageContainer';

/**
 * The page an invitation link opens: /invitations/accept#<token>. Signing
 * in comes first (ProtectedRoute, which brings the person back here). It names
 * the organization and joins it only when the person presses Accept. The token
 * is after the # so it never reaches a server log, and it leaves the address
 * bar once read (a reload still works, from the history state). `?token=` works
 * too.
 */

function initialToken(): string {
  const fromHash = window.location.hash.slice(1);
  if (fromHash) return fromHash;
  const fromQuery = new URLSearchParams(window.location.search).get('token');
  if (fromQuery) return fromQuery;
  const state = window.history.state as { invitationToken?: unknown } | null;
  return typeof state?.invitationToken === 'string' ? state.invitationToken : '';
}

/** The server's explanation (`{ error }`), which the API helpers leave on `response.data`. */
function errorMessage(error: unknown): string {
  const data = (error as { response?: { data?: { error?: unknown } } } | null)?.response?.data;
  return typeof data?.error === 'string' ? data.error : 'This invitation can’t be used.';
}

const personName = (p: { firstName: string | null; lastName: string | null } | null) =>
  p ? [p.firstName, p.lastName].filter(Boolean).join(' ') : '';

const AcceptInvitationPage: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [token] = useState(initialToken);
  const valid = invitationTokenSchema.safeParse({ token }).success;

  useEffect(() => {
    if (window.location.hash || window.location.search) {
      window.history.replaceState({ ...(window.history.state ?? {}), invitationToken: token }, '', window.location.pathname);
    }
  }, [token]);

  const preview = useInvitationPreviewQuery(token, { enabled: valid });
  const accept = useAcceptInvitationMutation();

  let heading: string;
  let body: string;
  if (accept.isSuccess) {
    heading = `You’ve joined ${accept.data.organization.name}`;
    body = accept.data.isAdmin
      ? 'You’re an admin of the organization, so you can manage it and open all of its ledgers.'
      : 'A ledger admin can now add you to the organization’s ledgers.';
  } else if (!valid) {
    heading = 'This invitation link doesn’t work';
    body = 'It isn’t complete. Ask whoever invited you to send the link again.';
  } else if (preview.isPending) {
    heading = 'Checking the invitation…';
    body = '';
  } else if (preview.isError) {
    heading = 'This invitation can’t be used';
    body = errorMessage(preview.error);
  } else {
    const { organization, isAdmin, alreadyMember, invitedBy } = preview.data;
    const by = personName(invitedBy);
    heading = `Join ${organization.name}?`;
    body = alreadyMember
      ? `You’re already a member of ${organization.name}.${isAdmin ? ' Accepting makes you one of its admins.' : ''}`
      : `${by ? `${by} invited you` : 'You’re invited'} to join ${organization.name} as ${isAdmin ? 'an admin' : 'a member'}.` +
        (isAdmin ? ' Admins manage the organization, its members and all of its ledgers.' : '');
  }

  const canAccept = valid && preview.isSuccess && !accept.isSuccess;

  return (
    <PageContainer width="auth" py="6">
      <Card size="4">
        <Flex direction="column" gap="4" align="center">
          <Building2 size={40} className="text-[var(--accent-11)]" aria-hidden="true" />
          <Heading size="5" align="center">{heading}</Heading>
          {body && <Text size="2" color="gray" align="center">{body}</Text>}
          {preview.isError && !accept.isSuccess && user?.email && (
            <Text size="1" color="gray" align="center">You’re signed in as {user.email}.</Text>
          )}
          {accept.isError && <Text size="2" color="red" align="center" role="alert">{errorMessage(accept.error)}</Text>}
          <Flex gap="3" justify="center" wrap="wrap">
            {canAccept && (
              <Button size="3" onClick={() => accept.mutate(token)} loading={accept.isPending}>
                Accept invitation
              </Button>
            )}
            <Button size="3" variant={canAccept ? 'soft' : 'solid'} {...(canAccept ? { color: 'gray' as const } : {})} onClick={() => navigate('/')}>
              {accept.isSuccess ? 'Open Nuggets' : canAccept ? 'Not now' : 'Go to Nuggets'}
            </Button>
          </Flex>
        </Flex>
      </Card>
    </PageContainer>
  );
};

export default AcceptInvitationPage;
