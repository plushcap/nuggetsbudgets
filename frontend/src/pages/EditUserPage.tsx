import React, { useState, useEffect } from 'react';
import { useForm, useWatch, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { describePasswordPolicy, ownProfileUpdateSchema, passwordProblem, userUpdateSchema } from '@nuggets/shared';
import { useNavigate, useParams } from 'react-router-dom';
import { Save, Key, Eye, EyeOff, Upload, X, User as UserIcon, Smartphone, Shield, Trash2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import SettingsPageHeader from '../components/SettingsPageHeader';
import PageLoader from '../components/PageLoader';
import toast from 'react-hot-toast';
import { changeUserPassword, updateUserWithImage, deleteAdminUserPasskey, setUserDeploymentAdmin, type AdminUser } from '../services/api';
import { useAdminUsersQuery, useAdminUserPasskeysQuery, usePasswordPolicy } from '../hooks/queries';
import { errorMessage } from '../utils/errors';
import { EditUserFormData, PasswordChangeFormData, createDefaultPasswordChangeForm } from '../types/forms';
import { Card, Flex, Grid, Box, Text, Button, TextField, Checkbox, IconButton } from '@radix-ui/themes';
import RadixIconPicker from '../components/RadixIconPicker';
import RadixColorPicker from '../components/RadixColorPicker';
import { useConfirmation } from '../hooks/useConfirmation';
import ConfirmationDialog from '../components/ConfirmationDialog';
import { profileImageUrl } from '../utils/profileImage';
import { IMAGE_UPLOAD_TYPES, imageUploadProblem } from '../utils/imageUploads';
import { EMPTY_LIST } from '../utils/emptyList';
import FieldError, { fieldErrorDescribedBy, fieldErrorProps } from '../components/forms/FieldError';
import FilePickerButton from '../components/forms/FilePickerButton';
import PageContainer from '../components/PageContainer';

/**
 * The admin's form: the route's checks (a first name), and the icon and colour bounded as My
 * Profile bounds them (`ownProfileUpdateSchema`), so a problem shows beside its picker.
 */
const editUserSchema = userUpdateSchema.extend({
  icon: ownProfileUpdateSchema.shape.icon.unwrap(),
  default_color: ownProfileUpdateSchema.shape.default_color.unwrap(),
});

const EditUserPage: React.FC = () => {
  const navigate = useNavigate();
  const { uuid } = useParams<{ uuid: string }>();
  const { data: adminUsers = EMPTY_LIST, isLoading: usersLoading } = useAdminUsersQuery();
  const userToEdit = usersLoading ? undefined : adminUsers.find((u) => u.uuid === uuid);

  // A user who isn't there: say so, and go back to the list.
  useEffect(() => {
    if (!usersLoading && uuid && !userToEdit) {
      toast.error('User not found');
      navigate('/settings/users');
    }
  }, [usersLoading, uuid, userToEdit, navigate]);

  if (usersLoading) {
    return (
      <PageContainer width="form">
        <PageLoader label="Loading user…" />
      </PageContainer>
    );
  }

  if (!userToEdit) {
    return (
      <PageContainer width="form">
        <Card>
          <Flex justify="center" align="center" py="9">
            <Text color="gray">User not found</Text>
          </Flex>
        </Card>
      </PageContainer>
    );
  }

  // The form mounts with the user, seeded through its defaults (keyed: another user
  // starts a fresh form).
  return <EditUserForm key={userToEdit.uuid} user={userToEdit} />;
};

const EditUserForm: React.FC<{ user: AdminUser }> = ({ user }) => {
  const navigate = useNavigate();
  const uuid = user.uuid;
  const { user: currentUser } = useAuth();
  const passwordPolicy = usePasswordPolicy();
  const [saving, setSaving] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [showPasswordSection, setShowPasswordSection] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [currentImageUrl, setCurrentImageUrl] = useState<string | null>(
    user.profile_image ? profileImageUrl(user.profile_image) : null,
  );
  const [removeProfileImage, setRemoveProfileImage] = useState(false);

  // Why a picked picture wasn't taken, shown beside the button, as on My Profile.
  const [imageProblem, setImageProblem] = useState<string | null>(null);
  const [passwordData, setPasswordData] = useState<PasswordChangeFormData>(createDefaultPasswordChangeForm());

  const {
    register,
    handleSubmit,
    control,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<EditUserFormData>({
    defaultValues: {
      ...user,
      first_name: user.first_name ?? '',
      last_name: user.last_name ?? '',
      default_color: user.default_color || '#3B82F6',
      icon: user.icon || 'User',
      profile_image_file: null,
    },
    resolver: zodResolver(editUserSchema) as never,
  });
  const [firstName, lastName, email, defaultColor, userId] = useWatch({
    control,
    name: ['first_name', 'last_name', 'email', 'default_color', 'id'],
  });
  
  // Passkeys state
  const passkeysQuery = useAdminUserPasskeysQuery(uuid, { meta: { suppressErrorToast: true } });
  const passkeys = passkeysQuery.data ?? [];
  const loadingPasskeys = passkeysQuery.isLoading;
  const fetchUserPasskeys = () => { void passkeysQuery.refetch(); };

  const { confirmAsync, dialogProps } = useConfirmation();

  const handleDeletePasskey = async (credentialId: string, deviceName?: string) => {
    if (!uuid) return;
    
    const confirmed = await confirmAsync({
      title: 'Delete Passkey',
      message: `Are you sure you want to delete ${deviceName || 'this passkey'}? This action cannot be undone.`,
      variant: 'danger',
      confirmText: 'Delete Passkey',
    });

    if (!confirmed) return;

    try {
      await deleteAdminUserPasskey(uuid, credentialId);
      toast.success('Passkey deleted successfully');
      await fetchUserPasskeys();
    } catch {
      toast.error('Failed to delete passkey');
    }
  };

  const onSubmit = async () => {
    const editUser = getValues();
    if (!editUser.uuid) return;

    setSaving(true);

    try {
      // Always use FormData to handle all cases (upload, delete, or regular update)
      const formData = new FormData();
      formData.append('first_name', editUser.first_name ?? '');
      formData.append('last_name', editUser.last_name ?? '');
      formData.append('default_color', editUser.default_color || '#3B82F6');
      formData.append('icon', editUser.icon || 'User');

      // Handle profile image deletion
      if (removeProfileImage) {
        formData.append('remove_profile_image', 'true');
      }

      // Handle profile image upload
      if (editUser.profile_image_file) {
        formData.append('profile_image', editUser.profile_image_file);
      }

      await updateUserWithImage(editUser.uuid, formData);

      // Deployment-admin is a global role set via its own endpoint (not the
      // profile update). Skipped when editing yourself (the toggle is hidden).
      if (editUser.id !== currentUser?.id) {
        await setUserDeploymentAdmin(editUser.uuid, !!editUser.is_deployment_admin);
      }

      toast.success('User updated successfully');
      navigate('/settings/users');
    } catch {
      toast.error('Error updating user');
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    const userUuid = getValues('uuid');
    if (!userUuid) return;

    if (passwordData.newPassword !== passwordData.confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }

    // The server's own rules and messages (it checks again).
    const problem = passwordProblem(passwordData.newPassword, passwordPolicy, { email: getValues('email') });
    if (problem) {
      toast.error(problem);
      return;
    }

    setChangingPassword(true);

    try {
      await changeUserPassword(userUuid, {
        newPassword: passwordData.newPassword
      });
      // A password set for someone else is replaced by them when they next sign in.
      toast.success(
        user.id === currentUser?.id
          ? 'Password changed successfully'
          : 'Password changed. They will be asked to choose their own when they next sign in.'
      );
      setPasswordData({ newPassword: '', confirmPassword: '' });
      setShowPasswordSection(false);
      setShowPassword(false);
      setShowConfirmPassword(false);
    } catch (error) {
      toast.error(errorMessage(error, 'Error changing password'));
    } finally {
      setChangingPassword(false);
    }
  };

  // A picture the server wouldn't take isn't taken: the field says why (it was a toast), and
  // the picture stays as it was.
  const handleImagePicked = (file: File) => {
    const problem = imageUploadProblem(file);
    setImageProblem(problem);
    if (problem) return;
    setValue('profile_image_file', file);
    setRemoveProfileImage(false); // Reset deletion flag when uploading new image

    // Create preview
    const reader = new FileReader();
    reader.onload = () => {
      setImagePreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const removeImage = () => {
    setValue('profile_image_file', null);
    setImagePreview(null);
    setCurrentImageUrl(null);
    setRemoveProfileImage(true);
    setImageProblem(null);
  };

  const handlePasswordChange = (field: keyof PasswordChangeFormData, value: string) => {
    setPasswordData({ ...passwordData, [field]: value });
  };

  return (
    <PageContainer width="form">
      {/* Header */}
      <SettingsPageHeader
        title="Edit User"
        subtitle={`Update user information for ${firstName} ${lastName}`}
        icon={<UserIcon size={20} className="text-[var(--accent-11)]" />}
        backPath="/settings/users"
      />

      <Flex direction="column" gap="6">
        {/* User Information Form */}
        <Card>
          <Flex direction="column" gap="6">
            <Text size="4" weight="bold">User Information</Text>

            <form onSubmit={handleSubmit(onSubmit)}>
              <Flex direction="column" gap="6">
                <Grid columns={{ initial: '1', md: '2' }} gap="6">
                  <Flex direction="column" gap="2">
                    <Text size="2" weight="medium" as="label" htmlFor="edit-user-first-name">
                      First Name *
                    </Text>
                    <TextField.Root
                      id="edit-user-first-name"
                      {...fieldErrorProps('edit-user-first-name', errors.first_name)}
                      {...register('first_name')}
                      size="3"
                      disabled={saving}
                    />
                    <FieldError fieldId="edit-user-first-name" message={errors.first_name?.message as string | undefined} />
                  </Flex>

                  <Flex direction="column" gap="2">
                    <Text size="2" weight="medium" as="label" htmlFor="edit-user-last-name">
                      Last Name
                    </Text>
                    <TextField.Root
                      id="edit-user-last-name"
                      {...register('last_name')}
                      size="3"
                      disabled={saving}
                    />
                  </Flex>
                </Grid>

                <Flex direction="column" gap="2">
                  <Text size="2" weight="medium" as="label" htmlFor="edit-user-email">
                    Email Address
                  </Text>
                  <TextField.Root
                    id="edit-user-email"
                    type="email"
                    value={email || ''}
                    readOnly
                    size="3"
                    disabled
                    className="bg-[var(--gray-3)]"
                  />
                  <Text size="1" color="gray">
                    Email addresses cannot be changed
                  </Text>
                </Flex>

                {/* Profile Image Upload */}
                <Flex direction="column" gap="2">
                  <Text size="2" weight="medium" as="p">
                    Profile Image
                  </Text>
                  <Flex direction="column" gap="4">
                    {/* Current/Preview Image */}
                    {(imagePreview || currentImageUrl) && (
                      <Box position="relative" display="inline-block">
                        <Box asChild width="96px" height="96px"><img
                          src={imagePreview || currentImageUrl || ''}
                          alt="Profile preview"
                          className="rounded-full object-cover border-2 border-[var(--gray-6)]"
                        /></Box>
                        <IconButton
                          type="button"
                          onClick={removeImage}
                          color="red"
                          variant="solid"
                          size="1"
                          className="absolute -top-2 -right-2"
                          aria-label="Remove image"
                        >
                          <X size={12} />
                        </IconButton>
                      </Box>
                    )}
                    
                    {/* Upload Button */}
                    <Flex direction="column" gap="2">
                      <FilePickerButton
                        accept={IMAGE_UPLOAD_TYPES.join(',')}
                        onFiles={([file]) => file && handleImagePicked(file)}
                        aria-describedby={fieldErrorDescribedBy('edit-user-picture', imageProblem, 'edit-user-picture-hint')}
                        size="3"
                        disabled={saving}
                      >
                        <Upload size={16} />
                        {currentImageUrl || imagePreview ? 'Change Image' : 'Upload Image'}
                      </FilePickerButton>
                      <Text id="edit-user-picture-hint" size="1" color="gray">
                        Upload a profile image (JPEG, PNG, GIF, WebP). Maximum size: 5MB.
                      </Text>
                      {/* Said as it appears: the chooser leaves the focus on the button. */}
                      <Box aria-live="polite">
                        <FieldError fieldId="edit-user-picture" message={imageProblem} />
                      </Box>
                    </Flex>
                  </Flex>
                </Flex>

                {/* User Icon and Color Selection */}
                <Grid columns={{ initial: '1', md: '2' }} gap="6">
                  <Box>
                    <Controller
                      control={control}
                      name="icon"
                      render={({ field }) => (
                        <RadixIconPicker
                          value={field.value || 'User'}
                          onChange={(iconName) => field.onChange(iconName)}
                          color={defaultColor || '#3B82F6'}
                          disabled={saving}
                          aria-describedby={fieldErrorDescribedBy('edit-user-icon', errors.icon)}
                          label="User Icon"
                          placeholder="Select an icon"
                        />
                      )}
                    />
                    <FieldError fieldId="edit-user-icon" message={errors.icon?.message as string | undefined} />
                  </Box>

                  <Box>
                    <Controller
                      control={control}
                      name="default_color"
                      render={({ field }) => (
                        <RadixColorPicker
                          value={field.value || '#3B82F6'}
                          onChange={(color) => field.onChange(color)}
                          disabled={saving}
                          aria-describedby={fieldErrorDescribedBy('edit-user-color', errors.default_color)}
                          label="Default Color"
                          placeholder="#3B82F6"
                        />
                      )}
                    />
                    <FieldError fieldId="edit-user-color" message={errors.default_color?.message as string | undefined} />
                  </Box>
                </Grid>

                {userId !== currentUser?.id && (
                  <Controller
                    control={control}
                    name="is_deployment_admin"
                    render={({ field }) => (
                      <Flex width="fit-content" asChild gap="3">
                        <label>
                          <Checkbox
                            checked={!!field.value}
                            onCheckedChange={(checked) => field.onChange(checked === true)}
                            disabled={saving}
                            aria-labelledby="deployment-admin-label"
                            aria-describedby="deployment-admin-hint"
                          />
                          <Flex direction="column" gap="1">
                            <Text id="deployment-admin-label" size="2" weight="medium">Deployment administrator</Text>
                            <Text id="deployment-admin-hint" size="1" color="amber" highContrast>
                              ⚠ Full control of the entire deployment — every ledger, organization, and user. Grant sparingly.
                            </Text>
                          </Flex>
                        </label>
                      </Flex>
                    )}
                  />
                )}
                
                {/* Form Actions */}
                <Flex gap="3" justify="end" pt="6" className="border-t border-[var(--gray-6)]">
                  <Button
                    type="button"
                    onClick={() => navigate('/settings/users')}
                    variant="soft"
                    color="gray"
                    size="3"
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    size="3"
                    disabled={saving}
                    loading={saving}
                  >
                    <Save size={16} />
                    Update User
                  </Button>
                </Flex>
              </Flex>
            </form>
          </Flex>
        </Card>

        {/* Password Change Section */}
        <Card>
          <Flex direction="column" gap="6">
            <Flex align="center" justify="between">
              <Flex direction="column" gap="1">
                <Text size="4" weight="bold">Password</Text>
                <Text size="2" color="gray">Change the user's password</Text>
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
              <form onSubmit={handleChangePassword}>
                <Flex direction="column" gap="6">
                  <Flex direction="column" gap="2">
                    <Text size="2" weight="medium" as="label" htmlFor="edit-user-new-password">
                      New Password *
                    </Text>
                    <TextField.Root
                      id="edit-user-new-password"
                      type={showPassword ? 'text' : 'password'}
                      value={passwordData.newPassword}
                      onChange={(e) => handlePasswordChange('newPassword', e.target.value)}
                      size="3"
                      required
                      minLength={passwordPolicy.minLength}
                      disabled={changingPassword}
                    >
                      <TextField.Slot side="right">
                        <IconButton
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          variant="ghost"
                          color="gray"
                          size="1"
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                        >
                          {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </IconButton>
                      </TextField.Slot>
                    </TextField.Root>
                  </Flex>
                  
                  <Flex direction="column" gap="2">
                    <Text size="2" weight="medium" as="label" htmlFor="edit-user-confirm-password">
                      Confirm New Password *
                    </Text>
                    <TextField.Root
                      id="edit-user-confirm-password"
                      type={showConfirmPassword ? 'text' : 'password'}
                      value={passwordData.confirmPassword}
                      onChange={(e) => handlePasswordChange('confirmPassword', e.target.value)}
                      size="3"
                      required
                      minLength={passwordPolicy.minLength}
                      disabled={changingPassword}
                    >
                      <TextField.Slot side="right">
                        <IconButton
                          type="button"
                          onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                          variant="ghost"
                          color="gray"
                          size="1"
                          aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                        >
                          {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </IconButton>
                      </TextField.Slot>
                    </TextField.Root>
                    <Text size="1" color="gray">
                      {describePasswordPolicy(passwordPolicy)}
                    </Text>
                  </Flex>
                  
                  {/* Password Form Actions */}
                  <Flex gap="3" justify="end" pt="6" className="border-t border-[var(--gray-6)]">
                    <Button
                      type="button"
                      onClick={() => {
                        setShowPasswordSection(false);
                        setPasswordData({ newPassword: '', confirmPassword: '' });
                        setShowPassword(false);
                        setShowConfirmPassword(false);
                      }}
                      variant="soft"
                      color="gray"
                      size="3"
                      disabled={changingPassword}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      color="red"
                      size="3"
                      disabled={changingPassword}
                      loading={changingPassword}
                    >
                      <Key size={16} />
                      Change Password
                    </Button>
                  </Flex>
                </Flex>
              </form>
            )}
          </Flex>
        </Card>

        {/* Passkeys Section */}
        <Card>
          <Flex direction="column" gap="6">
            <Flex align="center" justify="between">
              <Flex direction="column" gap="1">
                <Flex align="center" gap="2">
                  <Shield size={20} className="text-[var(--accent-11)]" />
                  <Text size="4" weight="bold">Passkeys</Text>
                </Flex>
                <Text size="2" color="gray">
                  {passkeys.length === 0 
                    ? 'No passkeys configured for this user' 
                    : `${passkeys.length} passkey${passkeys.length === 1 ? '' : 's'} configured`}
                </Text>
              </Flex>
            </Flex>

            {loadingPasskeys ? (
              <PageLoader minHeight="6rem" />
            ) : passkeys.length > 0 ? (
              <Flex direction="column" gap="3">
                {passkeys.map((passkey) => (
                  <Card key={passkey.id} variant="surface">
                    <Flex align="center" justify="between" p="3">
                      <Flex align="center" gap="3">
                        <Flex align="center" justify="center" width="40px" height="40px" className="rounded-full bg-[var(--accent-3)]">
                          <Smartphone size={20} className="text-[var(--accent-11)]" />
                        </Flex>
                        <Flex direction="column" gap="1">
                          <Text size="3" weight="medium">
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
                            {/* Sign-in asks for no email: only a discoverable passkey answers it. */}
                            {passkey.discoverable === false ? (
                              <Text size="1" color="amber" highContrast>
                                Can't sign in without an email: they need to add a new passkey to replace it
                              </Text>
                            ) : passkey.discoverable !== true ? (
                              <Text size="1" color="amber" highContrast>
                                Not yet known to sign in without an email
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
            ) : (
              <Flex
                direction="column"
                align="center"
                justify="center"
                py="8"
                className="rounded-[var(--radius-4)] bg-[var(--gray-2)] border border-dashed border-[var(--gray-6)]"
              >
                <Shield size={48} className="mb-3 text-[var(--gray-8)]" />
                <Text size="2" weight="medium" color="gray">
                  No passkeys configured
                </Text>
                <Text size="1" color="gray">
                  User can add passkeys from their Security Settings
                </Text>
              </Flex>
            )}
          </Flex>
        </Card>
      </Flex>
      <ConfirmationDialog {...dialogProps} />
    </PageContainer>
  );
};

export default EditUserPage;
