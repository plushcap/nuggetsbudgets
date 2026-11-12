import React, { useState, useId } from 'react';
import { Card, Flex, Box, Text, Button, TextField, IconButton, Table, Badge, Switch } from '@radix-ui/themes';
import { Trash2, UserPlus, Mail, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { addMemberSchema, type MemberDto } from '@nuggets/shared';
import { useConfirmation } from '../hooks/useConfirmation';
import ConfirmationDialog from './ConfirmationDialog';
import { apiErrorMessage } from '../utils/errors';

interface MembershipManagerProps {
  members: MemberDto[];
  loading: boolean;
  /** Whether the viewer may add/remove members and toggle admin. */
  canManage: boolean;
  /** Marks the viewer's own row with "(You)". */
  currentUserUuid?: string | undefined;
  /** Used in copy, e.g. "Remove … from this budget". */
  entityLabel: string;
  /**
   * Add an existing user by email. When given (and `canManage`), an email form is
   * shown; the org page passes it only to deployment admins, since an org's own
   * admins invite people instead.
   */
  onAddMember?: ((email: string, isAdmin: boolean) => Promise<void>) | undefined;
  /** The line under the email form. */
  addMemberHint?: string | undefined;
  /** Another way to add members (an invite dialog, a picker), shown above the list when `canManage`. */
  addControl?: React.ReactNode;
  onToggleAdmin: (member: MemberDto, isAdmin: boolean) => Promise<void>;
  onRemoveMember: (member: MemberDto) => Promise<void>;
  /**
   * Whether the viewer may toggle the GLOBAL account flags (is_locked /
   * login_disabled) — reserved for org admins and deployment admins. When false,
   * those flags are shown as read-only badges. Independent of `canManage`.
   */
  canManageUserFlags?: boolean | undefined;
  onToggleLocked?: ((member: MemberDto, locked: boolean) => Promise<void>) | undefined;
  onToggleLoginDisabled?: ((member: MemberDto, loginDisabled: boolean) => Promise<void>) | undefined;
}

// The server's reason (a refusal such as LAST_ADMIN names what to change first), never
// another error's text.
const errorMessage = (err: unknown): string => apiErrorMessage(err, 'Something went wrong');

const MembershipManager: React.FC<MembershipManagerProps> = ({
  members,
  loading,
  canManage,
  currentUserUuid,
  entityLabel,
  onAddMember,
  addMemberHint = 'The person must already have a Nuggets login. Create them under Users first if needed.',
  addControl,
  onToggleAdmin,
  onRemoveMember,
  canManageUserFlags = false,
  onToggleLocked,
  onToggleLoginDisabled,
}) => {
  const fieldId = useId();
  const [email, setEmail] = useState('');
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const { confirmAsync, dialogProps } = useConfirmation();

  const fullName = (m: MemberDto) =>
    [m.user.firstName, m.user.lastName].filter(Boolean).join(' ') || m.user.email;

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onAddMember) return;
    const parsed = addMemberSchema.safeParse({ email, isAdmin: makeAdmin });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Enter a valid email');
      return;
    }
    setSubmitting(true);
    try {
      await onAddMember(parsed.data.email, parsed.data.isAdmin);
      toast.success('Member added');
      setEmail('');
      setMakeAdmin(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (member: MemberDto, isAdmin: boolean) => {
    try {
      await onToggleAdmin(member, isAdmin);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleRemove = async (member: MemberDto) => {
    const confirmed = await confirmAsync({
      title: 'Remove member',
      message: `Remove ${fullName(member)} from this ${entityLabel}?`,
      variant: 'danger',
      confirmText: 'Remove',
      cancelText: 'Cancel',
      icon: <Trash2 size={24} />,
    });
    if (!confirmed) return;
    try {
      await onRemoveMember(member);
      toast.success('Member removed');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const roleBadge = (m: MemberDto) => (
    <Badge color={m.isAdmin ? 'iris' : 'gray'} variant="soft" radius="full">
      {m.isAdmin ? 'Admin' : 'Member'}
    </Badge>
  );

  // These flags live on the global users row, so the change reaches the person
  // everywhere — the confirmation makes that explicit.
  const globalImpact = ['This is a global change — it affects this person across every ledger and organization.'];

  const handleToggleLocked = async (member: MemberDto, locked: boolean) => {
    if (!onToggleLocked) return;
    const confirmed = await confirmAsync({
      title: locked ? 'Lock this account?' : 'Unlock this account?',
      message: locked
        ? `${fullName(member)} will be signed out and blocked from signing in.`
        : `${fullName(member)} will be able to sign in again.`,
      details: locked ? globalImpact : undefined,
      variant: locked ? 'danger' : 'info',
      confirmText: locked ? 'Lock account' : 'Unlock',
      cancelText: 'Cancel',
    });
    if (!confirmed) return;
    try {
      await onToggleLocked(member, locked);
      toast.success(locked ? 'Account locked' : 'Account unlocked');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleToggleLoginDisabled = async (member: MemberDto, disabled: boolean) => {
    if (!onToggleLoginDisabled) return;
    const confirmed = await confirmAsync({
      title: disabled ? 'Disable interactive sign-in?' : 'Enable interactive sign-in?',
      message: disabled
        ? `${fullName(member)} won't be able to sign in, but automation tokens (PAT / MCP) keep working.`
        : `${fullName(member)} will be able to sign in normally again.`,
      details: disabled ? globalImpact : undefined,
      variant: disabled ? 'danger' : 'info',
      confirmText: disabled ? 'Disable sign-in' : 'Enable sign-in',
      cancelText: 'Cancel',
    });
    if (!confirmed) return;
    try {
      await onToggleLoginDisabled(member, disabled);
      toast.success(disabled ? 'Interactive sign-in disabled' : 'Interactive sign-in enabled');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const restrictionBadges = (m: MemberDto) =>
    m.user.isLocked || m.user.loginDisabled ? (
      <Flex align="center" gap="1" wrap="wrap" justify="end">
        {m.user.isLocked && <Badge color="red" variant="soft" radius="full">Locked</Badge>}
        {m.user.loginDisabled && <Badge highContrast color="amber" variant="soft" radius="full">No sign-in</Badge>}
      </Flex>
    ) : null;

  const flagToggles = (m: MemberDto) => {
    const isSelf = m.user.uuid === currentUserUuid;
    return (
      <Flex direction="column" gap="2">
        <Flex align="center" gap="2" width="fit-content" asChild>
          <label>
            <Switch size="1" color="red" checked={m.user.isLocked} disabled={isSelf} onCheckedChange={(c) => handleToggleLocked(m, c)} />
            <Text size="1" color="gray">Locked</Text>
          </label>
        </Flex>
        <Flex align="center" gap="2" width="fit-content" asChild>
          <label>
            <Switch size="1" color="amber" checked={m.user.loginDisabled} disabled={isSelf} onCheckedChange={(c) => handleToggleLoginDisabled(m, c)} />
            <Text size="1" color="gray">No sign-in</Text>
          </label>
        </Flex>
      </Flex>
    );
  };

  return (
    <Box>
      {canManage && addControl}

      {canManage && onAddMember && (
        <Card mb="4">
          <form onSubmit={handleAdd}>
            <Flex direction={{ initial: 'column', sm: 'row' }} align={{ sm: 'end' }} gap="3">
              <Box flexGrow="1">
                <Text as="label" htmlFor={`${fieldId}-email`} size="2" weight="medium" mb="1" className="text-[var(--gray-12)]" style={{ display: 'block' }}>
                  Add a member by email
                </Text>
                <TextField.Root
                  id={`${fieldId}-email`}
                  type="email"
                  placeholder="person@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  size="3"
                >
                  <TextField.Slot>
                    <Mail size={16} />
                  </TextField.Slot>
                </TextField.Root>
              </Box>
              <Flex align="center" gap="2" pb={{ sm: '2' }} width="fit-content" asChild>
                <label>
                  <Switch checked={makeAdmin} onCheckedChange={setMakeAdmin} />
                  <Text size="2" className="text-[var(--gray-11)]">Admin</Text>
                </label>
              </Flex>
              <Button type="submit" size="3" disabled={submitting}>
                <UserPlus size={16} />
                Add
              </Button>
            </Flex>
            <Text as="div" size="1" color="gray" mt="2">
              {addMemberHint}
            </Text>
          </form>
        </Card>
      )}

      {loading ? (
        <Card>
          <Flex justify="center" py="6">
            <Text size="2" color="gray">Loading members…</Text>
          </Flex>
        </Card>
      ) : members.length === 0 ? (
        <Card>
          <Flex direction="column" align="center" gap="2" py="8">
            <Text size="3" weight="bold" className="text-[var(--gray-12)]">No members yet</Text>
          </Flex>
        </Card>
      ) : (
        <>
          {/* Mobile cards */}
          <Card className="block md:hidden">
            <Flex direction="column" gap="3">
              {members.map((m) => (
                <Card key={m.uuid} variant="surface">
                  <Flex align="start" justify="between" gap="3">
                    <Box minWidth="0">
                      <Text as="div" weight="bold" truncate className="text-[var(--gray-12)]">
                        {fullName(m)}
                        {m.user.uuid === currentUserUuid && (
                          <Text size="1" className="text-[var(--accent-11)]"> (You)</Text>
                        )}
                      </Text>
                      <Text as="div" size="2" color="gray" truncate>{m.user.email}</Text>
                    </Box>
                    <Flex direction="column" align="end" gap="1">
                      {!canManage && roleBadge(m)}
                      {restrictionBadges(m)}
                    </Flex>
                  </Flex>
                  {canManage && (
                    <Flex align="center" justify="between" mt="3" pt="3" className="border-t border-[var(--gray-6)]">
                      <Flex align="center" gap="2" width="fit-content" asChild>
                        <label>
                          <Switch checked={m.isAdmin} onCheckedChange={(checked) => handleToggle(m, checked)} />
                          <Text size="2" className="text-[var(--gray-11)]">Admin</Text>
                        </label>
                      </Flex>
                      <IconButton
                        color="red"
                        variant="soft"
                        onClick={() => handleRemove(m)}
                        aria-label={`Remove ${fullName(m)}`}
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </Flex>
                  )}
                  {canManageUserFlags && (
                    <Box mt="3" pt="3" className="border-t border-[var(--gray-6)]">
                      <Text as="div" size="1" color="gray" mb="2">
                        Account access (applies everywhere)
                      </Text>
                      {flagToggles(m)}
                    </Box>
                  )}
                </Card>
              ))}
            </Flex>
          </Card>

          {/* Desktop table */}
          <Card className="hidden md:block">
            <Table.Root size="2">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Member</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Email</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Role</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Access</Table.ColumnHeaderCell>
                  {canManage && <Table.ColumnHeaderCell justify="end">Actions</Table.ColumnHeaderCell>}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {members.map((m) => (
                  <Table.Row key={m.uuid}>
                    <Table.Cell>
                      <Flex align="center" gap="2">
                        {m.isAdmin && <ShieldCheck size={16} className="text-[var(--iris-11)]" aria-hidden="true" />}
                        <Text size="2" weight="medium">
                          {fullName(m)}
                          {m.user.uuid === currentUserUuid && (
                            <Text size="1" className="text-[var(--accent-11)]"> (You)</Text>
                          )}
                        </Text>
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <Flex align="center" gap="2">
                        <Mail size={16} className="text-[var(--gray-11)]" />
                        <Text size="2">{m.user.email}</Text>
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      {canManage ? (
                        <Flex align="center" gap="2" width="fit-content" asChild>
                          <label>
                            <Switch checked={m.isAdmin} onCheckedChange={(checked) => handleToggle(m, checked)} />
                            <Text size="1" color="gray">Admin</Text>
                          </label>
                        </Flex>
                      ) : (
                        roleBadge(m)
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      {canManageUserFlags ? flagToggles(m) : (restrictionBadges(m) ?? <Text size="1" color="gray">—</Text>)}
                    </Table.Cell>
                    {canManage && (
                      <Table.Cell justify="end">
                        <Flex justify="end">
                          <IconButton
                            color="red"
                            variant="ghost"
                            onClick={() => handleRemove(m)}
                            aria-label={`Remove ${fullName(m)}`}
                          >
                            <Trash2 size={16} />
                          </IconButton>
                        </Flex>
                      </Table.Cell>
                    )}
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Card>
        </>
      )}

      <ConfirmationDialog {...dialogProps} />
    </Box>
  );
};

export default MembershipManager;
