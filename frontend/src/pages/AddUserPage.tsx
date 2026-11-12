import React, { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createUserCreateSchema, describePasswordPolicy } from '@nuggets/shared';
import { useNavigate } from 'react-router-dom';
import { UserPlus, Save } from 'lucide-react';
import SettingsPageHeader from '../components/SettingsPageHeader';
import toast from 'react-hot-toast';
import { CreateUserFormData, createDefaultUserForm } from '../types/forms';
import { useCreateUserMutation, usePasswordPolicy } from '../hooks/queries';
import { Card, Flex, Grid, Text, Button, TextField } from '@radix-ui/themes';
import { apiErrorMessage } from '../utils/errors';
import FieldError, { fieldErrorProps } from '../components/forms/FieldError';
import PageContainer from '../components/PageContainer';

const AddUserPage: React.FC = () => {
  const navigate = useNavigate();
  const createUserMutation = useCreateUserMutation();
  const loading = createUserMutation.isPending;
  // The server's password rules, so the form refuses what the server would.
  const passwordPolicy = usePasswordPolicy();
  const schema = useMemo(() => createUserCreateSchema(passwordPolicy), [passwordPolicy]);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateUserFormData>({
    defaultValues: createDefaultUserForm(),
    resolver: zodResolver(schema) as never,
  });

  const onSubmit = async (data: CreateUserFormData) => {
    try {
      await createUserMutation.mutateAsync(data);
      // The password is the admin's choice, so the new user replaces it at first sign-in.
      toast.success('User created. They will be asked to choose their own password when they first sign in.');
      navigate('/settings/users');
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Failed to create user'));
    }
  };

  return (
    <PageContainer width="form">
      {/* Header */}
      <SettingsPageHeader
        title="Add New User"
        subtitle="Create a new user account"
        icon={<UserPlus size={20} className="text-[var(--accent-11)]" />}
        backPath="/settings/users"
      />

      {/* Form */}
      <Card>
        <form onSubmit={handleSubmit(onSubmit)}>
          <Flex direction="column" gap="6">
            <Grid columns={{ initial: '1', md: '2' }} gap="6">
              <Flex direction="column" gap="2">
                <Text size="2" weight="medium" as="label" htmlFor="add-user-first-name">
                  First Name *
                </Text>
                <TextField.Root
                  id="add-user-first-name"
                  {...fieldErrorProps('add-user-first-name', errors.first_name)}
                  {...register('first_name')}
                  size="3"
                  disabled={loading}
                />
                <FieldError fieldId="add-user-first-name" message={errors.first_name?.message as string | undefined} />
              </Flex>

              <Flex direction="column" gap="2">
                <Text size="2" weight="medium" as="label" htmlFor="add-user-last-name">
                  Last Name
                </Text>
                <TextField.Root
                  id="add-user-last-name"
                  {...fieldErrorProps('add-user-last-name', errors.last_name)}
                  {...register('last_name')}
                  size="3"
                  disabled={loading}
                />
                <FieldError fieldId="add-user-last-name" message={errors.last_name?.message as string | undefined} />
              </Flex>
            </Grid>

            <Flex direction="column" gap="2">
              <Text size="2" weight="medium" as="label" htmlFor="add-user-email">
                Email Address *
              </Text>
              <TextField.Root
                id="add-user-email"
                {...fieldErrorProps('add-user-email', errors.email)}
                type="email"
                {...register('email')}
                size="3"
                disabled={loading}
              />
              <FieldError fieldId="add-user-email" message={errors.email?.message as string | undefined} />
            </Flex>

            <Flex direction="column" gap="2">
              <Text size="2" weight="medium" as="label" htmlFor="add-user-password">
                Password *
              </Text>
              <TextField.Root
                id="add-user-password"
                type="password"
                {...register('password')}
                {...fieldErrorProps('add-user-password', errors.password, !errors.password && 'add-user-password-hint')}
                size="3"
                minLength={passwordPolicy.minLength}
                disabled={loading}
              />
              {errors.password ? (
                <FieldError fieldId="add-user-password" message={errors.password.message as string} />
              ) : (
                <Text id="add-user-password-hint" size="1" color="gray">
                  {describePasswordPolicy(passwordPolicy)} They choose their own when they first sign in.
                </Text>
              )}
            </Flex>

            {/* Form Actions */}
            <Flex gap="3" justify="end" pt="6" className="border-t border-[var(--gray-6)]">
              <Button
                type="button"
                onClick={() => navigate('/settings/users')}
                variant="soft"
                color="gray"
                size="3"
                disabled={loading}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="3"
                disabled={loading}
                loading={loading}
              >
                <Save size={16} />
                Create User
              </Button>
            </Flex>
          </Flex>
        </form>
      </Card>
    </PageContainer>
  );
};

export default AddUserPage;
