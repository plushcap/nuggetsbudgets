import {
  ownProfileResponseSchema,
  passwordChangedResponseSchema,
  type OwnProfile,
  type PasswordChangedResponse,
} from '@nuggets/shared';
import { getAuthHeaders, handleResponse, API_BASE_URL } from './base';
import { parseAnswer } from './parseAnswer';
import { logger } from '../../utils/logger';

export interface PasswordChangeData {
  currentPassword: string;
  newPassword: string;
}

/**
 * Update current user's profile
 */
/** Answers the updated user (the fields GET /auth/me has, but must_change_password). */
export const updateProfile = async (formData: FormData): Promise<OwnProfile> => {
  try {
    const headers = getAuthHeaders() as Record<string, string>;
    // Remove Content-Type to let browser set it with multipart boundary
    delete headers['Content-Type'];

    const response = await fetch(`${API_BASE_URL}/auth/profile`, {
      method: 'PUT',
      headers: headers,
      body: formData,
    });

    return parseAnswer(ownProfileResponseSchema, await handleResponse<unknown>(response), 'profile');
  } catch (error) {
    logger.error({ err: error, endpoint: '/auth/profile' }, 'Failed to update profile');
    throw error;
  }
};

/**
 * Change current user's password
 */
export const changePassword = async (passwordData: PasswordChangeData): Promise<PasswordChangedResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/auth/change-password`, {
      method: 'PUT',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(passwordData),
    });

    return parseAnswer(passwordChangedResponseSchema, await handleResponse<unknown>(response), 'password changed');
  } catch (error) {
    logger.error({ err: error, endpoint: '/auth/change-password' }, 'Failed to change password');
    throw error;
  }
};
