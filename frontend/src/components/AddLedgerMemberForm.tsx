import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'react-hot-toast';
import { Button, Card, Flex, Link, Select, Switch, Text } from '@radix-ui/themes';
import FormSelectRoot from './forms/FormSelectRoot';
import { UserPlus } from 'lucide-react';
import type { MemberCandidateDto } from '@nuggets/shared';
import { useTenantMemberCandidatesQuery } from '../hooks/queries/tenants';
import { createDefaultAddLedgerMemberForm, type AddLedgerMemberFormData } from '../types/forms';

const candidateName = (c: MemberCandidateDto) => [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email;

interface AddLedgerMemberFormProps {
  /** The ledger's organization, for the copy. */
  organizationName?: string;
  /** Show a way to invite people to the organization (the viewer is its admin). */
  canInvite: boolean;
  onAdd: (email: string, isAdmin: boolean) => Promise<void>;
}

/**
 * Add someone to the active ledger, picked from its organization's members who
 * aren't in it yet: a ledger only takes members of its organization, and
 * people join the organization by invitation.
 */
const AddLedgerMemberForm: React.FC<AddLedgerMemberFormProps> = ({ organizationName, canInvite, onAdd }) => {
  const { data: candidates = [], isLoading } = useTenantMemberCandidatesQuery();
  const {
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<AddLedgerMemberFormData>({ defaultValues: createDefaultAddLedgerMemberForm() });
  const orgLabel = organizationName ?? 'the organization';

  const onSubmit = async ({ userUuid, isAdmin }: AddLedgerMemberFormData) => {
    const candidate = candidates.find((c) => c.userUuid === userUuid);
    if (!candidate) {
      toast.error('Choose who to add');
      return;
    }
    try {
      await onAdd(candidate.email, isAdmin);
      toast.success(`${candidateName(candidate)} added`);
      reset(createDefaultAddLedgerMemberForm());
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Couldn’t add them');
    }
  };

  const inviteHint = (
    <Text as="div" size="1" color="gray" mt="2">
      Only members of {orgLabel} can be added.{' '}
      {canInvite ? (
        <Link asChild size="1">
          <RouterLink to="/settings/organization">Invite someone to the organization</RouterLink>
        </Link>
      ) : (
        'An organization admin can invite someone new.'
      )}
    </Text>
  );

  if (!isLoading && candidates.length === 0) {
    return (
      <Card mb="4">
        <Text size="2" className="text-[var(--gray-12)]">
          Everyone in {orgLabel} is already in this ledger.
        </Text>
        {inviteHint}
      </Card>
    );
  }

  return (
    <Card mb="4">
      <form onSubmit={handleSubmit(onSubmit)}>
        <Flex direction={{ initial: 'column', sm: 'row' }} align={{ sm: 'end' }} gap="3">
          <Flex direction="column" flexGrow="1">
            <Text as="label" htmlFor="add-ledger-member" size="2" weight="medium" mb="1" className="text-[var(--gray-12)]" style={{ display: 'block' }}>
              Add a member of {orgLabel}
            </Text>
            <Controller
              control={control}
              name="userUuid"
              render={({ field }) => (
                <FormSelectRoot value={field.value ?? undefined} onValueChange={field.onChange} size="3" disabled={isLoading}>
                  <Select.Trigger id="add-ledger-member" placeholder={isLoading ? 'Loading…' : 'Choose someone'} />
                  <Select.Content>
                    {candidates.map((c) => (
                      <Select.Item key={c.userUuid} value={c.userUuid}>
                        {candidateName(c)} ({c.email})
                      </Select.Item>
                    ))}
                  </Select.Content>
                </FormSelectRoot>
              )}
            />
          </Flex>
          <Controller
            control={control}
            name="isAdmin"
            render={({ field }) => (
              <Text as="label" size="2" className="text-[var(--gray-11)]">
                <Flex align="center" gap="2" pb={{ sm: '2' }}>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                  Admin
                </Flex>
              </Text>
            )}
          />
          <Button type="submit" size="3" loading={isSubmitting} disabled={isLoading}>
            <UserPlus size={16} />
            Add
          </Button>
        </Flex>
        {inviteHint}
      </form>
    </Card>
  );
};

export default AddLedgerMemberForm;
