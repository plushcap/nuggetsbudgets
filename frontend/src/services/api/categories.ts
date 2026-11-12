/**
 * API Categories Module - Transaction Category Operations
 *
 * Handles all category-related API operations:
 * - CRUD operations for transaction categories
 * - Category management for organizing transactions
 */

import { categoryListResponseSchema, categoryResponseSchema, type categoryWriteSchema } from '@nuggets/shared';
import { API_BASE_URL, assertOk, getAuthHeaders, handleResponse } from './base';
import type { Category, RequestBody } from './types';
import { parseAnswer } from './parseAnswer';
import { logger } from '../../utils/logger';

/**
 * POST /api/categories and PUT /api/categories/:uuid body (`categoryWriteSchema`): name and
 * icon, and a description, priority or notes as text, or null for none. A PUT
 * replaces the category, so the edit sends every field, a cleared one as null.
 */
export type CategoryWriteBody = RequestBody<typeof categoryWriteSchema>;

/**
 * Get all transaction categories
 *
 * @returns Array of categories
 */
export const getCategories = async (): Promise<Category[]> => {
  try {
    const response = await fetch(`${API_BASE_URL}/categories`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(categoryListResponseSchema, await handleResponse<unknown>(response), 'categories');
  } catch (error) {
    logger.error({ err: error, endpoint: '/categories' }, 'Failed to fetch categories');
    throw error;
  }
};

/**
 * Create a new transaction category
 *
 * @param data - The category
 * @returns Created category
 */
export const createCategory = async (data: CategoryWriteBody): Promise<Category> => {
  try {
    const response = await fetch(`${API_BASE_URL}/categories`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return parseAnswer(categoryResponseSchema, await handleResponse<unknown>(response), 'category');
  } catch (error) {
    logger.error({ err: error, endpoint: '/categories' }, 'Failed to create category');
    throw error;
  }
};

/**
 * Update an existing transaction category
 *
 * @param uuid - Category UUID
 * @param data - The whole category (a PUT replaces it)
 * @returns Updated category
 */
export const updateCategory = async (uuid: string, data: CategoryWriteBody): Promise<Category> => {
  try {
    const response = await fetch(`${API_BASE_URL}/categories/${uuid}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return parseAnswer(categoryResponseSchema, await handleResponse<unknown>(response), 'category');
  } catch (error) {
    logger.error({ err: error, categoryUuid: uuid, endpoint: `/categories/${uuid}` }, 'Failed to update category');
    throw error;
  }
};

/**
 * Delete a transaction category (204, no body)
 *
 * @param uuid - Category UUID
 */
export const deleteCategory = async (uuid: string): Promise<void> => {
  try {
    const response = await fetch(`${API_BASE_URL}/categories/${uuid}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    await assertOk(response);
  } catch (error) {
    logger.error({ err: error, categoryUuid: uuid, endpoint: `/categories/${uuid}` }, 'Failed to delete category');
    throw error;
  }
};
