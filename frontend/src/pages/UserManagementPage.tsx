import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  Users,
  UserPlus,
  Edit3,
  Trash2,
  Shield,
  User as UserIcon,
  Mail,
  Calendar,
  Search
} from 'lucide-react';
import toast from 'react-hot-toast';
import SettingsPageHeader from '../components/SettingsPageHeader';
import { useConfirmation } from '../hooks/useConfirmation';
import ConfirmationDialog from '../components/ConfirmationDialog';
import { type AdminUser as UserType } from '../services/api';
import { useAdminUsersQuery, useDeleteUserMutation, useUpdateUserMutation } from '../hooks/queries/settings';
import { getIconByName } from '../utils/iconCatalog';
import PageLoader from '../components/PageLoader';
import { profileImageUrl } from '../utils/profileImage';
import { apiErrorMessage } from '../utils/errors';
import { chosenColourProps } from '../utils/textColor';
import { Card, Flex, Box, Text, Button, TextField, IconButton, Table, Badge, Switch } from '@radix-ui/themes';
import PageContainer from '../components/PageContainer';
import { personName } from '../utils/personName';

const UserManagementPage: React.FC = () => {
  const { user, isDeploymentAdmin } = useAuth();
  const navigate = useNavigate();
  const { data: users = [], isLoading: loading } = useAdminUsersQuery();
  const deleteUserMutation = useDeleteUserMutation();
  const updateUserMutation = useUpdateUserMutation();
  const [searchTerm, setSearchTerm] = useState('');
  const { confirmAsync, dialogProps } = useConfirmation();

  // Helper function to render icons
  const renderIcon = (iconName: string, size = 20): React.ReactElement => {
    const iconOption = getIconByName(iconName);
    if (!iconOption) return <UserIcon size={size} />;
    const IconComponent = iconOption.component;
    return <IconComponent size={size} />;
  };

  const handleDeleteUser = async (userToDelete: UserType) => {
    const confirmed = await confirmAsync({
      title: 'Delete User',
      message: `Are you sure you want to delete ${personName(userToDelete, userToDelete.email)}?`,
      variant: 'danger',
      confirmText: 'Delete User',
      cancelText: 'Cancel',
      icon: <Trash2 size={24} />,
      details: [
        'This action cannot be undone',
        'The user will lose access to the system immediately'
      ]
    });

    if (!confirmed) return;

    try {
      await deleteUserMutation.mutateAsync(userToDelete.uuid);
      toast.success('User deleted successfully');
    } catch (error) {
      // The server's reason: LAST_ADMIN names what the user is the only admin of.
      toast.error(apiErrorMessage(error, 'Error deleting user'));
    }
  };

  const handleToggleLocked = async (userId: number, isLocked: boolean) => {
    try {
      // Find user by id to get the uuid
      const user = users.find(u => u.id === userId);
      if (!user) {
        toast.error('User not found');
        return;
      }
      
      await updateUserMutation.mutateAsync([user.uuid, { is_locked: isLocked }]);
      toast.success(`User ${isLocked ? 'locked' : 'unlocked'} successfully`);
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Error updating user status'));
    }
  };

  const handleToggleLoginDisabled = async (userId: number, loginDisabled: boolean) => {
    try {
      const user = users.find((u) => u.id === userId);
      if (!user) {
        toast.error('User not found');
        return;
      }
      await updateUserMutation.mutateAsync([user.uuid, { login_disabled: loginDisabled }]);
      toast.success(loginDisabled ? 'Interactive sign-in disabled' : 'Interactive sign-in enabled');
    } catch (error) {
      // The server's reason (CANNOT_DISABLE_OWN_LOGIN, say). The page looked for the code in
      // the message, which is the server's text, so it never found it.
      toast.error(apiErrorMessage(error, 'Error updating user sign-in'));
    }
  };

  // Filter users based on search term
  const filteredUsers = users.filter(u => 
    (u.first_name ?? '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    (u.last_name ?? '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    u.email.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // If not a deployment admin, show access denied
  if (!isDeploymentAdmin) {
    return (
      <PageContainer>
        <Card>
          <Flex direction="column" align="center" gap="4" py="9">
            <Shield size={64} className="text-[var(--red-11)]" />
            <Flex direction="column" align="center" gap="2">
              <Text size="6" weight="bold">Access Denied</Text>
              <Text size="2" color="gray">
                You need administrator privileges to access user management.
              </Text>
            </Flex>
          </Flex>
        </Card>
      </PageContainer>
    );
  }

  if (loading) {
    return (
      <PageContainer>
        <PageLoader label="Loading users…" />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Header */}
      <SettingsPageHeader
        title="User Management"
        subtitle="Manage system users and their permissions"
        icon={<Users size={20} className="text-[var(--accent-11)]" />}
        iconBackground="bg-[var(--accent-3)]"
        backPath="/settings"
        primaryAction={{
          label: 'Add User',
          onClick: () => navigate('/settings/users/add'),
          icon: <UserPlus size={16} />
        }}
      />

      {/* Search and Stats Card */}
      <Card mb="4">
        <Flex direction={{ initial: 'column', sm: 'row' }} align={{ sm: 'center' }} justify="between" gap="4">
          <Box flexGrow="1" maxWidth={{ sm: '28rem' }}>
            <TextField.Root
              aria-label="Search users"
              placeholder="Search users..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              size="3"
              variant="surface"
            >
              <TextField.Slot>
                <Search size={16} />
              </TextField.Slot>
            </TextField.Root>
          </Box>
          <Flex align="center" justify={{ initial: 'between', sm: 'start' }} gap="4">
            <Text size="2" color="gray">
              Total: <Text weight="medium" className="text-[var(--gray-12)]">{filteredUsers.length}</Text>
            </Text>
            <Text size="2" color="gray" weight="medium">
              Active: {filteredUsers.length}
            </Text>
          </Flex>
        </Flex>
      </Card>

      {/* Empty State */}
      {filteredUsers.length === 0 && (
        <Card>
          <Flex direction="column" align="center" gap="4" py="9">
            <Users size={48} className="text-[var(--gray-6)]" />
            <Flex direction="column" align="center" gap="2">
              <Text size="4" weight="bold" className="text-[var(--gray-12)]">No users found</Text>
              <Text size="2" color="gray" align="center">
                {searchTerm ? 'No users match your search criteria.' : 'No users have been created yet.'}
              </Text>
            </Flex>
            {!searchTerm && (
              <Button size="3" onClick={() => navigate('/settings/users/add')}>
                <UserPlus size={16} />
                Add First User
              </Button>
            )}
          </Flex>
        </Card>
      )}

      {/* Mobile Card View */}
      {filteredUsers.length > 0 && (
        <Card className="block md:hidden">
          <Flex direction="column" gap="4">
            {filteredUsers.map((u) => (
              <Card key={u.id} variant="surface">
              {/* Header Row */}
              <Flex align="start" justify="between" mb="3">
                <Flex align="center" gap="3" flexGrow="1" minWidth="0">
                  <Box position="relative" flexShrink="0">
                    {u.profile_image ? (
                      <Box asChild width="48px" height="48px"><img
                        src={profileImageUrl(u.profile_image) ?? undefined}
                        alt={`${personName(u, u.email)}`}
                        className="rounded-full object-cover border-2 border-[var(--gray-6)]"
                      /></Box>
                    ) : (
                      <Flex
                        align="center"
                        justify="center"
                        width="48px"
                        height="48px"
                        {...chosenColourProps(u.default_color, 'accent', 'rounded-full')}
                      >
                        {renderIcon(u.icon || 'User', 24)}
                      </Flex>
                    )}
                    {u.is_deployment_admin && (
                      <Flex
                        align="center"
                        justify="center"
                        position="absolute" top="-4px" right="-4px" width="20px" height="20px" className="rounded-full bg-[var(--accent-9)]"
                      >
                        <Shield size={12} className="text-[var(--accent-contrast)]" />
                      </Flex>
                    )}
                  </Box>
                  <Box flexGrow="1" minWidth="0">
                    <Text as="div" weight="bold" truncate className="text-[var(--gray-12)]">
                      {personName(u, u.email)}
                      {u.id === user?.id && <Text size="1" ml="2" className="text-[var(--accent-11)]">(You)</Text>}
                    </Text>
                    <Flex asChild align="center" gap="1">
                      <Text as="p" size="2" color="gray" truncate>
                        <Mail size={12} className="shrink-0" />
                        {u.email}
                      </Text>
                    </Flex>
                  </Box>
                </Flex>
              </Flex>

              {/* Info Grid */}
              <Flex direction="column" gap="2" mb="3">
                <Flex align="center" justify="between">
                  <Text size="2" color="gray">Role:</Text>
                  <Badge color={u.is_deployment_admin ? 'red' : 'gray'} variant="soft" radius="full">
                    {u.is_deployment_admin ? 'Administrator' : 'User'}
                  </Badge>
                </Flex>

                <Flex align="center" justify="between">
                  <Text size="2" color="gray">Status:</Text>
                  <Flex align="center" gap="2">
                    <Switch
                      aria-label={`Lock user ${personName(u, u.email)}`}
                      checked={u.is_locked}
                      onCheckedChange={(checked) => handleToggleLocked(u.id, checked)}
                      color={u.is_locked ? 'red' : 'green'}
                    />
                    <Text size="1" weight="medium" className={u.is_locked ? 'text-[var(--red-11)]' : 'text-[var(--green-12)]'}>
                      {u.is_locked ? 'Locked' : 'Active'}
                    </Text>
                  </Flex>
                </Flex>

                <Flex align="center" justify="between">
                  <Text size="2" color="gray">Sign-in:</Text>
                  <Flex align="center" gap="2">
                    <Switch
                      aria-label={`Disable sign-in for ${personName(u, u.email)}`}
                      checked={u.login_disabled}
                      onCheckedChange={(checked) => handleToggleLoginDisabled(u.id, checked)}
                      color={u.login_disabled ? 'amber' : 'gray'}
                    />
                    <Text size="1" weight="medium" className={u.login_disabled ? 'text-[var(--amber-12)]' : 'text-[var(--gray-11)]'}>
                      {u.login_disabled ? 'No sign-in' : 'Can sign in'}
                    </Text>
                  </Flex>
                </Flex>

                <Flex align="center" justify="between">
                  <Text size="2" color="gray">Created:</Text>
                  <Flex asChild align="center" gap="1">
                    <Text size="2" className="text-[var(--gray-12)]">
                      <Calendar size={12} />
                      {new Date(u.created_at).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric'
                      })}
                    </Text>
                  </Flex>
                </Flex>
              </Flex>

              {/* Action Buttons */}
              <Flex gap="2" pt="3" className="border-t border-[var(--gray-6)]">
                <Button
                  onClick={() => navigate(`/settings/users/edit/${u.uuid}`)}
                  variant="soft"
                  size="3"
                  className="flex-1"
                  style={{ minHeight: '44px' }}
                >
                  <Edit3 size={16} />
                  Edit
                </Button>
                {u.id !== user?.id && (
                  <Button
                    onClick={() => handleDeleteUser(u)}
                    variant="soft"
                    color="red"
                    size="3"
                    className="flex-1"
                    style={{ minHeight: '44px' }}
                  >
                    <Trash2 size={16} />
                    Delete
                  </Button>
                )}
              </Flex>
            </Card>
          ))}
          </Flex>
        </Card>
      )}

      {/* Desktop Table View */}
      {filteredUsers.length > 0 && (
        <Card className="hidden md:block">
          <Table.Root size="2">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>User</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Email</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Role</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Created</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell justify="end">Actions</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {filteredUsers.map((u) => (
                <Table.Row key={u.id}>
                  <Table.Cell>
                    <Flex align="center" gap="3">
                      <Box position="relative" flexShrink="0">
                        {u.profile_image ? (
                          <Box asChild width="40px" height="40px"><img
                            src={profileImageUrl(u.profile_image) ?? undefined}
                            alt={`${personName(u, u.email)}`}
                            className="rounded-full object-cover border-2 border-[var(--gray-6)]"
                          /></Box>
                        ) : (
                          <Flex
                            align="center"
                            justify="center"
                            width="40px"
                            height="40px"
                            {...chosenColourProps(u.default_color, 'accent', 'rounded-full')}
                          >
                            {renderIcon(u.icon || 'User', 20)}
                          </Flex>
                        )}
                        {u.is_deployment_admin && (
                          <Flex
                            align="center"
                            justify="center"
                            position="absolute" top="-4px" right="-4px" width="16px" height="16px" className="rounded-full bg-[var(--accent-9)]"
                          >
                            <Shield size={10} className="text-[var(--accent-contrast)]" />
                          </Flex>
                        )}
                      </Box>
                      <Flex direction="column" gap="1">
                        <Text size="2" weight="medium">
                          {personName(u, u.email)}
                          {u.id === user?.id && <Text size="1" className="text-[var(--accent-11)]"> (You)</Text>}
                        </Text>
                      </Flex>
                    </Flex>
                  </Table.Cell>
                  <Table.Cell>
                    <Flex align="center" gap="2">
                      <Mail size={16} className="text-[var(--gray-11)]" />
                      <Text size="2">{u.email}</Text>
                    </Flex>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge color={u.is_deployment_admin ? 'red' : 'gray'} variant="soft">
                      {u.is_deployment_admin ? 'Administrator' : 'User'}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <Flex direction="column" gap="2" align="start">
                      <Flex align="center" gap="2">
                        <Switch
                          aria-label={`Lock user ${personName(u, u.email)}`}
                          checked={u.is_locked}
                          onCheckedChange={(checked) => handleToggleLocked(u.id, checked)}
                          color={u.is_locked ? 'red' : 'green'}
                        />
                        <Text size="1" weight="medium" className={u.is_locked ? 'text-[var(--red-11)]' : 'text-[var(--green-12)]'}>
                          {u.is_locked ? 'Locked' : 'Active'}
                        </Text>
                      </Flex>
                      <Flex align="center" gap="2">
                        <Switch
                          aria-label={`Disable sign-in for ${personName(u, u.email)}`}
                          checked={u.login_disabled}
                          onCheckedChange={(checked) => handleToggleLoginDisabled(u.id, checked)}
                          color={u.login_disabled ? 'amber' : 'gray'}
                        />
                        <Text size="1" weight="medium" className={u.login_disabled ? 'text-[var(--amber-12)]' : 'text-[var(--gray-11)]'}>
                          {u.login_disabled ? 'No sign-in' : 'Can sign in'}
                        </Text>
                      </Flex>
                    </Flex>
                  </Table.Cell>
                  <Table.Cell>
                    <Flex align="center" gap="2">
                      <Calendar size={16} className="text-[var(--gray-11)]" />
                      <Text size="2" className="text-[var(--gray-11)]">
                        {new Date(u.created_at).toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'short', 
                          day: 'numeric'
                        })}
                      </Text>
                    </Flex>
                  </Table.Cell>
                  <Table.Cell justify="end">
                    <Flex gap="2" justify="end">
                      <IconButton
                        onClick={() => navigate(`/settings/users/edit/${u.uuid}`)}
                        variant="ghost"
                        size="2"
                        aria-label={`Edit user ${personName(u, u.email)}`}
                      >
                        <Edit3 size={16} />
                      </IconButton>
                      {u.id !== user?.id && (
                        <IconButton
                          onClick={() => handleDeleteUser(u)}
                          variant="ghost"
                          color="red"
                          size="2"
                          aria-label={`Delete user ${personName(u, u.email)}`}
                        >
                          <Trash2 size={16} />
                        </IconButton>
                      )}
                    </Flex>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Card>
      )}

      <ConfirmationDialog {...dialogProps} />
    </PageContainer>
  );
};

export default UserManagementPage;
