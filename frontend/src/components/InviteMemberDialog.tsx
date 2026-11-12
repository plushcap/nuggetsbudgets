import React, { useId, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'react-hot-toast';
import { Box, Button, Dialog, Flex, Switch, Text, TextField } from '@radix-ui/themes';
import { Copy, Mail, UserPlus } from 'lucide-react';
import { createInvitationSchema, type CreatedInvitationDto } from '@nuggets/shared';
import { useCreateOrgInvitationMutation } from '../hooks/queries/organizations';
import { createDefaultInviteMemberForm, type InviteMemberFormData } from '../types/forms';
import FieldError, { fieldErrorProps } from './forms/FieldError';

/** The link an invitee opens. The token goes after the #, so it never reaches a server log. */
export const invitationLink = (token: string): string => `${window.location.origin}/invitations/accept#${token}`;

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

interface InviteMemberDialogProps {
  orgUuid: string;
  orgName?: string | undefined;
}

/**
 * Invite someone to an organization: an admin enters an email address and
 * gets a one-time link to share. The person joins only by opening it signed in
 * with that address and accepting. Creating it says nothing about whether the
 * address has an account, and the link is shown only here, once.
 */
const InviteMemberDialog: React.FC<InviteMemberDialogProps> = ({ orgUuid, orgName }) => {
  const [open, setOpen] = useState(false);
  const adminId = useId();
  const [created, setCreated] = useState<CreatedInvitationDto | null>(null);
  const createInvitation = useCreateOrgInvitationMutation();
  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<InviteMemberFormData>({
    defaultValues: createDefaultInviteMemberForm(),
    resolver: zodResolver(createInvitationSchema) as never,
  });

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setCreated(null);
      reset(createDefaultInviteMemberForm());
    }
  };

  const onSubmit = async (values: InviteMemberFormData) => {
    try {
      setCreated(await createInvitation.mutateAsync({ uuid: orgUuid, input: values }));
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Couldn’t create the invitation');
    }
  };

  const link = created ? invitationLink(created.token) : '';
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success('Invitation link copied');
    } catch {
      toast.error('Couldn’t copy it. Select the link and copy it yourself.');
    }
  };

  const orgLabel = orgName ?? 'the organization';

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger>
        <Button>
          <UserPlus size={16} />
          Invite member
        </Button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="520px">
        {created ? (
          <Flex direction="column" gap="4">
            <Box>
              <Dialog.Title>Share the invitation</Dialog.Title>
              <Dialog.Description size="2">
                Send this link to {created.invitation.email}. It works once, until{' '}
                {formatDate(created.invitation.expiresAt)}, for someone signed in to Nuggets with that
                email address. It won’t be shown again.
              </Dialog.Description>
            </Box>
            <Flex direction="column" gap="1">
              <Text as="label" htmlFor="invitation-link" size="2" weight="medium">
                Invitation link
              </Text>
              <Flex gap="2" direction={{ initial: 'column', sm: 'row' }}>
                <Box flexGrow="1">
                  <TextField.Root id="invitation-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
                </Box>
                <Button onClick={copyLink}>
                  <Copy size={16} />
                  Copy link
                </Button>
              </Flex>
              <Text size="1" color="gray">
                They need a Nuggets sign-in with this address. If they don’t have one, a deployment admin
                can create it under Users.
              </Text>
            </Flex>
            <Flex justify="end">
              <Dialog.Close>
                <Button variant="soft" color="gray">Done</Button>
              </Dialog.Close>
            </Flex>
          </Flex>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} noValidate>
            <Flex direction="column" gap="4">
              <Box>
                <Dialog.Title>Invite someone to {orgLabel}</Dialog.Title>
                <Dialog.Description size="2">
                  You’ll get a link to send them. They join when they open it, signed in with this email
                  address, and accept.
                </Dialog.Description>
              </Box>
              <Flex direction="column" gap="1">
                <Text as="label" htmlFor="invite-email" size="2" weight="medium">
                  Email address
                </Text>
                <TextField.Root id="invite-email" type="email" placeholder="person@example.com" size="3" {...register('email')} {...fieldErrorProps('invite-email', errors.email)}>
                  <TextField.Slot>
                    <Mail size={16} />
                  </TextField.Slot>
                </TextField.Root>
                <FieldError fieldId="invite-email" message={errors.email?.message} />
              </Flex>
              <Controller
                control={control}
                name="isAdmin"
                render={({ field }) => (
                  <Text as="label" size="2">
                    <Flex align="start" gap="2">
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        aria-labelledby={`${adminId}-label`}
                        aria-describedby={`${adminId}-hint`}
                      />
                      <Flex direction="column">
                        <Text id={`${adminId}-label`}>Make them an organization admin</Text>
                        <Text id={`${adminId}-hint`} size="1" color="gray">
                          Admins manage the organization, its members and every one of its ledgers. Other members
                          see a ledger once one of its admins adds them.
                        </Text>
                      </Flex>
                    </Flex>
                  </Text>
                )}
              />
              <Flex justify="end" gap="2">
                <Dialog.Close>
                  <Button type="button" variant="soft" color="gray">Cancel</Button>
                </Dialog.Close>
                <Button type="submit" loading={createInvitation.isPending}>
                  Create invitation
                </Button>
              </Flex>
            </Flex>
          </form>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default InviteMemberDialog;
