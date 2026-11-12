/**
 * API Users Module - User Management Operations
 *
 * Handles all user-related API operations:
 * - Get users (regular and admin)
 * - Create, update, delete users
 * - Password management
 * - User profile image uploads
 *
 * Each answer is parsed with its `@nuggets/shared` schema.
 */

import {
  adminPasswordResetResponseSchema,
  adminUserListResponseSchema,
  adminUserUpdatedResponseSchema,
  createdUserResponseSchema,
  deploymentAdminChangedResponseSchema,
  tenantUserListResponseSchema,
  userDeletedResponseSchema,
  type AdminUserResponse,
} from '@nuggets/shared';
import { API_BASE_URL, getAuthHeaders, handleResponse, apiDelete, apiPatch, apiPost, apiPut, apiPutFormData } from './base';
import { parseAnswer } from './parseAnswer';
import type { AdminUser, User } from './types';
import { logger } from '../../utils/logger';

/**
 * The people who can open the active ledger (its members and its organization's admins),
 * for the pickers that assign one.
 */
export const getUsers = async (): Promise<User[]> => {
  try {
    const response = await fetch(`${API_BASE_URL}/tenants/current/users`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(tenantUserListResponseSchema, await handleResponse<unknown>(response), 'ledger people');
  } catch (error) {
    logger.error({ err: error, endpoint: '/tenants/current/users' }, 'Failed to fetch users');
    throw error;
  }
};

/**
 * Get full user data including UUIDs (admin only)
 */
export const getAdminUsers = async (): Promise<AdminUser[]> => {
  try {
    const response = await fetch(`${API_BASE_URL}/admin/users`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(adminUserListResponseSchema, await handleResponse<unknown>(response), 'admin users').users;
  } catch (error) {
    logger.error({ err: error, endpoint: '/admin/users' }, 'Failed to fetch admin users');
    throw error;
  }
};

/**
 * Create a new user (admin only)
 */
export const createUser = async (userData: { email: string; password: string; first_name: string; last_name: string }) =>
  parseAnswer(createdUserResponseSchema, await apiPost<unknown>('/admin/users', userData), 'user created');

/** Grant or revoke deployment-admin (the repurposed "Administrator" control). */
export const setUserDeploymentAdmin = async (userUuid: string, isDeploymentAdmin: boolean) =>
  parseAnswer(
    deploymentAdminChangedResponseSchema,
    await apiPatch<unknown>(`/admin/users/${userUuid}/deployment-admin`, { is_deployment_admin: isDeploymentAdmin }),
    'deployment admin changed'
  );

/**
 * Update an existing user (admin only)
 */
export const updateUser = async (userUuid: string, userData: Partial<AdminUser>) =>
  parseAnswer(adminUserUpdatedResponseSchema, await apiPut<unknown>(`/admin/users/${userUuid}`, userData), 'user updated');

/**
 * Update user with profile image upload (admin only): the account as saved.
 */
export const updateUserWithImage = async (userUuid: string, formData: FormData): Promise<AdminUserResponse> =>
  // Shared FormData helper attaches the X-CSRF-Token header (and omits Content-Type).
  parseAnswer(adminUserUpdatedResponseSchema, await apiPutFormData<unknown>(`/admin/users/${userUuid}`, formData), 'user updated').user;

/**
 * Delete a user (admin only), by uuid: the route takes no numeric id. A refusal
 * (LAST_ADMIN, say) rejects with the server's reason.
 */
export const deleteUser = async (userUuid: string) =>
  parseAnswer(userDeletedResponseSchema, await apiDelete<unknown>(`/admin/users/${encodeURIComponent(userUuid)}`), 'user deleted');

/**
 * Change user password (admin only): what it ended (their sessions, tokens and passkeys).
 */
export const changeUserPassword = async (userUuid: string, passwordData: { currentPassword?: string; newPassword: string }) =>
  parseAnswer(adminPasswordResetResponseSchema, await apiPut<unknown>(`/admin/users/${userUuid}/change-password`, passwordData), 'password reset');
