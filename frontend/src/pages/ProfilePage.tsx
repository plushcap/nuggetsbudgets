import React, { useState, useMemo } from 'react';
import { Navigate } from 'react-router-dom';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Save, Key, Eye, EyeOff, Upload, X, User as UserIcon, Shield, Smartphone, Plus, Trash2, Bell, Info } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import toast from 'react-hot-toast';
import {
  updateProfile,
  changePassword,
  registerPasskey,
  deletePasskey,
  isPasskeySupported,
} from '../services/api';
import { usePasswordPolicy, useUserPasskeysQuery } from '../hooks/queries';
import {
  changePasswordSchema,
  describePasswordPolicy,
  ownProfileUpdateSchema,
  passkeyRegistrationSchema,
  passwordProblem,
  type PasswordPolicy,
} from '@nuggets/shared';
import { Box, Card, Flex, Text, Button, TextField, IconButton, Separator, Heading, Grid, Dialog, Callout } from '@radix-ui/themes';
import PageLoader from '../components/PageLoader';
import { PushNotificationsCard } from '../components/PushNotificationsCard';
import { NotificationChoicesCard } from '../components/NotificationChoicesCard';
import RadixIconPicker from '../components/RadixIconPicker';
import RadixColorPicker from '../components/RadixColorPicker';
import FieldError, { fieldErrorDescribedBy, fieldErrorProps } from '../components/forms/FieldError';
import FilePickerButton from '../components/forms/FilePickerButton';
import { useConfirmation } from '../hooks/useConfirmation';
import { useFormReset } from '../hooks/useFormReset';
import ConfirmationDialog from '../components/ConfirmationDialog';
import ReauthDialog from '../components/ReauthDialog';
import { isReauthCancelledError, useReauth } from '../hooks/useReauth';
import { profileImageUrl } from '../utils/profileImage';
import { IMAGE_UPLOAD_TYPES, imageUploadProblem } from '../utils/imageUploads';
import { errorMessage } from '../utils/errors';
import {
  createDefaultOwnPasswordChangeForm,
  createProfileForm,
  type OwnPasswordChangeFormData,
  type PasskeyNameFormData,
  type ProfileFormData,
} from '../types/forms';
import PageContainer from '../components/PageContainer';

// The profile, password and passkey-name forms are react-hook-form forms,
// checked with the shared schemas of the routes they call.

/** A name: required here (the form always marked it so), bounded by PUT /api/auth/profile's schema. */
const nameField = (field: 'first_name' | 'last_name', missing: string) =>
  ownProfileUpdateSchema.shape[field].unwrap().refine((value) => value.trim() !== '', missing);

/** The profile's details, as `ownProfileUpdateSchema` (the route's) bounds them, and the picture. */
export const profileFormSchema = z.object({
  first_name: nameField('first_name', 'Enter your first name.'),
  last_name: nameField('last_name', 'Enter your last name.'),
  default_color: ownProfileUpdateSchema.shape.default_color.unwrap(),
  icon: ownProfileUpdateSchema.shape.icon.unwrap(),
  profile_image: z.instanceof(File).nullable(),
  remove_profile_image: z.boolean(),
});

/** The multipart body PUT /api/auth/profile takes (its fields `ownProfileUpdateSchema`, the picture `profile_image`). */
export function profileFormBody(form: ProfileFormData): FormData {
  const body = new FormData();
  body.append('first_name', form.first_name);
  body.append('last_name', form.last_name);
  body.append('default_color', form.default_color);
  body.append('icon', form.icon);
  if (form.remove_profile_image) body.append('remove_profile_image', 'true');
  if (form.profile_image) body.append('profile_image', form.profile_image);
  return body;
}

/**
 * A new password: the current one given, the new one by the server's policy and its message
 * (it checks again), confirmed; then as PUT /api/auth/change-password's schema reads them.
 */
export const ownPasswordSchema = (policy: PasswordPolicy, email: string) =>
  z
    .object({ currentPassword: z.string(), newPassword: z.string(), confirmPassword: z.string() })
    .superRefine((form, ctx) => {
      let refused = false;
      const refuse = (field: keyof OwnPasswordChangeFormData, message: string) => {
        refused = true;
        ctx.addIssue({ code: 'custom', path: [field], message });
      };
      if (!form.currentPassword) refuse('currentPassword', 'Enter your current password.');
      const problem = passwordProblem(form.newPassword, policy, { email });
      if (problem) refuse('newPassword', problem);
      else if (form.confirmPassword !== form.newPassword) refuse('confirmPassword', 'Passwords do not match');
      if (refused) return;
      const checked = changePasswordSchema.safeParse({ currentPassword: form.currentPassword, newPassword: form.newPassword });
      for (const issue of checked.success ? [] : checked.error.issues) {
        ctx.addIssue({ code: 'custom', path: [String(issue.path[0] ?? 'newPassword')], message: issue.message });
      }
    });

/** A passkey's name, as POST /api/passkeys/register/verify bounds it. */
const passkeyNameSchema = z.object({ deviceName: passkeyRegistrationSchema.shape.deviceName.unwrap().unwrap() });

/** A password box with its own show/hide button. */
const PasswordField: React.FC<{
  id: string;
  label: string;
  error: string | undefined;
  field: React.ComponentProps<typeof TextField.Root>;
  hint?: React.ReactNode;
}> = ({ id, label, error, field, hint }) => {
  const [visible, setVisible] = useState(false);
  return (
    <Flex direction="column" gap="2">
      <Text size="2" weight="medium" color="gray" highContrast as="label" htmlFor={id}>
        {label}
      </Text>
      <TextField.Root id={id} type={visible ? 'text' : 'password'} size="3" {...field} {...fieldErrorProps(id, error)}>
        <TextField.Slot side="right">
          <IconButton
            type="button"
            onClick={() => setVisible(!visible)}
            variant="ghost"
            color="gray"
            size="1"
            aria-label={visible ? 'Hide password' : 'Show password'}
          >
            {visible ? <EyeOff size={16} /> : <Eye size={16} />}
          </IconButton>
        </TextField.Slot>
      </TextField.Root>
      <FieldError fieldId={id} message={error ?? null} />
      {hint}
    </Flex>
  );
};

const ProfilePage: React.FC = () => {
  const { user, setUser, forgetSession } = useAuth();
  const passwordPolicy = usePasswordPolicy();

  // The profile form, starting from the signed-in user.
  const profileForm = useForm<ProfileFormData>({
    defaultValues: createProfileForm(user),
    resolver: zodResolver(profileFormSchema),
  });
  const { control: profileControl, register: profileField, handleSubmit: submitProfile, setValue: setProfileValue, reset: resetProfile } = profileForm;
  const profileErrors = profileForm.formState.errors;
  const saving = profileForm.formState.isSubmitting;
  const [defaultColor, removeProfileImage] = useWatch({ control: profileControl, name: ['default_color', 'remove_profile_image'] });
  // The picked picture, shown before it is saved.
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const currentImageUrl = profileImageUrl(user?.profile_image);
  // Why a picked file wasn't taken, shown beside the field.
  const [imageProblem, setImageProblem] = useState<string | null>(null);

  // Password change.
  const [showPasswordSection, setShowPasswordSection] = useState(false);
  const passwordSchema = useMemo(() => ownPasswordSchema(passwordPolicy, user?.email ?? ''), [passwordPolicy, user?.email]);
  const passwordForm = useForm<OwnPasswordChangeFormData>({
    defaultValues: createDefaultOwnPasswordChangeForm(),
    resolver: zodResolver(passwordSchema),
  });
  const passwordErrors = passwordForm.formState.errors;
  const changingPassword = passwordForm.formState.isSubmitting;
  // Open or closed, the section starts empty.
  useFormReset(passwordForm.reset, createDefaultOwnPasswordChangeForm(), [showPasswordSection]);

  // Passkeys state
  const passkeysQuery = useUserPasskeysQuery({ meta: { suppressErrorToast: true } });
  const passkeys = passkeysQuery.data ?? [];
  // Passkey sign-in asks for no email: only a discoverable passkey can answer it. One
  // added before may not be (some security keys), unless it has signed in that way since.
  const passkeysMaybeNotDiscoverable = passkeys.filter((passkey) => passkey.discoverable !== true).length;
  const loadingPasskeys = passkeysQuery.isLoading;
  const loadPasskeys = () => { void passkeysQuery.refetch(); };
  const [showAddPasskeyDialog, setShowAddPasskeyDialog] = useState(false);
  // The name is sent as typed: the server trims it.
  const passkeyForm = useForm<PasskeyNameFormData>({
    defaultValues: { deviceName: '' },
    resolver: zodResolver(passkeyNameSchema, undefined, { raw: true }),
  });
  const passkeyErrors = passkeyForm.formState.errors;
  const registeringPasskey = passkeyForm.formState.isSubmitting;
  // The dialog starts empty each time it opens.
  useFormReset(passkeyForm.reset, { deviceName: '' }, [showAddPasskeyDialog]);

  const { confirmAsync, dialogProps } = useConfirmation();
  const { withReauth, dialogProps: reauthDialogProps } = useReauth();
  const passkeySupported = isPasskeySupported();

  const handleUpdateProfile = async (form: ProfileFormData) => {
    if (!user) return;
    try {
      const updatedUser = await updateProfile(profileFormBody(form));

      // Update auth context with new user data (what the profile doesn't change, such as
      // must_change_password, stays as it was).
      setUser({ ...user, ...updatedUser });

      toast.success('Profile updated successfully');

      // Start over from what was saved, with no picture change pending.
      setImagePreview(null);
      setImageProblem(null);
      resetProfile(createProfileForm(updatedUser));
    } catch {
      toast.error('Error updating profile');
    }
  };

  const handleChangePassword = async (form: OwnPasswordChangeFormData) => {
    if (!user) return;
    try {
      await changePassword({ currentPassword: form.currentPassword, newPassword: form.newPassword });

      // Changing the password ended every session, this one too: sign in with the new one.
      toast.success('Password changed. Sign in with your new password.');
      setShowPasswordSection(false);
      forgetSession();
    } catch (error) {
      toast.error(errorMessage(error, 'Error changing password'));
    }
  };

  const handleAddPasskey = async ({ deviceName }: PasskeyNameFormData) => {
    try {
      // Adding a passkey needs a fresh password/passkey confirmation; this prompts and retries.
      await withReauth(() => registerPasskey(deviceName || undefined));
      toast.success('Passkey added successfully!');
      setShowAddPasskeyDialog(false);
      await loadPasskeys();
    } catch (error) {
      if (isReauthCancelledError(error)) return;
      toast.error(errorMessage(error, 'Failed to register passkey'));
    }
  };

  const handleDeletePasskey = async (credentialId: string, deviceName?: string) => {
    const confirmed = await confirmAsync({
      title: 'Delete Passkey',
      message: `Are you sure you want to delete ${deviceName || 'this passkey'}? This action cannot be undone.`,
      variant: 'danger',
      confirmText: 'Delete Passkey',
    });

    if (!confirmed) return;

    try {
      await deletePasskey(credentialId);
      toast.success('Passkey deleted successfully');
      await loadPasskeys();
    } catch {
      toast.error('Failed to delete passkey');
    }
  };

  // A picture that isn't one of these, or is too big, isn't taken: the field says why, and
  // the picture stays as it was.
  const handleImagePicked = (file: File) => {
    const problem = imageUploadProblem(file);
    setImageProblem(problem);
    if (problem) return;
    setProfileValue('profile_image', file);
    setProfileValue('remove_profile_image', false);

    const reader = new FileReader();
    reader.onloadend = () => {
      setImagePreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  /** Drops a picked picture (`remove`: and marks the saved one for removal). */
  const clearImage = (remove: boolean) => {
    setImagePreview(null);
    setImageProblem(null);
    setProfileValue('profile_image', null);
    setProfileValue('remove_profile_image', remove);
  };

  if (!user) {
    return <Navigate to="/login" />;
  }

  // The picture shown: one picked, else the saved one unless it is to be removed.
  const shownImage = imagePreview || (removeProfileImage ? null : currentImageUrl);

  return (
    <PageContainer width="form">
      <Flex direction="column" gap="6">
        {/* Page Header */}
        <Flex direction="column" gap="2" mb="6">
          <Heading size="8" color="gray" highContrast>My Profile</Heading>
          <Text size="3" color="gray">
            Manage your personal information and account settings
          </Text>
        </Flex>

        {/* Profile Information Card */}
        <Card>
          {/* handleSubmit is called on submit: the handler clears the picked picture. */}
          <form noValidate onSubmit={(event) => void submitProfile(handleUpdateProfile)(event)}>
            <Flex direction="column" gap="6" p="4">
              <Flex direction="column" gap="1">
                <Text size="5" weight="bold" color="gray" highContrast>Profile Information</Text>
                <Text size="2" color="gray">Update your personal details</Text>
              </Flex>

              <Separator size="4" />

              {/* Profile Image */}
              <Flex direction="column" gap="4">
                <Text size="2" weight="medium" color="gray" highContrast>Profile Picture</Text>
                <Flex align="start" gap="4">
                  {/* Image Preview */}
                  <Box position="relative">
                    <Flex
                      align="center"
                      justify="center"
                      width="96px"
                      height="96px"
                      overflow="hidden"
                      className="rounded-full bg-[var(--gray-3)] border-2 border-[var(--gray-6)]"
                    >
                      {shownImage ? (
                        <Box asChild width="100%" height="100%"><img
                          src={shownImage}
                          alt="Profile"
                          className="object-cover"
                        /></Box>
                      ) : (
                        <UserIcon size={48} className="text-[var(--gray-11)]" />
                      )}
                    </Flex>
                    {(imagePreview || (currentImageUrl && !removeProfileImage)) && (
                      <IconButton
                        type="button"
                        onClick={() => clearImage(!imagePreview)}
                        variant="solid"
                        color="red"
                        size="1"
                        radius="full"
                        style={{
                          position: 'absolute',
                          top: '-4px',
                          right: '-4px',
                        }}
                        aria-label="Remove image"
                      >
                        <X size={12} />
                      </IconButton>
                    )}
                  </Box>

                  <Flex direction="column" gap="2">
                    <FilePickerButton
                      accept={IMAGE_UPLOAD_TYPES.join(',')}
                      onFiles={([file]) => file && handleImagePicked(file)}
                      aria-describedby={fieldErrorDescribedBy('profile-picture', imageProblem, 'profile-picture-hint')}
                      color="blue"
                      size="3"
                      disabled={saving}
                    >
                      <Upload size={16} />
                      {currentImageUrl || imagePreview ? 'Change Image' : 'Upload Image'}
                    </FilePickerButton>
                    <Text id="profile-picture-hint" size="1" color="gray">
                      JPEG, PNG, GIF, or WebP. Max 5MB.
                    </Text>
                    {/* Said as it appears: the chooser leaves the focus on the button. */}
                    <Box aria-live="polite">
                      <FieldError fieldId="profile-picture" message={imageProblem} />
                    </Box>
                  </Flex>
                </Flex>
              </Flex>

              {/* Name Fields */}
              <Grid columns={{ initial: '1', md: '2' }} gap="4">
                <Flex direction="column" gap="2">
                  <Text size="2" weight="medium" color="gray" highContrast as="label" htmlFor="profile-first-name">
                    First Name *
                  </Text>
                  <TextField.Root
                    id="profile-first-name"
                    size="3"
                    required
                    {...profileField('first_name')}
                    {...fieldErrorProps('profile-first-name', profileErrors.first_name)}
                  />
                  <FieldError fieldId="profile-first-name" message={profileErrors.first_name?.message ?? null} />
                </Flex>

                <Flex direction="column" gap="2">
                  <Text size="2" weight="medium" color="gray" highContrast as="label" htmlFor="profile-last-name">
                    Last Name *
                  </Text>
                  <TextField.Root
                    id="profile-last-name"
                    size="3"
                    required
                    {...profileField('last_name')}
                    {...fieldErrorProps('profile-last-name', profileErrors.last_name)}
                  />
                  <FieldError fieldId="profile-last-name" message={profileErrors.last_name?.message ?? null} />
                </Flex>
              </Grid>

              {/* Email (Read-only) */}
              <Flex direction="column" gap="2">
                <Text size="2" weight="medium" color="gray" highContrast as="label" htmlFor="profile-email">
                  Email Address
                </Text>
                <TextField.Root
                  id="profile-email"
                  value={user?.email || ''}
                  size="3"
                  disabled
                  readOnly
                />
                <Text size="1" color="gray">
                  Email cannot be changed
                </Text>
              </Flex>

              {/* Icon and Color */}
              <Grid columns={{ initial: '1', md: '2' }} gap="6">
                <Box>
                  <Controller
                    control={profileControl}
                    name="icon"
                    render={({ field }) => (
                      <RadixIconPicker
                        value={field.value}
                        onChange={field.onChange}
                        color={defaultColor}
                        disabled={saving}
                        label="Profile Icon"
                        placeholder="Select an icon"
                        aria-describedby={fieldErrorDescribedBy('profile-icon', profileErrors.icon)}
                      />
                    )}
                  />
                  <FieldError fieldId="profile-icon" message={profileErrors.icon?.message ?? null} />
                </Box>

                <Box>
                  <Controller
                    control={profileControl}
                    name="default_color"
                    render={({ field }) => (
                      <RadixColorPicker
                        value={field.value}
                        onChange={field.onChange}
                        disabled={saving}
                        label="Profile Color"
                        placeholder="#3B82F6"
                        aria-describedby={fieldErrorDescribedBy('profile-color', profileErrors.default_color)}
                      />
                    )}
                  />
                  <FieldError fieldId="profile-color" message={profileErrors.default_color?.message ?? null} />
                </Box>
              </Grid>

              {/* Form Actions */}
              <Flex gap="3" justify="end" pt="4" className="border-t border-[var(--gray-6)]">
                <Button
                  type="submit"
                  color="blue"
                  size="3"
                  loading={saving}
                >
                  <Save size={16} />
                  Save Changes
                </Button>
              </Flex>
            </Flex>
          </form>
        </Card>

        {/* Security Section Header */}
        <Flex align="center" gap="2" mt="8" mb="4">
          <Shield size={24} className="text-[var(--accent-11)]" />
          <Heading size="6" color="gray" highContrast>Security</Heading>
        </Flex>

        {/* Password Change Card */}
        <Card>
          <Flex direction="column" gap="6" p="4">
            <Flex align="center" justify="between">
              <Flex direction="column" gap="1">
                <Text size="4" weight="bold" color="gray" highContrast>Password</Text>
                <Text size="2" color="gray">Change your account password</Text>
              </Flex>
              {!showPasswordSection && (
                <Button
                  onClick={() => setShowPasswordSection(true)}
                  variant="soft"
                  color="gray"
                  size="3"
                >
                  <Key size={16} />
                  Change Password
                </Button>
              )}
            </Flex>

            {showPasswordSection && (
              <>
                <Separator size="4" />
                <form noValidate onSubmit={passwordForm.handleSubmit(handleChangePassword)}>
                  <Flex direction="column" gap="4">
                    <PasswordField
                      id="profile-current-password"
                      label="Current Password *"
                      error={passwordErrors.currentPassword?.message}
                      field={{ ...passwordForm.register('currentPassword'), required: true, autoComplete: 'current-password' }}
                    />
                    <PasswordField
                      id="profile-new-password"
                      label="New Password *"
                      error={passwordErrors.newPassword?.message}
                      field={{ ...passwordForm.register('newPassword'), required: true, minLength: passwordPolicy.minLength, autoComplete: 'new-password' }}
                    />
                    <PasswordField
                      id="profile-confirm-password"
                      label="Confirm New Password *"
                      error={passwordErrors.confirmPassword?.message}
                      field={{ ...passwordForm.register('confirmPassword'), required: true, minLength: passwordPolicy.minLength, autoComplete: 'new-password' }}
                      hint={<Text size="1" color="gray">{describePasswordPolicy(passwordPolicy)}</Text>}
                    />

                    {/* Password Form Actions */}
                    <Flex gap="3" justify="end" pt="4" className="border-t border-[var(--gray-6)]">
                      <Button
                        type="button"
                        onClick={() => setShowPasswordSection(false)}
                        variant="soft"
                        color="gray"
                        size="3"
                        disabled={changingPassword}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        color="blue"
                        size="3"
                        loading={changingPassword}
                      >
                        <Key size={16} />
                        Change Password
                      </Button>
                    </Flex>
                  </Flex>
                </form>
              </>
            )}
          </Flex>
        </Card>

        {/* Passkeys Card */}
        <Card>
          <Flex direction="column" gap="6" p="4">
            <Flex align="center" justify="between">
              <Flex direction="column" gap="1">
                <Text size="4" weight="bold" color="gray" highContrast>Passkeys</Text>
                <Text size="2" color="gray">
                  {passkeys.length === 0 
                    ? 'No passkeys configured. Add a passkey for passwordless login.' 
                    : `${passkeys.length} passkey${passkeys.length === 1 ? '' : 's'} configured`}
                </Text>
              </Flex>
              {passkeySupported && (
                <Button
                  onClick={() => setShowAddPasskeyDialog(true)}
                  variant="soft"
                  color="blue"
                  size="3"
                >
                  <Plus size={16} />
                  Add Passkey
                </Button>
              )}
            </Flex>

            <Separator size="4" />

            {passkeysMaybeNotDiscoverable > 0 && (
              <Callout.Root color="amber" highContrast>
                <Callout.Icon>
                  <Info size={16} />
                </Callout.Icon>
                <Callout.Text>
                  Signing in with a passkey no longer asks for your email.{' '}
                  {passkeysMaybeNotDiscoverable === 1
                    ? "One of your passkeys isn't known to work that way"
                    : `${passkeysMaybeNotDiscoverable} of your passkeys aren't known to work that way`}
                  : some older security keys only sign in after an email. If a passkey doesn't sign
                  you in, add a new one on that device or key, then delete the old one. Your password
                  still works.
                </Callout.Text>
              </Callout.Root>
            )}

            {!passkeySupported && (
              <Flex 
                direction="column" 
                align="center" 
                justify="center" 
                py="6"
                className="bg-[var(--orange-3)] border border-[var(--orange-6)] rounded-[var(--radius-4)]"
              >
                <Shield size={48} className="mb-3 text-[var(--orange-12)]" />
                <Text size="2" weight="medium" color="orange" highContrast>
                  Passkeys are not supported in your browser
                </Text>
                <Text size="1" color="orange" highContrast>
                  Please use a modern browser to use passkeys
                </Text>
              </Flex>
            )}

            {loadingPasskeys ? (
              <Flex justify="center" py="6">
                <PageLoader minHeight="auto" size={32} />
              </Flex>
            ) : passkeys.length > 0 ? (
              <Flex direction="column" gap="3">
                {passkeys.map((passkey) => (
                  <Card key={passkey.id} variant="surface">
                    <Flex align="center" justify="between" p="3">
                      <Flex align="center" gap="3">
                        <Flex
                          align="center" justify="center" width="40px" height="40px" className="rounded-full bg-[var(--blue-3)]"
                        >
                          <Smartphone size={20} className="text-[var(--accent-11)]" />
                        </Flex>
                        <Flex direction="column" gap="1">
                          <Text size="3" weight="medium" color="gray" highContrast>
                            {passkey.deviceName || 'Unnamed Device'}
                          </Text>
                          <Flex direction="column" gap="1">
                            <Text size="1" color="gray">
                              {passkey.deviceType === 'multiDevice' ? 'Multi-device (synced)' : 'Single device'}
                              {passkey.backedUp && ' • Backed up'}
                            </Text>
                            {passkey.lastUsed && (
                              <Text size="1" color="gray">
                                Last used: {new Date(passkey.lastUsed).toLocaleDateString()}
                              </Text>
                            )}
                            <Text size="1" color="gray">
                              Created: {new Date(passkey.createdAt).toLocaleDateString()}
                            </Text>
                            {passkey.discoverable === false ? (
                              <Text size="1" color="amber" highContrast>
                                Can't sign in without your email: add a new passkey to replace it
                              </Text>
                            ) : passkey.discoverable !== true ? (
                              <Text size="1" color="amber" highContrast>
                                Not yet known to sign in without your email
                              </Text>
                            ) : null}
                          </Flex>
                        </Flex>
                      </Flex>
                      <IconButton
                        variant="soft"
                        color="red"
                        onClick={() => handleDeletePasskey(passkey.id, passkey.deviceName)}
                        aria-label="Delete passkey"
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </Flex>
                  </Card>
                ))}
              </Flex>
            ) : passkeySupported ? (
              <Flex 
                direction="column" 
                align="center" 
                justify="center" 
                py="8"
                className="bg-[var(--gray-2)] border border-dashed border-[var(--gray-6)] rounded-[var(--radius-4)]"
              >
                <Shield size={48} className="mb-3 text-[var(--gray-8)]" />
                <Text size="2" weight="medium" color="gray">
                  No passkeys configured
                </Text>
                <Text size="1" color="gray">
                  Add a passkey for secure, passwordless authentication
                </Text>
              </Flex>
            ) : null}
          </Flex>
        </Card>

        {/* Notifications Section Header */}
        <Flex align="center" gap="2" mt="8" mb="4">
          <Bell size={24} className="text-[var(--accent-11)]" />
          <Heading size="6" color="gray" highContrast>Notifications</Heading>
        </Flex>

        <NotificationChoicesCard />

        <PushNotificationsCard />


        {/* Add Passkey Dialog */}
        <Dialog.Root
          open={showAddPasskeyDialog}
          onOpenChange={(open) => !registeringPasskey && setShowAddPasskeyDialog(open)}
        >
          <Dialog.Content maxWidth="500px">
            <Dialog.Title>Add New Passkey</Dialog.Title>
            <Dialog.Description size="2" color="gray" mb="4">
              Give your passkey a memorable name
            </Dialog.Description>

            <Separator size="4" mb="4" />

            <form noValidate onSubmit={passkeyForm.handleSubmit(handleAddPasskey)}>
              <Flex direction="column" gap="2">
                <Text size="2" weight="medium" color="gray" highContrast as="label" htmlFor="passkey-device-name">
                  Device Name
                </Text>
                <TextField.Root
                  id="passkey-device-name"
                  placeholder="e.g., My phone, Work laptop"
                  size="3"
                  {...passkeyForm.register('deviceName')}
                  {...fieldErrorProps('passkey-device-name', passkeyErrors.deviceName, 'passkey-device-name-hint')}
                />
                <FieldError fieldId="passkey-device-name" message={passkeyErrors.deviceName?.message ?? null} />
                <Text id="passkey-device-name-hint" size="1" color="gray">
                  Optional: helps you identify this passkey later
                </Text>
              </Flex>

              <Flex gap="3" justify="end" pt="4">
                <Button
                  type="button"
                  onClick={() => setShowAddPasskeyDialog(false)}
                  variant="soft"
                  color="gray"
                  size="3"
                  disabled={registeringPasskey}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  color="blue"
                  size="3"
                  loading={registeringPasskey}
                >
                  <Plus size={16} />
                  Add Passkey
                </Button>
              </Flex>
            </form>
          </Dialog.Content>
        </Dialog.Root>
      </Flex>

      <ConfirmationDialog {...dialogProps} />
      <ReauthDialog {...reauthDialogProps} />
    </PageContainer>
  );
};

export default ProfilePage;
