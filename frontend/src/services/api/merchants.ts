/**
 * API Merchants Module - Merchant Operations
 * 
 * Handles all merchant-related API operations:
 * - Merchant CRUD operations
 * - Merchant search and pagination
 * - Merchant rules (matching rules for transactions)
 * - Merchant image uploads
 * - Merchant merging and cleanup
 */

import {
  merchantApplyRulesResponseSchema,
  merchantImageResponseSchema,
  merchantListQuery,
  merchantListResponseSchema,
  merchantLiteListResponseSchema,
  merchantMergeResponseSchema,
  merchantPageQuery,
  merchantPageResponseSchema,
  merchantRemoveUnusedResponseSchema,
  merchantResponseSchema,
  merchantRuleListResponseSchema,
  merchantRulePreviewResponseSchema,
  merchantRuleResponseSchema,
  queryString,
  type MerchantLite as SharedMerchantLite,
  type MerchantPageResponse,
  type MerchantRuleMethod,
  type MerchantRulePreview,
  type merchantCreateSchema,
  type merchantRuleCreateSchema,
} from '@nuggets/shared';
import { API_BASE_URL, assertOk, getAuthHeaders, handleResponse, apiPostFormData } from './base';
import type { Merchant, MerchantRule, Patch, RequestBody } from './types';
import { parseAnswer } from './parseAnswer';
import { logger } from '../../utils/logger';

// ====================================================================
// MERCHANT CRUD OPERATIONS
// ====================================================================

/**
 * Get all merchants.
 *
 * Pass `{ lite: true }` for the lightweight shape (id, uuid, name,
 * merchant_website only) that skips the expensive per-merchant transaction /
 * rule COUNT aggregations. Use it wherever you only need id -> name (selectors,
 * dropdowns); the default (with counts) is for the merchant management UI.
 */
export function getMerchants(options: { lite: true }): Promise<MerchantLite[]>;
export function getMerchants(options?: { lite?: false }): Promise<Merchant[]>;
export function getMerchants(options?: { lite?: boolean }): Promise<Merchant[] | MerchantLite[]>;
export async function getMerchants(options?: { lite?: boolean }): Promise<Merchant[] | MerchantLite[]> {
  try {
    const lite = options?.lite === true;
    const response = await fetch(`${API_BASE_URL}/merchants${queryString(merchantListQuery, { fields: lite ? 'lite' : undefined })}`, {
      headers: getAuthHeaders(),
    });
    const raw = await handleResponse<unknown>(response);
    return lite ? parseAnswer(merchantLiteListResponseSchema, raw, 'merchants (lite)') : parseAnswer(merchantListResponseSchema, raw, 'merchants');
  } catch (error) {
    logger.error({ err: error, endpoint: '/merchants' }, 'Failed to fetch merchants');
    throw error;
  }
}

/** A merchant as `GET /merchants?fields=lite` lists it: only what a selector needs, no counts. */
export type MerchantLite = SharedMerchantLite;

/**
 * Get paginated merchants with optional search
 */
export const getPaginatedMerchants = async (
  page: number = 1,
  limit: number = 50,
  search: string = ''
): Promise<MerchantPageResponse> => {
  try {
    const query = queryString(merchantPageQuery, { page, limit, search: search.trim() });
    const response = await fetch(`${API_BASE_URL}/merchants/paginated${query}`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(merchantPageResponseSchema, await handleResponse<unknown>(response), 'merchants page');
  } catch (error) {
    logger.error({ err: error, page, limit, search, endpoint: '/merchants/paginated' }, 'Failed to fetch paginated merchants');
    throw error;
  }
};

/**
 * Get a single merchant by UUID
 */
export const getMerchant = async (uuid: string): Promise<Merchant> => {
  try {
    const response = await fetch(`${API_BASE_URL}/merchants/${uuid}`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(merchantResponseSchema, await handleResponse<unknown>(response), 'merchant');
  } catch (error) {
    logger.error({ err: error, merchantUuid: uuid, endpoint: `/merchants/${uuid}` }, 'Failed to fetch merchant');
    throw error;
  }
};

/**
 * What a create or an update sends: the name and website as
 * merchantCreateSchema reads them, and the merchant's other fields, each as its value or null
 * for none (the route reads them as sent; an update clears one left out).
 */
export type MerchantWrite = RequestBody<typeof merchantCreateSchema> &
  Patch<Pick<Merchant, 'merchant_accountid' | 'merchant_image' | 'notes' | 'instructions' | 'transaction_auto_tag_id'>>;

/**
 * Create a new merchant
 */
export const createMerchant = async (merchantData: MerchantWrite): Promise<Merchant> => {
  try {
    const response = await fetch(`${API_BASE_URL}/merchants`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(merchantData),
    });
    return parseAnswer(merchantResponseSchema, await handleResponse<unknown>(response), 'merchant');
  } catch (error) {
    logger.error({ err: error, endpoint: '/merchants' }, 'Failed to create merchant');
    throw error;
  }
};

/**
 * Update an existing merchant
 */
export const updateMerchant = async (uuid: string, merchantData: MerchantWrite): Promise<Merchant> => {
  try {
    const response = await fetch(`${API_BASE_URL}/merchants/${uuid}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(merchantData),
    });
    return parseAnswer(merchantResponseSchema, await handleResponse<unknown>(response), 'merchant');
  } catch (error) {
    logger.error({ err: error, merchantUuid: uuid, endpoint: `/merchants/${uuid}` }, 'Failed to update merchant');
    throw error;
  }
};

/**
 * Delete a merchant with optional replacement merchant
 */
export const deleteMerchant = async (uuid: string, replacementMerchantUuid?: string): Promise<void> => {
  try {
    const body = replacementMerchantUuid ? { replacementMerchantId: replacementMerchantUuid } : {};
    const response = await fetch(`${API_BASE_URL}/merchants/${uuid}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
      body: JSON.stringify(body),
    });
    await assertOk(response);
  } catch (error) {
    logger.error({ err: error, merchantUuid: uuid, replacementMerchantUuid, endpoint: `/merchants/${uuid}` }, 'Failed to delete merchant');
    throw error;
  }
};

/**
 * Merge two merchants (source into target)
 */
export const mergeMerchants = async (sourceMerchantUuid: string, targetMerchantUuid: string): Promise<void> => {
  try {
    const response = await fetch(`${API_BASE_URL}/merchants/${sourceMerchantUuid}/merge`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ targetMerchantUuid }),
    });
    parseAnswer(merchantMergeResponseSchema, await handleResponse<unknown>(response), 'merchant merge');
  } catch (error) {
    logger.error({ err: error, sourceMerchantUuid, targetMerchantUuid, endpoint: `/merchants/${sourceMerchantUuid}/merge` }, 'Failed to merge merchants');
    throw error;
  }
};

/**
 * Upload an image for a merchant
 */
export const uploadMerchantImage = async (merchantUuid: string, file: File): Promise<{ message: string; merchant: Merchant }> => {
  try {
    const formData = new FormData();
    formData.append('merchant_image', file);

    // Shared FormData helper attaches the X-CSRF-Token header (and omits Content-Type).
    return parseAnswer(
      merchantImageResponseSchema,
      await apiPostFormData<unknown>(`/merchants/${merchantUuid}/upload-image`, formData),
      'merchant image'
    );
  } catch (error) {
    logger.error({ err: error, merchantUuid, endpoint: `/merchants/${merchantUuid}/image` }, 'Failed to upload merchant image');
    throw error;
  }
};

// ====================================================================
// MERCHANT RULES
// ====================================================================

/**
 * Get all rules for a merchant
 */
export const getMerchantRules = async (merchantUuid: string): Promise<MerchantRule[]> => {
  try {
    const response = await fetch(`${API_BASE_URL}/merchants/${merchantUuid}/rules`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(merchantRuleListResponseSchema, await handleResponse<unknown>(response), 'merchant rules');
  } catch (error) {
    logger.error({ err: error, merchantUuid, endpoint: `/merchants/${merchantUuid}/rules` }, 'Failed to fetch merchant rules');
    throw error;
  }
};

/**
 * Create a new merchant rule
 */
/** POST and PUT body of a merchant rule (merchantRuleCreateSchema): its method and text. */
export type MerchantRuleWrite = RequestBody<typeof merchantRuleCreateSchema> & { method: MerchantRuleMethod };

export const createMerchantRule = async (merchantUuid: string, ruleData: MerchantRuleWrite): Promise<MerchantRule> => {
  try {
    const response = await fetch(`${API_BASE_URL}/merchants/${merchantUuid}/rules`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(ruleData),
    });
    return parseAnswer(merchantRuleResponseSchema, await handleResponse<unknown>(response), 'merchant rule');
  } catch (error) {
    logger.error({ err: error, merchantUuid, endpoint: `/merchants/${merchantUuid}/rules` }, 'Failed to create merchant rule');
    throw error;
  }
};

/**
 * Update an existing merchant rule
 */
export const updateMerchantRule = async (ruleUuid: string, ruleData: MerchantRuleWrite): Promise<MerchantRule> => {
  try {
    const response = await fetch(`${API_BASE_URL}/merchants/rules/${ruleUuid}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(ruleData),
    });
    return parseAnswer(merchantRuleResponseSchema, await handleResponse<unknown>(response), 'merchant rule');
  } catch (error) {
    logger.error({ err: error, ruleUuid, endpoint: `/merchants/rules/${ruleUuid}` }, 'Failed to update merchant rule');
    throw error;
  }
};

/**
 * Delete a merchant rule
 */
export const deleteMerchantRule = async (ruleUuid: string): Promise<void> => {
  try {
    const response = await fetch(`${API_BASE_URL}/merchants/rules/${ruleUuid}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    await assertOk(response);
  } catch (error) {
    logger.error({ err: error, ruleUuid, endpoint: `/merchants/rules/${ruleUuid}` }, 'Failed to delete merchant rule');
    throw error;
  }
};

/**
 * Test merchant rules to see which transactions they would match
 */
export const testMerchantRules = async (merchantUuid: string): Promise<MerchantRulePreview> => {
  try {
    const response = await fetch(`${API_BASE_URL}/merchants/${merchantUuid}/test-rules`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseAnswer(merchantRulePreviewResponseSchema, await handleResponse<unknown>(response), 'merchant rules preview');
  } catch (error) {
    logger.error({ err: error, merchantUuid, endpoint: `/merchants/${merchantUuid}/rules/test` }, 'Failed to test merchant rules');
    throw error;
  }
};

/**
 * Apply merchant rules to specific transactions
 */
export const applyMerchantRules = async (merchantUuid: string, transactionIds: number[]): Promise<{
  updatedCount: number;
  merchantName: string;
  message: string;
}> => {
  try {
    const response = await fetch(`${API_BASE_URL}/merchants/${merchantUuid}/apply-rules`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ transactionIds }),
    });
    return parseAnswer(merchantApplyRulesResponseSchema, await handleResponse<unknown>(response), 'merchant rules applied');
  } catch (error) {
    logger.error({ err: error, merchantUuid, endpoint: `/merchants/${merchantUuid}/rules/apply` }, 'Failed to apply merchant rules');
    throw error;
  }
};

// ====================================================================
// MERCHANT ADMINISTRATIVE ACTIONS
// ====================================================================

/**
 * Remove all unused merchants: those no transaction, attachment, budget item, recurring
 * item, budget-item rule or usage history refers to (MerchantService.removeUnused)
 */
export const removeUnusedMerchants = async (): Promise<{
  message: string;
  removedCount: number;
  removedMerchants: Array<{ uuid: string; name: string }>;
}> => {
  try {
    const response = await fetch(`${API_BASE_URL}/merchants/admin/remove-unused`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return parseAnswer(merchantRemoveUnusedResponseSchema, await handleResponse<unknown>(response), 'unused merchants removed');
  } catch (error) {
    logger.error({ err: error, endpoint: '/merchants/cleanup' }, 'Failed to remove unused merchants');
    throw error;
  }
};
