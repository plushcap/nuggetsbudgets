import React, { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Eye, EyeOff, Shield, UserPlus } from 'lucide-react';
import toast from 'react-hot-toast';
import NuggetsLogo from '../components/NuggetsLogo';
import NuggetSpinner from '../components/NuggetSpinner';
import { SetupStatusError } from '../components/SetupStatusError';
import FieldError, { fieldErrorProps } from '../components/forms/FieldError';
import { usePasswordPolicy, useSetupStatusQuery, useSetupAdminMutation } from '../hooks/queries';
import { describePasswordPolicy, loginSchema, passwordProblem, type PasswordPolicy } from '@nuggets/shared';
import { apiErrorMessage } from '../utils/errors';
import { createDefaultAdminSetupForm, type AdminSetupFormData } from '../types/forms';
import {
  Card,
  Flex,
  Text,
  Button,
  IconButton,
  TextField,
  Callout,
  Code,
  Heading,
} from '@radix-ui/themes';
import PageContainer from '../components/PageContainer';

/**
 * First-run setup's checks (react-hook-form), each beside its field: the setup
 * token, a first name, an email sign-in will take (`loginSchema`'s), and a password the
 * server's policy takes, with its message (`passwordProblem`, the server's own rules; it
 * checks again), confirmed.
 */
export const adminSetupFormSchema = (policy: PasswordPolicy) =>
  z
    .object({
      setupToken: z.string(),
      email: z.string(),
      password: z.string(),
      confirmPassword: z.string(),
      firstName: z.string(),
      lastName: z.string(),
    })
    .superRefine((form, ctx) => {
      const refuse = (field: keyof AdminSetupFormData, message: string) => ctx.addIssue({ code: 'custom', path: [field], message });
      if (!form.setupToken.trim()) refuse('setupToken', 'Setup token is required');
      if (!form.firstName.trim()) refuse('firstName', 'First name is required');
      if (!form.email) refuse('email', 'Email is required');
      else if (!loginSchema.shape.email.safeParse(form.email).success) refuse('email', 'Enter a valid email address');
      if (!form.password) refuse('password', 'Password is required');
      else {
        const problem = passwordProblem(form.password, policy, { email: form.email });
        if (problem) refuse('password', problem);
      }
      if (form.password && form.password !== form.confirmPassword) refuse('confirmPassword', 'Passwords do not match');
    });

const AdminSetupPage: React.FC = () => {
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const setupAdminMutation = useSetupAdminMutation();
  const isLoading = setupAdminMutation.isPending;
  const passwordPolicy = usePasswordPolicy();
  const schema = useMemo(() => adminSetupFormSchema(passwordPolicy), [passwordPolicy]);
  const { register, handleSubmit, formState: { errors } } = useForm<AdminSetupFormData>({
    defaultValues: createDefaultAdminSetupForm(),
    resolver: zodResolver(schema),
  });

  // Whether setup already ran. Null while loading (the status screen) and when the probe
  // failed (a retry screen): only the server's answer may show the first-run form.
  const setupStatusQuery = useSetupStatusQuery();
  const setupComplete = setupStatusQuery.data?.setupComplete ?? null;

  // If setup is already complete, redirect to login
  if (setupComplete === true) {
    return <Navigate to="/login" replace />;
  }

  if (setupComplete === null && setupStatusQuery.isError) {
    return (
      <SetupStatusError
        error={setupStatusQuery.error}
        onRetry={() => void setupStatusQuery.refetch()}
        retrying={setupStatusQuery.isFetching}
      />
    );
  }

  // Still loading setup status
  if (setupComplete === null) {
    return (
      <Flex align="center" justify="center" className="bg-[var(--color-background)]" minHeight="100vh">
        <PageContainer width="auth">
          <Flex direction="column" align="center" gap="3">
            <NuggetSpinner size={48} />
            <Text size="2" color="gray">
              Checking system status...
            </Text>
          </Flex>
        </PageContainer>
      </Flex>
    );
  }

  const onSubmit = async (form: AdminSetupFormData) => {
    try {
      // Session cookie is set by the server on success.
      await setupAdminMutation.mutateAsync({
        setup_token: form.setupToken.trim(),
        email: form.email,
        password: form.password,
        first_name: form.firstName,
        last_name: form.lastName,
      });

      toast.success('Admin user created successfully!');

      // Redirect to dashboard after a brief delay
      setTimeout(() => {
        window.location.href = '/';
      }, 1000);
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Setup failed'));
    }
  };

  return (
    // A soft accent wash behind the card, from the theme so it follows the accent picker
    // and the appearance; Radix has no gradient utility, so it's Tailwind's.
    <Flex
      align="center"
      justify="center"
      py="4"
      className="bg-linear-to-br from-[var(--accent-3)] via-[var(--color-background)] to-[var(--accent-3)]"
      minHeight="100vh"
    >
      <PageContainer width="auth">
        {/* Header */}
        <Flex direction="column" align="center" gap="3" mb="8">
          <NuggetsLogo size={64} />
          <Heading as="h1" size="8" align="center">
            Welcome to Nuggets
          </Heading>
          <Text size="3" color="gray" align="center">
            Set up your admin account to get started
          </Text>
        </Flex>

        {/* Setup Form */}
        <Card>
          <Flex align="center" gap="2" mb="6">
            <UserPlus size={20} className="text-[var(--accent-11)]" />
            <Text size="5" weight="bold" color="gray" highContrast>
              Create Admin Account
            </Text>
          </Flex>

          <form noValidate onSubmit={handleSubmit(onSubmit)}>
            <Flex direction="column" gap="5">
              {/* Setup Token: only the operator, who can read the server log, has it */}
              <Flex direction="column" gap="2">
                <Text as="label" size="2" weight="medium" htmlFor="setupToken">
                  Setup Token <Text as="span" color="red">*</Text>
                </Text>
                <TextField.Root
                  type="text"
                  id="setupToken"
                  placeholder="Paste the setup token from the server log"
                  size="3"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  {...register('setupToken')}
                  {...fieldErrorProps('setupToken', errors.setupToken, 'setupTokenHelp')}
                />
                <FieldError fieldId="setupToken" message={errors.setupToken?.message ?? null} />
                <Text id="setupTokenHelp" size="1" color="gray">
                  The backend prints a one-time setup token in its server log when it starts with no
                  users (the line beginning &ldquo;First-run setup&rdquo;). To print a new one, run{' '}
                  <Code>node dist/scripts/setup-token.js</Code> in the backend container.
                </Text>
              </Flex>

              {/* First Name */}
              <Flex direction="column" gap="2">
                <Text as="label" size="2" weight="medium" htmlFor="firstName">
                  First Name <Text as="span" color="red">*</Text>
                </Text>
                <TextField.Root
                  type="text"
                  id="firstName"
                  placeholder="Enter your first name"
                  size="3"
                  required
                  {...register('firstName')}
                  {...fieldErrorProps('firstName', errors.firstName)}
                />
                <FieldError fieldId="firstName" message={errors.firstName?.message ?? null} />
              </Flex>

              {/* Last Name */}
              <Flex direction="column" gap="2">
                <Text as="label" size="2" weight="medium" htmlFor="lastName">
                  Last Name
                </Text>
                <TextField.Root
                  type="text"
                  id="lastName"
                  placeholder="Enter your last name"
                  size="3"
                  {...register('lastName')}
                />
              </Flex>

              {/* Email */}
              <Flex direction="column" gap="2">
                <Text as="label" size="2" weight="medium" htmlFor="email">
                  Email Address <Text as="span" color="red">*</Text>
                </Text>
                <TextField.Root
                  type="email"
                  id="email"
                  placeholder="Enter your email address"
                  size="3"
                  required
                  {...register('email')}
                  {...fieldErrorProps('email', errors.email)}
                />
                <FieldError fieldId="email" message={errors.email?.message ?? null} />
              </Flex>

              {/* Password */}
              <Flex direction="column" gap="2">
                <Text as="label" size="2" weight="medium" htmlFor="password">
                  Password <Text as="span" color="red">*</Text>
                </Text>
                <TextField.Root
                  type={showPassword ? 'text' : 'password'}
                  id="password"
                  placeholder="Create a password"
                  size="3"
                  required
                  {...register('password')}
                  {...fieldErrorProps('password', errors.password, 'password-policy')}
                >
                  <TextField.Slot side="right">
                    <IconButton
                      type="button"
                      variant="ghost"
                      color="gray"
                      size="2"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </IconButton>
                  </TextField.Slot>
                </TextField.Root>
                <FieldError fieldId="password" message={errors.password?.message ?? null} />
                <Text id="password-policy" size="1" color="gray">
                  {describePasswordPolicy(passwordPolicy)}
                </Text>
              </Flex>

              {/* Confirm Password */}
              <Flex direction="column" gap="2">
                <Text as="label" size="2" weight="medium" htmlFor="confirmPassword">
                  Confirm Password <Text as="span" color="red">*</Text>
                </Text>
                <TextField.Root
                  type={showConfirmPassword ? 'text' : 'password'}
                  id="confirmPassword"
                  placeholder="Confirm your password"
                  size="3"
                  required
                  {...register('confirmPassword')}
                  {...fieldErrorProps('confirmPassword', errors.confirmPassword)}
                >
                  <TextField.Slot side="right">
                    <IconButton
                      type="button"
                      variant="ghost"
                      color="gray"
                      size="2"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                    >
                      {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </IconButton>
                  </TextField.Slot>
                </TextField.Root>
                <FieldError fieldId="confirmPassword" message={errors.confirmPassword?.message ?? null} />
              </Flex>

              {/* Submit Button */}
              <Button type="submit" disabled={isLoading} size="3" >
                {isLoading ? (
                  <Flex align="center" gap="2">
                    <NuggetSpinner size={18} />
                    Creating Admin Account…
                  </Flex>
                ) : (
                  'Create Admin Account'
                )}
              </Button>
            </Flex>
          </form>

          {/* Security Notice */}
          <Callout.Root mt="6">
            <Callout.Icon>
              <Shield size={16} />
            </Callout.Icon>
            <Flex direction="column" gap="1">
              <Text size="2" weight="medium">
                Security Notice
              </Text>
              <Callout.Text>
                This account will have full administrative access to manage users and system settings.
                After setup, additional users can only be created by administrators from the settings page.
              </Callout.Text>
            </Flex>
          </Callout.Root>
        </Card>
      </PageContainer>
    </Flex>
  );
};

export default AdminSetupPage;
