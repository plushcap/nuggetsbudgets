/**
 * API Institutions Module - Financial Institution Operations
 *
 * Handles all institution-related API operations:
 * - CRUD operations for financial institutions (banks, credit unions, etc.)
 * - Institution listings and details
 */

import {
  institutionDeletedResponseSchema,
  institutionListResponseSchema,
  institutionResponseSchema,
  type InstitutionDeletedResponse,
  type institutionWriteSchema,
} from '@nuggets/shared';
import { API_BASE_URL, getAuthHeaders, handleResponse } from './base';
import type { Institution, RequestBody } from './types';
import { parseAnswer } from './parseAnswer';
import { logger } from '../../utils/logger';

/**
 * POST /api/institutions and PUT /api/institutions/:uuid body (`institutionWriteSchema`): the
 * name, and notes as text or null for none. A PUT replaces the institution.
 */
export type InstitutionWriteBody = RequestBody<typeof institutionWriteSchema>;

/**
 * Get all financial institutions
 *
 * @returns Array of institutions, each with its account count
 */
export const getInstitutions = async (): Promise<Institution[]> => {
  try {
    const response = await fetch(`${API_BASE_URL}/institutions`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(institutionListResponseSchema, await handleResponse<unknown>(response), 'institutions');
  } catch (error) {
    logger.error({ err: error, endpoint: '/institutions' }, 'Failed to fetch institutions');
    throw error;
  }
};

/**
 * Get a single institution by UUID
 *
 * @param uuid - Institution UUID
 * @returns Institution details
 */
export const getInstitution = async (uuid: string): Promise<Institution> => {
  try {
    const response = await fetch(`${API_BASE_URL}/institutions/${uuid}`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(institutionResponseSchema, await handleResponse<unknown>(response), 'institution');
  } catch (error) {
    logger.error({ err: error, endpoint: '/institutions' }, 'Failed to fetch institution');
    throw error;
  }
};

/**
 * Create a new financial institution
 *
 * @param institutionData - Institution data (name and optional notes)
 * @returns Created institution
 */
export const createInstitution = async (institutionData: InstitutionWriteBody): Promise<Institution> => {
  try {
    const response = await fetch(`${API_BASE_URL}/institutions`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(institutionData),
    });
    return parseAnswer(institutionResponseSchema, await handleResponse<unknown>(response), 'institution');
  } catch (error) {
    logger.error({ err: error, endpoint: '/institutions' }, 'Failed to create institution');
    throw error;
  }
};

/**
 * Update an existing financial institution
 *
 * @param uuid - Institution UUID
 * @param institutionData - The whole institution (a PUT replaces it): notes that are none are null
 * @returns Updated institution
 */
export const updateInstitution = async (uuid: string, institutionData: InstitutionWriteBody): Promise<Institution> => {
  try {
    const response = await fetch(`${API_BASE_URL}/institutions/${uuid}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(institutionData),
    });
    return parseAnswer(institutionResponseSchema, await handleResponse<unknown>(response), 'institution');
  } catch (error) {
    logger.error({ err: error, endpoint: '/institutions' }, 'Failed to update institution');
    throw error;
  }
};

/**
 * Delete a financial institution
 *
 * @param uuid - Institution UUID
 * @returns Deletion confirmation with deleted institution details
 */
export const deleteInstitution = async (uuid: string): Promise<InstitutionDeletedResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/institutions/${uuid}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseAnswer(institutionDeletedResponseSchema, await handleResponse<unknown>(response), 'deleted institution');
  } catch (error) {
    logger.error({ err: error, endpoint: '/institutions' }, 'Failed to delete institution');
    throw error;
  }
};
